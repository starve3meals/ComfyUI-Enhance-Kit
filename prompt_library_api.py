import asyncio
from pathlib import Path

from aiohttp import web

from .prompt_library import PromptLibraryError


_STATUSES = {"invalid_request": 400, "not_found": 404, "revision_conflict": 409, "storage_error": 500}


def _response(data, status=200):
    return web.json_response(data, status=status, headers={"Cache-Control": "no-store"})


async def _body(request, fields):
    try:
        data = await request.json()
    except (ValueError, UnicodeError) as error:
        raise PromptLibraryError("invalid_request", "请求必须是有效 JSON") from error
    if not isinstance(data, dict) or set(data) != fields:
        raise PromptLibraryError("invalid_request", "请求字段不正确")
    return data


def register_prompt_library_routes(server, store) -> None:
    """向 server 注册当前用户的库接口，store 提供同步存储操作，无返回值。

    路径始终由 ComfyUI 用户解析器确定；文件操作在线程执行，领域错误转换为 JSON。
    用户身份解析失败返回 401，未预期的程序故障交给 aiohttp 处理。
    """
    def filepath(request):
        path = server.user_manager.get_request_user_filepath(request, "enhance-kit/prompt-library.json", create_dir=False)
        if path is None:
            raise PromptLibraryError("storage_error", "用户数据目录不可用")
        return Path(path)

    async def respond(request, operation):
        try:
            path = filepath(request)
        except KeyError:
            return _response({"error": {"code": "invalid_user", "message": "用户配置不存在"}}, 401)
        except PromptLibraryError as error:
            return _response({"error": {"code": error.code, "message": error.message}}, _STATUSES[error.code])
        try:
            return _response(await operation(path))
        except PromptLibraryError as error:
            return _response({"error": {"code": error.code, "message": error.message}}, _STATUSES[error.code])

    @server.routes.get("/enhance-kit/prompt-library")
    async def read_library(request):
        async def read(path):
            return await asyncio.to_thread(store.read, path)
        return await respond(request, read)

    @server.routes.post("/enhance-kit/prompt-library")
    async def mutate_library(request):
        async def mutate(path):
            data = await _body(request, {"expected_revision", "action", "data"})
            return await asyncio.to_thread(store.mutate, path, data["expected_revision"], data["action"], data["data"])
        return await respond(request, mutate)

    @server.routes.post("/enhance-kit/prompt-library/resolve")
    async def resolve_prompt(request):
        async def resolve(path):
            data = await _body(request, {"prompt_id"})
            return await asyncio.to_thread(store.resolve, path, data["prompt_id"])
        return await respond(request, resolve)
