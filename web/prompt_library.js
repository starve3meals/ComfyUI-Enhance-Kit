import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { readLibrary, resolvePrompt } from "./prompt_library_client.js";
import { openPromptLibraryManager } from "./prompt_library_manager.js";

const states = new WeakMap();
const active = new Set();
let library = { categories: [], prompts: [] };
let libraryOwner;
let loading;
let refreshGeneration = 0;

function reference(node) {
    const saved = node.properties.enhanceKitPromptLibrary;
    const value = { category_id: saved?.category_id || "", prompt_id: saved?.prompt_id || "" };
    node.properties.enhanceKitPromptLibrary = value;
    return value;
}

function changed(state) {
    state.generation++;
    state.preview?.abort();
    state.text.value = "";
}

function render(state) {
    const selected = state.node.properties.enhanceKitPromptLibrary;
    const prompt = library.prompts.find((item) => item.id === selected.prompt_id);
    if (prompt) selected.category_id = prompt.category_id;
    state.category.options.values = ["", ...library.categories.map((item) => item.id)];
    state.prompt.options.values = ["", ...library.prompts.filter((item) => item.category_id === selected.category_id).map((item) => item.id)];
    state.category.value = selected.category_id;
    state.prompt.value = selected.prompt_id;
    state.text.value = prompt?.text ?? "";
    state.node.setDirtyCanvas(true, true);
}

function current(state, context) {
    return active.has(state) && state.node.graph === context.graph && app.rootGraph === context.root
        && api.user === context.user && state.generation === context.generation
        && state.node.properties.enhanceKitPromptLibrary.prompt_id === context.id;
}

function capture(state) {
    return { graph: state.node.graph, root: app.rootGraph, user: api.user,
        generation: state.generation, id: state.node.properties.enhanceKitPromptLibrary.prompt_id };
}

async function preview(state) {
    state.preview?.abort();
    const context = capture(state);
    if (!context.id || !context.graph) return;
    state.preview = new AbortController();
    try {
        const resolved = await resolvePrompt(context.id, { signal: state.preview.signal });
        if (!current(state, context)) return;
        state.node.properties.enhanceKitPromptLibrary.category_id = resolved.category_id;
        state.category.value = resolved.category_id;
        state.text.value = resolved.text;
        state.node.setDirtyCanvas(true, true);
    } catch (error) {
        if (!current(state, context) || error.name === "AbortError") return;
        state.text.value = "";
        if (state.text.element) state.text.element.placeholder = error.message;
        state.node.setDirtyCanvas(true, true);
    }
}

/** 用已保存的当前用户库刷新节点；按 ID 跟随移动，删除不替换选中条目。 */
export function refreshPromptLibraryNodes(updated) {
    refreshGeneration++;
    library = updated;
    libraryOwner = api.user;
    for (const state of active) {
        changed(state);
        state.owner = api.user;
        render(state);
    }
}

async function refresh() {
    const user = api.user, root = app.rootGraph, generation = ++refreshGeneration;
    if (libraryOwner !== user) {
        library = { categories: [], prompts: [] };
        for (const state of active) { changed(state); render(state); }
    }
    try {
        const updated = await readLibrary();
        if (api.user !== user || app.rootGraph !== root || generation !== refreshGeneration) return;
        refreshPromptLibraryNodes(updated);
    } catch (error) {
        if (api.user !== user || app.rootGraph !== root || generation !== refreshGeneration) return;
        library = { categories: [], prompts: [] };
        for (const state of active) {
            changed(state);
            render(state);
            if (state.text.element) state.text.element.placeholder = error.message;
        }
    }
}

app.registerExtension({
    name: "EnhanceKit.PromptLibrary",
    async setup() {
        const style = document.createElement("link");
        style.rel = "stylesheet";
        style.href = new URL("./prompt_library.css", import.meta.url).href;
        document.head.append(style);
        window.addEventListener("focus", () => { loading = refresh(); });
        loading = refresh();
        await loading;
    },
    async nodeCreated(node) {
        if (node.comfyClass !== "EnhanceKitPromptLibrary") return;
        const text = node.widgets.find((widget) => widget.name === "resolved_text");
        reference(node);
        const state = { node, text, generation: 0, owner: api.user };
        states.set(node, state);
        active.add(state);
        text.serialize = false;
        text.label = "正文预览";
        text.dynamicPrompts = false;
        text.options.read_only = true;
        if (text.element) text.element.readOnly = true;
        state.category = node.addWidget("combo", "分类", "", async (id) => {
            changed(state);
            node.properties.enhanceKitPromptLibrary = { category_id: id, prompt_id: "" };
            render(state);
        }, { values: [], serialize: false,
            getOptionLabel: (id) => library.categories.find((item) => item.id === id)?.name || (id ? "分类已删除" : "请选择分类") });
        state.prompt = node.addWidget("combo", "提示词", "", async (id) => {
            changed(state);
            node.properties.enhanceKitPromptLibrary.prompt_id = id;
            render(state);
            await preview(state);
        }, { values: [], serialize: false,
            getOptionLabel: (id) => library.prompts.find((item) => item.id === id)?.title || (id ? "提示词已删除，请重新选择" : "请选择提示词") });
        state.category.serialize = state.prompt.serialize = false;
        const manage = node.addWidget("button", "管理提示词库", null, () => {
            const selected = node.properties.enhanceKitPromptLibrary;
            openPromptLibraryManager({ categoryId: selected.category_id, promptId: selected.prompt_id,
                onSaved: refreshPromptLibraryNodes }).catch((error) => app.extensionManager.dialog.alert(error.message));
        }, { serialize: false });
        manage.serialize = false;
        node.widgets = [state.category, state.prompt, ...node.widgets.filter((widget) => widget !== state.category && widget !== state.prompt)];
        text.serializeValue = async () => {
            const context = capture(state);
            if (!context.id || !context.graph || state.owner !== context.user) throw new Error("请先选择当前用户库中的提示词。");
            const resolved = await resolvePrompt(context.id);
            if (!current(state, context)) throw new Error("提示词选择、用户或工作流已变化，请重新运行。");
            return resolved.text;
        };
        const originalConfigure = node.onConfigure;
        node.onConfigure = function (...args) {
            originalConfigure?.apply(this, args);
            const own = states.get(this);
            if (!own) return;
            reference(this);
            changed(own);
            render(own);
        };
        const originalRemoved = node.onRemoved;
        node.onRemoved = function (...args) {
            const own = states.get(this);
            if (own) { changed(own); active.delete(own); }
            originalRemoved?.apply(this, args);
        };
        if (loading) await loading;
        else if (libraryOwner !== api.user) { loading = refresh(); await loading; }
        render(state);
        node.setSize([Math.max(node.size[0], 360), Math.max(node.size[1], 300)]);
    },
    async afterConfigureGraph() {
        loading = refresh();
        await loading;
    },
});
