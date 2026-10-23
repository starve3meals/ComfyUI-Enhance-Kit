import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export const token = '11111111-1111-4111-8111-111111111111';
export const token2 = '22222222-2222-4222-8222-222222222222';
export class Events {
    listeners = new Map();
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatch(type, detail) { for (const fn of this.listeners.get(type) ?? []) fn({ type, detail }); }
}
export function graphFixture() {
    const source = { id: 1, type: 'Source', mode: 0, inputs: [], outputs: [{ name: 'value', type: 'INT', links: [7] }] };
    const target = { id: 2, type: 'Target', mode: 0, inputs: [{ name: 'value', type: 'INT', link: 7 }], outputs: [] };
    const link = { id: 7, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: 'INT' };
    const graph = { _version: 1, _nodes: [source, target], links: new Map([[7, link]]), events: new Events(),
        getNodeById(id) { return this._nodes.find((n) => String(n.id) === String(id)); },
        getLink(id) { return this.links.get(id); },
    };
    source.graph = target.graph = graph;
    const output = { '1': { class_type: 'Source', inputs: {} }, '2': { class_type: 'Target', inputs: { value: ['1', 0] } } };
    const workflow = { id: 'workflow', extra: { frontendVersion: '1.55.18' }, nodes: [{ id: 1 }, { id: 2 }], links: [[7, 1, 0, 2, 0, 'INT']] };
    return { graph, source, target, link, output, workflow };
}
export function delivery(changes = {}) {
    return { schema: 1, prompt_id: 'job-1', run_token: token, event_id: 1, node_id: '2', call_index: 0,
        edges: [{ source_node: '1', source_slot: 0, target_node: '2', target_input: 'value' }], ...changes };
}
export async function loadState() {
    const context = vm.createContext({ console });
    const source = await readFile(new URL('../../web/execution_link_flow_state.js', import.meta.url), 'utf8');
    const module = new vm.SourceTextModule(source, { context });
    await module.link(() => { throw Error('state must not import host modules'); });
    await module.evaluate();
    return module.namespace;
}
export async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

// 从 1.55.18 settingStore-DZ2-HL-F.js 取得的活跃方法文本；fixture 使用同一原生委托/返回契约。
const nativeRenderLink = 'renderLink(e,t,n,r,i,a,o,s,c,{startControl:l,endControl:u,reroute:d,num_sublines:f=1,disabled:p=!1}={}){if(this.linkRenderer){let m=this.buildLinkRenderContext();this.linkRenderer.renderLinkDirect(e,t,n,r,i,a,o,s,c,m,{reroute:d,startControl:l,endControl:u,num_sublines:f,disabled:p})}}';

export async function loadFrontend({ enabled = true, available = true, vue = false, queueImpl, fetchImpl, rendererSource = nativeRenderLink } = {}) {
    const f = graphFixture(), api = new Events(), settingsEvents = new Events(), document = new Events(), window = new Events(), motion = new Events();
    document.hidden = false; motion.matches = false;
    let now = 0, serial = 0, requestId = 0;
    const frames = new Map(), requests = [], renders = [], dirty = [], notices = [], extensions = [];
    const values = new Map([['EnhanceKit.ExecutionLinkFlow.Enabled', enabled], ['Comfy.VueNodes.Enabled', vue], ['Comfy.Locale', 'en']]);
    const canvas = { graph: f.graph, linkRenderer: { renderLinkDirect(...args) { renders.push(args); } },
        buildLinkRenderContext() { return { theme: 'native' }; }, setDirty(fg, bg) { dirty.push([fg, bg]); },
        renderLink: Function('return ({' + rendererSource + '})')().renderLink,
        drawConnections(ctx) { for (const link of this.graph.links.values()) this.renderLink(ctx, [0, 0], [100, 0], link, false, 0, '#abc', 4, 3); } };
    const setting = { get: (id) => values.get(id), set(id, value) { const oldValue = values.get(id); values.set(id, value); extensions.forEach((e) => e.settings?.find((s) => s.id === id)?.onChange?.(value, oldValue)); settingsEvents.dispatch(id + '.change', { value, oldValue }); } };
    const app = { graph: f.graph, rootGraph: f.graph, canvas, ui: { settings: settingsEvents },
        extensionManager: { setting, toast: { add: (n) => notices.push(n) } },
        registerExtension: (e) => extensions.push(e),
        async graphToPrompt() { return { output: f.output, workflow: f.workflow }; } };
    api.clientId = 'client'; api.user = 'user';
    api.fetchApi = async (route, options) => {
        requests.push({ route, options });
        if (route === '/enhance-kit/link-flow/status') return new Response(JSON.stringify({ schema: 1, available, reason_code: available ? null : 'unsupported_core' }));
        if (fetchImpl) return await fetchImpl(route, options);
        if (route === '/queue') return new Response(JSON.stringify({ queue_running: [], queue_pending: Array.from({ length: requestId }, (_, i) => [i, 'job-' + (i + 1)]) }));
        return new Response(JSON.stringify({ prompt_id: 'job-' + (++requestId), node_errors: {} }));
    };
    // 与 1.55.18 api.ts 相同的请求边界；额外 options 不会进入 extra_data。
    api.queuePrompt = queueImpl ?? async function (number, data, options) {
        const body = { client_id: this.clientId, prompt: data.output,
            ...(options?.partialExecutionTargets && { partial_execution_targets: options.partialExecutionTargets }),
            extra_data: { auth_token_comfy_org: 'auth', api_key_comfy_org: 'key', comfy_usage_source: 'comfyui-frontend', extra_pnginfo: { workflow: data.workflow } } };
        if (number === -1) body.front = true; else if (number !== 0) body.number = number;
        const res = await this.fetchApi('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (res.status !== 200) throw Error(await res.text());
        return await res.json();
    };
    const originals = { graphToPrompt: app.graphToPrompt, queuePrompt: api.queuePrompt, fetchApi: api.fetchApi, renderLink: canvas.renderLink };
    const context = vm.createContext({ console, document, window, Response, URL, JSON, Map, Set, WeakMap, Number,
        performance: { now: () => now },
        crypto: { randomUUID: () => `${String(++serial).padStart(8, '0')}-1111-4111-8111-111111111111` },
        matchMedia: () => motion,
        requestAnimationFrame: (fn) => { const id = ++serial; frames.set(id, fn); return id; },
        cancelAnimationFrame: (id) => frames.delete(id),
        LiteGraph: { vueNodesMode: vue },
    });
    const state = new vm.SourceTextModule(await readFile(new URL('../../web/execution_link_flow_state.js', import.meta.url), 'utf8'), { context });
    const appModule = new vm.SyntheticModule(['app'], function () { this.setExport('app', app); }, { context });
    const apiModule = new vm.SyntheticModule(['api'], function () { this.setExport('api', api); }, { context });
    const module = new vm.SourceTextModule(await readFile(new URL('../../web/execution_link_flow.js', import.meta.url), 'utf8'), { context });
    await state.link(() => { throw Error('unexpected import'); });
    await module.link((id) => id.includes('execution_link_flow_state') ? state : id.includes('app.js') ? appModule : apiModule);
    await module.evaluate();
    await extensions[0].setup(); await settle();
    const submit = async () => { const data = await app.graphToPrompt(); const result = await api.queuePrompt(0, data); await settle(); return { data, result, body: JSON.parse(requests.findLast((r) => r.route === '/prompt').options.body) }; };
    const emit = (body, changes = {}) => api.dispatch('enhance-kit.inputs-delivered', delivery({ run_token: body.extra_data.enhance_kit_link_flow?.run_token, ...changes }));
    const draw = (flow = null, extras = { reroute: { id: 99 }, startControl: [3, 4] }) => canvas.renderLink({ globalAlpha: 1 }, [0, 0], [100, 0], f.link, false, flow, '#abc', 4, 3, extras);
    const advance = async (ms) => { now += ms; const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn(now)); await settle(); };
    return { ...f, api, app, canvas, document, window, motion, values, setting, requests, renders, frames, dirty, notices, originals, extensions, context, submit, emit, draw, advance, namespace: module.namespace };
}
