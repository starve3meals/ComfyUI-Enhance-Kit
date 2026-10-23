# ComfyUI-Enhance-Kit

[简体中文](#简体中文) | [English](#english)

## 简体中文

ComfyUI 的轻量实用工具扩展，提供**LoRA 管理器**、**分类提示词库**和**菜单栏资源监控**。可以在一个节点中组合多项 LoRA、在多个工作流中维护常用提示词，以及查看主机资源状态。扩展不附带模型。

### 功能

#### LoRA 管理器

在节点搜索中查找 **LoRA 管理器（EnhanceKit）**，或在 `EnhanceKit → Model` 分类添加节点。

1. 将加载器的 `MODEL` 输出连接到节点的 `model` 输入，再将节点的 `model` 输出连接到采样器。
2. 点击 **添加 LoRA**，选择文件并分别设置该项模型强度和 CLIP 强度，默认为 `1`、`0`；可以继续添加其他 LoRA，也可以重复选择同一文件。
3. 用勾选框启用／停用单项，点击 `×` 删除条目；拖动左侧手柄调整顺序，也可使用上下箭头。
4. 需要应用文本编码器补丁时，将加载器的 `CLIP` 输出接到节点的 `clip` 输入，再将节点的 `clip` 输出连接到正、负提示词的文本编码节点，并调整对应 LoRA 的 CLIP 强度。

节点按列表从上到下应用启用项，两种强度均支持负数。停用项或两种强度都为 `0` 的项不会读取文件；某种强度为 `0` 时保留该部分原对象。列表为空或全部跳过时，输出原模型和已接入的 CLIP。删除条目不会删除磁盘上的 LoRA 文件。

- **CLIP 输入可选**：默认 CLIP 强度为 `0`，原 MODEL-only 工作流可继续使用；旧配置缺少 CLIP 强度时按 `0` 恢复。启用项的 CLIP 强度非零时必须接入 CLIP，否则运行会提示接入。
- 模型强度为 `0`、CLIP 强度非零时，可以单独应用文本编码器补丁。LoRA 是否包含这部分权重取决于其训练和保存内容。
- 文件从 ComfyUI 的 LoRA 目录中选择，通常为 `models/loras`，也支持 `extra_model_paths.yaml` 配置的 LoRA 目录。新增文件后刷新节点定义，必要时重启 ComfyUI 并刷新浏览器。
- 文件选择、开关、强度和顺序随工作流保存；**工作流不包含 LoRA 文件**，迁移时需要另行复制文件并保持对应相对路径。
- 文件不可用时保留原选择并提示；启用的非零项必须重新选择有效文件或停用，否则运行会报错。

普通 LoRA 的固定权重增量相加，交换顺序通常不会改变其数学结果，浮点计算可能有细微差异；DoRA 等依赖当前权重的补丁可能受顺序影响。此节点沿用 ComfyUI 官方加载与补丁机制，兼容性取决于基础模型和所选 LoRA。

#### 分类提示词库

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

#### 菜单栏资源监控

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

### 安装

以下步骤需要 Git。根据你的 ComfyUI 安装方式选择一组命令。

#### 常规安装（venv / Conda）

先激活运行 ComfyUI 的 Python 环境，再在 **ComfyUI 根目录**打开终端并执行：

```sh
git clone https://github.com/starve3meals/ComfyUI-Enhance-Kit.git custom_nodes/ComfyUI-Enhance-Kit
python -m pip install -r custom_nodes/ComfyUI-Enhance-Kit/requirements.txt
```

这里的 `python` 必须属于运行 ComfyUI 的环境。

#### Windows 便携版

在包含 `ComfyUI` 和 `python_embeded` 文件夹的**便携版根目录**打开 PowerShell，执行：

```powershell
git clone https://github.com/starve3meals/ComfyUI-Enhance-Kit.git .\ComfyUI\custom_nodes\ComfyUI-Enhance-Kit
.\python_embeded\python.exe -m pip install -r .\ComfyUI\custom_nodes\ComfyUI-Enhance-Kit\requirements.txt
```

安装完成后，**重启 ComfyUI 并刷新浏览器**。资源条会出现在菜单栏；使用 LoRA 管理器或提示词库时按上方步骤添加节点。

已安装过此扩展时，请按下方更新步骤操作，避免在 `custom_nodes` 中保留多个副本。其他安装方式可参考 [ComfyUI 官方自定义节点安装说明](https://docs.comfy.org/installation/install_custom_node)。

### 设置

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

### 支持范围

- GPU 指标通过 NVML 采集，目前支持 NVIDIA GPU，需要可用的 NVIDIA 驱动。
- 没有可用的 NVIDIA GPU 时，CPU 和内存仍可显示；GPU 相关项显示“不可用”。
- 提示词库已在 Windows、ComfyUI `0.39.0`、前端 `1.55.14` 验证，覆盖传统节点、Nodes 2.0 及深浅色主题；可在 CPU 环境运行。管理窗口使用官方扩展弹窗 API，跟随前端主题与弹窗层级。其他前端版本尚未验证。
- LoRA 管理器已在上述 ComfyUI／前端版本验证，覆盖传统节点、Nodes 2.0、深浅色主题、旧工作流恢复、复制、撤销重做及子图。加载链使用小型 CPU 模型、官方双文本编码器和实际队列验证，包括独立 CLIP 强度与官方文本编码；尚未验证完整 SD 1.5／SDXL 模型的 GPU 图像生成或其他前端版本。
- 资源条已验证 Windows、NVIDIA GPU，前端 `1.53.10` 和 `1.55.14`；其他系统尚未完成兼容性验证。
- 当前不提供 CPU 温度和磁盘指标。

直接依赖为 `psutil` 和 `nvidia-ml-py`，详见 [requirements.txt](requirements.txt)。其中 `nvidia-ml-py` 提供 `pynvml` 模块，无需另装同名 `pynvml` 分发包。

### 更新

在 `ComfyUI/custom_nodes/ComfyUI-Enhance-Kit` 目录执行：

```sh
git pull --ff-only
```

然后使用运行 ComfyUI 的 Python 按 `requirements.txt` 更新依赖，重启 ComfyUI 并刷新浏览器。

### 常见问题

**安装后没有看到资源条？**

确认已重启 ComfyUI、依赖安装在正确的 Python 环境中，且启动日志没有此扩展的导入错误。检查菜单是否可见、是否退出 Focus Mode，以及刷新间隔是否大于 `0`、至少一项指标是否开启。更新前端文件后可尝试强制刷新浏览器。

**GPU 指标显示“不可用”？**

确认使用 NVIDIA GPU，驱动可用，且 `nvidia-ml-py` 安装在 ComfyUI 环境中。部分设备可能不支持某个指标；单项读取失败不会阻止其他指标显示。

**为什么读数与工作流的资源占用不同？**

这些读数统计整台主机或整张 GPU，也包含浏览器、其他程序和其他 GPU 进程的占用。内存及显存容量使用 GiB，`1 GiB = 1024³ bytes`。

### 反馈

遇到问题请提交 [Issue](https://github.com/starve3meals/ComfyUI-Enhance-Kit/issues)，附上 ComfyUI 及前端版本、操作系统和相关错误日志；资源监控问题还请提供 GPU 型号。

### 致谢与许可证

资源条布局与配色参考 [ComfyUI-Crystools](https://github.com/crystian/ComfyUI-Crystools)。

本项目采用 [Apache-2.0](LICENSE) 许可证。

---

## English

A lightweight utility extension for ComfyUI with a **LoRA manager**, a **categorized prompt library**, and **menu bar resource monitoring**. Combine multiple LoRAs in one node, maintain reusable prompts across workflows, and monitor host resources. No models are bundled with the extension.

### Features

#### LoRA manager

Search for **LoRA 管理器（EnhanceKit）** (LoRA Manager), or add the node from `EnhanceKit → Model`.

1. Connect the loader's `MODEL` output to the node's `model` input, then connect its `model` output to your sampler.
2. Click **添加 LoRA** (Add LoRA), select a file, and set its model and CLIP strengths. The defaults are `1` and `0`. Add more entries as needed; the same file can be selected multiple times.
3. Use the checkbox to enable or disable an entry, and `×` to remove it. Drag the handle on the left to reorder entries, or use the up and down arrows.
4. To apply text encoder patches, connect the loader's `CLIP` output to the node's `clip` input. Connect the node's `clip` output to the text encoding nodes for your positive and negative prompts, and adjust the relevant LoRA's CLIP strength.

Enabled entries are applied from top to bottom. Both strengths support negative values. Disabled entries and entries with both strengths set to `0` do not read their files. A part with zero strength retains its original object. An empty list, or a list with all entries skipped, returns the original model and the connected CLIP. Removing an entry does not delete the LoRA file from disk.

- **CLIP input is optional**: its default strength is `0`, so existing MODEL-only workflows continue to work. Old entries without a CLIP strength are restored with `0`. An enabled entry with a nonzero CLIP strength requires a connected CLIP input; execution reports an error if it is missing.
- Set model strength to `0` and CLIP strength to a nonzero value to apply only text encoder patches. Whether a LoRA includes these weights depends on how it was trained and saved.
- Files are selected from ComfyUI's LoRA directories, usually `models/loras`. LoRA directories configured in `extra_model_paths.yaml` are also supported. Refresh node definitions after adding files; restart ComfyUI and refresh the browser if needed.
- File selections, enabled states, strengths, and ordering are saved with the workflow. **Workflows do not contain LoRA files**. Copy the files separately when migrating, and preserve their relative paths.
- Unavailable files retain their selections and display a message. An enabled entry with a nonzero strength must be assigned a valid file or disabled, otherwise execution fails.

Ordinary LoRAs add fixed weight deltas, so changing their order usually does not change the mathematical result, although floating-point calculations may differ slightly. Patches such as DoRA that depend on current weights may be affected by ordering. This node uses ComfyUI's official loading and patching mechanisms; compatibility depends on the base model and selected LoRAs.

#### Categorized prompt library

Search for **提示词库（EnhanceKit）** (Prompt Library), or add the node from `EnhanceKit → Prompt`.

1. Click **管理提示词库** (Manage Prompt Library) and create a category.
2. Create a prompt, enter its title and text, and save it. Organize categories by model, task, or your own preferences.
3. Select a category and prompt title in the node. Connect its `prompt` output to a text input that accepts `STRING`, such as the text input of a CLIP text encoding node.

The node uses standard dropdowns, a read-only text preview, and buttons. Workflows belonging to the same ComfyUI user share a prompt library; separate user profiles maintain separate libraries. Category names are unique within a library, and prompt titles are unique within a category. Different categories may use the same title.

- Runs submitted from the UI read the latest prompt text from the library. Once queued, that run uses a fixed snapshot.
- Renaming or moving a prompt preserves its reference. After deletion, select another prompt; execution does not use the old preview or substitute a different entry.
- Prompt text may be empty. Dynamic prompt syntax such as `{a|b}` is not expanded. Changing only the title or category preserves the text and its line breaks; when editing the text, line breaks follow the browser text area's format.
- Unsaved edits can be saved, discarded, or canceled. If another page has updated the library, a conflict is shown. Refresh and review the changes before saving; edits are not overwritten automatically.

Data is stored at `enhance-kit/prompt-library.json` inside the ComfyUI user directory, normally `ComfyUI/user/default/enhance-kit/prompt-library.json`. Copy this file separately for backup or migration: **workflow files store entry IDs, not the prompt library**. A single ComfyUI server process should manage each library file.

API clients should first POST `{"prompt_id":"entry-id"}` to `/enhance-kit/prompt-library/resolve`, then submit the returned `text` as the node's `resolved_text` input. Exported API execution graphs contain the prompt snapshot from the time of export; resubmitting them does not automatically read a newer version. In multi-user mode, include the header identifying the current ComfyUI user.

#### Menu bar resource monitoring

Compact colored cards display live resource readings:

| Metric | Display |
| --- | --- |
| CPU | Overall host CPU utilization |
| RAM | Physical memory usage percentage; hover for used and total capacity |
| GPU | Utilization of the selected NVIDIA GPU |
| VRAM | GPU memory usage percentage; hover for used and total capacity |
| GPU temperature | Temperature in Celsius; hover for the device name |

- Refreshes every second by default. Toggle metrics individually, adjust the refresh interval, and select a GPU.
- Refreshing pauses when the page or resource bar is hidden and resumes with fresh data when it becomes visible.
- Scroll horizontally within the resource bar in narrow windows.
- Unavailable data or a disconnected server is explicitly shown as unavailable. Updates resume automatically when the connection returns.
- At runtime, the extension communicates only with the current ComfyUI server and does not upload resource data.

CPU and RAM readings cover the whole host. GPU and VRAM readings include other processes and do not represent ComfyUI's exclusive usage. When accessing ComfyUI remotely, the readings describe the server host.

### Installation

Git is required. Choose the commands that match your ComfyUI installation.

#### Standard installation (venv / Conda)

Activate the Python environment used to run ComfyUI, then open a terminal in the **ComfyUI root directory** and run:

```sh
git clone https://github.com/starve3meals/ComfyUI-Enhance-Kit.git custom_nodes/ComfyUI-Enhance-Kit
python -m pip install -r custom_nodes/ComfyUI-Enhance-Kit/requirements.txt
```

The `python` command must use the environment that runs ComfyUI.

#### Windows portable installation

Open PowerShell in the **portable installation root directory**, which contains the `ComfyUI` and `python_embeded` folders, and run:

```powershell
git clone https://github.com/starve3meals/ComfyUI-Enhance-Kit.git .\ComfyUI\custom_nodes\ComfyUI-Enhance-Kit
.\python_embeded\python.exe -m pip install -r .\ComfyUI\custom_nodes\ComfyUI-Enhance-Kit\requirements.txt
```

After installation, **restart ComfyUI and refresh your browser**. The resource bar appears in the menu bar. Add the LoRA manager or prompt library nodes as described above.

If the extension is already installed, follow the update instructions below and avoid keeping multiple copies in `custom_nodes`. For other installation methods, see the [official ComfyUI custom node installation guide](https://docs.comfy.org/installation/install_custom_node).

### Settings

Open ComfyUI settings and search for **`EnhanceKit`**, or go to **EnhanceKit → Resources**.

| Setting (Chinese UI label) | Default | Description |
| --- | --- | --- |
| Show CPU utilization (显示 CPU 利用率) | Enabled | Show or hide the CPU card |
| Show memory usage (显示内存占用) | Enabled | Show or hide the RAM card |
| Show GPU utilization (显示 GPU 利用率) | Enabled | Show or hide the GPU card |
| Show VRAM usage (显示显存占用) | Enabled | Show or hide the VRAM card |
| Show GPU temperature (显示 GPU 温度) | Enabled | Show or hide the temperature card |
| Refresh interval (刷新间隔) | 1 second | Measured in seconds; set to `0` to disable monitoring |
| Monitored GPU (监控 GPU) | Automatic | Uses the first available NVIDIA GPU by default; an enumerated device can also be selected |

ComfyUI saves these settings. Disabling all metrics hides the resource bar and stops refreshing.

### Compatibility

- GPU metrics are collected through NVML. NVIDIA GPUs are currently supported, with a working NVIDIA driver required.
- Without an available NVIDIA GPU, CPU and RAM readings remain available; GPU-related metrics are shown as unavailable.
- The prompt library has been verified on Windows with ComfyUI `0.39.0` and frontend `1.55.14`, covering classic nodes, Nodes 2.0, and light and dark themes. It runs in CPU environments. The management window uses the official extension dialog API and follows the frontend theme and dialog layering. Other frontend versions have not been verified.
- The LoRA manager has been verified with the same ComfyUI and frontend versions, covering classic nodes, Nodes 2.0, light and dark themes, old workflow restoration, copying, undo/redo, and subgraphs. Its loading chain has been tested with small CPU models, official dual text encoders, and actual queued execution, including independent CLIP strength and official text encoding. GPU image generation with full SD 1.5 / SDXL models and other frontend versions have not been verified.
- The resource bar has been verified on Windows with NVIDIA GPUs and frontend versions `1.53.10` and `1.55.14`. Compatibility with other operating systems has not yet been verified.
- CPU temperature and disk metrics are not provided.

Direct dependencies are `psutil` and `nvidia-ml-py`; see [requirements.txt](requirements.txt). The `nvidia-ml-py` distribution provides the `pynvml` module. There is no need to install the separate distribution named `pynvml`.

### Updating

Run the following command in `ComfyUI/custom_nodes/ComfyUI-Enhance-Kit`:

```sh
git pull --ff-only
```

Then update dependencies according to `requirements.txt` using the Python environment that runs ComfyUI, restart ComfyUI, and refresh your browser.

### Troubleshooting

**The resource bar does not appear after installation.**

Check that ComfyUI has been restarted, dependencies were installed in the correct Python environment, and startup logs contain no import errors for this extension. Make sure the menu is visible, Focus Mode is off, the refresh interval is greater than `0`, and at least one metric is enabled. A hard browser refresh may help after frontend files have been updated.

**GPU metrics are shown as unavailable.**

Check that you have an NVIDIA GPU, a working driver, and `nvidia-ml-py` installed in the ComfyUI environment. Some devices may not support particular metrics; a failure to read one metric does not prevent the others from working.

**The readings differ from the resources used by my workflow.**

Readings cover the whole host or GPU, including the browser, other applications, and other GPU processes. RAM and VRAM capacities use GiB, where `1 GiB = 1024³ bytes`.

### Feedback

Please open an [issue](https://github.com/starve3meals/ComfyUI-Enhance-Kit/issues) with your ComfyUI and frontend versions, operating system, and relevant error logs. For resource monitoring issues, also include your GPU model.

### Acknowledgments and license

The resource bar's layout and colors were inspired by [ComfyUI-Crystools](https://github.com/crystian/ComfyUI-Crystools).

This project is licensed under [Apache-2.0](LICENSE).
