import { api } from "../../scripts/api.js";
import { readLibrary, mutateLibrary } from "./prompt_library_client.js";

let opened;

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

/** 打开当前用户的管理窗口，定位可选 ID；保存回调收到新库，关闭后兑现 Promise。
 * 读取失败保留窗口供重试，写入失败保留草稿；重复打开复用同一窗口。
 */
export function openPromptLibraryManager({ categoryId = "", promptId = "", onSaved } = {}) {
    if (opened) { opened.element.focus(); return opened.done; }
    const Dialog = window.comfyAPI?.ui?.ComfyDialog;
    if (!Dialog) return Promise.reject(new Error("当前 ComfyUI 前端没有可用的管理弹窗，请使用已支持版本。"));
    const dialog = new Dialog("div", []);
    dialog.element.classList.add("enhance-kit-prompt-library");
    const root = element("section");
    root.append(element("h2", "分类提示词库"), element("p", "同一用户的工作流共享此库；节点运行时读取最新正文。", "ek-description"));
    const status = element("p", "正在读取…", "ek-status");
    status.setAttribute("role", "status");
    root.append(status);
    const columns = element("div", undefined, "ek-columns");
    const categories = element("div", undefined, "ek-list");
    const prompts = element("div", undefined, "ek-list");
    const editor = element("div", undefined, "ek-editor");
    columns.append(categories, prompts, editor);
    root.append(columns);
    const footer = element("div", undefined, "ek-actions");
    const question = element("div", undefined, "ek-question");
    question.hidden = true;
    root.append(question, footer);
    const controls = {};
    function control(parent, tag, name, label) {
        const node = element(tag);
        node.dataset.action = name;
        node.setAttribute("aria-label", label);
        if (tag === "button") { node.type = "button"; node.textContent = label; }
        else parent.append(element("label", label));
        parent.append(node);
        controls[name] = node;
        return node;
    }
    const category = control(categories, "select", "category", "分类"); category.size = 8;
    const categoryName = control(categories, "input", "category-name", "分类名称");
    const categoryActions = element("div", undefined, "ek-actions"); categories.append(categoryActions);
    const createCategory = control(categoryActions, "button", "create-category", "新增");
    const renameCategory = control(categoryActions, "button", "rename-category", "改名");
    const deleteCategory = control(categoryActions, "button", "delete-category", "删除");
    const prompt = control(prompts, "select", "prompt", "提示词"); prompt.size = 8;
    const promptActions = element("div", undefined, "ek-actions"); prompts.append(promptActions);
    const createPrompt = control(promptActions, "button", "create-prompt", "新提示词");
    const deletePrompt = control(promptActions, "button", "delete-prompt", "删除");
    const target = control(editor, "select", "target", "所属分类");
    const title = control(editor, "input", "title", "标题");
    const text = control(editor, "textarea", "text", "正文"); text.rows = 14;
    const save = control(editor, "button", "save", "保存提示词");
    const latest = element("details"); latest.hidden = true;
    const latestText = element("pre"); latest.append(element("summary", "库中的当前正文（供冲突核对）"), latestText); editor.append(latest);
    const refresh = control(footer, "button", "refresh", "刷新库（保留编辑）");
    const close = control(footer, "button", "close", "关闭");
    let library = { revision: 0, categories: [], prompts: [] };
    let selectedCategory = categoryId, selectedPrompt = promptId;
    let original = { category_id: "", title: "", text: "" };
    let originalTextDisplay = "";
    let alive = true, loaded = false, busy, askResolve, readGeneration = 0;
    const owner = api.user;
    const readController = new AbortController();
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    opened = { element: dialog.element, done };

    function valid() { return alive && api.user === owner; }
    function draft() {
        // textarea 会规范换行；只改标题或分类时仍保存未经编辑的原始正文。
        return { category_id: target.value, title: title.value,
            text: text.value === originalTextDisplay ? original.text : text.value };
    }
    function dirty() {
        const value = draft();
        return value.category_id !== original.category_id || value.title !== original.title || value.text !== original.text;
    }
    function options(select, items, value) {
        select.replaceChildren(...items.map((item) => { const option = element("option", item.name ?? item.title); option.value = item.id; return option; }));
        select.value = value;
    }
    function renderLists() {
        options(category, library.categories, selectedCategory);
        options(prompt, library.prompts.filter((item) => item.category_id === selectedCategory), selectedPrompt);
        options(target, library.categories, target.value);
        categoryName.value = library.categories.find((item) => item.id === selectedCategory)?.name ?? "";
        updateDisabled();
    }
    function updateDisabled() {
        for (const [name, node] of Object.entries(controls)) node.disabled = name !== "close" && (!loaded || !!busy);
        if (!busy && loaded) {
            renameCategory.disabled = !selectedCategory;
            deleteCategory.disabled = !selectedCategory || library.prompts.some((item) => item.category_id === selectedCategory);
            createPrompt.disabled = !selectedCategory;
            deletePrompt.disabled = !selectedPrompt;
            save.disabled = !target.value;
        }
    }
    function select(categoryId, promptId) {
        selectedCategory = categoryId; selectedPrompt = promptId;
        const item = library.prompts.find((item) => item.id === promptId);
        if (item) selectedCategory = item.category_id;
        original = item ? { category_id: item.category_id, title: item.title, text: item.text } : { category_id: selectedCategory, title: "", text: "" };
        renderLists();
        target.value = original.category_id; title.value = original.title; text.value = original.text;
        originalTextDisplay = text.value;
        latest.hidden = true;
        updateDisabled();
    }
    function ask(message, choices) {
        if (askResolve) return Promise.resolve("cancel");
        question.replaceChildren(element("p", message)); question.hidden = false;
        return new Promise((resolve) => {
            askResolve = resolve;
            for (const [value, label, action] of choices) {
                const button = control(question, "button", action, label);
                button.onclick = () => { question.hidden = true; askResolve = undefined; resolve(value); };
            }
        });
    }
    async function canLeave() {
        if (!dirty()) return true;
        const answer = await ask("有未保存的提示词，如何处理？", [["save", "保存", "save-dirty"], ["discard", "放弃", "discard-dirty"], ["cancel", "取消", "cancel-dirty"]]);
        if (answer === "save") return await saveDraft();
        return answer === "discard";
    }
    async function write(action, data, after) {
        if (busy || askResolve || !valid() || !loaded) return false;
        readGeneration++;
        // 写入不使用读取 AbortSignal：关闭窗口不能撤销服务端已开始的原子保存。
        busy = (async () => {
            try {
                const updated = await mutateLibrary(library.revision, action, data);
                if (!valid()) return false;
                library = updated;
                after();
                onSaved?.(updated);
                status.textContent = "已保存";
                return true;
            } catch (error) {
                if (valid()) status.textContent = error.status === 409 ? "库已被其他页面更新；请刷新并核对后保存，编辑内容已保留。" : error.message;
                return false;
            }
        })();
        updateDisabled();
        const result = await busy;
        busy = undefined;
        if (valid()) updateDisabled();
        return result;
    }
    async function saveDraft() {
        const value = draft(), id = selectedPrompt;
        return await write(id ? "prompt.update" : "prompt.create", id ? { id, ...value } : value, () => {
            const saved = id ? library.prompts.find((item) => item.id === id) : library.prompts.find((item) => item.category_id === value.category_id && item.title === value.title.trim());
            select(saved.category_id, saved.id);
        });
    }
    async function reload(keepDraft) {
        if (busy || askResolve || !valid()) return;
        const generation = ++readGeneration;
        try {
            const updated = await readLibrary({ signal: readController.signal });
            if (!valid() || generation !== readGeneration) return;
            library = updated; loaded = true;
            if (keepDraft) {
                const value = draft();
                renderLists(); target.value = value.category_id; title.value = value.title; text.value = value.text;
                const item = library.prompts.find((item) => item.id === selectedPrompt);
                latest.hidden = !item; latestText.textContent = item?.text ?? "";
                status.textContent = "已刷新；编辑内容保留，请核对后保存。";
            } else {
                select(selectedCategory, selectedPrompt);
                status.textContent = library.categories.length ? "请选择或新增提示词" : "请先新增分类";
            }
            updateDisabled();
        } catch (error) { if (valid() && generation === readGeneration) { status.textContent = error.message; refresh.disabled = false; } }
    }
    async function transition(operation) {
        if (busy || askResolve || !valid()) return;
        if (await canLeave()) operation();
        else renderLists();
    }
    category.onchange = () => { const id = category.value; return transition(() => select(id, "")); };
    prompt.onchange = () => { const id = prompt.value; return transition(() => select(selectedCategory, id)); };
    createPrompt.onclick = () => transition(() => { select(selectedCategory, ""); title.focus(); });
    createCategory.onclick = async () => {
        const name = categoryName.value;
        if (!await canLeave()) return;
        return write("category.create", { name }, () => select(library.categories.find((item) => item.name === name.trim()).id, ""));
    };
    renameCategory.onclick = () => write("category.rename", { id: selectedCategory, name: categoryName.value }, renderLists);
    deleteCategory.onclick = async () => {
        if (deleteCategory.disabled || !await canLeave()) return;
        return write("category.delete", { id: selectedCategory }, () => select("", ""));
    };
    deletePrompt.onclick = async () => {
        if (busy || askResolve || !selectedPrompt) return;
        const answer = await ask("删除后引用此提示词的工作流需要重新选择。确认删除？", [["delete", "删除", "confirm-delete"], ["cancel", "取消", "cancel-delete"]]);
        if (answer === "delete") return write("prompt.delete", { id: selectedPrompt }, () => select(selectedCategory, ""));
    };
    save.onclick = saveDraft;
    refresh.onclick = () => reload(true);
    title.oninput = text.oninput = target.onchange = updateDisabled;
    const originalClose = dialog.close.bind(dialog);
    function destroy() {
        if (!alive) return;
        alive = false; readController.abort();
        askResolve?.("cancel"); askResolve = undefined;
        window.removeEventListener("focus", userChanged);
        originalClose(); dialog.element.remove(); opened = undefined; finish();
    }
    function userChanged() { if (api.user !== owner) destroy(); }
    dialog.close = async () => {
        if (askResolve) return;
        if (busy) await busy;
        if (valid() && await canLeave()) destroy();
        else if (api.user !== owner) destroy();
    };
    close.onclick = () => dialog.close();
    window.addEventListener("focus", userChanged);
    dialog.show(root);
    updateDisabled();
    void reload(false);
    return done;
}
