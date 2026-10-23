import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { LinkFlowState, captureGraphIdentity, graphIdentityMatches } from "./execution_link_flow_state.js";

const settingId = "EnhanceKit.ExecutionLinkFlow.Enabled";
const eventName = "enhance-kit.inputs-delivered";
// 1.55.18 实际分发构建的活跃入口文本；版本号不能代替活跃方法校验，包装或其他构建均保守停用。
const nativeRenderLink = 'renderLink(e,t,n,r,i,a,o,s,c,{startControl:l,endControl:u,reroute:d,num_sublines:f=1,disabled:p=!1}={}){if(this.linkRenderer){let m=this.buildLinkRenderContext();this.linkRenderer.renderLinkDirect(e,t,n,r,i,a,o,s,c,m,{reroute:d,startControl:l,endControl:u,num_sublines:f,disabled:p})}}';
const state = new LinkFlowState();
const acknowledged = new Map();
const queueCalls = [];
const cleanups = [];
const notices = new Set();
// 两种画布分别通过相同宿主绘制入口接入；支持范围由本版本的实际画布验收限定。
const supportedModes = new Set(["legacy", "vue"]);
let exports = new WeakMap();
let initialized = false;
let closed = false;
let available = false;
let connected = true;
let generation = 0;
let availabilityGeneration = 0;
let frame = null;
let painted = false;
let motion;
let canvas;
let graph;
let mode;
let renderSupported = false;
let renderWrapper;
let drawPass = null;
let graphCleanup = [];
let queueCheck = null;
let queueChanged = false;

function setting(id) { return app.extensionManager.setting.get(id); }
function chinese() { return String(setting("Comfy.Locale") ?? document.documentElement?.lang ?? "en").startsWith("zh"); }
function renderMode() {
    const enabled = globalThis.LiteGraph?.vueNodesMode;
    return enabled === true ? "vue" : enabled === false ? "legacy" : "unknown";
}
function now() { return performance.now(); }

function notice(reason) {
    if (notices.has(reason)) return;
    notices.add(reason);
    const reasons = {
        unsupported_python: ["当前 Python 运行环境尚未验证。", "This Python runtime has not been verified."],
        unsupported_core: ["当前 ComfyUI 执行器尚未验证。", "This ComfyUI core execution path has not been verified."],
        monitor_unavailable: ["本地执行监测不可用。", "Local execution monitoring is unavailable."],
        adapter_conflict: ["执行接口已被其他扩展改写。", "Another extension has changed the execution interfaces."],
        monitor_failure: ["执行监测发生故障，已停止动画。", "Execution monitoring failed; animation has stopped."],
        closed: ["执行监测已关闭。", "Execution monitoring is closed."],
        unsupported_canvas: ["当前画布绘制入口尚未验证。", "This canvas rendering path has not been verified."],
        unsupported_frontend: ["当前前端构建尚未验证，仅支持已验收的 1.55.18 构建。", "This frontend build has not been verified; use the tested 1.55.18 build."],
        status_unavailable: ["无法读取本地功能状态，请重新加载页面。", "Cannot read local availability; reload the page."],
        observer_failure: ["前端观测已停止，请重新加载页面。", "Frontend observation has stopped; reload the page."],
    };
    app.extensionManager.toast?.add({ severity: "warn", summary: chinese() ? "执行连线动画不可用" : "Execution link animation unavailable",
        detail: (reasons[reason] ?? reasons.unsupported_canvas)[chinese() ? 0 : 1], life: 5000 });
}

function listen(target, type, listener) {
    const handler = (event) => observe(() => listener(event));
    target.addEventListener(type, handler);
    const cleanup = () => target.removeEventListener(type, handler);
    cleanups.push(cleanup);
    return cleanup;
}

function stopFrames() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    const redraw = painted;
    painted = false;
    if (redraw) canvas.setDirty(true, true);
}

function clearAssociations() {
    generation++;
    state.clear();
    acknowledged.clear();
    exports = new WeakMap();
    queueChanged = false;
    stopFrames();
}

function watchGraph() {
    graphCleanup.forEach((cleanup) => cleanup());
    graphCleanup = [];
    if (!graph?.events?.addEventListener) return;
    for (const type of ["node:before-removed", "configuring"]) {
        const handler = () => observe(clearAssociations);
        graph.events.addEventListener(type, handler);
        graphCleanup.push(() => graph.events.removeEventListener(type, handler));
    }
}

function syncContext() {
    const nextGraph = app.rootGraph, nextMode = renderMode();
    if (graph !== nextGraph || mode !== nextMode) {
        clearAssociations();
        graph = nextGraph;
        mode = nextMode;
        watchGraph();
    }
}

function capable() {
    syncContext();
    return !closed && available && connected && setting(settingId) === true && app.canvas === canvas
        && renderSupported && canvas.renderLink === renderWrapper && canvas.graph === graph && !!canvas.linkRenderer
        && supportedModes.has(mode) && !!graph?.events?.addEventListener;
}

function visible() { return !document.hidden && !motion.matches; }

function tick() {
    frame = null;
    if (!capable() || !visible()) { state.dropPulses(); stopFrames(); return; }
    if (!state.activeLinks(graph, now()).length) { stopFrames(); return; }
    canvas.setDirty(true, true);
    frame = requestAnimationFrame(frameTick);
}

function frameTick() { observe(tick); }

function schedule() {
    if (!capable() || !visible() || !state.activeLinks(graph, now()).length) { stopFrames(); return; }
    if (frame === null) frame = requestAnimationFrame(frameTick);
}

function failObservation() {
    available = false;
    clearAssociations();
    notice("observer_failure");
}

function observe(action) {
    try { return action(); }
    catch {
        try { failObservation(); } catch { /* 通知/重绘也属于观测边界，不能中断原生提交。 */ }
    }
}

async function checkAvailability() {
    const check = ++availabilityGeneration;
    available = false;
    if (!initialized || closed || setting(settingId) !== true) return;
    try {
        const response = await api.fetchApi("/enhance-kit/link-flow/status", { cache: "no-store" });
        const status = response.ok ? await response.json() : null;
        if (closed || check !== availabilityGeneration || setting(settingId) !== true) return;
        available = status?.schema === 1 && status.available === true && status.reason_code === null;
        if (!available || !renderSupported || !supportedModes.has(renderMode()) || !canvas.linkRenderer) {
            notice(status?.reason_code ?? "unsupported_canvas");
            await app.extensionManager.setting.set(settingId, false);
        }
    } catch {
        if (closed || check !== availabilityGeneration) return;
        available = false;
        notice("status_unavailable");
        try { await app.extensionManager.setting.set(settingId, false); } catch { /* 只影响设置显示，仍保持关闭。 */ }
    }
}

function preferenceChanged() {
    if (!initialized) return;
    observe(clearAssociations);
    void checkAvailability();
}

function wrap(object, key, create) {
    const original = object[key];
    const wrapped = create(original);
    object[key] = wrapped;
    cleanups.push(() => { if (object[key] === wrapped) object[key] = original; });
}

function promptBody(route, options) {
    // fetchApi 本身负责 base URL、鉴权和超时；仅处理原生相对入口，不匹配其他地址或请求形状。
    if (route !== "/prompt" || options?.method !== "POST" || typeof options.body !== "string"
        || options.headers?.["Content-Type"] !== "application/json") return null;
    let body;
    try { body = JSON.parse(options.body); } catch { return null; }
    if (!body || typeof body !== "object" || !body.extra_data || typeof body.extra_data !== "object"
        || body.extra_data.enhance_kit_link_flow !== undefined || body.client_id !== api.clientId || !body.client_id) return null;
    return body;
}

function prepareRequest(route, options) {
    if (!capable() || !visible() || queueCalls.length !== 1) return null;
    const context = queueCalls[0], body = promptBody(route, options);
    if (!context || context.used || !body || !graphIdentityMatches(context.snapshot, graph)
        || JSON.stringify(body.prompt) !== context.prompt || JSON.stringify(body.extra_data.extra_pnginfo?.workflow) !== context.workflow) return null;
    const token = crypto.randomUUID();
    if (!state.prepare(graph, body.prompt, token)) return null;
    context.used = true;
    context.token = token;
    body.extra_data.enhance_kit_link_flow = { schema: 1, enabled: true, run_token: token };
    return { token, generation, options: { ...options, body: JSON.stringify(body) } };
}

function discard(token) {
    state.discard(token);
    acknowledged.delete(token);
    schedule();
}

function monitorResponse(response, submission) {
    try {
        if (!response.ok) { discard(submission.token); return; }
        // 不消费宿主响应。clone/JSON/关联失败都只关闭本次观测，原 fetch 不重试。
        void response.clone().json().then((body) => observe(() => {
            if (submission.generation !== generation || closed) return;
            if (state.acknowledge(submission.token, body?.prompt_id)) {
                acknowledged.set(submission.token, body.prompt_id);
                if (queueChanged) void checkQueue();
            }
            else acknowledged.delete(submission.token);
            schedule();
        })).catch(() => { if (submission.generation === generation) observe(() => discard(submission.token)); });
    } catch { discard(submission.token); }
}

function terminal(event, outcome) {
    const promptId = event.detail?.prompt_id;
    if (typeof promptId !== "string") return;
    state.finish(promptId, outcome, now());
    for (const [token, prompt] of acknowledged) if (prompt === promptId) acknowledged.delete(token);
    schedule();
}

async function checkQueue() {
    if (queueCheck || closed || !connected || !acknowledged.size) return;
    const check = { generation, prompts: new Map(acknowledged) };
    queueCheck = check;
    queueChanged = false;
    try {
        const response = await api.fetchApi("/queue", { cache: "no-store" });
        if (!response.ok) return;
        const queue = await response.json();
        if (closed || check.generation !== generation || !Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) return;
        const entries = [...queue.queue_running, ...queue.queue_pending];
        if (!entries.every((entry) => Array.isArray(entry) && typeof entry[1] === "string")) return;
        const ids = new Set(entries.map((entry) => entry[1]));
        for (const [token, promptId] of check.prompts) {
            if (acknowledged.get(token) !== promptId || ids.has(promptId)) continue;
            state.finish(promptId, "cancelled", now());
            acknowledged.delete(token);
        }
        schedule();
    } catch { /* 队列状态未知时不把等待任务猜成删除。 */ }
    finally {
        if (queueCheck === check) queueCheck = null;
        if (queueChanged && check.generation === generation) void checkQueue();
    }
}

function disconnect() { connected = false; available = false; clearAssociations(); }

function teardown() {
    if (closed) return;
    clearAssociations();
    closed = true;
    availabilityGeneration++;
    graphCleanup.forEach((cleanup) => cleanup());
    graphCleanup = [];
    cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
}

function setup() {
    if (initialized) return;
    initialized = true;
    canvas = app.canvas;
    graph = app.rootGraph;
    mode = renderMode();
    renderSupported = Function.prototype.toString.call(canvas.renderLink) === nativeRenderLink;
    motion = matchMedia("(prefers-reduced-motion: reduce)");
    watchGraph();

    wrap(app, "graphToPrompt", (original) => async function (...args) {
        const root = args[0] ?? this.rootGraph;
        const snapshot = observe(() => capable() && visible() && root === graph ? captureGraphIdentity(root) : null);
        const result = await original.apply(this, args);
        observe(() => {
            if (snapshot && capable() && graphIdentityMatches(snapshot, app.rootGraph) && result.workflow?.extra?.frontendVersion === "1.55.18") {
                exports.set(result, { snapshot, prompt: JSON.stringify(result.output), workflow: JSON.stringify(result.workflow), generation });
            } else if (snapshot && result.workflow?.extra?.frontendVersion !== "1.55.18") {
                available = false;
                clearAssociations();
                void Promise.resolve(app.extensionManager.setting.set(settingId, false)).catch(() => {});
                notice("unsupported_frontend");
            }
        });
        return result;
    });

    wrap(api, "queuePrompt", (original) => function (...args) {
        const saved = observe(() => capable() ? exports.get(args[1]) : null);
        const context = saved?.generation === generation ? { ...saved, used: false, token: null } : null;
        // 只认当前同步原生调用栈内的唯一候选。第三方延迟/重写链路不靠“最后一次提交”猜测。
        queueCalls.push(context);
        try {
            const result = original.apply(this, args);
            if (context) void Promise.resolve(result).catch(() => observe(() => discard(context.token)));
            return result;
        } catch (error) {
            if (context) observe(() => discard(context.token));
            throw error;
        } finally { queueCalls.pop(); }
    });

    wrap(api, "fetchApi", (original) => function (route, options, ...rest) {
        const submission = observe(() => prepareRequest(route, options));
        let result;
        try { result = original.call(this, route, submission?.options ?? options, ...rest); }
        catch (error) { if (submission) observe(() => discard(submission.token)); throw error; }
        if (submission) {
            try { void result.then((response) => observe(() => monitorResponse(response, submission)), () => observe(() => discard(submission.token))); }
            catch { observe(() => discard(submission.token)); }
        }
        return result;
    });

    wrap(canvas, "drawConnections", (original) => function (...args) {
        const previous = drawPass;
        // 原生同一绘制调用同步遍历全部连线；每次画布重绘只扫描一次活动边，避免平方级校验。
        drawPass = observe(() => capable() && visible() && this.graph === graph
            ? { graph, version: graph._version, links: new Set(state.activeLinks(graph, now()).map((pulse) => pulse.linkId)) } : null);
        try { return original.apply(this, args); }
        finally { drawPass = previous; }
    });

    wrap(canvas, "renderLink", (original) => function (...args) {
        const active = observe(() => {
            if (!capable() || !visible() || this.graph !== graph) return false;
            if (drawPass) return drawPass.graph === graph && drawPass.version === graph._version
                && graph.getLink(args[3]?.id) === args[3] && drawPass.links.has(args[3]?.id);
            return state.activeLinks(graph, now()).some((pulse) => pulse.linkId === args[3]?.id);
        });
        if (active && !args[5]) { args[5] = 0.35; painted = true; }
        return original.apply(this, args);
    });
    renderWrapper = canvas.renderLink;

    listen(api, eventName, (event) => observe(() => {
        if (!capable()) return;
        const accepted = state.accept(event.detail, graph, now());
        if (!visible()) { state.dropPulses(); return; }
        if (accepted) schedule();
    }));
    for (const [type, outcome] of [["execution_success", "success"], ["execution_error", "error"], ["execution_interrupted", "interrupted"]])
        listen(api, type, (event) => observe(() => terminal(event, outcome)));
    listen(api, "status", (event) => {
        if (event.detail === null) disconnect();
        else { queueChanged = true; void checkQueue(); }
    });
    listen(api, "reconnecting", disconnect);
    listen(api, "reconnected", () => { clearAssociations(); connected = true; void checkAvailability(); });
    listen(api, "graphCleared", clearAssociations);
    listen(document, "visibilitychange", () => { if (document.hidden) { state.dropPulses(); stopFrames(); } });
    listen(motion, "change", () => { clearAssociations(); });
    listen(app.ui.settings, "Comfy.VueNodes.Enabled.change", clearAssociations);
    listen(window, "pagehide", teardown);
    return checkAvailability();
}

app.registerExtension({
    name: "EnhanceKit.ExecutionLinkFlow",
    settings: [{ id: settingId, name: "执行连线动画 / Execution link animation", type: "boolean", defaultValue: false,
        tooltip: "仅在确认输入已交付时显示。 / Animate only confirmed input deliveries.", onChange: preferenceChanged }],
    setup,
    beforeConfigureGraph() { observe(clearAssociations); },
});
