"""显式 CPU 宿主回归；运行时必须提供 --comfy-root，不加载模型及用户节点。"""

import argparse
import asyncio
import copy
import importlib.util
import logging
from pathlib import Path
import sys
import unittest


if __name__ != "__main__":
    raise unittest.SkipTest("CPU 宿主回归需显式指定 --comfy-root")

parser = argparse.ArgumentParser()
parser.add_argument("--comfy-root", type=Path, required=True)
options = parser.parse_args()
sys.path.insert(0, str(options.comfy_root.resolve()))
import comfy.options
comfy.options.enable_args_parsing()
sys.argv = [__file__, "--cpu", "--disable-all-custom-nodes"]
import execution
import nodes
from comfy_api.latest import io
from comfy_execution.graph_utils import GraphBuilder, ExecutionBlocker
from comfy_execution.utils import get_executing_context

spec = importlib.util.spec_from_file_location("flow", Path(__file__).resolve().parents[2] / "execution_link_flow.py")
flow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flow)
logging.getLogger().setLevel(logging.CRITICAL)
TOKEN = "123e4567-e89b-42d3-a456-426614174000"
TRACE = []


def record(value):
    context = get_executing_context()
    TRACE.append(("body", context.prompt_id, context.node_id, context.list_index, value))


class Server:
    def __init__(self):
        self.client_id = None
        self.last_node_id = None
        self.sockets_metadata = {}
        self.messages = []
        self.fail_delivery = False

    def send_sync(self, event, data, sid=None):
        if event == "enhance-kit.inputs-delivered":
            if self.fail_delivery:
                raise RuntimeError("test delivery failure")
            TRACE.append(("delivery", data["prompt_id"], data["node_id"], data["call_index"]))
            self.messages.append((copy.deepcopy(data), sid))


class Const:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"value": ("INT",)}}
    FUNCTION = "run"
    RETURN_TYPES = ("INT",)
    def run(self, value):
        record(value)
        return (value,)


class Out(Const):
    OUTPUT_NODE = True
    def run(self, value):
        record(value)
        return {"ui": {"test_result": [value]}, "result": (value,)}


class Pass(Const):
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"value": ("INT",), "stamp": ("INT",)}}
    def run(self, value, stamp):
        record((value, stamp))
        return (value,)


class Lazy(Const):
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"choose": ("BOOLEAN",), "left": ("INT", {"lazy": True}), "right": ("INT", {"lazy": True})}}
    def check_lazy_status(self, choose, left=None, right=None):
        context = get_executing_context()
        TRACE.append(("lazy", context.prompt_id, context.node_id, context.list_index))
        return ["left" if choose else "right"] if (left if choose else right) is None else []
    def run(self, choose, left=None, right=None):
        record((left, right))
        return (left if choose else right,)


class Blocked(Const):
    def run(self, value):
        record(value)
        return (ExecutionBlocker(None),)


class Batch(Const):
    OUTPUT_IS_LIST = (True,)


class Mixed(Batch):
    def run(self, value):
        record(value)
        return ([value, ExecutionBlocker(None), value + 2],)


class ListOut(Out):
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (True,)


class Async(Const):
    async def run(self, value):
        record(value)
        await asyncio.sleep(0.002)
        await asyncio.sleep(0.002)
        return (value,)


class V3(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LinkFlowTestV3", inputs=[io.Int.Input("value")], outputs=[io.Int.Output()])
    @classmethod
    def execute(cls, value):
        record(value)
        return io.NodeOutput(value)


class V3Async(V3):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LinkFlowTestV3Async", inputs=[io.Int.Input("value")], outputs=[io.Int.Output()])
    @classmethod
    async def execute(cls, value):
        record(value)
        await asyncio.sleep(0.002)
        return io.NodeOutput(value)


class V3BadBinding(V3):
    @classmethod
    def execute(cls, wrong):
        record(wrong)
        return io.NodeOutput(wrong)


class V3Nested(V3):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LinkFlowTestV3Nested", inputs=[io.DynamicCombo.Input("mode", options=[io.DynamicCombo.Option("take", [io.Int.Input("value")])])], outputs=[io.Int.Output()])
    @classmethod
    def execute(cls, mode):
        record(mode)
        return io.NodeOutput(mode["value"])


class Rewrite(Const):
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"value": ("INT",)}, "hidden": {"dynprompt": "DYNPROMPT"}}
    def run(self, value, dynprompt):
        record(value)
        dynprompt.override_node("b", node("Const", value=["a", 0]))
        return (value,)


class Expand(Const):
    def run(self, value):
        record(value)
        graph = GraphBuilder()
        first = graph.node("LinkFlowTestConst", "inner", value=value)
        second = graph.node("LinkFlowTestConst", "second", value=first.out(0))
        return {"result": (second.out(0),), "expand": graph.finalize()}


class Raw(Const):
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"value": ("INT", {"rawLink": True})}}
    def run(self, value):
        record(value)
        return (9,)


class BadBinding(Const):
    def run(self, wrong):
        record(wrong)
        return (wrong,)


class Failure(Const):
    def run(self, value):
        record(value)
        raise ValueError("test node failure")


class Cancel(Const):
    def run(self, value):
        record(value)
        nodes.interrupt_processing(True)
        return (value,)


class Static(Const):
    @staticmethod
    def run(value):
        record(value)
        return (value,)


class Recursive(Const):
    def run(self, value):
        record(value)
        return self.run(value - 1) if value > 0 else (0,)


CLASSES = (Const, Out, Pass, Lazy, Blocked, Batch, Mixed, ListOut, Async, V3, V3Async, V3BadBinding, V3Nested, Rewrite, Expand, Raw, BadBinding, Failure, Cancel, Static, Recursive)
for cls in CLASSES:
    nodes.NODE_CLASS_MAPPINGS["LinkFlowTest" + cls.__name__] = cls


def node(kind, **inputs):
    return {"class_type": "LinkFlowTest" + kind, "inputs": inputs}


def chain(kind="Const", value=7):
    return {"a": node("Const", value=value), "b": node(kind, value=["a", 0]), "o": node("Out", value=["b", 0])}


NORMAL = [("a", "b", "value", 0), ("b", "o", "value", 0)]


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.originals = {name: getattr(execution, name) for name in flow._HOOKS}
        TRACE.clear()
        self.assertTrue(all(sys.monitoring.get_tool(i) is None for i in (3, 4)))

    def tearDown(self):
        self.assertTrue(all(getattr(execution, name) is original for name, original in self.originals.items()))
        self.assertTrue(all(sys.monitoring.get_tool(i) is None for i in (3, 4)))
        self.assertIsNone(flow._FRAME.get())

    def run_case(self, name, graph, expected, success=True, outputs=None, client="test-client", enabled=True, executor=None, server=None):
        server = server or Server()
        executor = executor or execution.PromptExecutor(server, cache_type=execution.CacheType.CLASSIC, cache_args={"ram": 0, "ram_inactive": 0})
        observer = flow.ExecutionLinkFlowObserver(server)
        start, message_start = len(TRACE), len(server.messages)
        if enabled:
            self.assertTrue(observer.install()["available"], observer.status())
        try:
            extra = {"client_id": client}
            if enabled:
                extra["enhance_kit_link_flow"] = {"schema": 1, "enabled": True, "run_token": TOKEN}
            executor.execute(copy.deepcopy(graph), name, extra, outputs or ["o"])
            self.assertEqual(executor.success, success, (name, executor.status_messages))
            messages = server.messages[message_start:]
            edges = sorted((edge["source_node"], edge["target_node"], edge["target_input"], data["call_index"])
                           for data, _ in messages for edge in data["edges"])
            self.assertEqual(edges, sorted(expected) if enabled else [], name)
            trace = TRACE[start:]
            for i, entry in enumerate(trace):
                if entry[0] == "delivery":
                    self.assertLess(i + 1, len(trace))
                    self.assertEqual(trace[i + 1][:4], ("body", *entry[1:]))
            ids = []
            for data, sid in messages:
                self.assertEqual(sid, client)
                self.assertEqual(data["run_token"], TOKEN)
                self.assertEqual(set(data), {"schema", "prompt_id", "run_token", "event_id", "node_id", "call_index", "edges"})
                ids.append(data["event_id"])
            self.assertEqual(ids, sorted(set(ids)))
            return [item for item in trace if item[0] != "delivery"], executor, server
        finally:
            observer.close()
            self.assertFalse(observer._active_codes)

    def test_real_executor_enabled_disabled_equivalence(self):
        lazy = {"a": node("Const", value=3), "z": node("Const", value=8), "b": node("Lazy", choose=True, left=["a", 0], right=["z", 0]), "o": node("Out", value=["b", 0])}
        right = copy.deepcopy(lazy)
        right["b"]["inputs"]["choose"] = False
        parallel = {"a": node("Const", value=1), "z": node("Const", value=2), "b": node("Async", value=["a", 0]), "c": node("Async", value=["z", 0]), "o": node("Out", value=["b", 0]), "p": node("Out", value=["c", 0])}
        cases = [
            ("normal_v1", chain(), NORMAL, True, None),
            ("valid_none", chain(value=None), NORMAL, True, None),
            ("lazy_left", lazy, [("a", "b", "left", 0), ("b", "o", "value", 0)], True, None),
            ("lazy_right", right, [("z", "b", "right", 0), ("b", "o", "value", 0)], True, None),
            ("blocker", chain("Blocked"), [("a", "b", "value", 0)], True, None),
            ("async_v1", chain("Async"), NORMAL, True, None),
            ("v3", chain("V3"), NORMAL, True, None),
            ("async_v3", chain("V3Async"), NORMAL, True, None),
            ("v3_bad_binding", chain("V3BadBinding"), [], False, None),
            ("v3_nested_inputs", {"a": node("Const", value=7), "b": node("V3Nested", mode="take", **{"mode.value": ["a", 0]}), "o": node("Out", value=["b", 0])}, [("b", "o", "value", 0)], True, None),
            ("runtime_node_override", {"a": node("Rewrite", value=7), "b": node("Const", value=["a", 0]), "o": node("Out", value=["b", 0])}, [], True, None),
            ("expansion_external_only", chain("Expand"), NORMAL, True, None),
            ("raw_link", chain("Raw"), [("b", "o", "value", 0)], True, None),
            ("bad_binding", chain("BadBinding"), [], False, None),
            ("node_error_after_delivery", chain("Failure"), [("a", "b", "value", 0)], False, None),
            ("interrupt_before_call", chain("Cancel"), [("a", "b", "value", 0)], False, None),
            ("mapped_list", {"a": node("Batch", value=[2, 4, 6]), "o": node("Out", value=["a", 0])}, [("a", "o", "value", i) for i in range(3)], True, None),
            ("whole_list", {"a": node("Batch", value=[2, 4, 6]), "o": node("ListOut", value=["a", 0])}, [("a", "o", "value", 0)], True, None),
            ("mapped_blocker", {"a": node("Mixed", value=2), "o": node("Out", value=["a", 0])}, [("a", "o", "value", 0), ("a", "o", "value", 2)], True, None),
            ("whole_list_blocker", {"a": node("Mixed", value=2), "o": node("ListOut", value=["a", 0])}, [], True, None),
            ("empty_list_binding", {"a": node("Batch", value=[]), "o": node("Out", value=["a", 0])}, [], False, None),
            ("async_parallel", parallel, [("a", "b", "value", 0), ("z", "c", "value", 0), ("b", "o", "value", 0), ("c", "p", "value", 0)], True, ["o", "p"]),
            ("static_method", chain("Static"), NORMAL, True, None),
            ("recursive_method", chain("Recursive", value=2), NORMAL, True, None),
        ]
        for name, graph, wanted, success, outputs in cases:
            with self.subTest(name=name):
                before, before_executor, _ = self.run_case(name, graph, wanted, success, outputs, enabled=False)
                after, after_executor, _ = self.run_case(name, graph, wanted, success, outputs, enabled=True)
                self.assertEqual(before, after, name)
                self.assertEqual(before_executor.history_result, after_executor.history_result, name)

    def test_no_client_and_cache_reuse(self):
        before, before_executor, _ = self.run_case("no_client", chain(), [], client=None, enabled=False)
        after, after_executor, _ = self.run_case("no_client", chain(), [], client=None)
        self.assertEqual(before, after)
        self.assertEqual(before_executor.history_result, after_executor.history_result)
        cache_runs = []
        for enabled in (False, True):
            graph = {"a": node("Const", value=7), "b": node("Pass", value=["a", 0], stamp=1), "o": node("Out", value=["b", 0])}
            warm, executor, server = self.run_case("cache_warm", graph, NORMAL, enabled=enabled)
            run = [(warm, copy.deepcopy(executor.history_result))]
            bodies, _, _ = self.run_case("cache_all_hit", graph, [], enabled=enabled, executor=executor, server=server)
            self.assertFalse(bodies)
            run.append((bodies, copy.deepcopy(executor.history_result)))
            graph["b"]["inputs"]["stamp"] = 2
            bodies, _, _ = self.run_case("cache_upstream_reused", graph, NORMAL, enabled=enabled, executor=executor, server=server)
            self.assertFalse(any(item[2] == "a" for item in bodies))
            run.append((bodies, copy.deepcopy(executor.history_result)))
            cache_runs.append(run)
        self.assertEqual(cache_runs[0], cache_runs[1])

    def test_sink_failure_does_not_change_execution(self):
        server = Server()
        server.fail_delivery = True
        bodies, executor, _ = self.run_case("sink_failure", chain(), [], server=server)
        self.assertTrue(executor.success)
        self.assertEqual([item[2] for item in bodies], ["a", "b", "o"])

    def test_slots_and_same_signature_conflict(self):
        observer = flow.ExecutionLinkFlowObserver(Server())
        for slot in (3, 4):
            sys.monitoring.use_tool_id(slot, "foreign")
        try:
            self.assertEqual(observer.install()["reason_code"], "monitor_unavailable")
            observer.close()
            self.assertEqual([sys.monitoring.get_tool(i) for i in (3, 4)], ["foreign", "foreign"])
        finally:
            for slot in (3, 4):
                sys.monitoring.free_tool_id(slot)
        original = execution.get_output_data
        async def replaced(prompt_id, unique_id, obj, input_data_all, execution_block_cb=None, pre_execute_cb=None, v3_data=None):
            return await original(prompt_id, unique_id, obj, input_data_all, execution_block_cb, pre_execute_cb, v3_data)
        execution.get_output_data = replaced
        try:
            self.assertEqual(observer.install()["reason_code"], "unsupported_core")
        finally:
            observer.close()
            execution.get_output_data = original

    def test_live_map_replacement_and_repeated_install(self):
        server = Server()
        observer = flow.ExecutionLinkFlowObserver(server)
        self.assertTrue(observer.install()["available"])
        wrapper = execution.execute
        self.assertTrue(observer.install()["available"])
        self.assertIs(execution.execute, wrapper)
        original = execution._async_map_node_over_list
        async def replacement(prompt_id, unique_id, obj, input_data_all, func, allow_interrupt=False, execution_block_cb=None, pre_execute_cb=None, v3_data=None):
            return await original(prompt_id, unique_id, obj, input_data_all, func, allow_interrupt, execution_block_cb, pre_execute_cb, v3_data)
        execution._async_map_node_over_list = replacement
        try:
            executor = execution.PromptExecutor(server, cache_args={"ram": 0, "ram_inactive": 0})
            executor.execute(chain(), "live_replacement", {"client_id": "client", "enhance_kit_link_flow": {"schema": 1, "enabled": True, "run_token": TOKEN}}, ["o"])
            self.assertTrue(executor.success)
            self.assertEqual([item[2] for item in TRACE if item[0] == "body"], ["a", "b", "o"])
            self.assertFalse(server.messages)
            self.assertEqual(observer.status()["reason_code"], "adapter_conflict")
        finally:
            observer.close()
            execution._async_map_node_over_list = original


unittest.main(argv=[__file__], verbosity=2)
