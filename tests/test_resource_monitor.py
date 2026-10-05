import importlib.util
import threading
import unittest
from collections import namedtuple
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch


MODULE_SPEC = importlib.util.find_spec("resource_monitor")
if MODULE_SPEC is not None:
    import resource_monitor
else:
    resource_monitor = None

CpuTimes = namedtuple("CpuTimes", "user nice system idle iowait irq softirq steal guest guest_nice")
ZERO_CPU = CpuTimes(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
BUSY_CPU = CpuTimes(20, 5, 15, 30, 10, 5, 5, 10, 5, 2)


class NvmlError(Exception):
    def __init__(self, value=3):
        self.value = value
        super().__init__(value)


class FakeNvml:
    NVMLError = NvmlError
    NVML_ERROR_UNINITIALIZED = 1
    NVML_ERROR_DRIVER_NOT_LOADED = 9
    NVML_ERROR_GPU_IS_LOST = 15
    NVML_ERROR_UNKNOWN = 999
    NVML_TEMPERATURE_GPU = 0

    def __init__(self):
        self.init_calls = 0
        self.shutdown_calls = 0
        self.init_error = None
        self.count_error = None
        self.utilization_error = None
        self.temperature_error = None
        self.memory_error = None
        self.name_error = None
        self.handle_error = None
        self.count = 1

    def nvmlInit(self):
        self.init_calls += 1
        if self.init_error:
            raise self.init_error

    def nvmlShutdown(self):
        self.shutdown_calls += 1

    def nvmlDeviceGetCount(self):
        if self.count_error:
            raise self.count_error
        return self.count

    def nvmlDeviceGetHandleByIndex(self, index):
        if self.handle_error:
            raise self.handle_error
        return index

    def nvmlDeviceGetName(self, handle):
        if self.name_error:
            raise self.name_error
        return b"NVIDIA test GPU"

    def nvmlDeviceGetUtilizationRates(self, handle):
        if self.utilization_error:
            raise self.utilization_error
        return SimpleNamespace(gpu=35, memory=15)

    def nvmlDeviceGetTemperature(self, handle, sensor):
        if sensor != 0:
            raise AssertionError("GPU temperature sensor required")
        if self.temperature_error:
            raise self.temperature_error
        return 62

    def nvmlDeviceGetMemoryInfo(self, handle):
        if self.memory_error:
            raise self.memory_error
        return SimpleNamespace(used=3_221_225_472, total=8_589_934_592, free=5_368_709_120)


class ResourceMonitorTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(resource_monitor, "ResourceMonitor 尚未实现")
        self.now = 0.0
        self.cpu = ZERO_CPU
        self.ram = SimpleNamespace(total=1000, available=400, used=123, free=100, percent=87.7)
        self.nvml = FakeNvml()
        self.cpu_calls = 0
        self.ram_calls = 0
        self.cpu_reader = self.read_cpu
        self.ram_reader = self.read_ram
        self.stack = [
            patch.object(resource_monitor, "psutil", SimpleNamespace(cpu_times=lambda: self.cpu_reader(), virtual_memory=lambda: self.ram_reader())),
            patch.object(resource_monitor, "pynvml", self.nvml),
            patch.object(resource_monitor.time, "monotonic", lambda: self.now),
            patch.object(resource_monitor.time, "time", lambda: 1_700_000_000.125),
        ]
        for item in self.stack:
            item.start()
            self.addCleanup(item.stop)
        self.monitor = resource_monitor.ResourceMonitor()
        self.addCleanup(self.monitor.close)

    def read_cpu(self):
        self.cpu_calls += 1
        return self.cpu

    def read_ram(self):
        self.ram_calls += 1
        return self.ram

    def next_sample(self):
        self.now += 1.1
        return self.monitor.snapshot()

    def test_first_cpu_sample_is_unavailable_and_ram_uses_available(self):
        sample = self.monitor.snapshot()
        self.assertEqual(sample["sampled_at_ms"], 1_700_000_000_125)
        self.assertEqual(sample["cpu"], {"utilization_percent": None})
        self.assertEqual(sample["memory"], {"used_bytes": 600, "total_bytes": 1000, "utilization_percent": 60.0})

    def test_cpu_delta_excludes_guest_duplicates_and_iowait(self):
        self.monitor.snapshot()
        self.cpu = BUSY_CPU
        self.assertEqual(self.next_sample()["cpu"]["utilization_percent"], 60.0)

    def test_cpu_baseline_is_shared_across_worker_threads(self):
        with ThreadPoolExecutor(max_workers=1) as first:
            first.submit(self.monitor.snapshot).result()
        self.cpu = BUSY_CPU
        self.now = 1.1
        with ThreadPoolExecutor(max_workers=1) as second:
            self.assertEqual(second.submit(self.monitor.snapshot).result()["cpu"]["utilization_percent"], 60.0)

    def test_no_elapsed_cpu_time_is_unavailable(self):
        self.monitor.snapshot()
        self.assertIsNone(self.next_sample()["cpu"]["utilization_percent"])

    def test_no_nvml_still_returns_cpu_and_ram(self):
        with patch.object(resource_monitor, "pynvml", None):
            self.assertEqual(self.monitor.snapshot()["gpus"], [])
            self.cpu = BUSY_CPU
            sample = self.next_sample()
        self.assertEqual(sample["cpu"]["utilization_percent"], 60.0)
        self.assertEqual(sample["memory"]["used_bytes"], 600)

    def test_gpu_fields_use_percent_celsius_and_bytes(self):
        self.assertEqual(self.monitor.snapshot()["gpus"], [{
            "index": 0, "name": "NVIDIA test GPU", "utilization_percent": 35,
            "temperature_c": 62, "memory": {"used_bytes": 3_221_225_472,
            "total_bytes": 8_589_934_592, "utilization_percent": 37.5},
        }])

    def test_gpu_metric_failure_does_not_reuse_old_value(self):
        self.monitor.snapshot()
        self.nvml.utilization_error = NvmlError()
        gpu = self.next_sample()["gpus"][0]
        self.assertIsNone(gpu["utilization_percent"])
        self.assertEqual(gpu["temperature_c"], 62)
        self.assertEqual(gpu["memory"]["utilization_percent"], 37.5)
        self.nvml.utilization_error = None
        self.assertEqual(self.next_sample()["gpus"][0]["utilization_percent"], 35)

    def test_temperature_and_memory_failures_are_local(self):
        self.nvml.temperature_error = NvmlError()
        self.nvml.memory_error = NvmlError()
        gpu = self.monitor.snapshot()["gpus"][0]
        self.assertEqual(gpu["utilization_percent"], 35)
        self.assertIsNone(gpu["temperature_c"])
        self.assertEqual(gpu["memory"], {"used_bytes": None, "total_bytes": None, "utilization_percent": None})

    def test_nvml_initialization_is_lazy_and_retries_after_failure(self):
        self.assertEqual(self.nvml.init_calls, 0)
        self.nvml.init_error = NvmlError(9)
        self.assertEqual(self.monitor.snapshot()["gpus"], [])
        self.nvml.init_error = None
        self.now = 2.0
        self.assertEqual(self.monitor.snapshot()["gpus"], [])
        self.now = 6.0
        self.assertEqual(self.monitor.snapshot()["gpus"][0]["temperature_c"], 62)
        self.assertEqual(self.nvml.init_calls, 2)

    def test_driver_loss_discards_gpu_values_and_can_recover(self):
        self.monitor.snapshot()
        self.nvml.count_error = NvmlError(9)
        self.assertEqual(self.next_sample()["gpus"], [])
        self.nvml.count_error = None
        self.now = 8.0
        self.assertEqual(self.monitor.snapshot()["gpus"][0]["utilization_percent"], 35)
        self.assertEqual(self.nvml.init_calls, 2)

    def test_lost_gpu_handle_does_not_remove_cpu_or_retain_metrics(self):
        self.nvml.handle_error = NvmlError(15)
        sample = self.monitor.snapshot()
        self.assertEqual(sample["memory"]["used_bytes"], 600)
        self.assertEqual(sample["gpus"], [{"index": 0, "name": "GPU 0", "utilization_percent": None,
            "temperature_c": None, "memory": {"used_bytes": None, "total_bytes": None, "utilization_percent": None}}])

    def test_no_gpu_returns_empty_list(self):
        self.nvml.count = 0
        self.assertEqual(self.monitor.snapshot()["gpus"], [])

    def test_os_failure_is_local_and_cpu_restarts_baseline(self):
        self.monitor.snapshot()
        self.cpu_reader = lambda: (_ for _ in ()).throw(OSError("CPU counter unavailable"))
        self.ram_reader = lambda: (_ for _ in ()).throw(OSError("RAM unavailable"))
        sample = self.next_sample()
        self.assertIsNone(sample["cpu"]["utilization_percent"])
        self.assertEqual(sample["memory"], {"used_bytes": None, "total_bytes": None, "utilization_percent": None})
        self.assertEqual(sample["gpus"][0]["temperature_c"], 62)
        self.cpu_reader = self.read_cpu
        self.ram_reader = self.read_ram
        self.cpu = BUSY_CPU
        self.assertIsNone(self.next_sample()["cpu"]["utilization_percent"])

    def test_programming_errors_are_not_swallowed(self):
        self.ram_reader = lambda: (_ for _ in ()).throw(TypeError("invalid collector code"))
        with self.assertRaisesRegex(TypeError, "invalid collector code"):
            self.monitor.snapshot()

    def test_cache_reuses_sample_for_one_second(self):
        first = self.monitor.snapshot()
        self.now = 0.5
        self.assertEqual(self.monitor.snapshot(), first)
        self.assertEqual(self.cpu_calls, 1)
        self.cpu = BUSY_CPU
        self.now = 1.1
        self.assertEqual(self.monitor.snapshot()["cpu"]["utilization_percent"], 60.0)
        self.assertEqual(self.cpu_calls, 2)

    def test_cache_age_starts_when_slow_collection_finishes(self):
        def slow_ram():
            self.now = 3.0
            return self.read_ram()
        self.ram_reader = slow_ram
        first = self.monitor.snapshot()
        self.now = 3.5
        self.assertEqual(self.monitor.snapshot(), first)
        self.assertEqual(self.ram_calls, 1)

    def test_concurrent_requests_share_one_collection(self):
        entered = threading.Event()
        release = threading.Event()
        def blocked_ram():
            entered.set()
            if not release.wait(2):
                raise AssertionError("test did not release collector")
            return self.read_ram()
        self.ram_reader = blocked_ram
        with ThreadPoolExecutor(max_workers=2) as workers:
            first = workers.submit(self.monitor.snapshot)
            self.assertTrue(entered.wait(2))
            second = workers.submit(self.monitor.snapshot)
            release.set()
            self.assertEqual(first.result(), second.result())
        self.assertEqual(self.cpu_calls, 1)
        self.assertEqual(self.ram_calls, 1)
        self.assertEqual(self.nvml.init_calls, 1)

    def test_close_waits_for_collection_and_is_idempotent(self):
        self.monitor.snapshot()
        self.now = 1.1
        entered = threading.Event()
        release = threading.Event()
        closing = threading.Event()
        def blocked_ram():
            entered.set()
            if not release.wait(2):
                raise AssertionError("test did not release collector")
            return self.read_ram()
        def close_monitor():
            closing.set()
            self.monitor.close()
        self.ram_reader = blocked_ram
        with ThreadPoolExecutor(max_workers=2) as workers:
            sample = workers.submit(self.monitor.snapshot)
            self.assertTrue(entered.wait(2))
            cleanup = workers.submit(close_monitor)
            self.assertTrue(closing.wait(2))
            self.assertFalse(cleanup.done())
            self.assertEqual(self.nvml.shutdown_calls, 0)
            release.set()
            self.assertEqual(sample.result()["gpus"][0]["temperature_c"], 62)
            cleanup.result()
        self.monitor.close()
        self.assertEqual(self.nvml.shutdown_calls, 1)
        with self.assertRaises(RuntimeError):
            self.monitor.snapshot()


if __name__ == "__main__":
    unittest.main()
