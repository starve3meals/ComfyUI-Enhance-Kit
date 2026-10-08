import asyncio
import importlib
import importlib.util
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "enhance_library_api_test"
parent = ModuleType(PACKAGE)
parent.__path__ = [str(ROOT)]
sys.modules[PACKAGE] = parent
STORE = importlib.import_module(PACKAGE + ".prompt_library")
API = None
if (ROOT / "prompt_library_api.py").exists():
    API = importlib.import_module(PACKAGE + ".prompt_library_api")


class LibraryApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertIsNotNone(API, "提示词库接口尚未实现")
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / ".codex/tmp/prompt-library")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = STORE.PromptLibraryStore()
        self.calls = []
        def filepath(request, file, create_dir=True):
            self.calls.append((file, create_dir))
            user = request.headers.get("comfy-user", "a")
            if user not in ("a", "b"):
                raise KeyError("unknown user")
            return str(self.root / user / file)
        self.app = web.Application()
        server = SimpleNamespace(routes=web.RouteTableDef(), user_manager=SimpleNamespace(get_request_user_filepath=filepath))
        API.register_prompt_library_routes(server, self.store)
        self.app.add_routes(server.routes)
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def mutate(self, revision, action, data, user="a"):
        return await self.client.post("/enhance-kit/prompt-library", headers={"comfy-user": user},
                                      json={"expected_revision": revision, "action": action, "data": data})

    async def seed(self):
        response = await self.mutate(0, "category.create", {"name": "写实"})
        category = (await response.json())["categories"][0]
        response = await self.mutate(1, "prompt.create", {"category_id": category["id"], "title": "人物", "text": "原文"})
        return category, (await response.json())["prompts"][0]

    async def test_empty_get_is_no_store_and_creates_nothing(self):
        response = await self.client.get("/enhance-kit/prompt-library")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual((await response.json())["revision"], 0)
        self.assertFalse((self.root / "a").exists())
        self.assertEqual(self.calls, [("enhance-kit/prompt-library.json", False)])

    async def test_profiles_are_isolated_and_unknown_user_is_rejected(self):
        _, prompt = await self.seed()
        response = await self.client.get("/enhance-kit/prompt-library", headers={"comfy-user": "b"})
        self.assertEqual((await response.json())["prompts"], [])
        response = await self.client.post("/enhance-kit/prompt-library/resolve", headers={"comfy-user": "b"}, json={"prompt_id": prompt["id"]})
        self.assertEqual(response.status, 404)
        response = await self.client.get("/enhance-kit/prompt-library", headers={"comfy-user": "unknown"})
        self.assertEqual(response.status, 401)

    async def test_resolve_reads_latest_and_current_category(self):
        _, prompt = await self.seed()
        response = await self.mutate(2, "category.create", {"name": "视频"})
        target = (await response.json())["categories"][-1]
        response = await self.mutate(3, "prompt.update", {"id": prompt["id"], "category_id": target["id"], "text": "  中文\r\n{a|b}  "})
        self.assertEqual(response.status, 200)
        response = await self.client.post("/enhance-kit/prompt-library/resolve", json={"prompt_id": prompt["id"]})
        resolved = await response.json()
        self.assertEqual(resolved["text"], "  中文\r\n{a|b}  ")
        self.assertEqual(resolved["category_id"], target["id"])
        self.assertEqual(resolved["revision"], 4)

    async def test_conflict_and_deleted_reference_are_explicit(self):
        _, prompt = await self.seed()
        response = await self.mutate(0, "prompt.delete", {"id": prompt["id"]})
        self.assertEqual(response.status, 409)
        self.assertEqual((await response.json())["error"]["code"], "revision_conflict")
        await self.mutate(2, "prompt.delete", {"id": prompt["id"]})
        response = await self.client.post("/enhance-kit/prompt-library/resolve", json={"prompt_id": prompt["id"]})
        self.assertEqual(response.status, 404)

    async def test_bad_json_and_extra_path_or_user_fields_are_rejected(self):
        for body in ({"expected_revision": 0, "action": "category.create", "data": {"name": "名称"}, "path": "outside"},
                     {"prompt_id": "missing", "user_id": "b"}, [], None):
            endpoint = "/enhance-kit/prompt-library/resolve" if isinstance(body, dict) and "prompt_id" in body else "/enhance-kit/prompt-library"
            response = await self.client.post(endpoint, json=body)
            self.assertEqual(response.status, 400)
        response = await self.client.post("/enhance-kit/prompt-library", data="{bad", headers={"Content-Type": "application/json"})
        self.assertEqual(response.status, 400)

    async def test_corrupt_file_is_preserved_and_body_not_logged_in_error(self):
        path = self.root / "a/enhance-kit/prompt-library.json"
        path.parent.mkdir(parents=True)
        path.write_text('private prompt broken json', encoding="utf-8")
        response = await self.client.get("/enhance-kit/prompt-library")
        self.assertEqual(response.status, 500)
        self.assertNotIn("private prompt", await response.text())
        self.assertEqual(path.read_text(), 'private prompt broken json')

    async def test_disk_read_does_not_block_event_loop(self):
        original = self.store.read
        entered, release = threading.Event(), threading.Event()
        def slow(path):
            entered.set()
            if not release.wait(2):
                raise AssertionError("worker not released")
            return original(path)
        self.store.read = slow
        request = asyncio.create_task(self.client.get("/enhance-kit/prompt-library"))
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
            tick = asyncio.Event()
            asyncio.get_running_loop().call_soon(tick.set)
            await asyncio.wait_for(tick.wait(), .5)
        finally:
            release.set()
            response = await request
        self.assertEqual(response.status, 200)

    async def test_storage_programming_error_is_not_reported_as_unknown_user(self):
        def broken(path):
            raise KeyError("programming fault")
        self.store.read = broken
        response = await self.client.get("/enhance-kit/prompt-library")
        self.assertEqual(response.status, 500)
