class EnhanceKitPromptLibrary:
    """输出提交前解析的提示词快照，执行期间不读取或修改共享库。"""

    @classmethod
    def INPUT_TYPES(cls):
        """声明原生多行正文控件；正文由前端解析，禁止动态展开及转为连线输入。"""
        return {"required": {"resolved_text": ("STRING", {
            "default": "", "multiline": True, "dynamicPrompts": False, "socketless": True,
        })}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "emit"
    CATEGORY = "EnhanceKit/Prompt"
    DESCRIPTION = "按分类选择共享提示词，运行时获取最新正文。使用管理按钮维护提示词库。"

    def emit(self, resolved_text: str) -> tuple[str]:
        """原样返回 resolved_text 的单项元组；空正文有效，不展开变量或读取文件。"""
        return (resolved_text,)
