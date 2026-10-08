import json
import os
import tempfile
import threading
import uuid
from pathlib import Path


class PromptLibraryError(Exception):
    """表示库操作的可预期失败；code 为领域原因，message 不包含用户正文。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _name(value):
    if not isinstance(value, str) or not value.strip():
        raise PromptLibraryError("invalid_request", "名称或标题不能为空")
    return value.strip()


def _fields(data, required, allowed):
    if not isinstance(data, dict) or not required <= data.keys() or not data.keys() <= allowed:
        raise PromptLibraryError("invalid_request", "操作字段不正确")


def _find(items, identifier):
    if not isinstance(identifier, str) or not identifier:
        raise PromptLibraryError("invalid_request", "请选择有效条目")
    for item in items:
        if item["id"] == identifier:
            return item
    raise PromptLibraryError("not_found", "条目已删除，请重新选择")


def _unique(items, name, field, exclude=None):
    if any(item[field] == name and item["id"] != exclude for item in items):
        raise PromptLibraryError("invalid_request", "该名称或标题已存在")


def _validate_library(library):
    if not isinstance(library, dict) or set(library) != {"schema_version", "revision", "categories", "prompts"}:
        raise ValueError("invalid library structure")
    if type(library["schema_version"]) is not int or library["schema_version"] != 1:
        raise ValueError("unsupported schema")
    if type(library["revision"]) is not int or library["revision"] < 0:
        raise ValueError("invalid revision")
    categories, prompts = library["categories"], library["prompts"]
    if not isinstance(categories, list) or not isinstance(prompts, list):
        raise ValueError("invalid lists")
    category_ids, names, prompt_ids, titles = set(), set(), set(), set()
    for category in categories:
        _fields(category, {"id", "name"}, {"id", "name"})
        identifier, name = category["id"], _name(category["name"])
        if not isinstance(identifier, str) or not identifier or identifier in category_ids or name in names or name != category["name"]:
            raise ValueError("invalid category")
        category_ids.add(identifier)
        names.add(name)
    for prompt in prompts:
        _fields(prompt, {"id", "category_id", "title", "text"}, {"id", "category_id", "title", "text"})
        identifier, category_id, title = prompt["id"], prompt["category_id"], _name(prompt["title"])
        if not isinstance(category_id, str) or category_id not in category_ids:
            raise ValueError("missing category")
        if not isinstance(identifier, str) or not identifier or identifier in prompt_ids or title != prompt["title"]:
            raise ValueError("invalid prompt")
        if (category_id, title) in titles or not isinstance(prompt["text"], str):
            raise ValueError("invalid prompt text or title")
        prompt_ids.add(identifier)
        titles.add((category_id, title))


class PromptLibraryStore:
    """管理单服务进程中的用户库文件；锁以已解析文件路径划分，不保存正文缓存。"""

    def __init__(self):
        self._locks = {}
        self._locks_guard = threading.Lock()

    def _lock(self, path):
        key = os.path.normcase(os.path.abspath(path))
        with self._locks_guard:
            return self._locks.setdefault(key, threading.Lock())

    def _read(self, path):
        try:
            with path.open(encoding="utf-8") as file:
                library = json.load(file)
        except FileNotFoundError:
            return {"schema_version": 1, "revision": 0, "categories": [], "prompts": []}
        except (OSError, UnicodeError, ValueError) as error:
            raise PromptLibraryError("storage_error", "无法读取提示词库，请检查文件和权限") from error
        try:
            _validate_library(library)
        except (ValueError, PromptLibraryError) as error:
            raise PromptLibraryError("storage_error", "提示词库格式损坏或版本不受支持，请检查文件") from error
        return library

    def read(self, path: Path) -> dict:
        """读取 path 指向的库副本；文件不存在返回空库且不创建目录。

        调用者负责定位当前用户的固定路径；读取及格式故障抛出 PromptLibraryError。
        """
        with self._lock(path):
            return self._read(path)

    def resolve(self, path: Path, prompt_id: str) -> dict:
        """按稳定 prompt_id 读取 path 的最新正文及当前分类，返回一次一致快照。

        不接受缓存正文；引用失效、非法 ID 或文件故障抛出 PromptLibraryError。
        """
        with self._lock(path):
            library = self._read(path)
            prompt = _find(library["prompts"], prompt_id)
            category = _find(library["categories"], prompt["category_id"])
            return {"revision": library["revision"], **prompt, "category_name": category["name"]}

    def mutate(self, path: Path, expected_revision: int, action: str, data: dict) -> dict:
        """串行修改 path 的库；expected_revision 必须匹配，action/data 指定单次操作。

        返回成功保存后的完整库；冲突、非法操作或存储故障抛出 PromptLibraryError。
        版本校验和原子替换处于同一锁中，失败时不覆盖已有文件。
        """
        if type(expected_revision) is not int or expected_revision < 0:
            raise PromptLibraryError("invalid_request", "库版本不正确")
        with self._lock(path):
            library = self._read(path)
            if library["revision"] != expected_revision:
                raise PromptLibraryError("revision_conflict", "提示词库已更新，请刷新后重试")
            self._apply(library, action, data)
            library["revision"] += 1
            self._write(path, library)
            return library

    def _apply(self, library, action, data):
        categories, prompts = library["categories"], library["prompts"]
        if action == "category.create":
            _fields(data, {"name"}, {"name"})
            name = _name(data["name"])
            _unique(categories, name, "name")
            categories.append({"id": str(uuid.uuid4()), "name": name})
        elif action == "category.rename":
            _fields(data, {"id", "name"}, {"id", "name"})
            category = _find(categories, data["id"])
            name = _name(data["name"])
            _unique(categories, name, "name", category["id"])
            category["name"] = name
        elif action == "category.delete":
            _fields(data, {"id"}, {"id"})
            category = _find(categories, data["id"])
            if any(prompt["category_id"] == category["id"] for prompt in prompts):
                raise PromptLibraryError("invalid_request", "请先移动或删除分类中的提示词")
            categories.remove(category)
        elif action in ("prompt.create", "prompt.update"):
            required = {"category_id", "title", "text"} if action == "prompt.create" else {"id"}
            allowed = required if action == "prompt.create" else {"id", "category_id", "title", "text"}
            _fields(data, required, allowed)
            prompt = {"id": str(uuid.uuid4())} if action == "prompt.create" else _find(prompts, data["id"])
            updated = {**prompt, **data}
            updated["title"] = _name(updated["title"])
            if not isinstance(updated["text"], str):
                raise PromptLibraryError("invalid_request", "正文必须是文本")
            _find(categories, updated["category_id"])
            _unique([item for item in prompts if item["category_id"] == updated["category_id"]],
                    updated["title"], "title", updated["id"])
            if action == "prompt.create":
                prompts.append(updated)
            else:
                prompt.update(updated)
        elif action == "prompt.delete":
            _fields(data, {"id"}, {"id"})
            prompts.remove(_find(prompts, data["id"]))
        else:
            raise PromptLibraryError("invalid_request", "不支持的库操作")

    def _write(self, path, library):
        temporary = None
        failure = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                             prefix=".prompt-library-", suffix=".tmp", delete=False) as file:
                temporary = Path(file.name)
                json.dump(library, file, ensure_ascii=False, indent=2)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, path)
        except OSError as error:
            failure = error
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError as error:
                    # 清理故障也要报告为存储错误，但不能覆盖导致保存失败的原始原因。
                    if failure is None:
                        failure = error
        if failure is not None:
            raise PromptLibraryError("storage_error", "无法保存提示词库，请检查文件和权限") from failure
