import threading
import time

import psutil

try:
    import pynvml
except ImportError:
    pynvml = None


def _memory_usage(used, total):
    return {
        "used_bytes": used,
        "total_bytes": total,
        "utilization_percent": used / total * 100 if total else None,
    }


def _unavailable_memory():
    return {"used_bytes": None, "total_bytes": None, "utilization_percent": None}


class ResourceMonitor:
    """采集本机资源；请求共享近期快照，驱动资源在 close 时释放。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._snapshot = None
        self._sampled_monotonic = 0.0
        self._cpu_times = None
        self._nvml_initialized = False
        self._nvml_retry_at = 0.0
        self._nvml_reset_needed = False
        self._closed = False

    def snapshot(self) -> dict:
        """返回固定结构的资源快照，无参数；首次 CPU 和失败指标为 None。

        同步串行采集并缓存一秒；已关闭时抛出 RuntimeError，编程异常原样传播。
        """
        with self._lock:
            if self._closed:
                raise RuntimeError("ResourceMonitor is closed")
            now = time.monotonic()
            if self._snapshot is not None and now - self._sampled_monotonic < 1.0:
                return self._snapshot

            cpu = self._collect_cpu()
            memory = self._collect_memory()
            gpus = self._collect_gpus(now)
            self._snapshot = {
                "sampled_at_ms": int(time.time() * 1000),
                "cpu": {"utilization_percent": cpu},
                "memory": memory,
                "gpus": gpus,
            }
            self._sampled_monotonic = time.monotonic()
            return self._snapshot

    def close(self) -> None:
        """等待在途采集并释放 NVML，无参数和返回值；重复调用安全。

        驱动清理失败不阻断应用退出，关闭后禁止继续采集。
        """
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._shutdown_nvml()
            self._snapshot = None
            self._cpu_times = None

    def _collect_cpu(self):
        try:
            current = psutil.cpu_times()
        except OSError:
            self._cpu_times = None
            return None
        previous = self._cpu_times
        self._cpu_times = current
        if previous is None:
            return None

        # guest 已包含在 user/nice 中；iowait 和 idle 都不占用 CPU。
        deltas = {field: max(getattr(current, field) - getattr(previous, field), 0.0) for field in current._fields}
        total = sum(value for field, value in deltas.items() if field not in ("guest", "guest_nice"))
        if total <= 0:
            return None
        busy = total - deltas["idle"] - deltas.get("iowait", 0.0)
        return max(0.0, min(busy / total * 100, 100.0))

    def _collect_memory(self):
        try:
            memory = psutil.virtual_memory()
        except OSError:
            return _unavailable_memory()
        return _memory_usage(memory.total - memory.available, memory.total)

    def _read_nvml(self, function, *args):
        try:
            return function(*args)
        except pynvml.NVMLError as error:
            if error.value in (
                pynvml.NVML_ERROR_UNINITIALIZED,
                pynvml.NVML_ERROR_DRIVER_NOT_LOADED,
                pynvml.NVML_ERROR_GPU_IS_LOST,
                pynvml.NVML_ERROR_UNKNOWN,
            ):
                self._nvml_reset_needed = True
            return None

    def _collect_gpus(self, now):
        if pynvml is None or now < self._nvml_retry_at:
            return []
        if not self._nvml_initialized:
            try:
                pynvml.nvmlInit()
            except pynvml.NVMLError:
                self._nvml_retry_at = time.monotonic() + 5.0
                return []
            self._nvml_initialized = True

        count = self._read_nvml(pynvml.nvmlDeviceGetCount)
        gpus = []
        if count is not None:
            for index in range(count):
                gpu = {
                    "index": index,
                    "name": f"GPU {index}",
                    "utilization_percent": None,
                    "temperature_c": None,
                    "memory": _unavailable_memory(),
                }
                handle = self._read_nvml(pynvml.nvmlDeviceGetHandleByIndex, index)
                if handle is not None:
                    name = self._read_nvml(pynvml.nvmlDeviceGetName, handle)
                    if name is not None:
                        gpu["name"] = name.decode("utf-8", errors="replace") if isinstance(name, bytes) else name
                    utilization = self._read_nvml(pynvml.nvmlDeviceGetUtilizationRates, handle)
                    if utilization is not None:
                        gpu["utilization_percent"] = utilization.gpu
                    gpu["temperature_c"] = self._read_nvml(pynvml.nvmlDeviceGetTemperature, handle, pynvml.NVML_TEMPERATURE_GPU)
                    memory = self._read_nvml(pynvml.nvmlDeviceGetMemoryInfo, handle)
                    if memory is not None:
                        gpu["memory"] = _memory_usage(memory.used, memory.total)
                gpus.append(gpu)

        if count is None or self._nvml_reset_needed:
            self._shutdown_nvml()
            self._nvml_retry_at = time.monotonic() + 5.0
        return gpus

    def _shutdown_nvml(self):
        if self._nvml_initialized:
            try:
                pynvml.nvmlShutdown()
            except pynvml.NVMLError:
                pass
            self._nvml_initialized = False
        self._nvml_reset_needed = False
