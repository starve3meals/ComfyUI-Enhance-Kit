# ComfyUI-Enhance-Kit

ComfyUI 的轻量实用工具扩展，当前提供可配置的**菜单栏资源监控**。安装后即可查看运行 ComfyUI 的主机资源状态，无需在工作流中添加节点，也无需下载模型。

## 功能

资源条以紧凑的彩色卡片显示实时读数：

| 指标 | 显示内容 |
| --- | --- |
| CPU | 主机整体 CPU 利用率 |
| RAM | 物理内存占用率；悬停查看已用／总容量 |
| GPU | 所选 NVIDIA GPU 的利用率 |
| VRAM | 所选 GPU 的显存占用率；悬停查看已用／总容量 |
| GPU 温度 | 摄氏温度；悬停查看设备名称 |

- 默认每秒刷新，支持分别开关指标、调整刷新间隔和选择 GPU。
- 页面或资源条隐藏时暂停刷新；恢复显示后重新获取数据。
- 窄窗口可在资源条内横向滚动。
- 数据不可用或连接中断时明确显示“不可用”，连接恢复后自动更新。
- 扩展运行时仅与当前 ComfyUI 服务通信，不上传资源数据。

CPU 和内存是主机整体统计；GPU 和显存包含其他进程的占用，不代表 ComfyUI 独占用量。远程访问 ComfyUI 时，显示的是服务端主机的资源。

## 安装

以下步骤需要 Git。根据你的 ComfyUI 安装方式选择一组命令。

### 常规安装（venv / Conda）

先激活运行 ComfyUI 的 Python 环境，再在 **ComfyUI 根目录**打开终端并执行：

```sh
git clone https://github.com/starve3meals/ComfyUI-Enhance-Kit.git custom_nodes/ComfyUI-Enhance-Kit
python -m pip install -r custom_nodes/ComfyUI-Enhance-Kit/requirements.txt
```

这里的 `python` 必须属于运行 ComfyUI 的环境。

### Windows 便携版

在包含 `ComfyUI` 和 `python_embeded` 文件夹的**便携版根目录**打开 PowerShell，执行：

```powershell
git clone https://github.com/starve3meals/ComfyUI-Enhance-Kit.git .\ComfyUI\custom_nodes\ComfyUI-Enhance-Kit
.\python_embeded\python.exe -m pip install -r .\ComfyUI\custom_nodes\ComfyUI-Enhance-Kit\requirements.txt
```

安装完成后，**重启 ComfyUI 并刷新浏览器**。资源条会出现在菜单栏；工作流不需要修改。

已安装过此扩展时，请按下方更新步骤操作，避免在 `custom_nodes` 中保留多个副本。其他安装方式可参考 [ComfyUI 官方自定义节点安装说明](https://docs.comfy.org/installation/install_custom_node)。

## 设置

打开 ComfyUI 设置，搜索 **`EnhanceKit`**，或进入 **EnhanceKit → Resources**。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| 显示 CPU 利用率 | 开启 | 显示／隐藏 CPU 卡片 |
| 显示内存占用 | 开启 | 显示／隐藏 RAM 卡片 |
| 显示 GPU 利用率 | 开启 | 显示／隐藏 GPU 卡片 |
| 显示显存占用 | 开启 | 显示／隐藏 VRAM 卡片 |
| 显示 GPU 温度 | 开启 | 显示／隐藏温度卡片 |
| 刷新间隔 | 1 秒 | 单位为秒；设为 `0` 关闭监控 |
| 监控 GPU | 自动 | 默认使用首张可用 NVIDIA GPU，也可指定已枚举的设备 |

设置由 ComfyUI 保存。全部指标关闭时，资源条隐藏并停止刷新。

## 支持范围

- GPU 指标通过 NVML 采集，目前支持 NVIDIA GPU，需要可用的 NVIDIA 驱动。
- 没有可用的 NVIDIA GPU 时，CPU 和内存仍可显示；GPU 相关项显示“不可用”。
- 当前已验证 Windows、NVIDIA GPU 和 ComfyUI 前端 `1.53.10`；其他系统及前端版本尚未完成兼容性验证。
- 当前不提供 CPU 温度和磁盘指标。

直接依赖为 `psutil` 和 `nvidia-ml-py`，详见 [requirements.txt](requirements.txt)。其中 `nvidia-ml-py` 提供 `pynvml` 模块，无需另装同名 `pynvml` 分发包。

## 更新

在 `ComfyUI/custom_nodes/ComfyUI-Enhance-Kit` 目录执行：

```sh
git pull --ff-only
```

然后使用运行 ComfyUI 的 Python 按 `requirements.txt` 更新依赖，重启 ComfyUI 并刷新浏览器。

## 常见问题

**安装后没有看到资源条？**

确认已重启 ComfyUI、依赖安装在正确的 Python 环境中，且启动日志没有此扩展的导入错误。检查菜单是否可见、是否退出 Focus Mode，以及刷新间隔是否大于 `0`、至少一项指标是否开启。更新前端文件后可尝试强制刷新浏览器。

**GPU 指标显示“不可用”？**

确认使用 NVIDIA GPU，驱动可用，且 `nvidia-ml-py` 安装在 ComfyUI 环境中。部分设备可能不支持某个指标；单项读取失败不会阻止其他指标显示。

**为什么读数与工作流的资源占用不同？**

这些读数统计整台主机或整张 GPU，也包含浏览器、其他程序和其他 GPU 进程的占用。内存及显存容量使用 GiB，`1 GiB = 1024³ bytes`。

## 文档与反馈

详细指标口径、开发接入和检查命令见 [使用说明](docs/usage.md)。遇到问题请提交 [Issue](https://github.com/starve3meals/ComfyUI-Enhance-Kit/issues)，附上 ComfyUI 及前端版本、操作系统、GPU 型号和相关启动日志。

## 致谢与许可证

资源条布局与配色参考 [ComfyUI-Crystools](https://github.com/crystian/ComfyUI-Crystools)。

本项目采用 [Apache-2.0](LICENSE) 许可证。
