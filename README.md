# ComfyUI-Enhance-Kit

ComfyUI 的轻量实用工具扩展，提供**LoRA 管理器**、**分类提示词库**和**菜单栏资源监控**。可以在一个节点中组合多项 LoRA、在多个工作流中维护常用提示词，以及查看主机资源状态。扩展不附带模型。

## 功能

### LoRA 管理器

在节点搜索中查找 **LoRA 管理器（EnhanceKit）**，或在 `EnhanceKit → Model` 分类添加节点。

1. 将加载器的 `MODEL` 输出连接到节点的 `model` 输入，再将节点的 `model` 输出连接到采样器。
2. 点击 **添加 LoRA**，选择文件并设置该项模型强度；可以继续添加其他 LoRA，也可以重复选择同一文件。
3. 用勾选框启用／停用单项，点击 `×` 删除条目；拖动左侧手柄调整顺序，也可使用上下箭头。

节点按列表从上到下应用启用项。强度默认为 `1`，支持负数；停用项和强度为 `0` 的项不会读取文件。列表为空或全部跳过时，输出原模型。删除条目不会删除磁盘上的 LoRA 文件。

- **仅处理 MODEL**：不加载 LoRA 中针对 CLIP／文本编码器的部分；需要调整 CLIP 时，请另接官方 LoRA 加载节点。
- 文件从 ComfyUI 的 LoRA 目录中选择，通常为 `models/loras`，也支持 `extra_model_paths.yaml` 配置的 LoRA 目录。新增文件后刷新节点定义，必要时重启 ComfyUI 并刷新浏览器。
- 文件选择、开关、强度和顺序随工作流保存；**工作流不包含 LoRA 文件**，迁移时需要另行复制文件并保持对应相对路径。
- 文件不可用时保留原选择并提示；启用的非零项必须重新选择有效文件或停用，否则运行会报错。

普通 LoRA 的固定权重增量相加，交换顺序通常不会改变其数学结果，浮点计算可能有细微差异；DoRA 等依赖当前权重的补丁可能受顺序影响。此节点沿用 ComfyUI 官方加载与补丁机制，兼容性取决于基础模型和所选 LoRA。

### 分类提示词库

在节点搜索中查找 **提示词库（EnhanceKit）**，或在 `EnhanceKit → Prompt` 分类添加节点。

1. 点击节点上的 **管理提示词库**，新增分类。
2. 新建提示词，填写标题和正文并保存；分类可按模型、任务或个人习惯划分。
3. 回到节点，选择分类和提示词标题，将 `prompt` 输出连接到接受 `STRING` 的文本输入，例如 CLIP 文本编码节点的文本输入。

节点使用官方下拉框、只读正文预览和按钮。同一 ComfyUI 用户的工作流共享提示词库；不同用户配置各自维护。分类名在库内唯一，标题在分类内唯一，不同分类可使用同名标题。

- 每次提交运行都读取库中的最新正文；进入队列后，该次任务使用固定快照。
- 重命名或移动提示词保留引用；删除后必须重新选择，运行不会使用旧预览或替换成其他提示词。
- 正文允许为空，不展开 `{a|b}` 等动态提示词语法。只改标题或分类时保留原正文及换行；编辑正文时，换行遵循浏览器文本框格式。
- 未保存编辑支持保存、放弃或取消；其他页面已更新库时显示冲突，刷新并核对后再保存，不自动覆盖。

数据保存在 ComfyUI 用户目录的 `enhance-kit/prompt-library.json`，默认通常是 `ComfyUI/user/default/enhance-kit/prompt-library.json`。备份或迁移时另行复制该文件：**工作流文件只保存条目 ID，不包含提示词库**。同一库文件应由一个 ComfyUI 服务进程维护。

API 调用方应先向 `/enhance-kit/prompt-library/resolve` POST `{"prompt_id":"条目ID"}`，再将返回的 `text` 作为节点输入 `resolved_text` 提交；导出的 API 执行图包含当时的正文快照，重复提交不会自动读取新版本。多用户模式需使用当前 ComfyUI 用户请求头。

### 菜单栏资源监控

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

安装完成后，**重启 ComfyUI 并刷新浏览器**。资源条会出现在菜单栏；使用 LoRA 管理器或提示词库时按上方步骤添加节点。

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
- 提示词库已在 Windows、ComfyUI `0.39.0`、前端 `1.55.14` 验证，覆盖传统节点、Nodes 2.0 及深浅色主题；可在 CPU 环境运行。管理窗口使用官方扩展弹窗 API，跟随前端主题与弹窗层级。其他前端版本尚未验证。
- LoRA 管理器已在上述 ComfyUI／前端版本验证，覆盖传统节点、Nodes 2.0、深浅色主题、工作流保存恢复、复制、撤销重做及子图；加载链使用小型 CPU 模型与实际队列验证。其他前端版本尚未验证。
- 资源条已验证 Windows、NVIDIA GPU，前端 `1.53.10` 和 `1.55.14`；其他系统尚未完成兼容性验证。
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

## 反馈

遇到问题请提交 [Issue](https://github.com/starve3meals/ComfyUI-Enhance-Kit/issues)，附上 ComfyUI 及前端版本、操作系统和相关错误日志；资源监控问题还请提供 GPU 型号。

## 致谢与许可证

资源条布局与配色参考 [ComfyUI-Crystools](https://github.com/crystian/ComfyUI-Crystools)。

本项目采用 [Apache-2.0](LICENSE) 许可证。
