import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLoraManager, widget, rows, control, config, click, edit, event } from './lora_manager_helpers.mjs';

test('replaces the STRING widget with one serialized JSON entry and disposes the old DOM widget', async () => {
  const world = await loadLoraManager(); const node = await world.node();
  assert.equal(node.widgets.length, 1);
  assert.equal(widget(node).value, '{"schema_version":1,"items":[]}');
  assert.equal(widget(node).serializeValue(), widget(node).value);
  assert.equal(world.registry.has(node.original), false);
  assert.equal(world.removals, 1);
  assert.equal(node.inputs.length, 1);
  assert.ok(node.size[0] >= 420);
});

test('add, independent field edits and delete update execution JSON without sharing duplicate rows', async () => {
  const world = await loadLoraManager(); const node = await world.node();
  click(node, 'add'); click(node, 'add');
  assert.deepEqual(config(node).items, [{ name: 'a.safetensors', enabled: true, strength: 1 }, { name: 'a.safetensors', enabled: true, strength: 1 }]);
  edit(node, 'enabled', false, 0); edit(node, 'name', 'sub/b.safetensors', 0); edit(node, 'strength', '-0.75', 0, 'input');
  assert.deepEqual(config(node).items, [{ name: 'sub/b.safetensors', enabled: false, strength: -0.75 }, { name: 'a.safetensors', enabled: true, strength: 1 }]);
  click(node, 'delete', 1);
  assert.equal(config(node).items.length, 1);
  assert.equal(config(node).items[0].enabled, false);
});

test('finite strength outside advertised range is preserved and ordinary input retains focus and DOM identity', async () => {
  const world = await loadLoraManager(); const node = await world.node(); click(node, 'add');
  const input = control(node, 'strength', 0); input.focus();
  edit(node, 'strength', '250.125', 0, 'input');
  assert.equal(config(node).items[0].strength, 250.125);
  assert.equal(control(node, 'strength', 0), input);
  assert.equal(world.document.activeElement, input);
  assert.equal(input.step, '0.01'); assert.equal(input.min, '-100'); assert.equal(input.max, '100');
  edit(node, 'strength', '', 0, 'input');
  assert.equal(config(node).items[0].strength, 250.125);
  assert.ok(input.validationMessage);
  input.dispatchEvent(event('blur'));
  assert.equal(input.value, '250.125');
});

test('move buttons reorder complete rows and publish old and new values at undo boundaries', async () => {
  const world = await loadLoraManager(); const node = await world.node();
  click(node, 'add'); click(node, 'add'); edit(node, 'name', 'sub/b.safetensors', 1); edit(node, 'enabled', false, 1);
  const before = widget(node).value; world.changes.length = 0;
  click(node, 'up', 1);
  assert.deepEqual(config(node).items, [{ name: 'sub/b.safetensors', enabled: false, strength: 1 }, { name: 'a.safetensors', enabled: true, strength: 1 }]);
  assert.deepEqual(world.changes, [{ phase: 'before', value: before }, { phase: 'after', value: widget(node).value }]);
  click(node, 'down', 0);
  assert.equal(widget(node).value, before);
  assert.equal(control(node, 'up', 0).disabled, true);
  assert.equal(control(node, 'down', 1).disabled, true);
});

test('drag handle drop uses local row order and rejects external drops without changing JSON', async () => {
  const world = await loadLoraManager(); const node = await world.node();
  click(node, 'add'); click(node, 'add'); edit(node, 'name', 'sub/b.safetensors', 1);
  const transfer = { effectAllowed: '', dropEffect: '', setData() {} };
  const start = event('dragstart', { dataTransfer: transfer }); control(node, 'drag', 1).dispatchEvent(start);
  const drop = event('drop', { dataTransfer: transfer }); rows(node)[0].dispatchEvent(drop);
  assert.deepEqual(config(node).items.map(item => item.name), ['sub/b.safetensors', 'a.safetensors']);
  assert.equal(start.stopped, true); assert.equal(drop.stopped, true); assert.equal(drop.defaultPrevented, true);
  const before = widget(node).value;
  widget(node).element.dispatchEvent(event('drop', { dataTransfer: { files: ['arbitrary.safetensors'] } }));
  assert.equal(widget(node).value, before);
});

test('save, reload and copied nodes preserve exact configuration while editing only their own state', async () => {
  const world = await loadLoraManager(); const first = await world.node(); click(first, 'add'); edit(first, 'strength', '-2', 0, 'input');
  const saved = widget(first).serializeValue();
  const second = await world.node({ value: saved });
  assert.equal(widget(second).value, saved);
  edit(second, 'enabled', false, 0);
  assert.equal(config(first).items[0].enabled, true);
  assert.equal(config(second).items[0].enabled, false);
  widget(second).value = saved;
  assert.equal(control(second, 'enabled', 0).checked, true);
  assert.equal(control(second, 'strength', 0).value, '-2');
});

for (const version of ['1.0', '1e0']) test(`restore canonicalizes schema version ${version} for Python without changing row values`, async () => {
  const world = await loadLoraManager();
  const expected = '{"schema_version":1,"items":[{"name":"sub/b.safetensors","enabled":false,"strength":-250.125},{"name":"a.safetensors","enabled":true,"strength":0.25}]}';
  const raw = ` { "schema_version": ${version}, "items": [{"name":"sub/b.safetensors","enabled":false,"strength":-250.125},{"name":"a.safetensors","enabled":true,"strength":2.5e-1}] } `;
  const node = await world.node({ value: raw });
  assert.equal(widget(node).value, expected);
  assert.equal(widget(node).serializeValue(), expected);
  assert.equal(control(node, 'enabled', 0).checked, false);
  assert.equal(control(node, 'strength', 0).value, '-250.125');
  assert.equal(control(node, 'name', 1).value, 'a.safetensors');
  widget(node).value = raw;
  assert.equal(widget(node).value, expected);
});

test('invalid restore after a valid configuration keeps the entire raw text instead of canonicalizing it', async () => {
  const world = await loadLoraManager(); const node = await world.node(); click(node, 'add');
  const raw = '  {"schema_version":1e0,"items":[{"name":"a.safetensors","enabled":true,"strength":true}]}  ';
  widget(node).value = raw;
  assert.equal(widget(node).value, raw); assert.equal(widget(node).serializeValue(), raw);
  assert.equal(control(node, 'raw').value, raw);
  assert.equal(control(node, 'add').disabled, true);
  assert.ok(control(node, 'status').textContent);
});

test('restore keeps malformed JSON, unsupported version and invalid field types intact with a visible error', async () => {
  for (const raw of ['{broken', '{"schema_version":2,"items":[]}', '{"schema_version":1,"items":[{"name":"a.safetensors","enabled":true,"strength":true}]}', '{"schema_version":1,"items":[{"name":"a.safetensors","enabled":false,"strength":1e999}]}']) {
    const world = await loadLoraManager(); const node = await world.node({ value: raw });
    assert.equal(widget(node).value, raw); assert.equal(widget(node).serializeValue(), raw);
    assert.equal(rows(node).length, 0);
    assert.ok(control(node, 'status').textContent);
    assert.equal(control(node, 'add').disabled, true);
    assert.equal(control(node, 'raw').value, raw);
  }
});

test('invalid restored JSON can be corrected explicitly without silently discarding its original contents', async () => {
  const world = await loadLoraManager(); const node = await world.node({ value: '{broken' });
  edit(node, 'raw', '{"schema_version":1,"items":[]}', undefined, 'input');
  assert.equal(widget(node).value, '{broken');
  click(node, 'apply');
  assert.equal(widget(node).value, '{"schema_version":1,"items":[]}');
  assert.equal(control(node, 'add').disabled, false);
  assert.deepEqual(world.changes.map(item => item.phase), ['before', 'after']);
});

test('definition refresh preserves missing filenames and field DOM while exposing the new official options', async () => {
  const world = await loadLoraManager(); const node = await world.node(); click(node, 'add');
  const select = control(node, 'name', 0), strength = control(node, 'strength', 0), before = widget(node).value;
  await world.definition(['new.safetensors']);
  assert.equal(widget(node).value, before);
  assert.equal(control(node, 'name', 0), select); assert.equal(control(node, 'strength', 0), strength);
  assert.ok(select.children.some(option => option.value === 'a.safetensors' && option.textContent.includes('不可用')));
  assert.ok(select.children.some(option => option.value === 'new.safetensors'));
  edit(node, 'name', 'new.safetensors', 0);
  assert.equal(config(node).items[0].name, 'new.safetensors');
  assert.equal(rows(node)[0].dataset.missing, 'false');
});

test('no files still allows adding an editable empty row, and list height is bounded without limiting row count', async () => {
  const world = await loadLoraManager([]); const node = await world.node({ size: [650, 200] });
  assert.ok(control(node, 'status').textContent.includes('暂无'));
  for (let index = 0; index < 30; index++) click(node, 'add');
  assert.equal(config(node).items.length, 30); assert.equal(config(node).items[0].name, '');
  assert.equal(node.size[0], 650); assert.ok(widget(node).options.getHeight() <= 460);
  const height = node.size[1];
  for (let index = 0; index < 29; index++) click(node, 'delete', 0);
  assert.ok(node.size[1] < height); assert.equal(node.size[0], 650);
});

test('the mounted DOM element carries bounded height and shrinks again when rows are removed', async () => {
  const world = await loadLoraManager(); const node = await world.node({ size: [650, 200] });
  const root = widget(node).element;
  assert.equal(root.style.height, '126px');
  assert.equal(root.style.maxHeight, '126px');
  assert.equal(root.style.minHeight, '0px');
  for (let index = 0; index < 20; index++) click(node, 'add');
  assert.equal(config(node).items.length, 20);
  assert.equal(root.style.height, '420px');
  assert.equal(root.style.maxHeight, '420px');
  assert.equal(widget(node).options.getHeight(), 420);
  for (let index = 0; index < 19; index++) click(node, 'delete', 0);
  assert.equal(root.style.height, '126px');
  assert.equal(root.style.maxHeight, '126px');
  widget(node).value = '{broken';
  assert.equal(root.style.height, '220px');
  assert.equal(root.style.maxHeight, '220px');
  assert.equal(node.size[0], 650);
});

test('widget removal stops refresh and stale input changes, then readding restores the same current state', async () => {
  const world = await loadLoraManager(); const node = await world.node(); click(node, 'add');
  const input = control(node, 'strength', 0), select = control(node, 'name', 0), before = widget(node).value;
  node.onRemoved(); await world.definition(['new.safetensors']);
  input.value = '8'; input.dispatchEvent(event('input'));
  assert.equal(widget(node).value, before);
  assert.equal(select.children.some(option => option.value === 'new.safetensors'), false);
  assert.equal(world.registry.size, 0);
  node.onAdded();
  assert.equal(world.registry.has(node.original), false);
  assert.equal(world.registry.has(widget(node)), true);
  assert.ok(control(node, 'name', 0).children.some(option => option.value === 'new.safetensors'));
  edit(node, 'strength', '3', 0, 'input'); assert.equal(config(node).items[0].strength, 3);
});

test('pointer, keyboard and wheel events remain inside the DOM widget without blocking normal control defaults', async () => {
  const world = await loadLoraManager(); const node = await world.node(); click(node, 'add');
  for (const type of ['pointerdown', 'mousedown', 'keydown', 'wheel']) {
    const inputEvent = event(type); control(node, 'strength', 0).dispatchEvent(inputEvent);
    assert.equal(inputEvent.stopped, true); assert.equal(inputEvent.defaultPrevented, false);
  }
});

test('replacement widget preserves the socketless contract used by official input construction', async () => {
  const world = await loadLoraManager(); const node = await world.node();
  assert.equal(node.original.options.socketless, true);
  assert.equal(widget(node).options.socketless, true);
  assert.equal(widget(node).options.dynamicPrompts, false);
  click(node, 'add'); const saved = widget(node).value;
  node.onConfigure();
  assert.equal(widget(node).value, saved);
  assert.deepEqual(node.inputs, [{ name: 'model' }]);
});

test('button operations create a public canvas transaction without depending on a later mouseup', async () => {
  const world = await loadLoraManager(); const node = await world.node();
  click(node, 'add');
  assert.deepEqual(world.changes, [
    { phase: 'before', value: '{"schema_version":1,"items":[]}' },
    { phase: 'after', value: '{"schema_version":1,"items":[{"name":"a.safetensors","enabled":true,"strength":1}]}' },
  ]);
});

test('undo and redo shortcuts propagate from buttons while text and number editing stays isolated', async () => {
  const world = await loadLoraManager(); const node = await world.node(); click(node, 'add');
  for (const extra of [{ key: 'z', ctrlKey: true }, { key: 'z', ctrlKey: true, shiftKey: true }, { key: 'y', ctrlKey: true }, { key: 'z', metaKey: true }]) {
    const key = event('keydown', extra); control(node, 'add').dispatchEvent(key);
    assert.equal(key.stopped, false); assert.equal(key.defaultPrevented, false);
    const numberKey = event('keydown', extra); control(node, 'strength', 0).dispatchEvent(numberKey);
    assert.equal(numberKey.stopped, true); assert.equal(numberKey.defaultPrevented, false);
  }
  widget(node).value = '{broken';
  const textKey = event('keydown', { key: 'z', ctrlKey: true }); control(node, 'raw').dispatchEvent(textKey);
  assert.equal(textKey.stopped, true); assert.equal(textKey.defaultPrevented, false);
});

test('undo reconstruction with the same widget address replaces the reused Vue host with fresh node DOM and state', async () => {
  const world = await loadLoraManager(); const first = await world.node({ id: 7 }); first.onAdded();
  const host = world.mount(first);
  click(first, 'add'); click(first, 'add'); const saved = widget(first).value;
  click(first, 'add'); first.onRemoved();
  const restored = await world.node({ id: 7, value: saved }); restored.onAdded();
  assert.equal(world.mount(restored), host);
  assert.equal(widget(restored).element.isConnected, true);
  assert.equal(widget(first).element.isConnected, false);
  assert.equal(rows(restored).length, 2);
  assert.equal(world.widgetValues.get('graph-1:7:loras'), widget(restored));
  edit(restored, 'strength', '2', 0, 'input');
  assert.equal(config(first).items[0].strength, 1);
  assert.equal(config(restored).items[0].strength, 2);
  const old = control(first, 'strength', 0); old.value = '9'; old.dispatchEvent(event('input'));
  assert.equal(config(restored).items[0].strength, 2);
});

test('mounted nodes from another graph or copied node ID keep their own DOM during reconstruction', async () => {
  const world = await loadLoraManager();
  const first = await world.node({ id: 7 }); first.onAdded(); world.mount(first); click(first, 'add');
  const graph = { id: 'subgraph-2', rootGraph: world.app.rootGraph, canvasAction(callback) { callback(world.canvas); } };
  const nested = await world.node({ id: 7, ownerGraph: graph }); nested.onAdded(); const nestedHost = world.mount(nested);
  const copied = await world.node({ id: 8 }); copied.onAdded(); const copiedHost = world.mount(copied);
  first.onRemoved();
  const restored = await world.node({ id: 7, value: widget(first).value }); restored.onAdded(); world.mount(restored);
  assert.equal(widget(nested).element.parentElement, nestedHost);
  assert.equal(widget(copied).element.parentElement, copiedHost);
  assert.equal(widget(restored).element.isConnected, true);
});

test('legacy UUID hosts still move a rebuilt widget into their new container after old host teardown', async () => {
  const world = await loadLoraManager(); const first = await world.node({ id: 7 }); first.onAdded();
  const oldHost = world.mount(first, 'legacy'); click(first, 'add');
  first.onRemoved();
  const restored = await world.node({ id: 7, value: widget(first).value }); restored.onAdded();
  const newHost = world.mount(restored, 'legacy');
  assert.notEqual(newHost, oldHost);
  assert.equal(oldHost.isConnected, false);
  assert.equal(widget(restored).element.parentElement, newHost);
  assert.equal(widget(restored).element.isConnected, true);
  assert.equal(rows(restored).length, 1);
});

test('initial creation and configure remove only the STRING factory generated loras socket and keep JSON authoritative', async () => {
  const world = await loadLoraManager(); const node = await world.node({ generatedInput: true });
  assert.deepEqual(node.inputs, [{ name: 'model' }]);
  assert.equal(node.widgets.length, 1);
  const saved = '{"schema_version":1,"items":[{"name":"a.safetensors","enabled":false,"strength":0.5}]}';
  const generated = { name: 'loras', type: 'STRING', link: null, widget: { name: 'loras' } };
  node.configure({ inputs: [{ name: 'model' }, generated], widgets_values: [saved] });
  assert.deepEqual(node.inputs, [{ name: 'model' }]);
  assert.equal(widget(node).serializeValue(), saved);
  assert.equal(rows(node).length, 1);
  const unknown = { name: 'other', type: 'STRING', widget: { name: 'other' }, link: null };
  node.configure({ inputs: [{ name: 'model' }, unknown, generated], widgets_values: [saved] });
  assert.deepEqual(node.inputs, [{ name: 'model' }, unknown]);
  assert.equal(widget(node).value, saved);
});
