from __future__ import annotations

import base64
from typing import Any

from app.ai.runtime.types import ProviderUserContent, ProviderUserInput


def openai_chat_content(user: ProviderUserContent, *, supports_vision: bool) -> str | list[dict[str, Any]]:
    if isinstance(user, str):
        return user
    if user.images and not supports_vision:
        raise ValueError("当前 AI 模型暂不支持图片识别，请切换支持视觉输入的模型后再试。")
    content: list[dict[str, Any]] = [{"type": "text", "text": user.text}]
    for image in user.images:
        encoded = base64.b64encode(image.payload).decode("ascii")
        content.append(
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:{image.content_type};base64,{encoded}",
                },
            }
        )
    return content


def openai_chat_messages(system: str, user: ProviderUserContent, *, supports_vision: bool) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    if isinstance(user, ProviderUserInput):
        messages.extend(
            {"role": "user", "content": prefix}
            for prefix in user.prefix_messages
            if isinstance(prefix, str) and prefix
        )
    messages.append({"role": "user", "content": openai_chat_content(user, supports_vision=supports_vision)})
    return messages


def responses_input(user: ProviderUserContent, *, supports_vision: bool) -> list[dict[str, Any]]:
    if isinstance(user, str):
        return [responses_text_message("user", user)]
    if user.images and not supports_vision:
        raise ValueError("当前 AI 模型暂不支持图片识别，请切换支持视觉输入的模型后再试。")
    messages: list[dict[str, Any]] = [
        responses_text_message("user", prefix)
        for prefix in user.prefix_messages
        if isinstance(prefix, str) and prefix
    ]
    if user.images:
        content: list[dict[str, Any]] = [{"type": "input_text", "text": user.text}]
        for image in user.images:
            encoded = base64.b64encode(image.payload).decode("ascii")
            content.append(
                {
                    "type": "input_image",
                    "image_url": f"data:{image.content_type};base64,{encoded}",
                    "detail": "auto",
                }
            )
        messages.append({"type": "message", "role": "user", "content": content})
    else:
        messages.append(responses_text_message("user", user.text))
    return messages


def responses_system_message(system: str) -> dict[str, Any]:
    return responses_text_message("system", system)


def responses_text_message(role: str, text: str) -> dict[str, Any]:
    return {
        "type": "message",
        "role": role,
        "content": [{"type": "input_text", "text": text}],
    }


def field_value(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def dump_value(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        try:
            return value.model_dump()
        except Exception:
            pass
    if isinstance(value, dict):
        return value
    if hasattr(value, "__dict__") and not isinstance(value, (str, bytes, bytearray)):
        return {key: item for key, item in vars(value).items() if not key.startswith("_")}
    return value
