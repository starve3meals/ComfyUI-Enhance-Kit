import asyncio

from aiohttp import web
from server import PromptServer

from .resource_monitor import ResourceMonitor


WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}

_monitor = ResourceMonitor()


@PromptServer.instance.routes.get("/enhance-kit/resources")
async def resources(request):
    """响应同源资源请求；request 不读取采样参数，返回不可缓存的 JSON 快照。

    在线程中采集以保护事件循环；非采集故障按 aiohttp 正常错误机制传播。
    """
    snapshot = await asyncio.to_thread(_monitor.snapshot)
    return web.json_response(snapshot, headers={"Cache-Control": "no-store"})


async def close_resources(application):
    """应用清理时在线程中释放采集器；application 为 aiohttp 生命周期参数，无返回值。"""
    await asyncio.to_thread(_monitor.close)


PromptServer.instance.app.on_cleanup.append(close_resources)
