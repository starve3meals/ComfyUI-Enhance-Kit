# 使用说明

## 安装

将仓库克隆到 ComfyUI 的 `custom_nodes` 目录，并用运行 ComfyUI 的 Python 安装依赖。以当前机器为例：

```powershell
git clone https://github.com/starve3meals/ComfyUI-Enhance-Kit.git D:\ComfyUI\custom_nodes\ComfyUI-Enhance-Kit
& D:\anaconda\envs\comfyui\python.exe -m pip install -r D:\ComfyUI\custom_nodes\ComfyUI-Enhance-Kit\requirements.txt
```

重启 ComfyUI，刷新浏览器后，资源条出现在菜单栏。工作流无需添加节点。如果目标目录已有安装，使用该目录更新，避免重复加载扩展。

`psutil` 采集 CPU 和内存；`nvidia-ml-py` 提供 `pynvml` 模块。不要另外安装同名 `pynvml` 分发包。GPU 指标需要可用的 NVIDIA 驱动；无 NVIDIA GPU 或驱动不可用时，CPU 和内存仍可显示。

## 开发接入

开发目录是 `D:\PycharmProjects\ComfyUI-Enhance-Kit`。若希望 ComfyUI 直接读取这里的源码，可在目标 `custom_nodes` 下创建目录联接；该目标目录必须尚不存在：

```powershell
New-Item -ItemType Junction -Path D:\ComfyUI\custom_nodes\ComfyUI-Enhance-Kit -Target D:\PycharmProjects\ComfyUI-Enhance-Kit
& D:\anaconda\envs\comfyui\python.exe -m pip install -r D:\PycharmProjects\ComfyUI-Enhance-Kit\requirements.txt
```

克隆安装和目录联接选择一种即可。修改 Python 后重启 ComfyUI，修改 JavaScript/CSS 后刷新浏览器。本次验收通过额外 custom_nodes 搜索路径加载开发目录，使用隔离端口及临时用户目录；未改动已有 ComfyUI 核心源码或安装目录。

## 设置

打开 ComfyUI 设置，在 **EnhanceKit → Resources** 中配置，也可搜索 `EnhanceKit`：

| 设置 | 默认值 | 行为 |
| --- | --- | --- |
| 显示 CPU 利用率 | 开启 | 主机整体 CPU 利用率 |
| 显示内存占用 | 开启 | 占用率；悬浮查看已用／总量 |
| 显示 GPU 利用率 | 开启 | 所选 GPU 整卡利用率 |
| 显示 GPU 温度 | 开启 | 所选 GPU 摄氏温度 |
| 显示显存占用 | 开启 | 占用率；悬浮查看已用／总量 |
| 刷新间隔 | 1 秒 | 0 关闭监控；设置由 ComfyUI 保存 |
| 监控 GPU | 自动 | 首张可用 NVIDIA GPU，或实际枚举的指定设备 |

资源条外观参考 [ComfyUI-Crystools](https://github.com/crystian/ComfyUI-Crystools/blob/main/web/monitor.css)：标签左下、读数右上，背景填充随数值变化。温度使用 0–100°C 的显示色阶，实际温度读数不裁剪。

全部指标关闭、页面隐藏、Focus Mode 隐藏菜单或禁用顶部菜单时，暂停请求；恢复显示后重新获取数值。窄窗口可在资源条内横向滚动，悬浮每项可查看完整读数及设备名称。

## 指标口径与不可用值

- 指标属于运行 ComfyUI 的主机。CPU 为两次采样之间的整体利用率；第一次建立基线时显示“采样中”。
- 内存已用量为物理内存总量减去可用内存。内存和显存显示 GiB，`1 GiB = 1024³ bytes`。
- GPU 利用率、温度和显存来自 NVML，包含其他进程的整卡使用情况，不等同于 ComfyUI 独占的资源。设备或单项指标不受驱动支持时，对应项显示“不可用”。
- 请求失败、超时或读数超过有效期时显示“不可用”，恢复后自动更新；有效的 0% 仍显示 0.0%。
- 后端按请求采集，多个页面共享 1 秒内的快照。没有界面请求时，不启动持续采集线程。刷新间隔建议至少 1 秒。

首版不采集 CPU 温度和磁盘，不需要额外传感器软件。扩展运行时不访问互联网、不上传资源数据，也不导入 torch 或创建 CUDA 上下文获取指标。

## 开发检查

在项目根目录运行：

```powershell
& D:\anaconda\envs\comfyui\python.exe -B -m unittest discover -s tests -p 'test_*.py' -v
& D:\nodejs\node.exe --experimental-vm-modules --test tests/js/resource_monitor.test.mjs
```

设计和验收记录见 [设计规格](resource-monitor-design.md) 与 [实施计划](resource-monitor-implementation-plan.md)。
