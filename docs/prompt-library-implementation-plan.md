# 分类提示词库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans 或经用户选择的 superpowers:subagent-driven-development 逐项实施。使用 `- [ ]` 跟踪步骤；工作流选择不得绕过模型、权限或写入隔离规则。

**Goal:** 新增采用官方控件的分类提示词库节点，跨工作流维护提示词，提交时获取最新正文并输出固定的 `STRING` 快照。

**Architecture:** Python 存储模块持有文件、版本检查和锁；接口适配模块只处理当前 ComfyUI 用户及 HTTP 契约；执行节点只返回已解析正文。原生 JavaScript 通过官方节点控件和可等待的 `serializeValue` 接入选择、预览及提交，管理面板使用 ComfyUI 现有 DOM 弹窗与主题变量。

**Tech Stack:** 现有 Python、aiohttp、原生 JavaScript/CSS；Python unittest、Node 内置 test runner；不增加运行依赖或构建工具。

**Spec:** [分类提示词库设计规格](prompt-library-design.md)，用户于 2026-10-08 确认。

状态：计划待审阅与执行方式选择；以下步骤尚未执行。代码基线 `6e466da`，设计提交 `8c6e185`，当前分支 `docs/prompt-library-design`。

## Global Constraints

- 节点 ID `EnhanceKitPromptLibrary`，名称「提示词库（EnhanceKit）」，分类 `EnhanceKit/Prompt`，唯一输出 `prompt: STRING`。
- 同一 ComfyUI 用户配置内跨工作流共享；固定用户相对路径 `enhance-kit/prompt-library.json`，不跨用户读取或写入。
- 一级分类；分类名在库内唯一，标题在分类内唯一；名称去除首尾空白，正文按原文保留并允许空字符串。
- 点击运行时读取最新正文，排队后固定；重命名不改变 ID，移动保持提示词 ID；删除后不得替换为其他条目或返回旧预览。
- 原生控件及主题变量；验收前端 `1.55.14`、Nodes 2.0 和传统渲染、深浅主题；不要求用户更改全局设置。
- 不修改 ComfyUI 核心、安装副本或实际用户库；不增加依赖、框架、互联网请求、全局 CSS、后台轮询或队列猴子补丁。
- Python 使用 `D:\anaconda\envs\comfyui\python.exe`，Node 使用 `D:\nodejs\node.exe`；正式文档位于 `docs/`。
- 实施前检查状态并确认 `feat/prompt-library` 不存在，再从本计划提交创建该分支。现有未跟踪 `.idea/` 原样保留，不纳入提交。
- 当前 `.codex/` 在默认沙箱下只读；首次临时写入前核实权限，通过正式审批取得所需写入权限。获准后，测试夹具、隔离用户目录、截图与辅助文件放在 `.codex/tmp/prompt-library/`，不进入 Git。
- 本计划只安排一个 ComfyUI 服务进程对其用户库的并发操作；不新增多个服务进程共用同一数据文件的协作机制。
- 后续实现按高风险门禁执行：新数据契约、并发写入和用户配置边界必须通过独立只读审查。审查者不参与实施；启动时核实有效模型、强度、授权与只读边界，不能用自审代替。
- 此次授权仅生成计划；没有本功能的合并、推送、安装副本更新授权。

## 已核实的前端接入

本机 `1.55.14` 的源码映射中，`src/utils/executionUtil.ts:134-136` 实际等待 `widget.serializeValue(node, i)`；`src/scripts/app.ts:1941` 等待 `graphToPrompt` 后才提交队列。`widget.beforeQueued` 没有等待异步结果，不用于读取库。

工作流持久化读取 `widget.value`，执行输入才调用异步 serializer。稳定引用以节点属性 `enhanceKitPromptLibrary` 为唯一持久化来源；分类、标题控件由该属性恢复，设置 `widget.serialize = false` 和 `options.serialize = false`，不重复存入控件值或执行输入。正文设置 `widget.serialize = false` 排除预览持久化，但保留执行序列化。复制和恢复时重新绑定当前节点。

官方 combo 的 `getOptionLabel` 在两种渲染下均被调用，可用 ID 作为值、名称作为显示。正文使用官方 `STRING(multiline)`，设置 `options.read_only = true`，传统 DOM 同时设置 `element.readOnly = true`；显式关闭 `dynamicPrompts`。

现代 `showExtensionDialog` 需要 Vue component，未核实无需构建的桥接方式。本计划使用当前明确导出的 `window.comfyAPI.ui.ComfyDialog` 和 DOM 内容，不引入 Vue 或导入带哈希的内部 chunk。其对应 `scripts/ui.js` shim 已标记 deprecated，因此只承诺已验收版本，不将其描述为现代稳定弹窗 API；若实际浏览器无法使用此入口，应停止面板接入并上报，不能自行扩大依赖范围。

以上为静态源码核查，不替代任务 5 的实际运行验证。

## 文件与接口

| 文件 | 职责 |
| --- | --- |
| `prompt_library.py` | 文件格式、分类操作、原子保存、revision、锁和领域错误 |
| `prompt_library_api.py` | 用户文件定位、三个同源接口、错误状态和线程适配 |
| `prompt_library_nodes.py` | 仅消费 `resolved_text` 的文本输出节点 |
| `__init__.py` | 注册节点、显示名及提示词接口，保留资源监控入口 |
| `web/prompt_library_client.js` | 通过 `api.fetchApi` 访问库、提交修改和解析正文 |
| `web/prompt_library.js` | 注册扩展、原生控件、稳定引用、预览、执行快照和生命周期 |
| `web/prompt_library_manager.js`、`web/prompt_library.css` | 编辑窗口、保存/关闭状态和限定范围的主题样式 |
| `tests/test_prompt_library.py` | 存储、并发与故障检查 |
| `tests/test_prompt_library_api.py`、`tests/test_prompt_library_nodes.py` | HTTP、用户边界、注册和原文输出检查 |
| `tests/js/prompt_library_client.test.mjs`、`tests/js/prompt_library.test.mjs`、`tests/js/prompt_library_manager.test.mjs` | 请求、选择、提交、管理和生命周期检查 |
| `tests/test_server.py`、`README.md`、`docs/usage.md` | 原注册断言的必要更新、用户说明和 API 使用边界 |

存储接口：`PromptLibraryStore.read(path: Path) -> dict`、`mutate(path: Path, expected_revision: int, action: str, data: dict) -> dict`、`resolve(path: Path, prompt_id: str) -> dict`。构造时不访问文件。`PromptLibraryError(code: str, message: str)` 使用 `invalid_request`、`not_found`、`revision_conflict`、`storage_error` 四种 code，不携带正文，也不依赖 HTTP。

库格式沿用规格中的 `schema_version/categories/prompts/revision`；空库为版本 1、revision 0、两个空列表。解析返回 `{revision, id, category_id, category_name, title, text}`。管理成功返回完整更新库，revision 加一。

接口注册：`register_prompt_library_routes(server, store) -> None`。路径沿用规格；管理请求为 `{expected_revision, action, data}`，解析请求为 `{prompt_id}`。错误体为 `{error: {code, message}}`；四种存储错误分别映射 400、404、409、500，未知用户映射 401。所有库响应使用 `Cache-Control: no-store`。

客户端接口：`readLibrary({signal} = {}) -> Promise<Library>`、`mutateLibrary(expectedRevision, action, data, {signal} = {}) -> Promise<Library>`、`resolvePrompt(promptId, {signal} = {}) -> Promise<ResolvedPrompt>`；signal 为可选 AbortSignal。非成功响应抛出含 `status/code/message` 的错误，不退回缓存。取消请求不代表回滚服务端已开始的写入。

## Review Focus

1. 保存冲突或原子替换失败时不能覆盖另一页面内容或损坏原文件；任务 1 用同时写入及 `os.replace` 失败夹具证明。
2. 切换用户、工作流或选择期间晚返回的请求不能串用正文；任务 3 捕获节点所属图、`api.user`、ID 和选择代次，并验证失效结果。
3. 复制、撤销恢复或子图中的节点不能继承原节点闭包；任务 3 检查重新绑定和实际 DTO 参数，不依赖 serializer 参数是完整节点。
4. `{a|b}`、前后空白、中文、CRLF 和空正文不能被动态提示词扩展或预览控件改变；任务 2/3 检查响应正文与执行输入相等。
5. 有未保存内容时关闭、切换条目及 HTTP 409 不能静默丢弃编辑；任务 4 检查保存、放弃、取消及冲突后保留输入。

---

### 任务 1：分类库持久化与并发更新

**Files:** 创建 `prompt_library.py`、`tests/test_prompt_library.py`。

**Interfaces:** 产出上文的 `PromptLibraryStore`、`PromptLibraryError`，供任务 2 调用；不导入 ComfyUI、aiohttp 或前端概念。

- [ ] **Step 1：编写失败测试。** 夹具使用获准的 `.codex/tmp/prompt-library/` 内唯一测试目录；每个测试独立库文件。实现以下测试及核心断言：

```python
def test_missing_file_is_empty_without_creating_it(self):
    self.assertEqual(self.store.read(self.path), EMPTY_LIBRARY)
    self.assertFalse(self.path.exists())

def test_rename_and_move_keep_prompt_identity(self):
    self.assertEqual(moved_prompt["id"], original_prompt["id"])
    self.assertEqual(moved_prompt["category_id"], target_category["id"])
    self.assertEqual(reloaded_prompt["text"], "  中文\r\n{a|b}  ")

def test_concurrent_same_revision_has_one_winner(self):
    self.assertEqual(success_count, 1)
    self.assertEqual(error_codes, ["revision_conflict"])
    self.assertEqual(self.store.read(self.path)["revision"], original_revision + 1)

def test_replace_failure_preserves_file(self):
    self.assertEqual(self.path.read_bytes(), original_bytes)
    self.assertEqual(error.code, "storage_error")
```

另测六种管理操作、重启重读、空正文、名称去空白后的重复、不同分类同名标题、非空分类删除、失效 ID、非法字段及 bool revision、错误 schema_version/损坏 JSON 保留原文件。

- [ ] **Step 2：运行并确认失败来自未实现契约。** `python -B -m unittest discover -s tests -p test_prompt_library.py -v`；保存必要失败证据。
- [ ] **Step 3：实现存储接口。** 单用户文件锁覆盖读取、revision 校验、操作及写入；对新结构校验后以同目录临时文件、flush/fsync、`os.replace` 保存。每次返回独立数据，写入失败清理本次临时文件。只校验元数据与结构，不改写正文。
- [ ] **Step 4：重跑同一命令，要求退出码 0、全部断言通过。** 不用关闭校验、缩减测试或返回空库掩盖失败。
- [ ] **Step 5：检查差异并仅提交本任务文件。** `feat(提示词库): 实现分类数据持久化`。

### 任务 2：同源接口与原文输出节点

**Files:** 创建 `prompt_library_api.py`、`prompt_library_nodes.py`、两份相应 Python 测试；修改 `__init__.py`、`tests/test_server.py`。

**Interfaces:** 消费任务 1 接口；产出三个同源路由、`EnhanceKitPromptLibrary` 注册及 `emit(resolved_text: str) -> tuple[str]`。

- [ ] **Step 1：编写失败测试。** 使用 aiohttp `TestClient/TestServer` 和可控用户文件解析器，不载入真实用户目录；节点测试直接调用并验证契约。

```python
def test_emit_preserves_exact_text(self):
    self.assertEqual(node.emit("  中文\r\n{a|b}  "), ("  中文\r\n{a|b}  ",))
    self.assertEqual(node.emit(""), ("",))
    self.assertEqual(node.RETURN_TYPES, ("STRING",))

async def test_user_profiles_do_not_share_library(self):
    self.assertEqual((await user_b_library.json())["prompts"], [])
    self.assertEqual(user_b_resolve.status, 404)

async def test_resolve_reads_latest_and_uses_current_category(self):
    self.assertEqual((await response.json())["text"], updated_text)
    self.assertEqual((await response.json())["category_id"], moved_category_id)
```

补充 400/401/404/409/500 状态与无正文错误体、固定路径、no-store、GET 不创建目录、线程隔离、删除失效、损坏文件、资源接口仍可用和节点映射已注册。更新原有空映射断言为检查新增节点，不删除原测试。

- [ ] **Step 2：运行并确认失败。** `python -B -m unittest discover -s tests -p 'test_prompt_library*.py' -v`。
- [ ] **Step 3：实现接口和节点。** 用户路径调用 `get_request_user_filepath(request, "enhance-kit/prompt-library.json", create_dir=False)`；存储调用用 `asyncio.to_thread`；未知用户按当前 ComfyUI 解析结果处理。节点仅定义 `resolved_text: STRING(multiline, dynamicPrompts=false, socketless=true)` 输入，按现有映射注册，不添加后端不读取的分类/标题参数。
- [ ] **Step 4：重跑新增检查及 `python -B -m unittest discover -s tests -p test_server.py -v`，要求退出码 0。** 核查导入不读取用户文件、不影响资源采集器。
- [ ] **Step 5：检查并提交本任务差异。** `feat(提示词库): 注册节点与用户数据接口`。

### 任务 3：原生选择控件与最新执行快照

**Files:** 创建 `web/prompt_library_client.js`、`web/prompt_library.js` 及两份相应 JS 测试。

**Interfaces:** 消费任务 2 HTTP 契约；产出客户端三个方法及 `refreshPromptLibraryNodes(library) -> void`。节点属性 `enhanceKitPromptLibrary` 保存 `{category_id, prompt_id}`；正文控件执行输入名保持 `resolved_text`。

- [ ] **Step 1：编写失败测试。** 沿现有 Node test runner/VM 模块模式模拟 `api`、原生控件和 Deferred Promise；断言以下用例，不用延长定时器掩盖竞态。

```javascript
test('queue awaits latest text rather than preview', async () => {
  assert.equal(submitted, false); // resolve Promise 尚未完成
  resolveReply({ text: '新正文', id: promptId, category_id: categoryId });
  assert.equal(await queuedText, '新正文');
});
test('deleted or changed selection rejects submission', async () => {
  await assert.rejects(queuedText);
  assert.equal(queueCalls, 0);
});
test('raw text survives while preview is excluded from workflow', () => {
  assert.equal(textWidget.dynamicPrompts, false);
  assert.equal(textWidget.serialize, false);
  assert.equal(categoryWidget.options.serialize, false);
  assert.deepEqual(savedReferences, { category_id: categoryId, prompt_id: promptId });
});
```

补充空库、分类切换清空、同名标题、重命名显示、移动跟随、请求乱序、复制/恢复/子图独立绑定、等待中切换用户或工作流、UTF-8/CRLF/空文本及焦点恢复、节点删除与清理。客户端测试核对 URL、JSON、no-store 和非成功抛错。

- [ ] **Step 2：运行两个 JS 文件并确认预期失败。** `node --experimental-vm-modules --test tests/js/prompt_library_client.test.mjs tests/js/prompt_library.test.mjs`。
- [ ] **Step 3：实现客户端与节点控件。** 使用 `api.fetchApi`；combo 值为 ID，数组 `options.values` 配合 `getOptionLabel` 显示名称；控件选择同步到节点属性，控件值不重复持久化。只读设置覆盖两种渲染，正文 serializer 返回 resolve 响应的 `text`，不从 DOM 或预览重新取值。管理按钮在任务 4 接入，此任务不添加占位按钮或尚不存在的面板导入。
- [ ] **Step 4：实现请求和生命周期校验。** serializer 捕获所绑定的原节点、所属图、`api.user`、提示词 ID 和选择代次，返回后核对；参数可能是 DTO，不拿它代替绑定节点。预览与执行请求独立；重新配置后重装绑定，切换图或用户丢弃旧结果；焦点恢复、库保存与工作流加载刷新，不轮询。无效状态抛出，阻止此次提交。
- [ ] **Step 5：重跑两个 JS 文件，退出码 0；检查图序列化只保存稳定引用，执行图包含实际正文。** 记录保存工作流与导出执行 API 的差别。
- [ ] **Step 6：检查并提交本任务差异。** `feat(提示词库): 实现分类选择与执行快照`。

### 任务 4：官方风格管理面板

**Files:** 创建 `web/prompt_library_manager.js`、`web/prompt_library.css`、`tests/js/prompt_library_manager.test.mjs`；接入 `web/prompt_library.js` 的管理按钮。

**Interfaces:** 消费客户端 `readLibrary/mutateLibrary`；产出 `openPromptLibraryManager({categoryId, promptId, onSaved}) -> Promise<void>`，保存成功调用 `onSaved(library)`；入口用任务 3 的 `refreshPromptLibraryNodes` 刷新节点。

- [ ] **Step 1：编写失败测试。** 覆盖分类/提示词 CRUD、移动、六种 action、revision 传递、打开时定位、删除确认、只删空分类、无全局样式、纯文本显示和重复打开时的监听清理。

```javascript
test('cancel preserves dirty edit and dialog stays open', async () => {
  assert.equal(dialogClosed, false);
  assert.equal(editor.value, unsavedText);
});
test('conflict keeps input and does not retry over newer data', async () => {
  assert.equal(editor.value, unsavedText);
  assert.equal(mutateCalls, 1);
  assert.equal(errorStatus, 409);
});
test('html-looking prompt is rendered as text', () => {
  assert.equal(preview.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(preview.querySelector('img'), null);
});
```

- [ ] **Step 2：运行 `node --experimental-vm-modules --test tests/js/prompt_library_manager.test.mjs`，确认失败。**
- [ ] **Step 3：实现管理窗口并接入原生按钮。** 使用当前导出的 `ComfyDialog`，传 DOM 内容而非 HTML 字符串；分类列表、提示词列表和标题/正文编辑区使用原生元素。按钮设置两个 serialize 开关为 false，不进入工作流值或执行输入。CSS 只作用于 `.enhance-kit-prompt-library` 及其后代，颜色、字体和控件状态使用 ComfyUI 主题变量。
- [ ] **Step 4：实现未保存及失败流程。** 保存/放弃/取消覆盖关闭与切换；409 显示刷新入口并保留编辑内容，不自动覆盖或循环重试；写入故障同样保留输入。保存中禁用重复操作并等待结果后处理关闭，避免将取消请求误认为取消写入；其他关闭路径清理事件与读取请求，异步返回后核对用户和窗口仍有效。
- [ ] **Step 5：重跑管理面板及任务 3 的受影响 JS 检查，要求退出码 0。**
- [ ] **Step 6：检查并提交本任务差异。** `feat(提示词库): 添加原生风格管理面板`。

### 任务 5：实际运行、视觉验收与独立审查

**Files:** 修改 `README.md`、`docs/usage.md` 和本计划的状态；必要修复只触及本功能相关代码。验证配置、截图与辅助脚本保存在获准的 `.codex/tmp/prompt-library/`。

**Interfaces:** 消费任务 1–4 的稳定交付；产出对应提交状态的测试证据、用户说明和独立审查结论。

- [ ] **Step 1：执行范围匹配的完整检查。** Python：`python -B -m unittest discover -s tests -p 'test_*.py' -v`。JavaScript：以 `--experimental-vm-modules --test` 显式运行资源条原测试及三份新测试。要求退出码 0；`git diff --check` 通过。
- [ ] **Step 2：启动隔离 ComfyUI 服务。** 核对空闲端口和已有服务 PID，保留用户进程；使用 `--cpu --disable-auto-launch --base-directory` 指向临时 runtime 目录，额外配置只加载开发仓库，配合 `--disable-all-custom-nodes --whitelist-custom-nodes ComfyUI-Enhance-Kit`。用户、输出、输入、temp 均在隔离目录中，不加载安装副本或其他节点。用户目录需要预先存在时先按已获准路径创建。
- [ ] **Step 3：验证 HTTP 与实际队列。** 使用隔离数据完成 CRUD、并发冲突、删除和 resolve；创建「提示词库 → 官方 PreviewAny」最小工作流，不加载模型。修改库后提交应输出新正文；延迟解析时不得提前入队；排队后再修改库，已提交任务仍输出原快照。未知/另一用户的请求不能获得该库；多用户验收通过同一隔离服务的 `--multi-user` 配置和测试用户进行。
- [ ] **Step 4：浏览器视觉及交互验收。** 仅用 localhost HTTP。与官方多行文本节点并排检查 Nodes 2.0/传统渲染、深浅主题、节点缩放、窄窗口、长标题和长正文；确认选中复制、按钮、焦点、滚动和插槽不受遮挡。实际检查复制、撤销恢复、子图及批量队列的 serializer，验证断网、晚返回、改选和图切换；保存/重载工作流仍保留引用。浏览器临时主题设置只改变隔离用户。
- [ ] **Step 5：补齐面向用户的说明。** README 增加功能与最短使用步骤，usage 写分类规则、保存位置、删除与冲突处理、每次提交的快照语义、跨机器需要另行复制库，以及 API 客户端先 resolve 再提交；兼容范围只写实际验收结果。
- [ ] **Step 6：独立只读审查。** Reviewer 读取规格、计划、最终 diff 和必要验证证据，重点检查用户文件边界、revision/原子写、异步序列化、快照、生命周期和样式范围。当前正式子代理工具支持显式模型/档位和只读任务说明；实施启动时复核策略与权限。修复后只重跑受影响检查，并交原 Reviewer 增量复审。
- [ ] **Step 7：核对完成门禁并收尾。** 所有规格验收条目有证据、相关检查通过、独立审查通过；停止本任务创建的服务，保留证据及用户文件。文档单独提交 `docs(提示词库): 完善使用与验收说明`，提交前确认不含 `.codex/`、`.idea/`。报告代码分支与提交，不在无新授权时合并、推送或更新安装副本。

## 实施前交接与停止条件

推荐由主代理在本会话顺序实施任务 1–4，再安排独立 Reviewer：接口与前端状态紧密衔接，顺序集成可减少交接开销，仍保留高风险门禁。也可由用户选择子代理实施，但需要先确认合规基准、职责和写入边界；同一工作副本的文件与 Git 索引只允许一个写入主体。

开始实施前需用户审阅本计划并选择执行方式。正式产品代码、依赖安装、服务启动与测试数据写入不在本次编写计划阶段执行。

如官方序列化或原生弹窗的实际行为与已核实源码不符、必要独立审查不可用、临时路径审批被拒，或必须新增框架/修改核心才能继续，停止受影响步骤并说明具体证据，不扩大授权、绕过权限或降低完成门禁。
