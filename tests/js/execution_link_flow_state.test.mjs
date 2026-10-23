import test from 'node:test';
import assert from 'node:assert/strict';
import { graphFixture, delivery, token, token2, loadState } from './execution_link_flow_helpers.mjs';

async function fixture() { const { LinkFlowState } = await loadState(); return { ...graphFixture(), state: new LinkFlowState() }; }
function prepare(f, t = token) { assert.equal(f.state.prepare(f.graph, f.output, t), true); }
function links(f, now = 0) { return Array.from(f.state.activeLinks(f.graph, now), (x) => ({ ...x })); }

test('event before HTTP acknowledgement binds only the prepared run', async () => {
    const f = await fixture(); prepare(f);
    assert.equal(f.state.accept(delivery({ run_token: token2 }), f.graph, 0), 0);
    assert.equal(f.state.accept(delivery(), f.graph, 0), 1);
    assert.equal(f.state.acknowledge(token, 'job-1'), true);
    assert.deepEqual(links(f), [{ linkId: 7, progress: 0 }]);
    assert.equal(f.state.accept(delivery(), f.graph, 20), 0);
    assert.equal(f.state.acknowledge(token, 'other-job'), false);
    assert.deepEqual(links(f), []);
});
test('terminal before acknowledgement never resurrects a run', async () => {
    for (const outcome of ['success', 'error', 'interrupted', 'cancelled']) {
        const f = await fixture(); prepare(f); f.state.finish('job-1', outcome, 0);
        assert.equal(f.state.accept(delivery(), f.graph, 10), 0);
        assert.equal(f.state.acknowledge(token, 'job-1'), false);
        assert.deepEqual(links(f), []);
    }
});
test('duplicate event does not extend 450ms and same frame deliveries merge', async () => {
    const f = await fixture(); prepare(f);
    assert.equal(f.state.accept(delivery(), f.graph, 0), 1);
    assert.equal(f.state.accept(delivery({ event_id: 2, call_index: 1 }), f.graph, 1), 0);
    assert.equal(f.state.accept(delivery({ event_id: 2 }), f.graph, 200), 0);
    assert.equal(links(f, 225)[0].progress, .5);
    assert.deepEqual(links(f, 450), []);
});
test('success retains only existing pulse remainder, failures clear immediately', async () => {
    for (const outcome of ['success', 'error', 'interrupted', 'cancelled']) {
        const f = await fixture(); prepare(f); f.state.accept(delivery(), f.graph, 0); f.state.finish('job-1', outcome, 50);
        assert.equal(f.state.accept(delivery({ event_id: 2 }), f.graph, 100), 0);
        assert.equal(links(f, 200).length, outcome === 'success' ? 1 : 0);
        assert.deepEqual(links(f, 450), []);
    }
});
test('invalid metadata does not bind or create pulses', async () => {
    const invalid = [{ schema: 2 }, { prompt_id: 1 }, { node_id: 2 }, { call_index: -1 }, { event_id: NaN }, { event_id: Number.MAX_SAFE_INTEGER + 1 }, { edges: [{}] }, { edges: [{ source_node: '1', source_slot: 0, target_node: '3', target_input: 'value' }] }];
    for (const value of invalid) { const f = await fixture(); prepare(f); assert.equal(f.state.accept(delivery(value), f.graph, 0), 0); assert.deepEqual(links(f), []); }
});
test('same IDs with changed instances or ports reject stale events', async () => {
    const changes = [(f) => { f.graph = graphFixture().graph; }, (f) => { f.graph._nodes[1] = { ...f.target }; },
        (f) => { f.target.inputs[0] = { ...f.target.inputs[0] }; }, (f) => { f.target.inputs[0].name = 'other'; },
        (f) => { f.source.outputs[0] = { ...f.source.outputs[0] }; }, (f) => { f.link.origin_slot = 1; },
        (f) => { f.graph.links.set(7, { ...f.link }); }, (f) => { f.graph._version++; }];
    for (const change of changes) { const f = await fixture(); prepare(f); change(f); assert.equal(f.state.accept(delivery(), f.graph, 0), 0); assert.deepEqual(links(f), []); }
});
test('same instance remove add configure and restored ports stay invalid', async () => {
    const f = await fixture(); prepare(f); f.graph._nodes.pop(); f.graph._version++; f.graph._nodes.push(f.target); f.graph._version++;
    assert.equal(f.state.accept(delivery(), f.graph, 0), 0);
    const g = await fixture(); prepare(g); const input = g.target.inputs[0]; g.target.inputs = []; g.graph._version++; g.target.inputs = [input]; g.graph._version++;
    assert.equal(g.state.accept(delivery(), g.graph, 0), 0);
});
test('drawing revalidates instances and graph lifecycle', async () => {
    const f = await fixture(); prepare(f); f.state.accept(delivery(), f.graph, 0); f.graph._version++;
    assert.deepEqual(links(f, 10), []);
});
test('bypass and subgraph ambiguity never guesses display IDs', async () => {
    const f = await fixture(); f.target.mode = 4; assert.equal(f.state.prepare(f.graph, f.output, token), false);
    const g = await fixture(); g.output['2'].inputs.value = ['1:9', 0]; assert.equal(g.state.prepare(g.graph, g.output, token), false);
});
test('concurrent runs have independent sequence and prompt binding', async () => {
    const f = await fixture(); prepare(f); prepare(f, token2); f.state.acknowledge(token, 'job-1'); f.state.acknowledge(token2, 'job-2');
    assert.equal(f.state.accept(delivery({ event_id: 19 }), f.graph, 0), 1);
    assert.equal(f.state.accept(delivery({ run_token: token2, prompt_id: 'job-2', event_id: 3 }), f.graph, 100), 1);
    f.state.discard(token); assert.equal(links(f, 200).length, 1);
    f.state.clear(); assert.deepEqual(links(f, 200), []);
});
test('dropping visual backlog preserves identity for new deliveries', async () => {
    const f = await fixture(); prepare(f); f.state.accept(delivery(), f.graph, 0); f.state.dropPulses(); assert.deepEqual(links(f, 20), []);
    assert.equal(f.state.accept(delivery({ event_id: 2 }), f.graph, 100), 1);
});

test('bounded early terminal records cannot resurrect delayed acknowledgements after expiry', async () => {
    const f = await fixture(); prepare(f); f.state.finish('job-1', 'success', 0);
    f.state.activeLinks(f.graph, 30001);
    assert.equal(f.state.acknowledge(token, 'job-1'), false);
    assert.equal(f.state.accept(delivery(), f.graph, 30002), 0);
});
