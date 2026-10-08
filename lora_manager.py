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
        clip_strength = item.get("clip_strength", 0)
        if type(clip_strength) not in (int, float) or (isinstance(clip_strength, float) and not math.isfinite(clip_strength)):
            raise ValueError(f"第 {index} 项 LoRA 的 clip_strength 必须是有限数值")
        if item["enabled"] and (strength != 0 or clip_strength != 0):
            active.append((item["name"], strength, clip_strength))

    if not active:
        return []
    available = set(folder_paths.get_filename_list("loras"))
    resolved = []
    for name, strength, clip_strength in active:
        if name not in available:
            raise ValueError(f"LoRA 文件不在当前可用列表中：{name}")
        resolved.append((folder_paths.get_full_path_or_raise("loras", name), strength, clip_strength))
    return resolved


class EnhanceKitLoraManager:
    """按工作流中的有序列表独立应用 MODEL 和 CLIP LoRA，复用官方补丁能力。"""

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("model", "clip")
    FUNCTION = "apply_loras"
    CATEGORY = "EnhanceKit/Model"

    @classmethod
    def INPUT_TYPES(cls):
        """声明必填 MODEL、JSON 列表及可选 CLIP，返回含官方 LoRA 文件选项的输入契约。

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
        }, "optional": {"clip": ("CLIP",)}}

    def apply_loras(self, model, loras, clip=None):
        """按 loras JSON 顺序为 model 和可选 clip 应用双强度 LoRA，返回 (MODEL, CLIP)。

        model 是原模型；clip 未连接时为 None，活动项 CLIP 强度非零则要求接入。
        配置不合法、缺少必需 CLIP 或文件不在官方列表时抛出 ValueError；底层异常传播。
        停用或双零项不访问文件；仅非零部分交由官方接口克隆，零强度部分保留原对象。
        旧行缺少 clip_strength 时按 0 处理；强度接受所有有限数值，重复行逐项应用。
        文件数据仅在本次调用内复用，不保留跨执行缓存。
        """
        active = _active_loras(loras)
        if clip is None and any(clip_strength != 0 for _, _, clip_strength in active):
            raise ValueError("使用非零 CLIP 强度时请接入 CLIP")
        loaded = {}
        for path, strength, clip_strength in active:
            if path not in loaded:
                loaded[path] = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
            data, metadata = loaded[path]
            patched_model, patched_clip = comfy.sd.load_lora_for_models(model if strength != 0 else None, clip if clip_strength != 0 else None, data, strength, clip_strength, lora_metadata=metadata)
            if strength != 0:
                model = patched_model
            if clip_strength != 0:
                clip = patched_clip
        return (model, clip)

    @classmethod
    def IS_CHANGED(cls, model, loras, clip=None):
        """返回 loras 活动文件的有序路径、大小和纳秒修改时间指纹，供执行缓存失效判断。

        model 与 clip 是缓存接口要求的参数，连线对象可为占位 None，不检查对象可用性。
        loras 使用与执行相同的配置、活动项和路径校验；任一强度非零的启用项均参与指纹。
        无活动项返回空元组且不访问文件；配置、路径和 stat 异常传播，不读取权重。
        保留全部文件元数据的特殊替换不在该指纹的检测范围内。
        """
        fingerprint = []
        for path, _, _ in _active_loras(loras):
            stat = os.stat(path)
            fingerprint.append((path, stat.st_size, stat.st_mtime_ns))
        return tuple(fingerprint)
