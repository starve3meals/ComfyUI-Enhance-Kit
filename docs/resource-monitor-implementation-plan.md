# 资源监控条 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 在 ComfyUI 菜单栏实时显示 CPU、内存、GPU、GPU 温度和显存，保持扩展轻量。

**Architecture:** Python 采集器只负责主机数值和 NVML 生命周期，加载入口负责本地 HTTP 适配。原生 JavaScript 通过 ComfyUI 的菜单与设置扩展入口展示数值。请求驱动采集，同一时刻只允许一个采集任务，不启动持续监控线程。

**Tech Stack:** Python、psutil、nvidia-ml-py、aiohttp、原生 JavaScript/CSS；unittest 和 Node 内置 test runner。

**Spec:** [resource-monitor-design.md](resource-monitor-design.md)

## Global Constraints

- 项目：`D:\PycharmProjects\ComfyUI-Enhance-Kit`；本地分支：`feat/resource-monitor`；基线：`af865b8`。
- 用户已确认书面规格，并明确授权“生成实施计划，开始实施”；无需再等待计划审批。
- 默认显示全部五项指标，每秒刷新；各项开关、刷新间隔和 GPU 选择使用 ComfyUI 设置。
- CPU 温度、磁盘、额外监控软件、工作流节点和模型操作均不属于首版。
- ComfyUI 前端验收基线为 1.53.10；不修改 ComfyUI 核心或已有 custom_nodes。
- Python 使用 `D:\anaconda\envs\comfyui\python.exe`，Node 使用 `D:\nodejs\node.exe`；不安装新的前端工具链。
- `.codex/` 仅放临时日志、隔离验证配置与截图，且不进入 Git。该路径运行时只读，临时写入通过正式审批执行。
- 两个实施代理分别拥有后端和前端文件；均不得修改 Git 索引。主代理管理文档、忽略规则、集成、提交和验收。
- 仅在代码稳定后启动独立只读 Reviewer；修复交回原实施代理，保持审查独立性。

## 文件与接口

| 文件 | 职责／写入主体 |
| --- | --- |
| `resource_monitor.py` | 资源采集器，后端代理 |
| `__init__.py` | ComfyUI 加载、HTTP 路由、清理，后端代理 |
| `requirements.txt` | psutil 与 nvidia-ml-py，后端代理 |
| `tests/test_resource_monitor.py`、`tests/test_server.py` | 采样、故障、并发与 HTTP 契约测试，后端代理 |
| `web/resource_monitor.js`、`web/resource_monitor.css` | 菜单条及 ComfyUI 设置，前端代理 |
| `tests/js/resource_monitor.test.mjs` | 展示、刷新、设置与生命周期测试，前端代理 |
| `.gitignore`、`docs/` | 忽略规则、计划、使用说明和交付状态，主代理 |

`ResourceMonitor.snapshot() -> dict` 同步提供数值快照；`ResourceMonitor.close() -> None` 释放驱动状态。HTTP 适配使用 `asyncio.to_thread`，避免占用 ComfyUI 主事件循环。

`GET /enhance-kit/resources` 不接受采样参数，返回以下固定结构：

```json
{
  "sampled_at_ms": 0,
  "cpu": {"utilization_percent": null},
  "memory": {"used_bytes": 0, "total_bytes": 0, "utilization_percent": 0},
  "gpus": [{
    "index": 0, "name": "NVIDIA GPU",
    "utilization_percent": null, "temperature_c": null,
    "memory": {"used_bytes": null, "total_bytes": null, "utilization_percent": null}
  }]
}
```

`sampled_at_ms` 为实际采集完成的 Unix 毫秒时间；所有不可用数值使用 `null`，示例中的 0 是类型示意。没有可枚举的 NVIDIA GPU 时 `gpus` 为 `[]`。容量单位 bytes，温度摄氏度，利用率百分数。接口使用 `Cache-Control: no-store`，快照缓存只由采集器管理。

## Review Focus

1. 多页面或取消请求不应引发重叠采集、重复 NVML 初始化或清理竞态；任务 1 测试并发和 cleanup。
2. NVML 单项失败、GPU 丢失与驱动恢复不应使 CPU/内存失败，也不能把旧 GPU 数值继续标成实时；任务 1 测试逐项故障与重试恢复。
3. CPU 首次采样、Linux guest/iowait 统计及内存 available 口径不应伪造 0 或重复计算；任务 1 使用明确样本验证。
4. 扩展设置 onChange 早于 setup、禁用后迟到响应、超时后恢复不应复活刷新或显示旧结果；任务 2 用可控请求测试。
5. Focus Mode 重建、浮动菜单与窄窗口不应导致资源条丢失、重复挂载或遮挡菜单；任务 2 测试生命周期，任务 3 进行浏览器验收。

## Task 1：资源采集与本地接口

**Files:** 创建后端主体与两份 Python 测试，见文件表。

**Interfaces:** 消费 psutil/NVML；生产 `ResourceMonitor.snapshot()`、`close()` 以及上述 HTTP 契约。使用 `WEB_DIRECTORY = "./web"` 和空 `NODE_CLASS_MAPPINGS`。

- [ ] 先写测试：首次 CPU 为 null；两次样本计算正确百分比；内存 `used = total - available`；无 NVML 仍提供 CPU/内存；GPU 单指标异常不影响其余字段；初始化失败后恢复；并发共享快照且一次采集；close 幂等并与在途采集同步。
- [ ] 运行 `python -B -m unittest discover -s tests -p "test_*.py" -v`，保存功能缺失导致失败的证据。
- [ ] 实现采样基线、线程锁、1 秒近期快照、NVML 惰性初始化与失败退避。仅捕获可解释的依赖／驱动／系统采集异常，GPU 失败字段置 null，禁止吞掉编程错误。
- [ ] 在加载入口注册路由和 aiohttp cleanup。路由直接返回采集器快照，HTTP 测试覆盖结构、no-store、事件循环不被慢采样阻塞以及正常清理。
- [ ] 重跑 Python 全部测试；在本机直接读取两份真实快照，核对 RTX 5090 Laptop GPU 的字段，并测量采集耗时。
- [ ] 提供命令、退出状态、测试数量及证据路径，完成后由主代理安排独立任务审查和提交。

## Task 2：菜单资源条与设置

**Files:** 创建前端主体、CSS 和 Node 测试，见文件表。

**Interfaces:** 消费 Task 1 的固定 JSON 契约以及 `app`、`api`。通过 `app.registerExtension` 的 `settings` 和 `setup` 注册；只使用当前官方保留的菜单对象挂载入口。

- [ ] 先写行为测试：五项格式化、null 与零值区别、GiB 容量／百分比一致、GPU 选择、各项开关，以及 setup 前设置回调不会报错。
- [ ] 补充可控请求／定时器测试：不重叠、超时、断线恢复、禁用后迟到响应不改变状态、隐藏暂停与恢复、菜单重挂载保持唯一元素。
- [ ] 运行 `node --experimental-vm-modules --test tests/js/resource_monitor.test.mjs`，记录功能缺失导致失败的证据。测试可对 ComfyUI 模块和浏览器 API 做必要替身，生产代码不得引入测试专用开关。
- [ ] 实现五项紧凑资源显示、各项开关、刷新间隔（默认 1 秒；0 关闭）与实际 GPU 选项。启动后只更新现有 DOM 数值；异步请求必须有超时、取消与状态版本保护。
- [ ] 实现主题兼容 CSS、稳定数值宽度及窄窗口显示；绑定页面生命周期，在实际挂载容器变化后恢复资源条。避免全页面高频 DOM 轮询。
- [ ] 重跑 Node 全部测试，提供结果、覆盖范围和证据；完成后由主代理安排独立任务审查和提交。

## Task 3：集成、独立审查与交付

**Files:** 主代理创建 `docs/usage.md` 并更新本计划状态；临时验证文件位于 `.codex/tmp/resource-monitor/`。

- [ ] 定向复核两代理交付的关键代码、测试输出与当前文件状态，交由独立 Reviewer 审查最终差异、数据契约和生命周期风险。
- [ ] 在隔离端口使用真实 ComfyUI 启动验证。优先以已有 `main.py` 命令及 `--extra-model-paths-config` 加载开发项目，仅白名单 Enhance-Kit；临时 input/output/temp/user 放入项目 `.codex/`，不开启 Manager 或其他插件。
- [ ] 通过 HTTP 验证扩展被加载、资源数据、JavaScript/CSS 可用，浏览器验证菜单显示、刷新、设置、宽窄窗口、Focus Mode／浮动菜单及断线恢复。截图保存到项目 `.codex/`。
- [ ] 修复独立审查与浏览器发现的问题，补充针对性回归测试；新差异交回 Reviewer 增量复审。
- [ ] 保存正式使用说明：安装／开发接入方式、设置位置、指标口径、NVIDIA 支持范围和不可用值。正常结束隔离验证服务。
- [ ] 更新计划的实际完成状态与证据；执行 `git diff --check`、确认 `.codex/` 未跟踪，按单一逻辑目的使用中文提交。保留本地分支，不执行远程操作。

## 执行记录

- 2026-10-05：规格已确认，用户明确授权生成计划后开始实施。
- 隔离选择：当前项目是仅有设计文档的独立仓库，分支干净且由本任务新建；沿用用户指定目录。两个实施代理的文件互不重叠，不额外创建 worktree，不触碰已有 ComfyUI 工作区。
- 工作流适配：writing-plans 的再次等待计划确认被用户当前连续实施授权覆盖；SDD 默认临时目录与项目规则冲突，改用项目 `.codex/`；模型选择完全遵守用户模型登记，均使用 gpt-6.1-sol，最高 Max。
- 基线验证：尚无功能代码或测试，因此不执行空测试并宣称通过；后续各任务先建立行为测试再实现。
