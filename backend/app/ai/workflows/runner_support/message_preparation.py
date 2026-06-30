from __future__ import annotations


def message_summary(prompt: str, attachment_count: int) -> str:
    if prompt.strip():
        return prompt.strip()
    return f"上传了 {attachment_count} 张图片"
