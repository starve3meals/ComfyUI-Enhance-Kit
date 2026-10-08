import importlib.util
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "prompt_library.py"
MODULE = None
if SOURCE.exists():
    spec = importlib.util.spec_from_file_location("prompt_library_test", SOURCE)
    MODULE = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(MODULE)


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(MODULE, "提示词库存储模块尚未实现")
        parent = ROOT / ".codex" / "tmp" / "prompt-library"
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "enhance-kit" / "prompt-library.json"
        self.store = MODULE.PromptLibraryStore()

    def mutate(self, action, data, revision=None):
        if revision is None:
            revision = self.store.read(self.path)["revision"]
        return self.store.mutate(self.path, revision, action, data)

    def category(self, name="写实"):
        return self.mutate("category.create", {"name": name})["categories"][-1]

    def prompt(self, category, title="人物", text="正文"):
        return self.mutate("prompt.create", {
            "category_id": category["id"], "title": title, "text": text,
        })["prompts"][-1]

    def assert_error(self, code, call):
        with self.assertRaises(MODULE.PromptLibraryError) as result:
            call()
        self.assertEqual(result.exception.code, code)

    def test_missing_file_is_empty_without_creating_directory(self):
        self.assertEqual(self.store.read(self.path), {
            "schema_version": 1, "revision": 0, "categories": [], "prompts": [],
        })
        self.assertFalse(self.path.parent.exists())

    def test_create_reopen_and_returned_values_do_not_share_state(self):
        category = self.category("  写实  ")
        prompt = self.prompt(category, "  人物  ", "  中文\r\n{a|b}  ")
        library = MODULE.PromptLibraryStore().read(self.path)
        self.assertEqual(library["revision"], 2)
        self.assertEqual(category["name"], "写实")
        self.assertEqual(prompt["title"], "人物")
        self.assertEqual(library["prompts"][0]["text"], "  中文\r\n{a|b}  ")
        library["prompts"].clear()
        self.assertEqual(len(self.store.read(self.path)["prompts"]), 1)

    def test_rename_move_and_latest_resolve_keep_identity(self):
        source, target = self.category(), self.category("视频")
        prompt = self.prompt(source)
        self.mutate("category.rename", {"id": source["id"], "name": "摄影"})
        self.mutate("prompt.update", {
            "id": prompt["id"], "category_id": target["id"], "title": "镜头", "text": "新版",
        })
        self.assertEqual(self.store.resolve(self.path, prompt["id"]), {
            "revision": 5, "id": prompt["id"], "category_id": target["id"],
            "category_name": "视频", "title": "镜头", "text": "新版",
        })

    def test_delete_only_empty_category_and_never_reuse_deleted_reference(self):
        category = self.category()
        prompt = self.prompt(category)
        self.assert_error("invalid_request", lambda: self.mutate("category.delete", {"id": category["id"]}))
        self.mutate("prompt.delete", {"id": prompt["id"]})
        replacement = self.prompt(category)
        self.assertNotEqual(replacement["id"], prompt["id"])
        self.assert_error("not_found", lambda: self.store.resolve(self.path, prompt["id"]))
        self.mutate("prompt.delete", {"id": replacement["id"]})
        self.assertEqual(self.mutate("category.delete", {"id": category["id"]})["categories"], [])

    def test_unique_names_and_titles_are_scoped_and_trimmed(self):
        first, second = self.category(), self.category("视频")
        self.assert_error("invalid_request", lambda: self.category(" 写实 "))
        self.prompt(first)
        self.assert_error("invalid_request", lambda: self.prompt(first, " 人物 "))
        self.prompt(second)
        self.assertEqual(len(self.store.read(self.path)["prompts"]), 2)

    def test_update_cannot_move_to_duplicate_title(self):
        first, second = self.category(), self.category("视频")
        original = self.prompt(first)
        self.prompt(second)
        before = self.path.read_bytes()
        self.assert_error("invalid_request", lambda: self.mutate("prompt.update", {
            "id": original["id"], "category_id": second["id"], "title": "人物", "text": "新版",
        }))
        self.assertEqual(self.path.read_bytes(), before)

    def test_empty_body_and_partial_update_preserve_other_fields(self):
        category = self.category()
        prompt = self.prompt(category, text="")
        updated = self.mutate("prompt.update", {"id": prompt["id"], "title": "负面"})["prompts"][0]
        self.assertEqual(updated["text"], "")
        self.assertEqual(updated["category_id"], category["id"])
        self.assertEqual(updated["title"], "负面")

    def test_invalid_request_does_not_write(self):
        for revision, action, data in [
            (True, "category.create", {"name": "分类"}),
            (-1, "category.create", {"name": "分类"}),
            (0, "unknown", {}),
            (0, "category.create", {"name": " "}),
            (0, "category.create", {"name": "分类", "path": "outside"}),
            (0, "prompt.create", {"category_id": "missing", "title": "标题", "text": 3}),
        ]:
            with self.subTest(action=action, data=data):
                self.assert_error("invalid_request", lambda: self.store.mutate(self.path, revision, action, data))
        self.assertFalse(self.path.exists())

    def test_missing_identifiers_return_not_found(self):
        for action, data in [("category.rename", {"id": "missing", "name": "名称"}),
                             ("prompt.delete", {"id": "missing"}),
                             ("prompt.create", {"category_id": "missing", "title": "标题", "text": ""})]:
            self.assert_error("not_found", lambda: self.mutate(action, data))

    def test_concurrent_same_revision_has_one_winner(self):
        self.category()
        barrier = Barrier(2)
        def write(name):
            barrier.wait(timeout=2)
            try:
                self.store.mutate(self.path, 1, "category.create", {"name": name})
                return "success"
            except MODULE.PromptLibraryError as error:
                return error.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(write, ("A", "B")))
        self.assertCountEqual(results, ["success", "revision_conflict"])
        self.assertEqual(self.store.read(self.path)["revision"], 2)

    def test_replace_failure_preserves_original_and_cleans_owned_temp(self):
        self.category()
        before = self.path.read_bytes()
        with patch.object(MODULE.os, "replace", side_effect=PermissionError("denied")):
            self.assert_error("storage_error", lambda: self.category("视频"))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_corrupt_or_unsupported_file_is_not_overwritten(self):
        self.path.parent.mkdir(parents=True)
        for contents in ['{broken', json.dumps({"schema_version": 2}),
                         json.dumps({"schema_version": 1, "revision": 0, "categories": [], "prompts": [{"id": "x"}]})]:
            self.path.write_text(contents, encoding="utf-8")
            self.assert_error("storage_error", lambda: self.store.read(self.path))
            self.assert_error("storage_error", lambda: self.category())
            self.assertEqual(self.path.read_text(encoding="utf-8"), contents)


if __name__ == "__main__":
    unittest.main()
