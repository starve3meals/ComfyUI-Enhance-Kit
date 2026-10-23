import asyncio
import contextvars
import gc
import importlib.util
import inspect
import sys
import types
import unittest
import weakref
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
TOKEN = "123e4567-e89b-42d3-a456-426614174000"
CURRENT = contextvars.ContextVar("test_host_node", default=None)


class HostContext:
    def __init__(self, prompt_id, node_id, list_index):
        self.value = types.SimpleNamespace(prompt_id=prompt_id, node_id=node_id, list_index=list_index)

    def __enter__(self):
        self.token = CURRENT.set(self.value)

    def __exit__(self, *args):
        CURRENT.reset(self.token)


def current_context():
    return CURRENT.get()


class Graph:
    def __init__(self):
        self.original_prompt = {"a": {"inputs": {}}, "b": {"inputs": {"value": ["a", 0]}}}
        self.node_overrides = {}

    def get_node(self, node_id):
        return self.node_overrides.get(node_id, self.original_prompt[node_id])


class Server:
    def __init__(self):
        self.client_id = "client"
        self.messages = []
        self.fail = False

    def send_sync(self, event, data, client):
        if self.fail:
            raise RuntimeError("sink failure")
        self.messages.append((event, data, client))


class Node:
    FUNCTION = "run"

    def __init__(self):
        self.entries = []

    def run(self, value):
        self.entries.append((CURRENT.get().prompt_id, value))
        return value


class AsyncNode(Node):
    async def run(self, value):
        self.entries.append((CURRENT.get().prompt_id, value))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        return value


def make_host():
    host = types.ModuleType("execution")
    host.start_gate = None
    host.before_input = None
    host.DynamicPrompt = Graph

    def get_input_data(inputs, class_def, unique_id, execution_list=None, dynprompt=None, extra_data=None):
        # The stub substitutes only the expensive host; monitoring and node bodies stay real.
        return execution_list, extra_data.get("missing", {}), extra_data.get("v3", {})

    async def get_output_data(prompt_id, unique_id, obj, input_data_all, execution_block_cb=None, pre_execute_cb=None, v3_data=None):
        method = getattr(obj, obj.FUNCTION)
        async def invoke():
            gate = host.start_gate.get(prompt_id) if isinstance(host.start_gate, dict) else host.start_gate
            if gate is not None:
                await gate.wait()
            with HostContext(prompt_id, unique_id, 0):
                return await method(**{k: v[0] for k, v in input_data_all.items()})
        if inspect.iscoroutinefunction(method):
            task = asyncio.create_task(invoke())
            # Deliberately return before the task has ever started.
            return [task], {}, False, True
        with HostContext(prompt_id, unique_id, 0):
            return method(**{k: v[0] for k, v in input_data_all.items()}), {}, False, False

    async def execute(server, dynprompt, caches, current_item, extra_data, executed, prompt_id, execution_list, pending_subgraph_results=None, pending_async_nodes=None, ui_outputs=None, asset_manager=None):
        if host.before_input:
            host.before_input(dynprompt)
        result = host.get_input_data(dynprompt.get_node(current_item)["inputs"], type(caches), current_item, execution_list, dynprompt, extra_data)
        return await host.get_output_data(prompt_id, current_item, caches, result[0], v3_data=result[2])

    host.get_input_data = get_input_data
    host.get_output_data = get_output_data
    host.execute = execute
    return host


class ObserverTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        path = ROOT / "execution_link_flow.py"
        self.assertTrue(path.is_file(), "缺少执行连线观测器，输入交付无法确认")
        spec = importlib.util.spec_from_file_location("link_flow_under_test", path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.host = make_host()
        self.server = Server()
        self.graph = Graph()
        self.node = Node()
        self.targets = {
            "execution.execute": (self.host, "execute"),
            "execution.get_input_data": (self.host, "get_input_data"),
            "execution.get_output_data": (self.host, "get_output_data"),
            "context": (types.SimpleNamespace(get=current_context), "get"),
        }
        self.patches = [
            patch.dict(sys.modules, {"execution": self.host}),
            patch.object(self.module, "_runtime_targets", lambda execution: self.targets),
            patch.object(self.module, "_get_context", current_context),
            patch.object(self.module, "_SUPPORTED_CODES", {name: self.module._code_digest(getattr(owner, attr).__code__) for name, (owner, attr) in self.targets.items()}),
            patch.object(self.module, "_FUNCTION_MODULES", {name: current_context.__module__ for name in self.targets}),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.observer = self.module.ExecutionLinkFlowObserver(self.server)
        self.addCleanup(self.observer.close)

    def install(self):
        self.assertEqual(self.observer.install(), {"schema": 1, "available": True, "reason_code": None})

    async def run_node(self, prompt="p", extra=None, graph=None, node=None, resolved=None):
        extra = extra if extra is not None else {"client_id": self.server.client_id, "enhance_kit_link_flow": {"schema": 1, "enabled": True, "run_token": TOKEN}}
        return await self.host.execute(self.server, graph or self.graph, node or self.node, "b", extra, set(), prompt, resolved if resolved is not None else {"value": [7]})

    async def test_delivery_requires_matching_input_and_function_entry(self):
        self.install()
        self.assertEqual(self.server.messages, [])
        result = await self.run_node()
        self.assertEqual(result, (7, {}, False, False))
        self.assertEqual(self.node.entries, [("p", 7)])
        self.assertEqual(self.server.messages, [("enhance-kit.inputs-delivered", {
            "schema": 1, "prompt_id": "p", "run_token": TOKEN, "event_id": 1,
            "node_id": "b", "call_index": 0,
            "edges": [{"source_node": "a", "source_slot": 0, "target_node": "b", "target_input": "value"}],
        }, "client")])
        self.assertIsNone(self.module._FRAME.get())

    async def test_missing_none_and_raw_link_are_distinct(self):
        self.install()
        await self.run_node(resolved={"value": [None]})
        self.assertEqual(len(self.server.messages), 1)
        extra = {"enhance_kit_link_flow": {"schema": 1, "enabled": True, "run_token": TOKEN}, "missing": {"value": True}}
        await self.run_node(extra=extra, resolved={"value": [None]})
        await self.run_node(resolved={"value": [self.graph.original_prompt["b"]["inputs"]["value"]]})
        self.assertEqual(len(self.server.messages), 1)

    async def test_async_contexts_and_shared_code_do_not_mix(self):
        self.install()
        self.host.start_gate = asyncio.Event()
        a, b = AsyncNode(), AsyncNode()
        results = await asyncio.gather(self.run_node("one", node=a), self.run_node("two", node=b))
        self.assertEqual(self.server.messages, [])
        self.assertTrue(sys.monitoring.get_local_events(self.observer._tool_id, AsyncNode.run.__code__))
        self.host.start_gate.set()
        await asyncio.gather(*(r[0][0] for r in results))
        await asyncio.sleep(0)
        self.assertEqual([m[1]["prompt_id"] for m in self.server.messages], ["one", "two"])
        self.assertEqual(a.entries, [("one", 7)])
        self.assertEqual(b.entries, [("two", 7)])
        self.assertEqual(sys.monitoring.get_local_events(self.observer._tool_id, AsyncNode.run.__code__), 0)

    async def test_binding_failure_and_recursive_entry_do_not_duplicate(self):
        class Recursive(Node):
            def run(self, value):
                self.entries.append(value)
                return self.run(value - 1) if value else 0
        self.install()
        with self.assertRaises(TypeError):
            await self.run_node(resolved={"wrong": [1]})
        self.assertFalse(self.server.messages)
        node = Recursive()
        await self.run_node(node=node, resolved={"value": [2]})
        self.assertEqual(node.entries, [2, 1, 0])
        self.assertEqual(len(self.server.messages), 1)

    async def test_unknown_or_replaced_runtime_disables_observer(self):
        self.install()
        original = self.host.get_input_data
        def same_signature(inputs, class_def, unique_id, execution_list=None, dynprompt=None, extra_data=None):
            return original(inputs, class_def, unique_id, execution_list, dynprompt, extra_data)
        self.host.get_input_data = same_signature
        await self.run_node()
        self.assertEqual(self.node.entries, [("p", 7)])
        self.assertFalse(self.server.messages)
        self.assertEqual(self.observer.status()["reason_code"], "adapter_conflict")
        self.observer.close()
        self.assertIs(self.host.get_input_data, same_signature)

    async def test_dynamic_inputs_and_overrides_remain_static(self):
        self.install()
        extra = {"enhance_kit_link_flow": {"schema": 1, "enabled": True, "run_token": TOKEN}, "v3": {"dynamic_paths": {"value": "nested.value"}}}
        await self.run_node(extra=extra)
        self.graph.node_overrides["a"] = {"inputs": {}}
        await self.run_node()
        self.assertFalse(self.server.messages)

    async def test_dynamic_descriptor_is_not_probed(self):
        class Dynamic(Node):
            @property
            def run(self):
                self.entries.append("lookup")
                return lambda value: value
        self.install()
        node = Dynamic()
        await self.run_node(node=node)
        self.assertEqual(node.entries, ["lookup"])
        self.assertFalse(self.server.messages)

    async def test_observer_failure_preserves_original_call(self):
        self.install()
        self.server.fail = True
        await self.run_node()
        self.server.fail = False
        await self.run_node()
        self.assertEqual(self.node.entries, [("p", 7), ("p", 7)])
        self.assertFalse(self.server.messages)
        await self.run_node(graph=Graph(), prompt="next")
        self.assertEqual(len(self.server.messages), 1)

    async def test_disabled_and_invalid_request_use_original_path(self):
        self.install()
        for value in [None, {}, {"schema": 2, "enabled": True, "run_token": TOKEN}, {"schema": 1, "enabled": True, "run_token": "bad"}, {"schema": True, "enabled": True, "run_token": TOKEN}]:
            await self.run_node(extra={"enhance_kit_link_flow": value})
        self.server.client_id = None
        await self.run_node()
        self.assertEqual(len(self.node.entries), 6)
        self.assertFalse(self.server.messages)
        self.assertFalse(self.observer._active_codes)

    async def test_repeated_install_and_close_pending_task(self):
        self.install()
        execute = self.host.execute
        self.install()
        self.assertIs(self.host.execute, execute)
        result = await self.run_node(node=AsyncNode())
        self.observer.close()
        self.observer.close()
        self.assertEqual(await result[0][0], 7)
        self.assertFalse(self.server.messages)
        self.assertEqual(self.observer.status()["reason_code"], "closed")
        self.assertTrue(all(sys.monitoring.get_tool(i) is None for i in (3, 4)))

    async def test_monitor_ownership_is_preserved(self):
        for slot in (3, 4):
            sys.monitoring.use_tool_id(slot, "foreign")
        try:
            self.assertEqual(self.observer.install()["reason_code"], "monitor_unavailable")
            await self.run_node()
            self.assertEqual(self.node.entries, [("p", 7)])
            self.observer.close()
            self.assertEqual([sys.monitoring.get_tool(i) for i in (3, 4)], ["foreign", "foreign"])
        finally:
            for slot in (3, 4):
                sys.monitoring.free_tool_id(slot)

    async def test_shared_code_stays_monitored_until_last_task_finishes(self):
        self.install()
        self.host.start_gate = {"two": asyncio.Event()}
        first = await self.run_node("one", node=AsyncNode())
        second = await self.run_node("two", node=AsyncNode())
        await first[0][0]
        await asyncio.sleep(0)
        self.assertTrue(sys.monitoring.get_local_events(self.observer._tool_id, AsyncNode.run.__code__))
        self.host.start_gate["two"].set()
        await second[0][0]
        await asyncio.sleep(0)
        self.assertEqual([m[1]["prompt_id"] for m in self.server.messages], ["one", "two"])
        self.assertEqual(sys.monitoring.get_local_events(self.observer._tool_id, AsyncNode.run.__code__), 0)

    async def test_send_failure_stops_other_active_contexts_for_same_graph(self):
        self.install()
        self.host.start_gate = {"two": asyncio.Event()}
        first = await self.run_node("p", node=AsyncNode())
        second = await self.run_node("two", node=AsyncNode())
        self.server.fail = True
        await first[0][0]
        self.server.fail = False
        self.host.start_gate["two"].set()
        await second[0][0]
        self.assertEqual(self.server.messages, [])

    async def test_in_place_code_replacement_preserves_new_runtime_behavior(self):
        self.install()
        original = self.observer._originals["get_output_data"]
        code = original.__code__
        host = self.host
        async def replacement(prompt_id, unique_id, obj, input_data_all, execution_block_cb=None, pre_execute_cb=None, v3_data=None):
            return (99 if host else 0), {}, False, False
        original.__code__ = replacement.__code__
        try:
            self.assertEqual(await self.run_node(), (99, {}, False, False))
            self.assertFalse(self.server.messages)
            self.assertEqual(self.observer.status()["reason_code"], "adapter_conflict")
        finally:
            original.__code__ = code

    async def test_foreign_slot_owner_is_not_released(self):
        self.install()
        slot = self.observer._tool_id
        sys.monitoring.free_tool_id(slot)
        sys.monitoring.use_tool_id(slot, "replacement-owner")
        try:
            await self.run_node()
            self.observer.close()
            self.assertEqual(sys.monitoring.get_tool(slot), "replacement-owner")
            self.assertEqual(self.node.entries, [("p", 7)])
            self.assertFalse(self.server.messages)
        finally:
            sys.monitoring.free_tool_id(slot)

    async def test_monitor_registration_and_cleanup_failures_are_isolated(self):
        class FaultMonitor:
            def __init__(self):
                self.failure = None

            def __getattr__(self, name):
                value = getattr(sys.monitoring, name)
                if not callable(value):
                    return value
                def call(*args):
                    if self.failure == name:
                        self.failure = None
                        raise RuntimeError("monitor operation failed")
                    return value(*args)
                return call
        for operation in ("register_callback", "set_local_events", "free_tool_id"):
            with self.subTest(operation=operation):
                observer = self.module.ExecutionLinkFlowObserver(self.server)
                self.addCleanup(observer.close)
                monitor = FaultMonitor()
                observer._monitor = monitor
                if operation == "register_callback":
                    monitor.failure = operation
                    self.assertEqual(observer.install()["reason_code"], "monitor_failure")
                    self.assertTrue(all(sys.monitoring.get_tool(i) is None for i in (3, 4)))
                    continue
                self.assertTrue(observer.install()["available"])
                if operation == "set_local_events":
                    monitor.failure = operation
                    await self.run_node()
                    self.assertFalse(self.server.messages)
                    try:
                        self.assertEqual(observer.status()["reason_code"], "monitor_failure")
                    finally:
                        observer.close()
                    continue
                monitor.failure = operation
                observer.close()
                observer.close()
                self.assertTrue(all(sys.monitoring.get_tool(i) is None for i in (3, 4)))

    async def test_node_exceptions_are_unchanged(self):
        class Failing(Node):
            def run(self, value):
                self.entries.append(value)
                raise ValueError("node error")
        self.install()
        node = Failing()
        with self.assertRaisesRegex(ValueError, "node error"):
            await self.run_node(node=node)
        self.assertEqual(node.entries, [7])
        self.assertEqual(len(self.server.messages), 1)
        self.assertFalse(self.observer._active_codes)

    async def test_graph_and_input_values_are_not_retained(self):
        class Value:
            pass
        self.install()
        graph, value = Graph(), Value()
        graph_ref, value_ref = weakref.ref(graph), weakref.ref(value)
        await self.run_node(graph=graph, resolved={"value": [value]})
        self.node.entries.clear()
        del graph, value
        gc.collect()
        self.assertIsNone(graph_ref())
        self.assertIsNone(value_ref())

    async def test_unsupported_python_and_initial_code_are_rejected(self):
        with patch.object(self.module.sys, "version_info", (3, 12, 9)):
            self.assertEqual(self.observer.install()["reason_code"], "unsupported_python")
        original = self.host.get_output_data
        async def replacement(*args, **kwargs):
            return await original(*args, **kwargs)
        self.host.get_output_data = replacement
        self.assertEqual(self.observer.install()["reason_code"], "unsupported_core")
        self.assertTrue(all(sys.monitoring.get_tool(i) is None for i in (3, 4)))

    async def test_graph_rewrite_between_dispatch_and_input_resolution_is_static(self):
        self.install()
        def rewrite(graph):
            graph.node_overrides["b"] = {"inputs": {"value": ["a", 0]}}
        self.host.before_input = rewrite
        await self.run_node()
        self.assertFalse(self.server.messages)
        self.assertEqual(self.node.entries, [("p", 7)])

    async def test_rewritten_link_description_does_not_reuse_old_source(self):
        self.install()
        self.graph.original_prompt["z"] = {"inputs": {}}
        def rewrite(graph):
            graph.original_prompt["b"]["inputs"]["value"] = ["z", 0]
        self.host.before_input = rewrite
        await self.run_node()
        self.assertFalse(self.server.messages)

    async def test_partial_close_keeps_slot_until_local_and_callback_cleanup_succeeds(self):
        for operation in ("set_local_events", "register_callback", "free_tool_id"):
            with self.subTest(operation=operation):
                self.install()
                self.host.start_gate = asyncio.Event()
                result = await self.run_node(node=AsyncNode())
                slot = self.observer._tool_id
                with patch.object(sys.monitoring, operation, side_effect=RuntimeError("cleanup failure")):
                    self.observer.close()
                self.assertEqual(sys.monitoring.get_tool(slot), self.observer._tool_name)
                self.assertEqual(self.observer.status()["reason_code"], "monitor_failure")
                self.observer.close()
                self.assertIsNone(sys.monitoring.get_tool(slot))
                self.host.start_gate.set()
                self.assertEqual(await result[0][0], 7)
                self.assertFalse(self.server.messages)

    async def test_event_is_pinned_to_dispatch_client(self):
        self.install()
        self.host.start_gate = asyncio.Event()
        result = await self.run_node(node=AsyncNode())
        self.server.client_id = "later-client"
        self.host.start_gate.set()
        await result[0][0]
        self.assertEqual(self.server.messages[0][2], "client")

    async def test_old_tasks_cannot_release_reinstalled_observer_monitoring(self):
        self.install()
        self.host.start_gate = {"old": asyncio.Event(), "new": asyncio.Event()}
        old = await self.run_node("old", node=AsyncNode())
        self.observer.close()
        self.install()
        current = await self.run_node("new", node=AsyncNode())
        self.host.start_gate["old"].set()
        await old[0][0]
        await asyncio.sleep(0)
        self.assertTrue(sys.monitoring.get_local_events(self.observer._tool_id, AsyncNode.run.__code__))
        self.host.start_gate["new"].set()
        await current[0][0]
        self.assertEqual([m[1]["prompt_id"] for m in self.server.messages], ["new"])

    async def test_request_client_wins_over_mutable_server_client(self):
        self.install()
        self.server.client_id = "another-submission"
        await self.run_node(extra={"client_id": "owner", "enhance_kit_link_flow": {"schema": 1, "enabled": True, "run_token": TOKEN}})
        self.assertEqual(self.server.messages[0][2], "owner")
        await self.run_node(extra={"enhance_kit_link_flow": {"schema": 1, "enabled": True, "run_token": TOKEN}})
        self.assertEqual(len(self.server.messages), 1)

    async def test_identical_code_with_different_globals_is_not_trusted(self):
        original = self.host.get_output_data
        self.host.get_output_data = types.FunctionType(original.__code__, dict(original.__globals__), original.__name__, original.__defaults__, original.__closure__)
        self.assertEqual(self.observer.install()["reason_code"], "unsupported_core")


if __name__ == "__main__":
    unittest.main()
