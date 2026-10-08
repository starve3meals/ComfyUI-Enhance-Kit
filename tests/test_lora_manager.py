import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "lora_manager.py"


class Model:
    def __init__(self, patches=()):
        self.patches = patches


class LoraManagerTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SOURCE.is_file(), "LoRA 管理器尚未实现")
        self.directory = tempfile.TemporaryDirectory(prefix="backend-fixture-", dir=ROOT / ".codex/tmp/lora-manager")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.files = {}
        for name, value in (("first.safetensors", "first"), ("nested/second.safetensors", "second")):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value, encoding="utf-8")
            self.files[name] = str(path)
        self.scans = 0
        self.resolved = []
        self.reads = []
        self.folder_paths = SimpleNamespace(get_filename_list=self.list_files, get_full_path_or_raise=self.resolve)
        self.utils = SimpleNamespace(load_torch_file=self.load_file)
        self.sd = SimpleNamespace(load_lora_for_models=self.apply_patch)
        comfy = SimpleNamespace(utils=self.utils, sd=self.sd)
        modules = {"folder_paths": self.folder_paths, "comfy": comfy, "comfy.utils": self.utils, "comfy.sd": self.sd}
        context = patch.dict(sys.modules, modules)
        context.start()
        self.addCleanup(context.stop)
        spec = importlib.util.spec_from_file_location("enhance_kit_lora_test", SOURCE)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.node = self.module.EnhanceKitLoraManager()
        self.model = Model()

    def list_files(self, category):
        self.assertEqual(category, "loras")
        self.scans += 1
        return list(self.files)

    def resolve(self, category, name):
        self.assertEqual(category, "loras")
        self.resolved.append(name)
        return self.files[name]

    def load_file(self, path, *, safe_load, return_metadata):
        self.assertTrue(safe_load)
        self.assertTrue(return_metadata)
        self.reads.append(path)
        return {"value": Path(path).read_text(encoding="utf-8")}, {"source": path}

    def apply_patch(self, model, clip, data, strength_model, strength_clip, *, lora_metadata):
        self.assertIsNone(clip)
        self.assertEqual(strength_clip, 0)
        entry = (data["value"], strength_model, lora_metadata["source"])
        return Model(model.patches + (entry,)), None

    @staticmethod
    def config(*items):
        return json.dumps({"schema_version": 1, "items": list(items)})

    @staticmethod
    def item(name, strength=1.0, enabled=True):
        return {"name": name, "enabled": enabled, "strength": strength}

    def test_input_contract_supplies_files_and_empty_serialized_default(self):
        inputs = self.node.INPUT_TYPES()["required"]
        self.assertEqual(set(inputs), {"model", "loras"})
        self.assertEqual(inputs["model"], ("MODEL",))
        self.assertEqual(inputs["loras"][0], "STRING")
        options = inputs["loras"][1]
        self.assertEqual(json.loads(options["default"]), {"schema_version": 1, "items": []})
        self.assertTrue(options["socketless"])
        self.assertFalse(options["dynamicPrompts"])
        self.assertEqual(options["enhanceKitLoraOptions"], list(self.files))
        self.assertEqual(self.node.RETURN_TYPES, ("MODEL",))
        self.assertEqual(self.node.RETURN_NAMES, ("model",))
        self.assertEqual(self.node.FUNCTION, "apply_loras")
        self.assertEqual(self.node.CATEGORY, "EnhanceKit/Model")

    def test_empty_and_skipped_entries_return_original_without_filesystem_access(self):
        for config in (self.config(), self.config(self.item("../missing", enabled=False), self.item("", strength=0))):
            with self.subTest(config=config):
                result = self.node.apply_loras(self.model, config)
                self.assertEqual(result, (self.model,))
                self.assertIs(result[0], self.model)
                self.assertEqual(self.node.IS_CHANGED(self.model, config), ())
        self.assertEqual(self.scans, 0)
        self.assertEqual(self.resolved, [])
        self.assertEqual(self.reads, [])

    def test_order_duplicates_metadata_and_unbounded_finite_strength_are_preserved(self):
        config = self.config(self.item("first.safetensors", 250), self.item("nested/second.safetensors", -0.5), self.item("first.safetensors", -1000))
        result, = self.node.apply_loras(self.model, config)
        self.assertEqual(result.patches, (("first", 250, self.files["first.safetensors"]), ("second", -0.5, self.files["nested/second.safetensors"]), ("first", -1000, self.files["first.safetensors"])))
        self.assertEqual(self.model.patches, ())
        self.assertIsNot(result, self.model)
        self.assertEqual(self.reads, [self.files["first.safetensors"], self.files["nested/second.safetensors"]])

    def test_file_data_cache_is_discarded_between_executions(self):
        config = self.config(self.item("first.safetensors"), self.item("first.safetensors", 2))
        initial, = self.node.apply_loras(self.model, config)
        Path(self.files["first.safetensors"]).write_text("replaced", encoding="utf-8")
        changed, = self.node.apply_loras(self.model, config)
        self.assertEqual([item[0] for item in initial.patches], ["first", "first"])
        self.assertEqual([item[0] for item in changed.patches], ["replaced", "replaced"])
        self.assertEqual(len(self.reads), 2)

    def test_invalid_json_shapes_versions_and_fields_fail_before_file_access(self):
        invalid = ["{", "null", "[]", "{}", '{"schema_version":true,"items":[]}', '{"schema_version":1.0,"items":[]}', '{"schema_version":2,"items":[]}', '{"schema_version":1,"items":{}}', '{"schema_version":1,"items":[null]}']
        for field, value in (("name", None), ("enabled", 1), ("strength", True), ("strength", "1"), ("strength", None), ("strength", float("nan")), ("strength", float("inf")), ("strength", -float("inf"))):
            item = self.item("first.safetensors", enabled=False)
            item[field] = value
            invalid.append(self.config(item))
        for field in ("name", "enabled", "strength"):
            item = self.item("first.safetensors")
            del item[field]
            invalid.append(self.config(item))
        for config in invalid:
            with self.subTest(config=config):
                with self.assertRaises(ValueError):
                    self.node.apply_loras(self.model, config)
                with self.assertRaises(ValueError):
                    self.node.IS_CHANGED(self.model, config)
        self.assertEqual(self.scans, 0)
        self.assertEqual(self.reads, [])

    def test_active_name_must_be_in_current_official_list_before_resolving(self):
        for name in ("", "../first.safetensors", "C:\\outside.safetensors", "/outside.safetensors", "missing.safetensors"):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, "LoRA"):
                    self.node.apply_loras(self.model, self.config(self.item(name)))
                with self.assertRaises(ValueError):
                    self.node.IS_CHANGED(self.model, self.config(self.item(name)))
        self.assertEqual(self.resolved, [])
        self.assertEqual(self.reads, [])
        del self.files["first.safetensors"]
        with self.assertRaises(ValueError):
            self.node.apply_loras(self.model, self.config(self.item("first.safetensors")))

    def test_resolver_load_and_patch_errors_propagate(self):
        config = self.config(self.item("first.safetensors"))
        for dependency, method, error in ((self.folder_paths, "get_full_path_or_raise", FileNotFoundError("removed")), (self.utils, "load_torch_file", OSError("bad checkpoint")), (self.sd, "load_lora_for_models", RuntimeError("patch failed"))):
            with self.subTest(method=method), patch.object(dependency, method, side_effect=error):
                with self.assertRaises(type(error)) as raised:
                    self.node.apply_loras(self.model, config)
                self.assertIs(raised.exception, error)

    def test_fingerprint_tracks_active_file_path_size_and_nanosecond_mtime(self):
        config = self.config(self.item("first.safetensors"), self.item("nested/second.safetensors", enabled=False), self.item("missing", 0), self.item("first.safetensors", 2))
        path = Path(self.files["first.safetensors"])
        initial_stat = path.stat()
        expected = ((str(path), initial_stat.st_size, initial_stat.st_mtime_ns),) * 2
        initial = self.node.IS_CHANGED(self.model, config)
        self.assertEqual(initial, expected)
        self.assertEqual(initial, self.node.IS_CHANGED(self.model, config))
        os.utime(path, ns=(initial_stat.st_atime_ns, initial_stat.st_mtime_ns + 1_000_000_000))
        self.assertNotEqual(initial, self.node.IS_CHANGED(self.model, config))
        before_size = self.node.IS_CHANGED(self.model, config)
        path.write_text("different size", encoding="utf-8")
        os.utime(path, ns=(initial_stat.st_atime_ns, initial_stat.st_mtime_ns + 1_000_000_000))
        self.assertNotEqual(before_size, self.node.IS_CHANGED(self.model, config))
        self.assertEqual(self.reads, [])

    def test_fingerprint_changes_when_official_resolver_moves_same_name(self):
        config = self.config(self.item("first.safetensors"))
        initial = self.node.IS_CHANGED(self.model, config)
        self.files["first.safetensors"] = self.files["nested/second.safetensors"]
        self.assertNotEqual(initial, self.node.IS_CHANGED(self.model, config))


if __name__ == "__main__":
    unittest.main()
