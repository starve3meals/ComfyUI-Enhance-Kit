import json
import math
import os

import comfy.sd
import comfy.utils
import folder_paths


def _active_loras(loras):
    if not isinstance(loras, str):
        raise ValueError("LoRA 配置必须是 JSON 字符串")
    try:
        config = json.loads(loras)
    except json.JSONDecodeError as error:
        raise ValueError("LoRA 配置不是有效的 JSON") from error
    if not isinstance(config, dict) or type(config.get("schema_version")) is not int or config["schema_version"] != 1:
        raise ValueError("LoRA 配置的 schema_version 必须是整数 1")
    if not isinstance(config.get("items"), list):
        raise ValueError("LoRA 配置的 items 必须是数组")

    active = []
    for index, item in enumerate(config["items"], start=1):
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise ValueError(f"第 {index} 项 LoRA 的 name 必须是字符串")
        if type(item.get("enabled")) is not bool:
            raise ValueError(f"第 {index} 项 LoRA 的 enabled 必须是 boolean")
        strength = item.get("strength")
        if type(strength) not in (int, float) or (isinstance(strength, float) and not math.isfinite(strength)):
            raise ValueError(f"第 {index} 项 LoRA 的 strength 必须是有限数值")
        if item["enabled"] and strength != 0:
            active.append((item["name"], strength))

    if not active:
        return []
    available = set(folder_paths.get_filename_list("loras"))
    resolved = []
    for name, strength in active:
        if name not in available:
            raise ValueError(f"LoRA 文件不在当前可用列表中：{name}")
        resolved.append((folder_paths.get_full_path_or_raise("loras", name), strength))
    return resolved


class EnhanceKitLoraManager:
    """按工作流中的有序列表应用 MODEL LoRA，仅复用官方模型补丁能力。"""

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "apply_loras"
    CATEGORY = "EnhanceKit/Model"

    @classmethod
    def INPUT_TYPES(cls):
        """声明 MODEL 和 JSON 列表输入，返回含当前官方 LoRA 文件选项的节点契约。

        无调用参数；文件扫描异常按官方接口传播。JSON 输入不生成连线插槽或动态提示词。
        """
        return {"required": {
            "model": ("MODEL",),
            "loras": ("STRING", {
                "default": '{"schema_version":1,"items":[]}',
                "socketless": True,
                "dynamicPrompts": False,
                "enhanceKitLoraOptions": folder_paths.get_filename_list("loras"),
            }),
        }}

    def apply_loras(self, model, loras):
        """依次为 model 应用 loras JSON 中启用且非零的 LoRA，返回单项 MODEL 元组。

        配置不合法或文件不在官方列表时抛出 ValueError；路径、读取和补丁异常直接传播。
        空列表或全跳过返回原模型；活动项由官方接口克隆模型，重复项仍逐项应用。
        文件数据仅在本次调用内复用，强度接受所有有限数值，不处理 CLIP。
        """
        loaded = {}
        for path, strength in _active_loras(loras):
            if path not in loaded:
                loaded[path] = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
            data, metadata = loaded[path]
            model, _ = comfy.sd.load_lora_for_models(model, None, data, strength, 0, lora_metadata=metadata)
        return (model,)

    @classmethod
    def IS_CHANGED(cls, model, loras):
        """返回 loras 活动文件的有序路径、大小和纳秒修改时间指纹，供执行缓存失效判断。

        model 是节点缓存接口要求的输入，不读取模型内容；loras 使用同一 JSON 校验。
        无活动项返回空元组且不访问文件；配置、路径和 stat 异常传播，不读取权重。
        保留全部文件元数据的特殊替换不在该指纹的检测范围内。
        """
        fingerprint = []
        for path, _ in _active_loras(loras):
            stat = os.stat(path)
            fingerprint.append((path, stat.st_size, stat.st_mtime_ns))
        return tuple(fingerprint)
