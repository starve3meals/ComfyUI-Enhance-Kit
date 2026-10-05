import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const prefix = "EnhanceKit.Resources.";
const metrics = [
    { key: "cpu", setting: "ShowCPU", label: "CPU", name: "CPU 利用率" },
    { key: "memory", setting: "ShowMemory", label: "RAM", name: "内存占用" },
    { key: "gpu", setting: "ShowGPU", label: "GPU", name: "GPU 利用率" },
    { key: "vram", setting: "ShowVRAM", label: "VRAM", name: "显存占用" },
    { key: "temperature", setting: "ShowTemperature", label: "GPU温度", name: "GPU 温度" },
];
const legacySelector = '[data-testid="legacy-topbar-container"]';
const unavailable = "不可用";
const automaticGPU = { value: -1, text: "自动（首张可用 GPU）" };
let bar;
let fields;
let currentSnapshot = null;
let lastSampledAt = null;
let receivedAt = 0;
let gpuDevices = [];
let firstSnapshot = true;
let samplingCPU = false;
let running = false;
let intervalMs = 1000;
let generation = 0;
let request = null;
let refreshTimer;
let expiryTimer;
let mountObserver;
let visibilityObserver;
let observedRoot;
let observedAncestors = [];

function setting(name) {
    return app.extensionManager.setting.get(prefix + name);
}

function percent(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)}%` : unavailable;
}

function capacity(memory) {
    const amount = Number.isFinite(memory?.used_bytes) && Number.isFinite(memory?.total_bytes)
        ? `${(memory.used_bytes / 1024 ** 3).toFixed(1)}/${(memory.total_bytes / 1024 ** 3).toFixed(1)} GiB`
        : unavailable;
    return `${percent(memory?.utilization_percent)} ${amount}`;
}

function fresh(snapshot) {
    return Number.isFinite(snapshot?.sampled_at_ms)
        && performance.now() - receivedAt <= Math.max(3000, intervalMs * 3);
}

function render() {
    const snapshot = fresh(currentSnapshot) ? currentSnapshot : null;
    const selected = Number(setting("GPU"));
    const gpu = selected === -1
        ? snapshot?.gpus?.find((item) => [item.utilization_percent, item.temperature_c, item.memory?.used_bytes, item.memory?.total_bytes, item.memory?.utilization_percent].some(Number.isFinite))
        : snapshot?.gpus?.find((item) => item.index === selected);
    const values = {
        cpu: snapshot ? (samplingCPU && snapshot.cpu?.utilization_percent === null ? "采样中" : percent(snapshot.cpu?.utilization_percent)) : unavailable,
        memory: percent(snapshot?.memory?.utilization_percent),
        gpu: percent(gpu?.utilization_percent),
        temperature: Number.isFinite(gpu?.temperature_c) ? `${gpu.temperature_c.toFixed(0)}°C` : unavailable,
        vram: percent(gpu?.memory?.utilization_percent),
    };
    const details = {
        memory: snapshot ? capacity(snapshot.memory) : unavailable,
        vram: gpu ? capacity(gpu.memory) : unavailable,
    };
    const levels = {
        cpu: snapshot?.cpu?.utilization_percent,
        memory: snapshot?.memory?.utilization_percent,
        gpu: gpu?.utilization_percent,
        vram: gpu?.memory?.utilization_percent,
        temperature: gpu?.temperature_c,
    };
    for (const metric of metrics) {
        const field = fields[metric.key];
        const value = values[metric.key];
        if (field.value.textContent !== value) field.value.textContent = value;
        const level = levels[metric.key];
        const width = Number.isFinite(level) ? Math.min(100, Math.max(0, level)) : 0;
        field.fill.style.width = `${width}%`;
        field.element.dataset.available = String(Number.isFinite(level));
        // 温度沿用参考样式的 0–100°C 色阶；读数本身不裁剪。
        if (metric.key === "temperature") field.fill.style.backgroundColor = `color-mix(in srgb, #ff0000 ${width}%, #00ff00)`;
        const device = ["gpu", "temperature", "vram"].includes(metric.key) && gpu ? `${gpu.name} · ` : "";
        field.element.title = `${device}${metric.name}: ${details[metric.key] ?? value}`;
    }
}

function visible() {
    if (document.hidden || bar.hidden || !bar.isConnected || bar.getClientRects().length === 0) return false;
    for (let element = bar.parentElement; element; element = element.parentElement) {
        if (element.hidden || element.inert || element.getAttribute("aria-hidden") === "true") return false;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    }
    return true;
}

function stop() {
    running = false;
    generation++;
    clearTimeout(refreshTimer);
    clearTimeout(expiryTimer);
    if (request) {
        clearTimeout(request.timeout);
        request.controller.abort();
        request = null;
    }
    currentSnapshot = null;
    render();
}

/** 获取同源资源快照；取消、超时或设置代次变化后，响应不能重新激活刷新。 */
async function refresh() {
    if (!running || request) return;
    const state = { controller: new AbortController(), generation, timeout: null };
    request = state;
    try {
        const snapshot = await Promise.race([
            (async () => {
                const response = await api.fetchApi("/enhance-kit/resources", { signal: state.controller.signal, cache: "no-store" });
                if (!response.ok) throw new Error("资源接口不可用");
                return await response.json();
            })(),
            new Promise((_, reject) => {
                state.timeout = setTimeout(() => {
                    state.controller.abort();
                    reject(new Error("资源接口超时"));
                }, 5000);
            }),
        ]);
        if (!running || state.generation !== generation) return;
        // 服务端时间只标识样本变化；有效期使用本机单调时钟，避免双端偏差和系统校时。
        if (Number.isFinite(snapshot?.sampled_at_ms) && snapshot.sampled_at_ms !== lastSampledAt) {
            lastSampledAt = snapshot.sampled_at_ms;
            receivedAt = performance.now();
        }
        currentSnapshot = fresh(snapshot) ? snapshot : null;
        if (currentSnapshot) {
            const devices = Array.isArray(snapshot.gpus) ? snapshot.gpus : [];
            if (devices.length !== gpuDevices.length || devices.some((gpu, index) => gpu.index !== gpuDevices[index].index || gpu.name !== gpuDevices[index].name)) {
                gpuDevices = devices.map(({ index, name }) => ({ index, name }));
                // 替换官方响应式定义，已打开的设置面板才能收到枚举变化；不改用户选择。
                app.extensionManager.setting.settings[prefix + "GPU"].options = [
                    automaticGPU,
                    ...gpuDevices.map((gpu) => ({ value: gpu.index, text: `GPU ${gpu.index}: ${gpu.name}` })),
                ];
            }
            samplingCPU = firstSnapshot && snapshot.cpu?.utilization_percent === null;
            firstSnapshot = false;
        }
        render();
        clearTimeout(expiryTimer);
        if (currentSnapshot) {
            const expiresIn = Math.max(3000, intervalMs * 3) - (performance.now() - receivedAt);
            expiryTimer = setTimeout(() => {
                currentSnapshot = null;
                render();
            }, expiresIn + 1);
        }
    } catch {
        if (!running || state.generation !== generation) return;
        currentSnapshot = null;
        clearTimeout(expiryTimer);
        render();
    } finally {
        clearTimeout(state.timeout);
        if (request === state) {
            request = null;
            if (running && state.generation === generation) refreshTimer = setTimeout(refresh, intervalMs);
        }
    }
}

function updateState() {
    if (!bar) return;
    const seconds = Number(setting("Interval"));
    const nextInterval = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000;
    let anyShown = false;
    for (const metric of metrics) {
        const shown = setting(metric.setting) !== false;
        fields[metric.key].element.hidden = !shown;
        anyShown ||= shown;
    }
    bar.hidden = nextInterval === 0 || !anyShown;
    const shouldRun = visible();
    if (running && (!shouldRun || nextInterval !== intervalMs)) stop();
    intervalMs = nextInterval;
    render();
    if (shouldRun && !running) {
        running = true;
        void refresh();
    }
}

/** 跟踪菜单所在的实际祖先；样式或挂载变化会暂停、恢复采样，不依赖页面轮询。 */
function observeVisibility() {
    const ancestors = [];
    for (let element = bar.parentElement; element; element = element.parentElement) ancestors.push(element);
    if (ancestors.length === observedAncestors.length && ancestors.every((element, index) => element === observedAncestors[index])) return;
    observedAncestors = ancestors;
    visibilityObserver.disconnect();
    for (const element of ancestors) {
        visibilityObserver.observe(element, { attributes: true, attributeFilter: ["class", "style", "hidden", "inert", "aria-hidden"] });
    }
}

function mount() {
    const menu = app.menu.element;
    if (!menu.isConnected) {
        const container = document.querySelector(legacySelector);
        // Focus Mode 会重建 legacy 容器，而上游 onMounted 不会再次挂回保留的菜单对象。
        if (container) container.appendChild(menu);
    }
    const anchor = app.menu.settingsGroup.element;
    if (anchor.parentElement && (bar.parentElement !== anchor.parentElement || bar.nextElementSibling !== anchor)) anchor.before(bar);
    const root = document.querySelector(".comfyui-body-top") ?? document.body;
    if (root !== observedRoot) {
        observedRoot = root;
        mountObserver.disconnect();
        mountObserver.observe(root, { childList: true, subtree: true });
    }
    observeVisibility();
    updateState();
}

function setup() {
    if (bar) {
        mount();
        return;
    }
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("./resource_monitor.css", import.meta.url).href;
    document.head.appendChild(stylesheet);
    bar = document.createElement("div");
    bar.className = "enhance-kit-resources";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "本机资源监控");
    fields = {};
    for (const metric of metrics) {
        const element = document.createElement("div");
        element.className = "enhance-kit-resource";
        element.dataset.metric = metric.key;
        const fill = document.createElement("span");
        fill.className = "enhance-kit-resource-fill";
        fill.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.className = "enhance-kit-resource-label";
        label.textContent = metric.label;
        const value = document.createElement("span");
        value.className = "enhance-kit-resource-value";
        value.textContent = unavailable;
        element.append(fill, label, value);
        bar.appendChild(element);
        fields[metric.key] = { element, value, fill };
    }
    visibilityObserver = new MutationObserver(updateState);
    mountObserver = new MutationObserver((records) => {
        const menu = app.menu.element;
        const relevant = records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) =>
            node.nodeType === 1 && (node.contains(menu) || node.matches(legacySelector) || node.querySelector(legacySelector))));
        if (relevant) mount();
    });
    document.addEventListener("visibilitychange", updateState);
    window.addEventListener("resize", updateState);
    // CSS 显隐和折叠过渡会改变布局；恢复时立即采样，不按刷新周期探测菜单。
    const layoutObserver = new ResizeObserver(updateState);
    layoutObserver.observe(bar);
    mount();
}

app.registerExtension({
    name: "EnhanceKit.ResourceMonitor",
    settings: [
        ...metrics.map((metric) => ({
            id: prefix + metric.setting,
            name: `显示${metric.name}`,
            type: "boolean",
            defaultValue: true,
            onChange: updateState,
        })),
        {
            id: prefix + "Interval",
            name: "刷新间隔（秒，0 关闭）",
            type: "number",
            defaultValue: 1,
            attrs: { min: 0, step: 1 },
            onChange: updateState,
        },
        {
            id: prefix + "GPU",
            name: "监控 GPU",
            type: "combo",
            defaultValue: -1,
            options: [automaticGPU],
            onChange: updateState,
        },
    ],
    setup,
});