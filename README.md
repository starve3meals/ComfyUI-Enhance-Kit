# ComfyUI-Enhance-Kit

用于逐步添加自己需要的 ComfyUI 功能的轻量扩展。首个功能是菜单栏资源监控：CPU 利用率、内存占用、GPU 利用率、GPU 温度和显存占用。

默认每秒刷新，可独立开关指标、调整间隔和选择 NVIDIA GPU。无需添加工作流节点；运行时只请求 ComfyUI 自身的资源接口。

安装、开发接入和指标说明见 [使用说明](docs/usage.md)。

当前已验证 ComfyUI 前端 1.53.10、Windows 和 NVIDIA GPU。GPU 数据使用 `nvidia-ml-py`；CPU 温度和磁盘不在首版范围内。

许可证：[Apache-2.0](LICENSE)。
