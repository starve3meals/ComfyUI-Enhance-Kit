"""在已验证的本地执行链上确认输入交付，不读取或保存输入值。"""

import asyncio
import contextvars
import functools
import hashlib
import importlib
import inspect
import sys
import types
import uuid
import weakref


_FRAME = contextvars.ContextVar("enhance_kit_link_flow", default=None)
_MAX_INTEGER = 9007199254740991
_HOOKS = ("execute", "get_input_data", "get_output_data")

# CPython 3.13.11 / c06bf5f；摘要取自活跃代码对象，包含嵌套函数与调用约定。
_SUPPORTED_CODES = {
    "execution.execute": "73db7b953a507db8d39b8a71513e36f7afe8f46c52a11c7498813554a96ebf87",
    "execution.get_input_data": "bf780c3094726b03eba966393470151412d85e83d3611e5e5935d2bb8fc40409",
    "execution.get_output_data": "cd53216c1c64844ae4e5d4f4e2b7e11835eb57659cbedf77b2492fbbff9f69e5",
    "execution._async_map_node_over_list": "7e194d71684f3ef6bb6bec3851cb97373f7eb813c198cae08d53dde1968ed291",
    "execution.resolve_map_node_over_list_results": "2f587d4537aa39b8141650f6cccede2dadbebbe4ae6f125acaa554c18c224e6c",
    "execution.get_input_info": "802885f81a9fa10a3bcdd8012eaeb4fd8d3740755a2044ea71418be66aee081b",
    "execution.is_link": "0d31565d2d735172d74a8e92231bb9e5ec5dcb49ba7fb29f9e724b12317e0e0a",
    "execution.make_locked_method_func": "eb05d2a2b8abb481d3cf3c55b0c62540fe595c8149b230df09337f31003a0ea8",
    "execution.is_class": "b29d6bddd48ad1606552cd522d6f218e6ec5cb8269a1d57bec14780793c457d8",
    "utils.get_executing_context": "af86e4d75017bcaa12c0aecbf48b4ceb8fc848cdf80b98a97e220d7060887c0d",
    "CurrentNodeContext.__init__": "d263e5c8d0d7dcd57207b8fa282965a1920400a6c77460864ecd8e1268c70b8b",
    "CurrentNodeContext.__enter__": "810b62cabb7e257dcda734765e0fb802cd55e4a93e0d3c7058d93d1c6dc1ad58",
    "CurrentNodeContext.__exit__": "661ed188d8993989a75962f13ac10c0f038706e36d6a99a73ccd56409d5a2f8e",
    "DynamicPrompt.get_node": "44c986499bb432e33604f28ff26b3f69167e6556d825d8537ed0b060b36849c5",
    "DynamicPrompt.get_original_prompt": "e96d9065eed94c88451fc811ecbfd29d7a635f4f1ea08bff9b83dae760b96085",
    "DynamicPrompt.get_real_node_id": "3cce7087ad5bb4b7bb5ec00344860657ae21c82a4e928c598060256d15952347",
    "DynamicPrompt.get_display_node_id": "b42cbf9c140f13bfd71c83c891c921f7310301ff6349f46008038b7130d20395",
    "DynamicPrompt.get_parent_node_id": "973ec185abc5f29b430c166e2e8b50e7d949509843a0bcd7d83876719cc0862e",
    "io.get_finalized_class_inputs": "281fad50ca851941f4e64bfd382925024ba8bda25c0f6e393f21378cff273636",
    "io.build_nested_inputs": "50b3eda72b1951163ef3142985426d0cf9e1787567f6d48824e21c4f4a6cc3f3",
    "internal.lock_class": "2b22679c461f1bafc7fe40a76baadc2bac16e9f0bafdad3c1a05feb6830760e7",
    "V3.FUNCTION": "c062a64e779aae2fe145ea4aff7acf799662bf004cdc1ee61bf556287d919c66",
    "V3.EXECUTE_NORMALIZED": "fa9a597070c825984f3605c166e9aa466fa967105795466c705630c761f66feb",
    "V3.EXECUTE_NORMALIZED_ASYNC": "98b991848887b13d97305630cfbef3b8a63a8add299b74cff44c34f1f7958cce",
}

_CORE_MODULES = {
    "execution": "execution", "utils": "comfy_execution.utils", "CurrentNodeContext": "comfy_execution.utils",
    "DynamicPrompt": "comfy_execution.graph", "io": "comfy_api.latest._io",
    "V3": "comfy_api.latest._io", "internal": "comfy_api.internal",
}
_FUNCTION_MODULES = {name: _CORE_MODULES[name.split(".", 1)[0]] for name in _SUPPORTED_CODES}
_FUNCTION_MODULES.update({
    "execution.get_input_info": "comfy_execution.graph", "execution.is_link": "comfy_execution.graph_utils",
    "execution.make_locked_method_func": "comfy_api.internal", "execution.is_class": "comfy_api.internal",
})


def _code_digest(code):
    def normalize(value):
        if isinstance(value, types.CodeType):
            return (value.co_code, tuple(normalize(x) for x in value.co_consts), value.co_names,
                    value.co_varnames, value.co_freevars, value.co_cellvars, value.co_argcount,
                    value.co_posonlyargcount, value.co_kwonlyargcount, value.co_flags, value.co_exceptiontable)
        if isinstance(value, frozenset):
            return ("frozenset", tuple(sorted(repr(x) for x in value)))
        return value
    return hashlib.sha256(repr(normalize(code)).encode("utf-8")).hexdigest()


def _runtime_targets(execution):
    utils = importlib.import_module("comfy_execution.utils")
    internal = importlib.import_module("comfy_api.internal")
    targets = {"execution." + name: (execution, name) for name in (
        *_HOOKS, "_async_map_node_over_list", "resolve_map_node_over_list_results",
        "get_input_info", "is_link", "make_locked_method_func", "is_class")}
    targets["utils.get_executing_context"] = (utils, "get_executing_context")
    for name in ("__init__", "__enter__", "__exit__"):
        targets["CurrentNodeContext." + name] = (execution.CurrentNodeContext, name)
    for name in ("get_node", "get_original_prompt", "get_real_node_id", "get_display_node_id", "get_parent_node_id"):
        targets["DynamicPrompt." + name] = (execution.DynamicPrompt, name)
    for name in ("get_finalized_class_inputs", "build_nested_inputs"):
        targets["io." + name] = (execution._io, name)
    targets["V3.FUNCTION"] = (inspect.getattr_static(execution._io.ComfyNode, "FUNCTION"), "f")
    for name in ("EXECUTE_NORMALIZED", "EXECUTE_NORMALIZED_ASYNC"):
        targets["V3." + name] = (execution._io.ComfyNode, name)
    targets["internal.lock_class"] = (internal, "lock_class")
    return targets


def _get_context():
    return sys.modules["comfy_execution.utils"].get_executing_context()


def _active_function(owner, attr):
    function = inspect.getattr_static(owner, attr)
    return function.__func__ if type(function) in (classmethod, staticmethod) else function


def _identifier(value):
    return type(value) is str and bool(value)


def _integer(value):
    return type(value) is int and 0 <= value <= _MAX_INTEGER


def _request(extra_data):
    if type(extra_data) is not dict:
        return None
    option = extra_data.get("enhance_kit_link_flow")
    if (type(option) is not dict or type(option.get("schema")) is not int
            or option["schema"] != 1 or option.get("enabled") is not True):
        return None
    token = option.get("run_token")
    if type(token) is not str:
        return None
    try:
        return token if str(uuid.UUID(token)) == token else None
    except ValueError:
        return None


class _Delivery:
    def __init__(self, prompt_id, node_id, token, client, graph, links):
        self.prompt_id = prompt_id
        self.node_id = node_id
        self.token = token
        self.client = client
        self.graph = weakref.ref(graph)
        self.links = links
        self.input_id = None
        self.edges = ()
        self.code = None
        self.seen = set()
        self.disabled = False


class ExecutionLinkFlowObserver:
    """确认执行函数入口并向提交客户端发送边坐标。

    server 为宿主发送器；不持有输入数据。兼容或观测故障只禁用观测，
    不改变节点返回和异常；监测槽、包装器仅在仍属于本实例时清理。
    """

    def __init__(self, server):
        self._server = server
        self._execution = None
        self._originals = {}
        self._wrappers = {}
        self._checked = {}
        self._tool_id = None
        self._tool_name = "enhance-kit-link-flow:" + format(id(self), "x")
        self._monitor = getattr(sys, "monitoring", None)
        self._active_codes = {}
        self._states = weakref.WeakSet()
        self._failed_graphs = weakref.WeakSet()
        self._reason = "closed"
        self._event_id = 0
        self._generation = 0

    def status(self):
        """返回 schema、后端可用性及原因码；无路径、输入或堆栈，不抛观测异常。"""
        if self._reason is None:
            try:
                if not self._runtime_valid() or not self._owns_monitor():
                    self._reason = "adapter_conflict"
            except Exception:
                self._reason = "monitor_failure"
        return {"schema": 1, "available": self._reason is None, "reason_code": self._reason}

    def install(self):
        """重复安全地安装三个窄适配器；返回状态字典，失败回滚自身资源而不阻断宿主。"""
        if self._reason is None:
            return self.status()
        if self._tool_id is not None or self._wrappers:
            return self.status()
        if sys.implementation.name != "cpython" or sys.version_info[:3] != (3, 13, 11):
            self._reason = "unsupported_python"
            return self.status()
        try:
            self._execution = importlib.import_module("execution")
            targets = _runtime_targets(self._execution)
            if set(targets) != set(_SUPPORTED_CODES):
                self._reason = "unsupported_core"
                return self.status()
            for name, (owner, attr) in targets.items():
                function = _active_function(owner, attr)
                if (type(function) is not types.FunctionType or hasattr(function, "__wrapped__")
                        or function.__globals__ is not vars(sys.modules[_FUNCTION_MODULES[name]])
                        or _code_digest(function.__code__) != _SUPPORTED_CODES[name]):
                    self._reason = "unsupported_core"
                    return self.status()
                self._checked[name] = (owner, attr, function, function.__code__)
            self._originals = {name: getattr(self._execution, name) for name in _HOOKS}
            if self._monitor is None:
                self._reason = "monitor_unavailable"
                return self.status()
            for slot in (3, 4):
                if self._monitor.get_tool(slot) is None:
                    try:
                        self._monitor.use_tool_id(slot, self._tool_name)
                    except ValueError:
                        continue
                    self._tool_id = slot
                    break
            if self._tool_id is None:
                self._reason = "monitor_unavailable"
                return self.status()
            self._generation += 1
            self._monitor.register_callback(self._tool_id, self._monitor.events.PY_START, self._on_start)
            self._wrap()
            self._reason = None
        except Exception:
            self.close()
            self._reason = "monitor_failure"
        return self.status()

    def _runtime_valid(self):
        targets = _runtime_targets(self._execution)
        if targets.keys() != self._checked.keys():
            return False
        for name, (owner, attr, function, code) in self._checked.items():
            new_owner, new_attr = targets[name]
            current = _active_function(new_owner, new_attr)
            expected = self._wrappers.get(attr, function) if owner is self._execution else function
            if new_owner is not owner or current is not expected or function.__code__ is not code:
                return False
        return True

    def _owns_monitor(self):
        return self._tool_id is not None and self._monitor.get_tool(self._tool_id) == self._tool_name

    def _fail(self, state):
        state.disabled = True
        graph = state.graph()
        if graph is not None:
            self._failed_graphs.add(graph)

    def _state(self, bound):
        token = _request(bound["extra_data"])
        client = bound["extra_data"].get("client_id") if token else None
        if not token or not _identifier(client) or bound["server"] is not self._server:
            return None
        if not self.status()["available"]:
            return None
        graph, node_id, prompt_id = bound["dynprompt"], bound["current_item"], bound["prompt_id"]
        if graph in self._failed_graphs or not _identifier(node_id) or not _identifier(prompt_id):
            return None
        original, overrides = graph.original_prompt, graph.node_overrides
        if node_id not in original or node_id in overrides:
            return None
        links = []
        for name, value in original[node_id]["inputs"].items():
            if (type(value) is list and len(value) == 2 and _identifier(value[0])
                    and _integer(value[1]) and value[0] in original and value[0] not in overrides
                    and _identifier(name)):
                links.append((name, value[0], value[1]))
        if not links:
            return None
        state = _Delivery(prompt_id, node_id, token, client, graph, tuple(links))
        self._states.add(state)
        return state

    def _graph_matches(self, state):
        graph = state.graph()
        if (graph is None or type(graph) is not self._execution.DynamicPrompt
                or state.node_id in graph.node_overrides):
            return False
        inputs = graph.original_prompt[state.node_id]["inputs"]
        for name, source, slot in state.links:
            value = inputs.get(name)
            if (source in graph.node_overrides or type(value) is not list or len(value) != 2
                    or type(value[0]) is not str or value[0] != source
                    or type(value[1]) is not int or value[1] != slot):
                return False
        return True

    def _wrap(self):
        execute, get_input, get_output = (self._originals[name] for name in _HOOKS)
        execute_signature = inspect.signature(execute)
        input_signature = inspect.signature(get_input)
        output_signature = inspect.signature(get_output)

        @functools.wraps(execute)
        async def execute_wrapper(*args, **kwargs):
            state = None
            if self._reason is None:
                try:
                    state = self._state(execute_signature.bind(*args, **kwargs).arguments)
                except Exception:
                    self._reason = "monitor_failure"
            token = _FRAME.set(state) if state is not None or _FRAME.get() is not None else None
            try:
                return await execute(*args, **kwargs)
            finally:
                if token is not None:
                    _FRAME.reset(token)

        @functools.wraps(get_input)
        def input_wrapper(*args, **kwargs):
            result = get_input(*args, **kwargs)
            state = _FRAME.get()
            if state is not None and not state.disabled and self._reason is None:
                try:
                    bound = input_signature.bind(*args, **kwargs)
                    bound.apply_defaults()
                    data = bound.arguments
                    if data["unique_id"] == state.node_id and data["execution_list"] is not None:
                        if (not self._graph_matches(state)
                                or data["inputs"] is not state.graph().original_prompt[state.node_id]["inputs"]):
                            state.disabled = True
                            return result
                        resolved, missing, _ = result
                        state.input_id = id(resolved)
                        state.edges = tuple((source, slot, state.node_id, name) for name, source, slot in state.links
                            if name not in missing and name in resolved and len(resolved[name]) > 0
                            and not (len(resolved[name]) == 1 and resolved[name][0] is data["inputs"][name]))
                except Exception:
                    self._fail(state)
            return result

        @functools.wraps(get_output)
        async def output_wrapper(*args, **kwargs):
            state = _FRAME.get()
            code = None
            generation = self._generation
            if state is not None and not state.disabled and self._reason is None:
                try:
                    bound = output_signature.bind(*args, **kwargs)
                    bound.apply_defaults()
                    data = bound.arguments
                    if (state.input_id == id(data["input_data_all"]) and data["prompt_id"] == state.prompt_id
                            and data["unique_id"] == state.node_id and state.edges
                            and not (data["v3_data"] or {}).get("dynamic_paths")):
                        code = self._method_code(data["obj"])
                        if code is not None and self.status()["available"]:
                            self._retain(code)
                            state.code = code
                except Exception:
                    self._fail(state)
                    code = None
            handed_off = False
            try:
                result = await get_output(*args, **kwargs)
                if code is not None:
                    try:
                        tasks = [task for task in result[0] if isinstance(task, asyncio.Task)] if result[3] else []
                        if tasks:
                            # Task 继承本次 ContextVar；等最后一个 Task 结束才撤销共享代码监听。
                            pending_count = len(tasks)
                            def completed(_task):
                                nonlocal pending_count
                                pending_count -= 1
                                if not pending_count:
                                    self._release(code, generation)
                            for task in tasks:
                                task.add_done_callback(completed)
                            handed_off = True
                    except Exception:
                        self._fail(state)
                return result
            finally:
                if code is not None and not handed_off:
                    self._release(code, generation)

        self._wrappers = dict(zip(_HOOKS, (execute_wrapper, input_wrapper, output_wrapper)))
        for name, wrapper in self._wrappers.items():
            setattr(self._execution, name, wrapper)

    def _method_code(self, obj):
        cls = obj if isinstance(obj, type) else type(obj)
        if inspect.getattr_static(type(cls), "__getattribute__") is not type.__getattribute__:
            return None
        if not isinstance(obj, type) and inspect.getattr_static(cls, "__getattribute__") is not object.__getattribute__:
            return None
        name = inspect.getattr_static(obj, "FUNCTION", None)
        internal = getattr(self._execution, "_ComfyNodeInternal", None)
        if internal is not None and issubclass(cls, internal):
            base = self._execution._io.ComfyNode
            if name is not inspect.getattr_static(base, "FUNCTION"):
                return None
            if any(inspect.getattr_static(cls, attr) is not inspect.getattr_static(base, attr)
                   for attr in ("EXECUTE_NORMALIZED", "EXECUTE_NORMALIZED_ASYNC")):
                return None
            name = "execute"
        if type(name) is not str:
            return None
        method = inspect.getattr_static(obj, name, None)
        if type(method) in (staticmethod, classmethod):
            method = method.__func__
        elif type(method) is not types.FunctionType:
            return None
        if hasattr(method, "__wrapped__"):
            return None
        return method.__code__

    def _retain(self, code):
        count = self._active_codes.get(code, 0)
        if not count:
            # 先登记所有权，API 部分成功后抛错时仍可在 close 中撤销。
            self._active_codes[code] = 1
            try:
                self._monitor.set_local_events(self._tool_id, code, self._monitor.events.PY_START)
            except Exception:
                self._reason = "monitor_failure"
                raise
        self._active_codes[code] = count + 1

    def _release(self, code, generation):
        if generation != self._generation:
            return
        count = self._active_codes.get(code, 0)
        if not count:
            return
        if count > 1:
            self._active_codes[code] = count - 1
            return
        try:
            if self._owns_monitor():
                self._monitor.set_local_events(self._tool_id, code, 0)
            self._active_codes.pop(code, None)
        except Exception:
            self._reason = "monitor_failure"

    def _on_start(self, code, instruction_offset):
        state = _FRAME.get()
        if self._reason is not None or state is None or state.disabled or state.code is not code:
            return
        try:
            graph = state.graph()
            if graph is None or graph in self._failed_graphs or not self._graph_matches(state):
                state.disabled = True
                return
            context = _get_context()
            if (context is None or context.prompt_id != state.prompt_id or context.node_id != state.node_id
                    or not _integer(context.list_index) or context.list_index in state.seen):
                return
            if not self._owns_monitor() or not self._runtime_valid():
                self._reason = "adapter_conflict"
                return
            state.seen.add(context.list_index)
            self._event_id += 1
            if not _integer(self._event_id):
                self._fail(state)
                return
            self._server.send_sync("enhance-kit.inputs-delivered", {
                "schema": 1, "prompt_id": state.prompt_id, "run_token": state.token,
                "event_id": self._event_id, "node_id": state.node_id, "call_index": context.list_index,
                "edges": [{"source_node": source, "source_slot": slot, "target_node": target,
                           "target_input": name} for source, slot, target, name in state.edges],
            }, state.client)
        except Exception:
            self._fail(state)

    def close(self):
        """撤销自身挂接和局部监测；可重复调用，清理失败保留所有权供下次重试，不抛异常。"""
        self._reason = "closed"
        for state in self._states:
            state.disabled = True
        for name, wrapper in self._wrappers.items():
            if getattr(self._execution, name, None) is wrapper:
                setattr(self._execution, name, self._originals[name])
        self._wrappers.clear()
        if self._tool_id is None:
            return
        try:
            if not self._owns_monitor():
                self._active_codes.clear()
                self._tool_id = None
                return
            for code in tuple(self._active_codes):
                self._monitor.set_local_events(self._tool_id, code, 0)
                self._active_codes.pop(code, None)
            self._monitor.register_callback(self._tool_id, self._monitor.events.PY_START, None)
            self._monitor.free_tool_id(self._tool_id)
            self._tool_id = None
        except Exception:
            self._reason = "monitor_failure"
