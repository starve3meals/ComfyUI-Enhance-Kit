import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const sourcePath = new URL('../../web/resource_monitor.js', import.meta.url);
const GiB = 1024 ** 3;
const IDs = {
    cpu: 'EnhanceKit.Resources.ShowCPU',
    memory: 'EnhanceKit.Resources.ShowMemory',
    gpu: 'EnhanceKit.Resources.ShowGPU',
    temperature: 'EnhanceKit.Resources.ShowTemperature',
    vram: 'EnhanceKit.Resources.ShowVRAM',
    interval: 'EnhanceKit.Resources.Interval',
    device: 'EnhanceKit.Resources.GPU',
};

class Events {
    listeners = new Map();
    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatch(type) { for (const fn of this.listeners.get(type) ?? []) fn({ type }); }
}

class Element extends Events {
    constructor(tag, document) {
        super();
        this.nodeType = 1;
        this.tagName = tag.toUpperCase();
        this.ownerDocument = document;
        this.children = [];
        this.parentElement = null;
        this.dataset = {};
        this.style = {};
        this.attributes = new Map();
        this.className = '';
        this.id = '';
        this.hidden = false;
        this.inert = false;
        this._text = '';
    }
    get nextElementSibling() { const siblings = this.parentElement?.children ?? []; return siblings[siblings.indexOf(this) + 1] ?? null; }
    get isConnected() { return this === this.ownerDocument.body || !!this.parentElement?.isConnected; }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) {
        for (const node of nodes) {
            if (node.parentElement) node.remove();
            node.parentElement = this;
            this.children.push(node);
            this.ownerDocument.notify({ type: 'childList', target: this, addedNodes: [node], removedNodes: [] });
        }
    }
    appendChild(node) { this.append(node); return node; }
    before(node) {
        const parent = this.parentElement;
        if (!parent) return;
        if (node.parentElement) node.remove();
        node.parentElement = parent;
        parent.children.splice(parent.children.indexOf(this), 0, node);
        this.ownerDocument.notify({ type: 'childList', target: parent, addedNodes: [node], removedNodes: [] });
    }
    remove() {
        const parent = this.parentElement;
        if (!parent) return;
        parent.children.splice(parent.children.indexOf(this), 1);
        this.parentElement = null;
        this.ownerDocument.notify({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] });
    }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
    matches(selector) {
        if (selector.startsWith('#')) return this.id === selector.slice(1);
        if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
        const attribute = selector.match(/^\[([^=]+)="([^"]*)"\]$/);
        if (attribute) return this.getAttribute(attribute[1]) === attribute[2];
        return this.tagName.toLowerCase() === selector;
    }
    querySelector(selector) {
        for (const child of this.children) {
            if (child.matches(selector)) return child;
            const found = child.querySelector(selector);
            if (found) return found;
        }
        return null;
    }
    querySelectorAll(selector) {
        return this.children.flatMap((child) => [ ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector) ]);
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'id') this.id = String(value);
        if (name === 'class') this.className = String(value);
        this.ownerDocument.notify({ type: 'attributes', target: this, attributeName: name });
    }
    getAttribute(name) {
        if (name.startsWith('data-')) {
            const key = name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
            return this.dataset[key] ?? this.attributes.get(name) ?? null;
        }
        return this.attributes.get(name) ?? null;
    }
    getClientRects() {
        if (!this.isConnected) return [];
        for (let node = this; node; node = node.parentElement) {
            if (node.hidden || node.inert || node.style.display === 'none' || node.style.visibility === 'hidden' || node.style.opacity === '0' || node.getAttribute('aria-hidden') === 'true') return [];
        }
        return [{ width: 500, height: 24 }];
    }
    getBoundingClientRect() { return this.getClientRects()[0] ?? { width: 0, height: 0 }; }
}

class Document extends Events {
    constructor() {
        super();
        this.observers = new Set();
        this.hidden = false;
        this.visibilityState = 'visible';
        this.body = new Element('body', this);
        this.head = new Element('head', this);
        this.documentElement = this.body;
    }
    createElement(tag) { return new Element(tag, this); }
    querySelector(selector) { return this.body.querySelector(selector); }
    querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
    getElementById(id) { return this.querySelector(`#${id}`); }
    notify(record) {
        for (const observer of this.observers) {
            if (!observer.targets.some(({ target, options }) => (target === record.target || (options.subtree && target.contains(record.target))) && options[record.type] && (!options.attributeFilter || record.type !== 'attributes' || options.attributeFilter.includes(record.attributeName)))) continue;
            observer.records.push(record);
            if (observer.queued) continue;
            observer.queued = true;
            queueMicrotask(() => {
                observer.queued = false;
                const records = observer.records.splice(0);
                if (records.length) observer.callback(records);
            });
        }
    }
}

class Timers {
    now = 1_800_000_000_000;
    wallClockOffset = 0;
    nextId = 0;
    tasks = new Map();
    setTimeout = (callback, delay = 0) => {
        const id = ++this.nextId;
        this.tasks.set(id, { callback, at: this.now + Number(delay) });
        return id;
    };
    clearTimeout = (id) => this.tasks.delete(id);
    async advance(ms) {
        const target = this.now + ms;
        let steps = 0;
        while (true) {
            const next = [...this.tasks].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            assert.ok(++steps < 500, 'timer loop should remain bounded');
            this.now = next[1].at;
            this.tasks.delete(next[0]);
            next[1].callback();
            await settle();
        }
        this.now = target;
        await settle();
    }
}

async function settle() { for (let index = 0; index < 15; index++) await Promise.resolve(); }

function snapshot(now, changes = {}) {
    return {
        sampled_at_ms: now,
        cpu: { utilization_percent: 25.5 },
        memory: { used_bytes: 8 * GiB, total_bytes: 32 * GiB, utilization_percent: 25 },
        gpus: [{ index: 0, name: 'GPU A', utilization_percent: 80, temperature_c: 63, memory: { used_bytes: 6 * GiB, total_bytes: 24 * GiB, utilization_percent: 25 } }],
        ...changes,
    };
}

async function harness(initial = {}) {
    const document = new Document();
    const window = new Events();
    const timers = new Timers();
    const requests = [];
    const definitions = new Map();
    const settings = {};
    const optionsConsumers = new Map();
    const values = new Map(Object.entries(initial));
    let extension;
    const top = document.createElement('div');
    top.className = 'comfyui-body-top';
    const legacy = document.createElement('div');
    legacy.dataset.testid = 'legacy-topbar-container';
    const menu = document.createElement('div');
    const settingsGroup = document.createElement('div');
    menu.append(settingsGroup);
    legacy.append(menu);
    top.append(legacy);
    document.body.append(top);
    const app = {
        menu: { element: menu, settingsGroup: { element: settingsGroup } },
        extensionManager: { setting: { settings, get: (id) => values.get(id) ?? definitions.get(id)?.defaultValue } },
        registerExtension(definition) {
            extension = definition;
            for (const setting of definition.settings) {
                const reactiveSetting = new Proxy(setting, {
                    set(target, property, value) {
                        target[property] = value;
                        if (property === 'options') for (const invalidate of optionsConsumers.get(setting.id) ?? []) invalidate();
                        return true;
                    },
                });
                settings[setting.id] = reactiveSetting;
                definitions.set(setting.id, reactiveSetting);
                setting.onChange?.(app.extensionManager.setting.get(setting.id));
            }
        },
    };
    const api = {
        fetchApi(path, options) {
            assert.equal(path, '/enhance-kit/resources');
            assert.equal(options.cache, 'no-store');
            assert.ok(options.signal instanceof AbortSignal);
            let resolve;
            let reject;
            const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
            requests.push({
                signal: options.signal,
                respond(data, ok = true) { resolve({ ok, json: async () => data }); },
                fail(error = new Error('disconnected')) { reject(error); },
            });
            return promise;
        },
    };
    class MutationObserver {
        constructor(callback) { this.callback = callback; this.targets = []; this.records = []; document.observers.add(this); }
        observe(target, options) { this.targets.push({ target, options }); }
        disconnect() { this.targets = []; this.records = []; }
    }
    class ResizeObserver {
        constructor(callback) { this.callback = callback; }
        observe() {}
        disconnect() {}
    }
    class ControlledDate extends Date { static now() { return timers.now + timers.wallClockOffset; } }
    const context = vm.createContext({
        document, window, MutationObserver, ResizeObserver, AbortController, AbortSignal,
        setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
        Date: ControlledDate, performance: { now: () => timers.now }, URL, console, queueMicrotask,
        getComputedStyle: (node) => ({ display: node.style.display ?? 'flex', visibility: node.style.visibility ?? 'visible', opacity: node.style.opacity ?? '1' }),
    });
    const source = await readFile(sourcePath, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
    const module = new vm.SourceTextModule(source, { context, identifier: sourcePath.href, initializeImportMeta(meta) { meta.url = sourcePath.href; } });
    await module.link(async (specifier) => {
        assert.ok(specifier === '../../scripts/app.js' || specifier === '../../scripts/api.js', `unexpected import: ${specifier}`);
        const dependency = specifier.endsWith('app.js') ? { app } : { api };
        return new vm.SyntheticModule(Object.keys(dependency), function () { for (const [key, value] of Object.entries(dependency)) this.setExport(key, value); }, { context });
    });
    await module.evaluate();
    assert.ok(extension, 'resource monitor extension must be registered');
    const setup = async () => { await extension.setup(); await settle(); };
    const change = async (id, value) => {
        values.set(id, value);
        const definition = definitions.get(id);
        assert.ok(definition, `setting ${id} must be registered`);
        await definition.onChange?.(value);
        await settle();
    };
    // 模拟 SettingItem computed 对响应式 options 属性的依赖；普通闭包赋值不会使已开面板失效。
    const optionsReader = (id) => {
        let cached;
        let invalidated = true;
        if (!optionsConsumers.has(id)) optionsConsumers.set(id, new Set());
        optionsConsumers.get(id).add(() => { invalidated = true; });
        return () => {
            if (invalidated) {
                const options = definitions.get(id).options;
                cached = typeof options === 'function' ? options() : options;
                invalidated = false;
            }
            return cached;
        };
    };
    const bar = () => document.querySelector('.enhance-kit-resources');
    const metric = (key) => bar()?.querySelector(`[data-metric="${key}"]`);
    return { document, window, timers, requests, app, definitions, setup, change, optionsReader, bar, metric, top, legacy, menu, settingsGroup };
}

test('注册设置时的回调早于 setup，仍能按保存的开关首次显示', async () => {
    const h = await harness({ [IDs.cpu]: false, [IDs.interval]: 0 });
    await h.setup();
    assert.equal(h.metric('cpu').hidden, true);
    assert.equal(h.bar().hidden, true);
    assert.equal(h.requests.length, 0);
    await h.change(IDs.interval, 1);
    assert.equal(h.requests.length, 1);
    assert.equal(h.bar().hidden, false);
});

test('五项显示紧凑读数与完整容量 tooltip，刷新复用原有数值元素', async () => {
    const h = await harness();
    await h.setup();
    h.requests[0].respond(snapshot(h.timers.now));
    await settle();
    const value = h.metric('cpu').querySelector('.enhance-kit-resource-value');
    assert.equal(value.textContent, '25.5%');
    assert.equal(h.metric('memory').querySelector('.enhance-kit-resource-value').textContent, '25.0%');
    assert.equal(h.metric('gpu').querySelector('.enhance-kit-resource-value').textContent, '80.0%');
    assert.equal(h.metric('temperature').querySelector('.enhance-kit-resource-value').textContent, '63°C');
    assert.equal(h.metric('vram').querySelector('.enhance-kit-resource-value').textContent, '25.0%');
    assert.match(h.metric('vram').title, /GPU A.*6\.0\/24\.0 GiB/);
    assert.match(h.metric('memory').title, /8\.0\/32\.0 GiB/);
    assert.equal(h.metric('cpu').querySelector('.enhance-kit-resource-fill').style.width, '25.5%');
    assert.equal(h.metric('temperature').querySelector('.enhance-kit-resource-fill').style.width, '63%');
    await h.timers.advance(1000);
    h.requests[1].respond(snapshot(h.timers.now, { cpu: { utilization_percent: 50 } }));
    await settle();
    assert.equal(h.metric('cpu').querySelector('.enhance-kit-resource-value'), value);
    assert.equal(value.textContent, '50.0%');
});

test('首份新鲜快照的 CPU null 显示采样中，合法零值继续显示零', async () => {
    const h = await harness();
    await h.setup();
    h.requests[0].respond(snapshot(h.timers.now, { cpu: { utilization_percent: null }, gpus: [] }));
    await settle();
    assert.match(h.metric('cpu').textContent, /采样中/);
    assert.match(h.metric('gpu').textContent, /不可用/);
    await h.timers.advance(1000);
    h.requests[1].respond(snapshot(h.timers.now, { cpu: { utilization_percent: 0 } }));
    await settle();
    assert.match(h.metric('cpu').textContent, /0\.0%/);
    await h.timers.advance(1000);
    h.requests[2].respond(snapshot(h.timers.now, { cpu: { utilization_percent: null } }));
    await settle();
    assert.match(h.metric('cpu').textContent, /不可用/);
});

test('单项缺失保持不可用，其他 GPU 数值及 RAM 容量继续显示', async () => {
    const h = await harness();
    await h.setup();
    const data = snapshot(h.timers.now);
    data.gpus[0].utilization_percent = null;
    data.gpus[0].temperature_c = 0;
    data.gpus[0].memory.used_bytes = null;
    data.memory.utilization_percent = null;
    h.requests[0].respond(data);
    await settle();
    assert.match(h.metric('gpu').textContent, /不可用/);
    assert.match(h.metric('temperature').textContent, /0°C/);
    assert.match(h.metric('vram').title, /不可用/);
    assert.match(h.metric('vram').textContent, /25\.0%/);
    assert.match(h.metric('memory').title, /不可用.*8\.0\/32\.0 GiB/);
});

test('GPU 设置来自实际列表，选中另一设备立即展示其数值', async () => {
    const h = await harness();
    await h.setup();
    const data = snapshot(h.timers.now);
    data.gpus.push({ index: 2, name: 'GPU B', utilization_percent: 15, temperature_c: 45, memory: { used_bytes: 2 * GiB, total_bytes: 8 * GiB, utilization_percent: 25 } });
    h.requests[0].respond(data);
    await settle();
    const options = h.optionsReader(IDs.device)();
    assert.ok(options.some((option) => option.value === 2 && option.text.includes('GPU B')));
    await h.change(IDs.device, 2);
    assert.match(h.metric('gpu').textContent, /15\.0%/);
    assert.match(h.metric('vram').title, /GPU B/);
    await h.change(IDs.device, 99);
    assert.match(h.metric('gpu').textContent, /不可用/);
});

test('五项开关即时生效，全部关闭时隐藏并暂停请求', async () => {
    const h = await harness();
    await h.setup();
    for (const [key, id] of Object.entries(IDs).filter(([key]) => !['interval', 'device'].includes(key))) {
        await h.change(id, false);
        assert.equal(h.metric(key).hidden, true);
    }
    assert.equal(h.bar().hidden, true);
    assert.equal(h.requests[0].signal.aborted, true);
    await h.timers.advance(10_000);
    assert.equal(h.requests.length, 1);
    await h.change(IDs.cpu, true);
    assert.equal(h.bar().hidden, false);
    assert.equal(h.requests.length, 2);
});

test('慢请求不重叠，超时使旧值不可用且下一周期能恢复', async () => {
    const h = await harness();
    await h.setup();
    await h.timers.advance(4000);
    assert.equal(h.requests.length, 1);
    await h.timers.advance(1000);
    assert.equal(h.requests[0].signal.aborted, true);
    assert.match(h.metric('cpu').textContent, /不可用/);
    await h.timers.advance(1000);
    assert.equal(h.requests.length, 2);
    h.requests[1].respond(snapshot(h.timers.now));
    await settle();
    assert.match(h.metric('cpu').textContent, /25\.5%/);
    h.requests[0].respond(snapshot(h.timers.now, { cpu: { utilization_percent: 99 } }));
    await settle();
    assert.match(h.metric('cpu').textContent, /25\.5%/);
});

test('断线与 HTTP 错误清除旧值，恢复后继续显示新读数', async () => {
    const h = await harness();
    await h.setup();
    h.requests[0].respond(snapshot(h.timers.now));
    await settle();
    await h.timers.advance(1000);
    h.requests[1].fail();
    await settle();
    assert.match(h.metric('cpu').textContent, /不可用/);
    assert.equal(h.metric('cpu').querySelector('.enhance-kit-resource-fill').style.width, '0%');
    await h.timers.advance(1000);
    h.requests[2].respond({}, false);
    await settle();
    assert.match(h.metric('memory').textContent, /不可用/);
    await h.timers.advance(1000);
    h.requests[3].respond(snapshot(h.timers.now));
    await settle();
    assert.match(h.metric('memory').title, /25\.0% 8\.0\/32\.0 GiB/);
});

test('关闭后迟到响应不能改动状态或复活定时器，重新开启即时刷新', async () => {
    const h = await harness();
    await h.setup();
    await h.change(IDs.interval, 0);
    const before = h.bar().textContent;
    h.requests[0].respond(snapshot(h.timers.now));
    await settle();
    assert.equal(h.bar().textContent, before);
    await h.timers.advance(10_000);
    assert.equal(h.requests.length, 1);
    await h.change(IDs.interval, 2);
    assert.equal(h.requests.length, 2);
    h.requests[1].respond(snapshot(h.timers.now));
    await settle();
    await h.timers.advance(1999);
    assert.equal(h.requests.length, 2);
    await h.timers.advance(1);
    assert.equal(h.requests.length, 3);
});

test('页面隐藏暂停并取消请求，恢复显示后即时获取新快照', async () => {
    const h = await harness();
    await h.setup();
    h.document.hidden = true;
    h.document.visibilityState = 'hidden';
    h.document.dispatch('visibilitychange');
    await settle();
    assert.equal(h.requests[0].signal.aborted, true);
    await h.timers.advance(10_000);
    assert.equal(h.requests.length, 1);
    h.document.hidden = false;
    h.document.visibilityState = 'visible';
    h.document.dispatch('visibilitychange');
    await settle();
    assert.equal(h.requests.length, 2);
});

test('菜单祖先隐藏暂停，恢复后即时刷新', async () => {
    const h = await harness();
    await h.setup();
    h.top.style.display = 'none';
    h.top.setAttribute('style', 'display: none');
    await settle();
    assert.equal(h.requests[0].signal.aborted, true);
    await h.timers.advance(10_000);
    assert.equal(h.requests.length, 1);
    h.top.style.display = 'flex';
    h.top.setAttribute('style', 'display: flex');
    await settle();
    assert.equal(h.requests.length, 2);
});

test('Focus Mode 删除后重建真实菜单容器，恢复原条且始终唯一', async () => {
    const h = await harness();
    await h.setup();
    const original = h.bar();
    h.legacy.remove();
    await settle();
    assert.equal(h.requests[0].signal.aborted, true);
    await h.timers.advance(10_000);
    assert.equal(h.requests.length, 1);
    const replacement = h.document.createElement('div');
    replacement.dataset.testid = 'legacy-topbar-container';
    h.top.append(replacement);
    await settle();
    assert.equal(h.menu.parentElement, replacement);
    assert.equal(h.bar(), original);
    assert.equal(h.document.querySelectorAll('.enhance-kit-resources').length, 1);
    assert.equal(h.requests.length, 2);
    await h.setup();
    assert.equal(h.document.querySelectorAll('.enhance-kit-resources').length, 1);
});

test('浮动菜单移动复用条，数值不会重建或停止刷新', async () => {
    const h = await harness();
    await h.setup();
    const original = h.bar();
    const floating = h.document.createElement('div');
    h.top.append(floating);
    floating.append(h.legacy);
    await settle();
    assert.equal(h.bar(), original);
    assert.equal(h.requests[0].signal.aborted, false);
    h.requests[0].respond(snapshot(h.timers.now));
    await settle();
    assert.match(h.metric('cpu').textContent, /25\.5%/);
});

test('挂起请求期间已显示数值按收到后的单调时间过期', async () => {
    const h = await harness();
    await h.setup();
    h.requests[0].respond(snapshot(h.timers.now));
    await settle();
    assert.match(h.metric('cpu').textContent, /25\.5%/);
    await h.timers.advance(3001);
    assert.match(h.metric('cpu').textContent, /不可用/);
});

test('服务端时钟前后相差五秒，新采样仍可用且按客户端单调时间过期', async () => {
    for (const offset of [-5000, 5000]) {
        const h = await harness();
        await h.setup();
        h.requests[0].respond(snapshot(h.timers.now + offset));
        await settle();
        assert.match(h.metric('cpu').textContent, /25\.5%/, `clock offset ${offset}`);
        await h.timers.advance(3001);
        assert.match(h.metric('cpu').textContent, /不可用/, `expired clock offset ${offset}`);
    }
});

test('浏览器 wallclock 前拨或回拨不影响新样本的可用期', async () => {
    for (const adjustment of [-60_000, 60_000]) {
        const h = await harness();
        await h.setup();
        h.requests[0].respond(snapshot(h.timers.now));
        await settle();
        h.timers.wallClockOffset = adjustment;
        h.window.dispatch('resize');
        assert.match(h.metric('cpu').textContent, /25\.5%/, `adjustment ${adjustment}`);
        await h.timers.advance(1000);
        h.requests[1].respond(snapshot(h.timers.now, { cpu: { utilization_percent: 50 } }));
        await settle();
        assert.match(h.metric('cpu').textContent, /50\.0%/, `new sample after adjustment ${adjustment}`);
        await h.timers.advance(3001);
        assert.match(h.metric('cpu').textContent, /不可用/, `expired after adjustment ${adjustment}`);
    }
});

test('重复相同采样时间不能延长旧值可用期，过期后重复响应仍不可用', async () => {
    const h = await harness();
    await h.setup();
    const original = snapshot(h.timers.now);
    h.requests[0].respond(original);
    await settle();
    for (let index = 1; index <= 3; index++) {
        await h.timers.advance(1000);
        h.requests[index].respond(original);
        await settle();
    }
    await h.timers.advance(1);
    assert.match(h.metric('cpu').textContent, /不可用/);
    await h.timers.advance(999);
    h.requests[4].respond(original);
    await settle();
    assert.match(h.metric('cpu').textContent, /不可用/);
});

test('服务端校正为较早的不同时间戳时，新样本仍会恢复显示', async () => {
    const h = await harness();
    await h.setup();
    h.requests[0].respond(snapshot(h.timers.now));
    await settle();
    await h.timers.advance(1000);
    h.requests[1].respond(snapshot(h.timers.now - 60_000, { cpu: { utilization_percent: 50 } }));
    await settle();
    assert.match(h.metric('cpu').textContent, /50\.0%/);
    await h.timers.advance(3001);
    assert.match(h.metric('cpu').textContent, /不可用/);
});

test('非有限采样时间不能被当成新的有效样本', async () => {
    for (const sampledAt of [null, undefined, NaN, Infinity]) {
        const h = await harness();
        await h.setup();
        h.requests[0].respond(snapshot(sampledAt));
        await settle();
        assert.match(h.metric('cpu').textContent, /不可用/);
    }
});
test('面板先于首份快照缓存 GPU 选项时，新枚举仍更新已开面板并保留选择', async () => {
    const h = await harness({ [IDs.device]: 2 });
    await h.setup();
    const readOptions = h.optionsReader(IDs.device);
    assert.equal(readOptions().some((option) => option.value === 2), false);
    const data = snapshot(h.timers.now);
    data.gpus.push({ index: 2, name: 'GPU B', utilization_percent: 15, temperature_c: 45, memory: { used_bytes: 2 * GiB, total_bytes: 8 * GiB, utilization_percent: 25 } });
    h.requests[0].respond(data);
    await settle();
    assert.ok(readOptions().some((option) => option.value === 2 && option.text.includes('GPU B')));
    assert.equal(h.app.extensionManager.setting.get(IDs.device), 2);
    assert.match(h.metric('gpu').textContent, /15\.0%/);
});

test('GPU 名称或索引变化更新已开面板，仅指标改变时保持选项数组', async () => {
    const h = await harness();
    await h.setup();
    const readOptions = h.optionsReader(IDs.device);
    readOptions();
    h.requests[0].respond(snapshot(h.timers.now));
    await settle();
    const original = readOptions();
    assert.ok(original.some((option) => option.value === 0 && option.text.includes('GPU A')));
    await h.timers.advance(1000);
    const sameDevices = snapshot(h.timers.now);
    sameDevices.gpus[0].utilization_percent = 50;
    h.requests[1].respond(sameDevices);
    await settle();
    assert.equal(readOptions(), original);
    assert.match(h.metric('gpu').textContent, /50\.0%/);
    await h.timers.advance(1000);
    const changedDevices = snapshot(h.timers.now);
    changedDevices.gpus[0].name = 'GPU A renamed';
    h.requests[2].respond(changedDevices);
    await settle();
    assert.ok(readOptions().some((option) => option.value === 0 && option.text.includes('GPU A renamed')));
    await h.timers.advance(1000);
    const newDevice = snapshot(h.timers.now);
    newDevice.gpus[0].index = 3;
    h.requests[3].respond(newDevice);
    await settle();
    assert.equal(readOptions().some((option) => option.value === 0), false);
    assert.ok(readOptions().some((option) => option.value === 3));
    await h.timers.advance(1000);
    h.requests[4].respond(snapshot(h.timers.now, { gpus: [] }));
    await settle();
    assert.equal(readOptions().some((option) => option.value === 3), false);
    assert.match(h.metric('gpu').textContent, /不可用/);
});
test('自动模式跳过全部指标不可用的首卡，显示后续可用 GPU', async () => {
    const h = await harness();
    await h.setup();
    const data = snapshot(h.timers.now);
    data.gpus[0] = { index: 0, name: 'GPU A', utilization_percent: null, temperature_c: null, memory: { used_bytes: null, total_bytes: null, utilization_percent: null } };
    data.gpus.push({ index: 1, name: 'GPU B', utilization_percent: 75, temperature_c: 52, memory: { used_bytes: 4 * GiB, total_bytes: 16 * GiB, utilization_percent: 25 } });
    h.requests[0].respond(data);
    await settle();
    assert.match(h.metric('gpu').textContent, /75\.0%/);
    assert.match(h.metric('temperature').textContent, /52°C/);
    assert.match(h.metric('vram').title, /25\.0% 4\.0\/16\.0 GiB/);
    assert.match(h.metric('gpu').title, /GPU B/);
    assert.equal(h.app.extensionManager.setting.get(IDs.device), -1);
});

test('自动模式优先部分可读的首卡，零温度或零显存字段也表示可用', async () => {
    for (const readable of ['temperature', 'memory']) {
        const h = await harness();
        await h.setup();
        const data = snapshot(h.timers.now);
        data.gpus[0] = { index: 0, name: 'GPU A', utilization_percent: null, temperature_c: null, memory: { used_bytes: null, total_bytes: null, utilization_percent: null } };
        if (readable === 'temperature') data.gpus[0].temperature_c = 0;
        else data.gpus[0].memory.used_bytes = 0;
        data.gpus.push({ index: 1, name: 'GPU B', utilization_percent: 75, temperature_c: 52, memory: { used_bytes: 4 * GiB, total_bytes: 16 * GiB, utilization_percent: 25 } });
        h.requests[0].respond(data);
        await settle();
        assert.match(h.metric('gpu').title, /GPU A/);
        assert.match(h.metric('gpu').textContent, /不可用/);
        if (readable === 'temperature') assert.match(h.metric('temperature').textContent, /0°C/);
        assert.equal(h.app.extensionManager.setting.get(IDs.device), -1);
    }
});

test('显式选择失效首卡时仍显示不可用，不自动改选后续 GPU', async () => {
    const h = await harness({ [IDs.device]: 0 });
    await h.setup();
    const data = snapshot(h.timers.now);
    data.gpus[0] = { index: 0, name: 'GPU A', utilization_percent: null, temperature_c: null, memory: { used_bytes: null, total_bytes: null, utilization_percent: null } };
    data.gpus.push({ index: 1, name: 'GPU B', utilization_percent: 75, temperature_c: 52, memory: { used_bytes: 4 * GiB, total_bytes: 16 * GiB, utilization_percent: 25 } });
    h.requests[0].respond(data);
    await settle();
    assert.match(h.metric('gpu').textContent, /不可用/);
    assert.match(h.metric('temperature').textContent, /不可用/);
    assert.match(h.metric('vram').textContent, /不可用/);
    assert.match(h.metric('gpu').title, /GPU A/);
    assert.equal(h.app.extensionManager.setting.get(IDs.device), 0);
});