import asyncio
import importlib.util
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer


ROOT = Path(__file__).resolve().parents[1]
PAYLOAD = {
    "sampled_at_ms": 1_700_000_000_125,
    "cpu": {"utilization_percent": None},
    "memory": {"used_bytes": 600, "total_bytes": 1000, "utilization_percent": 60.0},
    "gpus": [],
}


class AdapterMonitor:
    def __init__(self):
        self.snapshot_thread = None
        self.close_thread = None
        self.closed = False
        self.entered = threading.Event()
        self.release = threading.Event()
        self.block = False

    def snapshot(self):
        self.snapshot_thread = threading.get_ident()
        self.entered.set()
        if self.block and not self.release.wait(2):
            raise AssertionError("test did not release collector")
        return PAYLOAD

    def close(self):
        self.close_thread = threading.get_ident()
        self.closed = True


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        entrypoint = ROOT / "__init__.py"
        self.assertTrue(entrypoint.is_file(), "ComfyUI 加载入口尚未实现")
        self.monitor = AdapterMonitor()
        self.server = SimpleNamespace(routes=web.RouteTableDef(), app=web.Application())
        package = "enhance_kit_server_test"
        dependency = SimpleNamespace(ResourceMonitor=lambda: self.monitor)
        comfy_sd = SimpleNamespace()
        comfy_utils = SimpleNamespace()
        self.patches = [patch.dict(sys.modules, {
            "server": SimpleNamespace(PromptServer=SimpleNamespace(instance=self.server)),
            package + ".resource_monitor": dependency,
            "folder_paths": SimpleNamespace(get_filename_list=lambda category: []),
            "comfy": SimpleNamespace(sd=comfy_sd, utils=comfy_utils),
            "comfy.sd": comfy_sd,
            "comfy.utils": comfy_utils,
        })]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        spec = importlib.util.spec_from_file_location(package, entrypoint, submodule_search_locations=[str(ROOT)])
        self.extension = importlib.util.module_from_spec(spec)
        package_patch = patch.dict(sys.modules, {package: self.extension})
        package_patch.start()
        self.addCleanup(package_patch.stop)
        spec.loader.exec_module(self.extension)
        self.server.app.add_routes(self.server.routes)
        self.client = TestClient(TestServer(self.server.app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def test_local_route_returns_fixed_payload_and_no_store(self):
        response = await self.client.get("/enhance-kit/resources")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(await response.json(), PAYLOAD)
        self.assertEqual(self.extension.WEB_DIRECTORY, "./web")
        self.assertIn("EnhanceKitPromptLibrary", self.extension.NODE_CLASS_MAPPINGS)
        self.assertEqual(self.extension.NODE_CLASS_MAPPINGS["EnhanceKitPromptLibrary"].RETURN_TYPES, ("STRING",))
        self.assertIn("EnhanceKitLoraManager", self.extension.NODE_CLASS_MAPPINGS)
        lora_node = self.extension.NODE_CLASS_MAPPINGS["EnhanceKitLoraManager"]
        self.assertEqual(lora_node.RETURN_TYPES, ("MODEL", "CLIP"))
        self.assertEqual(lora_node.RETURN_NAMES, ("model", "clip"))
        self.assertEqual(lora_node.INPUT_TYPES()["optional"], {"clip": ("CLIP",)})
        self.assertEqual(self.extension.NODE_DISPLAY_NAME_MAPPINGS["EnhanceKitLoraManager"], "LoRA 管理器（EnhanceKit）")

    async def test_slow_collection_runs_outside_event_loop(self):
        self.monitor.block = True
        request = asyncio.create_task(self.client.get("/enhance-kit/resources"))
        try:
            self.assertTrue(await asyncio.to_thread(self.monitor.entered.wait, 1))
            self.assertNotEqual(self.monitor.snapshot_thread, threading.get_ident())
            ticked = asyncio.Event()
            asyncio.get_running_loop().call_soon(ticked.set)
            await asyncio.wait_for(ticked.wait(), 0.5)
        finally:
            self.monitor.release.set()
            response = await request
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), PAYLOAD)

    async def test_cleanup_closes_owned_monitor_outside_event_loop(self):
        await self.client.close()
        self.assertTrue(self.monitor.closed)
        self.assertNotEqual(self.monitor.close_thread, threading.get_ident())


if __name__ == "__main__":
    unittest.main()
