import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document;
    this.children = []; this.dataset = {}; this.style = {}; this.attributes = {};
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false;
    this.textContent = ''; this.className = ''; this.listeners = new Map();
    this.classList = {
      add: name => { if (!this.className.split(' ').includes(name)) this.className += ` ${name}`; },
      remove: name => { this.className = this.className.split(' ').filter(item => item !== name).join(' '); },
      toggle: (name, force) => force ? this.classList.add(name) : this.classList.remove(name),
    };
  }
  append(...children) { for (const child of children) { child.remove(); this.children.push(child); child.parentElement = this; } }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  replaceWith(replacement) { const parent = this.parentElement; if (!parent) return; replacement.remove(); parent.children.splice(parent.children.indexOf(this), 1, replacement); replacement.parentElement = parent; this.parentElement = null; }
  get isConnected() { return this.tagName === 'BODY' || this.tagName === 'HEAD' || Boolean(this.parentElement?.isConnected); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, handler) { const handlers = this.listeners.get(name) ?? []; handlers.push(handler); this.listeners.set(name, handlers); }
  removeEventListener(name, handler) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== handler)); }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    event.currentTarget = this;
    for (const handler of this.listeners.get(event.type) ?? []) handler(event);
    this[`on${event.type}`]?.(event);
    if (!event.stopped && event.bubbles && this.parentElement) this.parentElement.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  querySelectorAll(selector) {
    const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    if (selector === '*') return all;
    const action = selector.match(/^\[data-action="(.+)"\]$/)?.[1];
    const className = selector.startsWith('.') ? selector.slice(1) : null;
    return all.filter(child => action ? child.dataset.action === action : className ? child.className.split(' ').includes(className) : child.tagName.toLowerCase() === selector);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() { this.ownerDocument.activeElement = this; }
  setCustomValidity(message) { this.validationMessage = message; }
}

export function event(type, extra = {}) {
  return { type, bubbles: true, defaultPrevented: false, stopped: false,
    stopPropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; }, ...extra };
}

export async function loadLoraManager(files = ['a.safetensors', 'sub/b.safetensors']) {
  const world = { extensions: [], removals: 0, changes: [], registry: new Set(), widgetValues: new Map(), hosts: new Map(), nextNodeId: 1 };
  const document = { activeElement: null };
  document.createElement = tag => new Element(tag, document);
  document.head = document.createElement('head'); document.body = document.createElement('body');
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  const graph = {
    id: 'graph-1',
    beforeChange() {}, afterChange() {},
    canvasAction(callback) { callback(world.canvas); },
  };
  graph.rootGraph = graph;
  const capture = phase => world.changes.push({ phase, value: world.currentNode?.widgets.find(widget => widget.name === 'loras')?.value });
  world.canvas = { emitBeforeChange() { capture('before'); }, emitAfterChange() { capture('after'); } };
  const app = { graph, rootGraph: graph, registerExtension(extension) { world.extensions.push(extension); } };
  const context = vm.createContext({ console, document, URL, setTimeout, clearTimeout });
  let source;
  try { source = await readFile(new URL('../../web/lora_manager.js', import.meta.url), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; source = ''; }
  const appModule = new vm.SyntheticModule(['app'], function () { this.setExport('app', app); }, { context });
  const module = new vm.SourceTextModule(source, { context, initializeImportMeta(meta) { meta.url = 'http://localhost/extensions/kit/lora_manager.js'; } });
  await module.link(specifier => { assert.equal(specifier, '../../scripts/app.js'); return appModule; });
  await module.evaluate();
  world.extension = world.extensions.find(extension => extension.name === 'EnhanceKit.LoraManager');
  assert.ok(world.extension, 'LoRA Manager extension must register its real node lifecycle');
  world.document = document; world.app = app;
  world.definition = async options => world.extension.beforeRegisterNodeDef(function Node() {}, {
    name: 'EnhanceKitLoraManager', input: { required: { model: ['MODEL'], loras: ['STRING', { default: '{"schema_version":1,"items":[]}', enhanceKitLoraOptions: options }] } },
  }, app);
  await world.definition(files);
  await world.extension.setup?.();
  world.node = async ({ value = '{"schema_version":1,"items":[]}', size = [320, 200], id = world.nextNodeId++, ownerGraph = graph, generatedInput = false } = {}) => {
    const node = { id, comfyClass: 'EnhanceKitLoraManager', graph: ownerGraph, size, inputs: [{ name: 'model' }], outputs: [{ name: 'model' }], widgets: [], dirty: 0,
      setSize(next) { this.size = [...next]; }, setDirtyCanvas() { this.dirty++; },
      removeInput(index) { this.inputs.splice(index, 1); },
      configure(info) { this.inputs = structuredClone(info.inputs); this.widgets.find(widget => widget.name === 'loras').value = info.widgets_values[0]; this.onConfigure?.(info); },
      computeSize() { return [240, 64 + this.widgets.reduce((sum, widget) => sum + (widget.options.getMinHeight?.() ?? 24), 0)]; },
      removeWidget(widget) { const id = widget.widgetId; widget.onRemove?.(); world.widgetValues.delete(id); this.widgets.splice(this.widgets.indexOf(widget), 1); },
      addDOMWidget(name, type, element, options) {
        const widget = { name, type, element, options, widgetId: `${this.graph.rootGraph.id}:${this.id}:${name}`, serializeValue() { return this.value; }, onRemove() { world.registry.delete(this); } };
        Object.defineProperty(widget, 'value', { get() { return options.getValue?.() ?? ''; }, set(value) { options.setValue?.(value); this.callback?.(this.value); } });
        this.widgets.push(widget); world.registry.add(widget); world.widgetValues.set(widget.widgetId, widget);
        const added = this.onAdded, removed = this.onRemoved;
        this.onAdded = function (...args) { added?.apply(this, args); world.registry.add(widget); };
        this.onRemoved = function (...args) { removed?.apply(this, args); widget.onRemove?.(); };
        return widget;
      },
    };
    const original = node.addDOMWidget('loras', 'customtext', document.createElement('textarea'), { getValue: () => value, setValue: next => { value = next; }, socketless: !generatedInput, dynamicPrompts: false });
    if (generatedInput) node.inputs.push({ name: 'loras', type: 'STRING', link: null, widget: { name: 'loras' } });
    const remove = original.onRemove;
    original.onRemove = function () { world.removals++; remove.call(this); };
    await world.extension.nodeCreated(node);
    world.currentNode = node;
    node.original = original;
    return node;
  };
  world.mount = (node, mode = 'vue') => {
    const current = widget(node);
    const owner = `${node.graph.id}:${node.id}:${current.name}`;
    let host = world.hosts.get(owner);
    // Nodes 2.0 reuses the same component by address/type and only mounts on creation.
    if (mode === 'vue' && host?.type === current.type) return host.element;
    const element = document.createElement('div'); document.body.append(element);
    element.append(current.element);
    world.hosts.set(owner, { element, type: current.type });
    if (mode === 'legacy') host?.element.remove();
    return element;
  };
  return world;
}

export const widget = node => node.widgets.find(item => item.name === 'loras');
export const rows = node => widget(node).element.querySelectorAll('.enhance-kit-lora-row');
export const control = (node, name, index) => (index === undefined ? widget(node).element : rows(node)[index]).querySelector(`[data-action="${name}"]`);
export const config = node => JSON.parse(widget(node).value);
export function click(node, name, index) { const button = control(node, name, index); assert.ok(button, `${name} control must exist`); if (!button.disabled) { button.focus(); button.dispatchEvent(event('click')); } }
export function edit(node, name, value, index, type = 'change') { const input = control(node, name, index); assert.ok(input, `${name} input must exist`); if (name === 'enabled') input.checked = value; else input.value = value; input.dispatchEvent(event(type)); return input; }
