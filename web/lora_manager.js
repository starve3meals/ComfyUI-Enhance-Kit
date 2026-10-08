import { app } from "../../scripts/app.js";

const states = new WeakMap();
const active = new Set();
let files = [];

function parseConfig(raw) {
    const config = JSON.parse(raw);
    if (!config || typeof config !== "object" || config.schema_version !== 1 || !Array.isArray(config.items)) {
        throw new Error("配置版本必须为 1，items 必须为数组。");
    }
    for (const item of config.items) {
        if (!item || typeof item !== "object" || typeof item.name !== "string" || typeof item.enabled !== "boolean"
            || typeof item.strength !== "number" || !Number.isFinite(item.strength)) {
            throw new Error("每项必须包含文件名、启用开关和有限数值强度。");
        }
    }
    return config.items.map(({ name, enabled, strength }) => ({ name, enabled, strength }));
}

function element(tag, className, action) {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (action) value.dataset.action = action;
    return value;
}

function button(action, text, title) {
    const value = element("button", "", action);
    value.type = "button";
    value.textContent = text;
    value.title = title;
    value.setAttribute("aria-label", title);
    return value;
}

function height(state) {
    return state.error ? 220 : Math.min(420, 84 + Math.max(state.items.length, 1) * 42);
}

function resize(state) {
    const node = state.node;
    const widgetHeight = `${height(state)}px`;
    state.root.style.height = widgetHeight;
    state.root.style.maxHeight = widgetHeight;
    state.root.style.minHeight = "0px";
    node.setSize([Math.max(node.size[0], 420), node.computeSize()[1]]);
    node.setDirtyCanvas(true, true);
}

function attachElement(state) {
    const { node, root } = state;
    if (!node.graph || node.id === -1) return;
    const graphId = String(node.graph.id);
    const nodeId = String(node.id);
    root.dataset.graphId = graphId;
    root.dataset.nodeId = nodeId;
    // Nodes 2.0 撤销时复用 host，但只在 mounted 挂载元素；替换同一所属位置的旧元素。
    for (const previous of document.querySelectorAll(".enhance-kit-lora-manager")) {
        if (previous !== root && previous.dataset.graphId === graphId && previous.dataset.nodeId === nodeId) {
            previous.replaceWith(root);
            break;
        }
    }
}

function removeLoraSocket(node) {
    // 官方 STRING factory 未传递 socketless，创建和配置恢复后需移除它生成的同名插槽。
    const index = node.inputs.findIndex(input => input.name === "loras" && input.type === "STRING" && input.widget?.name === "loras");
    if (index !== -1) node.removeInput(index);
}

function status(state) {
    state.add.disabled = Boolean(state.error);
    state.repair.hidden = !state.error;
    state.status.dataset.error = String(Boolean(state.error));
    if (state.error) {
        state.status.textContent = `LoRA 配置无效：${state.error} 原文已保留，可修正后应用。`;
    } else if (!files.length) {
        state.status.textContent = "暂无 LoRA 文件；放入 LoRA 目录后刷新节点定义。";
    } else {
        const missing = state.items.filter(item => item.name && !files.includes(item.name)).length;
        state.status.textContent = missing ? `${missing} 个文件不可用；已保留原选择，请重新选择或停用。` : "";
    }
    state.status.hidden = !state.status.textContent;
}

function selectOptions(row, item) {
    const options = [];
    const empty = element("option");
    empty.value = "";
    empty.textContent = files.length ? "请选择 LoRA" : "暂无 LoRA 文件";
    options.push(empty);
    if (item.name && !files.includes(item.name)) {
        const missing = element("option");
        missing.value = item.name;
        missing.textContent = `文件不可用：${item.name}`;
        options.push(missing);
    }
    for (const name of files) {
        const option = element("option");
        option.value = name;
        option.textContent = name;
        options.push(option);
    }
    row.select.replaceChildren(...options);
    row.select.value = item.name;
    row.select.title = item.name || "请选择 LoRA 文件";
    row.element.dataset.missing = String(Boolean(item.name && !files.includes(item.name)));
}

function change(state, mutate, rebuild = false) {
    if (!active.has(state) || state.error) return;
    const graph = state.node.graph;
    graph?.canvasAction(canvas => canvas.emitBeforeChange());
    mutate();
    state.raw = JSON.stringify({ schema_version: 1, items: state.items });
    if (rebuild) render(state);
    else status(state);
    state.node.setDirtyCanvas(true, true);
    graph?.canvasAction(canvas => canvas.emitAfterChange());
}

function move(state, from, to) {
    if (from === to || from < 0 || to < 0 || from >= state.items.length || to >= state.items.length) return;
    change(state, () => {
        const [item] = state.items.splice(from, 1);
        state.items.splice(to, 0, item);
        state.dragIndex = null;
    }, true);
}

function createRow(state, item, index) {
    const root = element("div", "enhance-kit-lora-row");
    const drag = button("drag", "⠿", `拖拽排序第 ${index + 1} 项 LoRA`);
    drag.className = "enhance-kit-lora-drag";
    drag.draggable = true;
    drag.addEventListener("dragstart", (event) => {
        event.stopPropagation();
        if (!active.has(state)) { event.preventDefault(); return; }
        state.dragIndex = index;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", "EnhanceKit LoRA");
    });
    drag.addEventListener("dragend", () => { state.dragIndex = null; });
    const enabled = element("input", "", "enabled");
    enabled.type = "checkbox";
    enabled.checked = item.enabled;
    enabled.title = "启用 LoRA";
    enabled.setAttribute("aria-label", `启用第 ${index + 1} 项 LoRA`);
    enabled.addEventListener("change", () => change(state, () => { item.enabled = enabled.checked; }));
    const select = element("select", "", "name");
    select.setAttribute("aria-label", `第 ${index + 1} 项 LoRA 文件`);
    const row = { element: root, select };
    selectOptions(row, item);
    select.addEventListener("change", () => change(state, () => {
        item.name = select.value;
        select.title = item.name || "请选择 LoRA 文件";
        root.dataset.missing = String(Boolean(item.name && !files.includes(item.name)));
    }));
    const strength = element("input", "", "strength");
    strength.type = "number";
    strength.min = "-100";
    strength.max = "100";
    strength.step = "0.01";
    strength.value = String(item.strength);
    strength.title = "模型强度（步长 0.01）";
    strength.setAttribute("aria-label", `第 ${index + 1} 项模型强度`);
    strength.addEventListener("input", () => {
        const value = strength.value.trim() === "" ? NaN : Number(strength.value);
        strength.setCustomValidity(Number.isFinite(value) ? "" : "请输入有限数值。");
        if (Number.isFinite(value) && value !== item.strength) change(state, () => { item.strength = value; });
    });
    strength.addEventListener("blur", () => {
        strength.value = String(item.strength);
        strength.setCustomValidity("");
    });
    const arrows = element("div", "enhance-kit-lora-moves");
    const up = button("up", "↑", `上移第 ${index + 1} 项 LoRA`);
    const down = button("down", "↓", `下移第 ${index + 1} 项 LoRA`);
    up.disabled = index === 0;
    down.disabled = index === state.items.length - 1;
    up.addEventListener("click", () => move(state, index, index - 1));
    down.addEventListener("click", () => move(state, index, index + 1));
    arrows.append(up, down);
    const remove = button("delete", "×", `删除第 ${index + 1} 项 LoRA（保留磁盘文件）`);
    remove.addEventListener("click", () => change(state, () => { state.items.splice(index, 1); }, true));
    root.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (state.dragIndex !== null) event.dataTransfer.dropEffect = "move";
    });
    root.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (state.dragIndex !== null) move(state, state.dragIndex, index);
    });
    root.append(drag, enabled, select, strength, arrows, remove);
    return row;
}

function render(state) {
    state.rows = state.items.map((item, index) => createRow(state, item, index));
    state.list.replaceChildren(...state.rows.map(row => row.element));
    status(state);
    resize(state);
}

function restore(state, value) {
    state.raw = typeof value === "string" ? value : JSON.stringify(value);
    state.dragIndex = null;
    try {
        state.items = parseConfig(state.raw);
        state.raw = JSON.stringify({ schema_version: 1, items: state.items });
        state.error = "";
    } catch (error) {
        state.items = [];
        state.error = error.message;
        state.rawInput.value = state.raw;
    }
    render(state);
}

app.registerExtension({
    name: "EnhanceKit.LoraManager",
    setup() {
        const style = document.createElement("link");
        style.rel = "stylesheet";
        style.href = new URL("./lora_manager.css", import.meta.url).href;
        document.head.append(style);
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "EnhanceKitLoraManager") return;
        files = [...(nodeData.input.required.loras[1].enhanceKitLoraOptions ?? [])];
        for (const state of active) {
            state.rows.forEach((row, index) => selectOptions(row, state.items[index]));
            status(state);
            state.node.setDirtyCanvas(true, true);
        }
    },
    nodeCreated(node) {
        if (node.comfyClass !== "EnhanceKitLoraManager" || states.has(node)) return;
        const original = node.widgets.find(widget => widget.name === "loras");
        const index = node.widgets.indexOf(original);
        const value = original.value;
        removeLoraSocket(node);
        const root = element("div", "enhance-kit-lora-manager");
        const list = element("div", "enhance-kit-lora-list");
        const message = element("div", "enhance-kit-lora-status", "status");
        message.setAttribute("role", "status");
        const repair = element("div", "enhance-kit-lora-repair");
        const rawInput = element("textarea", "", "raw");
        rawInput.setAttribute("aria-label", "原始 LoRA 配置 JSON");
        rawInput.spellcheck = false;
        const apply = button("apply", "应用修正配置", "应用修正后的 LoRA 配置 JSON");
        repair.append(rawInput, apply);
        const add = button("add", "+ 添加 LoRA", "添加一项 LoRA");
        root.append(list, message, repair, add);
        const state = { node, root, list, status: message, repair, rawInput, add, items: [], rows: [], raw: value, error: "", dragIndex: null };
        states.set(node, state);
        active.add(state);
        add.addEventListener("click", () => change(state, () => {
            state.items.push({ name: files[0] ?? "", enabled: true, strength: 1 });
        }, true));
        apply.addEventListener("click", () => {
            if (!active.has(state)) return;
            try { parseConfig(rawInput.value); }
            catch (error) { state.error = error.message; status(state); return; }
            const graph = node.graph;
            graph?.canvasAction(canvas => canvas.emitBeforeChange());
            restore(state, rawInput.value);
            graph?.canvasAction(canvas => canvas.emitAfterChange());
        });
        for (const name of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "wheel"]) {
            root.addEventListener(name, event => event.stopPropagation());
        }
        for (const name of ["keydown", "keyup"]) {
            root.addEventListener(name, event => {
                const target = event.target;
                const editing = target.tagName === "TEXTAREA" || target.tagName === "INPUT" && target.type !== "checkbox" || target.isContentEditable;
                const undoRedo = (event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key?.toLowerCase());
                if (!editing && undoRedo) return;
                event.stopPropagation();
            });
        }
        for (const name of ["dragover", "drop"]) {
            root.addEventListener(name, event => { event.stopPropagation(); event.preventDefault(); });
        }
        node.removeWidget(original);
        original.element?.remove();
        const widget = node.addDOMWidget("loras", "enhance-kit-loras", root, {
            getValue: () => state.raw,
            setValue: value => restore(state, value),
            getMinHeight: () => height(state),
            getMaxHeight: () => height(state),
            getHeight: () => height(state),
            hideOnZoom: false,
            socketless: true,
        });
        widget.dynamicPrompts = false;
        widget.options.dynamicPrompts = false;
        node.widgets.splice(node.widgets.indexOf(widget), 1);
        node.widgets.splice(index, 0, widget);
        const removed = widget.onRemove;
        widget.onRemove = function (...args) {
            active.delete(state);
            state.dragIndex = null;
            return removed?.apply(this, args);
        };
        const added = node.onAdded;
        node.onAdded = function (...args) {
            const result = added?.apply(this, args);
            original.onRemove?.();
            active.add(state);
            state.rows.forEach((row, index) => selectOptions(row, state.items[index]));
            status(state);
            attachElement(state);
            return result;
        };
        const configure = node.onConfigure;
        node.onConfigure = function (...args) {
            const result = configure?.apply(this, args);
            removeLoraSocket(node);
            attachElement(state);
            resize(state);
            return result;
        };
        restore(state, value);
        attachElement(state);
    },
});
