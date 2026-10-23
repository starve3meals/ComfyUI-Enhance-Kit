import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend, settle } from './execution_link_flow_helpers.mjs';

test('native JSON POST gets metadata while all native fields and options survive', async () => {
    const f = await loadFrontend(); const data = await f.app.graphToPrompt();
    await f.api.queuePrompt(-1, data, { partialExecutionTargets: ['2'] }); await settle();
    const body = JSON.parse(f.requests.findLast((r) => r.route === '/prompt').options.body);
    assert.equal(body.extra_data.enhance_kit_link_flow.schema, 1); assert.equal(body.extra_data.enhance_kit_link_flow.enabled, true);
    assert.equal(body.extra_data.auth_token_comfy_org, 'auth'); assert.equal(body.front, true); assert.deepEqual(body.partial_execution_targets, ['2']);
    assert.deepEqual(body.prompt, f.output); assert.deepEqual(body.extra_data.extra_pnginfo.workflow, f.workflow);
});
test('default setting is off and backend unavailable does not claim enabled', async () => {
    const f = await loadFrontend({ enabled: false }); assert.equal(f.extensions[0].settings[0].defaultValue, false);
    assert.equal((await f.submit()).body.extra_data.enhance_kit_link_flow, undefined);
    const g = await loadFrontend({ available: false }); assert.equal((await g.submit()).body.extra_data.enhance_kit_link_flow, undefined); assert.equal(g.notices.length, 1);
    assert.match(g.notices[0].detail, /ComfyUI core/);
});
test('concurrent submissions use unique tokens and exact export object identity', async () => {
    const f = await loadFrontend(); const data = await f.app.graphToPrompt();
    await Promise.all([f.api.queuePrompt(0, data), f.api.queuePrompt(0, data)]);
    const bodies = f.requests.filter((r) => r.route === '/prompt').map((r) => JSON.parse(r.options.body));
    assert.notEqual(bodies[0].extra_data.enhance_kit_link_flow.run_token, bodies[1].extra_data.enhance_kit_link_flow.run_token);
    await f.api.queuePrompt(0, { ...data }); const body = JSON.parse(f.requests.findLast((r) => r.route === '/prompt').options.body);
    assert.equal(body.extra_data.enhance_kit_link_flow, undefined);
});
test('ambiguous nested request context and unrelated request completely pass through', async () => {
    let nesting = false;
    const f = await loadFrontend({ queueImpl: function (number, data) {
        if (!nesting) { nesting = true; const result = this.queuePrompt(number, data); nesting = false; return result; }
        return this.fetchApi('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: data.output, client_id: this.clientId, extra_data: { extra_pnginfo: { workflow: data.workflow } } }) }).then((r) => r.json());
    } });
    const data = await f.app.graphToPrompt(); await f.api.queuePrompt(0, data);
    assert.equal(JSON.parse(f.requests.findLast((r) => r.route === '/prompt').options.body).extra_data.enhance_kit_link_flow, undefined);
    const options = { method: 'POST', body: 'payload', credentials: 'include' }; await f.api.fetchApi('/other', options); assert.equal(f.requests.at(-1).options, options);
});
test('export graph mutations and rewritten request bodies skip observation', async () => {
    const f = await loadFrontend(); const data = await f.app.graphToPrompt(); f.graph._version++;
    await f.api.queuePrompt(0, data); assert.equal(JSON.parse(f.requests.findLast((r) => r.route === '/prompt').options.body).extra_data.enhance_kit_link_flow, undefined);
    const g = await loadFrontend(); const changed = await g.app.graphToPrompt(); changed.output['2'].inputs.value = ['1', 1];
    await g.api.queuePrompt(0, changed); assert.equal(JSON.parse(g.requests.findLast((r) => r.route === '/prompt').options.body).extra_data.enhance_kit_link_flow, undefined);
});
test('event before response clone and terminal before acknowledgement cannot resurrect', async () => {
    let release; const f = await loadFrontend({ fetchImpl: (route) => route === '/prompt' ? new Promise((resolve) => { release = resolve; }) : new Response('{}') });
    const pending = f.api.queuePrompt(0, await f.app.graphToPrompt()); const body = JSON.parse(f.requests.at(-1).options.body);
    f.emit(body); f.draw(); assert.ok(f.renders.at(-1)[5] > 0);
    f.api.dispatch('execution_error', { prompt_id: 'job-1' }); assert.equal(f.frames.size, 0);
    release(new Response(JSON.stringify({ prompt_id: 'job-1' }))); assert.equal((await pending).prompt_id, 'job-1'); await settle();
    f.emit(body, { event_id: 2 }); f.draw(); assert.equal(f.renders.at(-1)[5], null);
});
test('response cloning leaves original body readable and failed request is never retried', async () => {
    const response = new Response(JSON.stringify({ prompt_id: 'job-1' }));
    const f = await loadFrontend({ fetchImpl: () => response }); const result = await f.submit(); assert.equal(result.result.prompt_id, 'job-1'); assert.equal(response.bodyUsed, true);
    let calls = 0; const g = await loadFrontend({ fetchImpl: () => { calls++; throw Error('network'); } });
    await assert.rejects(g.api.queuePrompt(0, await g.app.graphToPrompt()), /network/); assert.equal(calls, 1); assert.equal(g.frames.size, 0);
});
test('render keeps host shape color reroute return and existing flow, never changes last_time', async () => {
    const f = await loadFrontend(); const { body } = await f.submit(); f.emit(body); const extras = { reroute: { id: 99 }, startControl: [8, 5] };
    assert.equal(f.draw(null, extras), undefined); const args = f.renders.at(-1); assert.ok(args[5] > 0); assert.equal(args[6], '#abc'); assert.equal(args[10].reroute, extras.reroute); assert.equal(args[10].startControl, extras.startControl); assert.equal(f.link._last_time, undefined);
    f.draw(.9); assert.equal(f.renders.at(-1)[5], .9);
});
test('no idle RAF and duplicate event does not extend 450ms', async () => {
    const f = await loadFrontend(); assert.equal(f.frames.size, 0); const { body } = await f.submit(); assert.equal(f.frames.size, 0);
    f.emit(body); assert.equal(f.frames.size, 1); await f.advance(300); f.emit(body); await f.advance(150);
    assert.equal(f.frames.size, 0); f.draw(); assert.equal(f.renders.at(-1)[5], null);
    const count = f.dirty.length; await f.advance(1000); assert.equal(f.dirty.length, count);
});
test('hidden page drops backlog and resumes only new deliveries', async () => {
    const f = await loadFrontend(); const { body } = await f.submit(); f.emit(body); f.document.hidden = true; f.document.dispatch('visibilitychange'); assert.equal(f.frames.size, 0);
    f.emit(body, { event_id: 2 }); f.document.hidden = false; f.document.dispatch('visibilitychange'); f.draw(); assert.equal(f.renders.at(-1)[5], null);
    f.emit(body, { event_id: 3 }); f.draw(); assert.ok(f.renders.at(-1)[5] > 0);
});
test('reduced motion change, setting disable, mode switch and disconnect stop immediately', async () => {
    for (const change of [(f) => { f.motion.matches = true; f.motion.dispatch('change'); }, (f) => f.setting.set('EnhanceKit.ExecutionLinkFlow.Enabled', false), (f) => f.setting.set('Comfy.VueNodes.Enabled', true), (f) => f.api.dispatch('reconnecting')]) {
        const f = await loadFrontend(); const { body } = await f.submit(); f.emit(body); change(f); assert.equal(f.frames.size, 0); f.emit(body, { event_id: 2 }); f.draw(); assert.equal(f.renders.at(-1)[5], null);
    }
});
test('queue removal cleans only acknowledged snapshot IDs and keeps waiting entries', async () => {
    let queue = { queue_running: [], queue_pending: [[0, 'job-1']] };
    const f = await loadFrontend({ fetchImpl: (route) => new Response(JSON.stringify(route === '/queue' ? queue : { prompt_id: 'job-1' })) });
    const { body } = await f.submit(); f.api.dispatch('status', {}); await settle(); f.emit(body); f.draw(); assert.ok(f.renders.at(-1)[5] > 0);
    queue = { queue_running: [], queue_pending: [] }; f.api.dispatch('status', {}); await settle(); f.draw(); assert.equal(f.renders.at(-1)[5], null);
});
test('foreign wrapper preserved on unload and listeners are removed', async () => {
    const f = await loadFrontend(); const ourRender = f.canvas.renderLink, foreign = function (...args) { return ourRender.apply(this, args); }; f.canvas.renderLink = foreign;
    f.window.dispatch('pagehide'); assert.equal(f.canvas.renderLink, foreign); assert.equal(f.api.queuePrompt, f.originals.queuePrompt);
    assert.equal(f.api.listeners.get('enhance-kit.inputs-delivered').size, 0); assert.equal(f.frames.size, 0);
});

test('only a freshly exported verified frontend version can opt in', async () => {
    for (const version of [undefined, '1.55.17', '1.56.0']) {
        const f = await loadFrontend(); f.workflow.extra.frontendVersion = version;
        assert.equal((await f.submit()).body.extra_data.enhance_kit_link_flow, undefined);
        assert.equal(f.values.get('EnhanceKit.ExecutionLinkFlow.Enabled'), false);
    }
});

test('same version with an unknown active renderer stays unavailable', async () => {
    const f = await loadFrontend({ rendererSource: 'renderLink(...args) { return this.linkRenderer.renderLinkDirect(...args); }' });
    assert.equal((await f.submit()).body.extra_data.enhance_kit_link_flow, undefined);
    assert.equal(f.notices.length, 1);
});

test('malformed JSON and nonlocal prompt calls do not disable following confirmed submissions', async () => {
    const f = await loadFrontend(); const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' };
    await f.api.fetchApi('/prompt', options); await f.api.fetchApi('https://elsewhere.invalid/prompt', options);
    assert.equal(f.requests.at(-1).options, options); assert.equal(f.notices.length, 0);
    assert.ok((await f.submit()).body.extra_data.enhance_kit_link_flow);
});

test('graph mutation during export and same instance lifecycle do not preserve old mappings', async () => {
    const f = await loadFrontend(); const dataPromise = f.app.graphToPrompt(); f.graph._version++;
    await f.api.queuePrompt(0, await dataPromise); assert.equal(JSON.parse(f.requests.at(-1).options.body).extra_data.enhance_kit_link_flow, undefined);
    const g = await loadFrontend(); const { body } = await g.submit(); g.graph.events.dispatch('node:before-removed', { node: g.target });
    g.graph._nodes.pop(); g.graph._version++; g.graph._nodes.push(g.target); g.graph._version++;
    g.emit(body); g.draw(); assert.equal(g.renders.at(-1)[5], null);
});

test('success preserves remainder and reconnect never accepts old tokens', async () => {
    const f = await loadFrontend(); const { body } = await f.submit(); f.emit(body); await f.advance(100);
    f.api.dispatch('execution_success', { prompt_id: 'job-1' }); f.draw(); assert.ok(f.renders.at(-1)[5] > 0);
    f.emit(body, { event_id: 2 }); await f.advance(350); f.draw(); assert.equal(f.renders.at(-1)[5], null);
    f.api.dispatch('reconnecting'); f.api.dispatch('reconnected'); await settle(); f.emit(body, { event_id: 3 }); f.draw(); assert.equal(f.renders.at(-1)[5], null);
});

test('one canvas pass validates a hundred simultaneous links with linear lookup work', async () => {
    const f = await loadFrontend(); f.graph.links.clear(); f.target.inputs = []; f.source.outputs[0].links = []; f.output['2'].inputs = {};
    const edges = [];
    for (let i = 0; i < 100; i++) {
        f.graph.links.set(i, { id: i, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: i });
        f.target.inputs.push({ name: 'value_' + i, type: 'INT', link: i }); f.source.outputs[0].links.push(i);
        f.output['2'].inputs['value_' + i] = ['1', 0]; edges.push({ source_node: '1', source_slot: 0, target_node: '2', target_input: 'value_' + i });
    }
    f.graph._version++; const { body } = await f.submit(); f.emit(body, { edges });
    let lookups = 0; const original = f.graph.getNodeById; f.graph.getNodeById = function (...args) { lookups++; return original.apply(this, args); };
    const outputLinks = f.source.outputs[0].links; let fanoutReads = 0;
    Object.defineProperty(f.source.outputs[0], 'links', { get() { fanoutReads++; return outputLinks; } });
    f.canvas.drawConnections({}); assert.equal(f.renders.length, 100); assert.ok(f.renders.every((args) => args[5] > 0));
    assert.ok(lookups < 1000, 'a canvas pass must not rescan all active edges for every link: ' + lookups);
    assert.ok(fanoutReads < 1000, 'a canvas pass must not scan the whole fan-out for every edge: ' + fanoutReads);
});

test('observer and notice failures still call the original POST exactly once', async () => {
    const f = await loadFrontend(); const data = await f.app.graphToPrompt();
    f.graph.getNodeById = () => { throw Error('observer graph failure'); };
    f.app.extensionManager.toast.add = () => { throw Error('toast failure'); };
    const result = await f.api.queuePrompt(0, data); assert.equal(result.prompt_id, 'job-1');
    const posts = f.requests.filter((r) => r.route === '/prompt'); assert.equal(posts.length, 1);
    assert.equal(JSON.parse(posts[0].options.body).extra_data.enhance_kit_link_flow, undefined);
});

test('queue removal before acknowledgement cannot leave a live mapping', async () => {
    let release;
    const f = await loadFrontend({ fetchImpl: (route) => route === '/prompt'
        ? new Promise((resolve) => { release = resolve; })
        : new Response(JSON.stringify({ queue_running: [], queue_pending: [] })) });
    const pending = f.api.queuePrompt(0, await f.app.graphToPrompt()); const body = JSON.parse(f.requests.at(-1).options.body);
    f.api.dispatch('status', {}); release(new Response(JSON.stringify({ prompt_id: 'job-1' }))); await pending; await settle();
    f.emit(body); f.draw(); assert.equal(f.renders.at(-1)[5], null);
});

test('unknown rendering mode does not silently become legacy', async () => {
    const f = await loadFrontend(); delete f.context.LiteGraph.vueNodesMode;
    assert.equal((await f.submit()).body.extra_data.enhance_kit_link_flow, undefined);
});
