import importlib.util
import unittest
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1] / "prompt_library_nodes.py"
MODULE = None
if SOURCE.exists():
    spec = importlib.util.spec_from_file_location("prompt_library_node_test", SOURCE)
    MODULE = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(MODULE)


class PromptNodeTests(unittest.TestCase):
    def test_node_emits_exact_body_without_expansion(self):
        self.assertIsNotNone(MODULE, "提示词节点尚未实现")
        node = MODULE.EnhanceKitPromptLibrary()
        for text in ("", "  中文\r\n{a|b}  ", "<script>text</script>"):
            self.assertEqual(node.emit(text), (text,))
        self.assertEqual(node.RETURN_TYPES, ("STRING",))
        self.assertFalse(node.INPUT_TYPES()["required"]["resolved_text"][1]["dynamicPrompts"])
