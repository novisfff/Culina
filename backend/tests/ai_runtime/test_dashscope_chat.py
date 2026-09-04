from __future__ import annotations

from types import SimpleNamespace

from app.ai.runtime.dashscope_chat import DashScopeChatProvider
from app.ai.runtime.types import ProviderImageInput, ProviderUserInput
from app.services.family_model_settings.types import DispatchCredential


def _binding(*, supports_vision: bool = False):
    return SimpleNamespace(
        requested_model="qwen-plus",
        options={"supports_vision": supports_vision, "max_output_tokens": 128},
    )


def test_dashscope_generation_response_is_normalized(monkeypatch) -> None:
    seen: dict[str, object] = {}

    def call(**kwargs):
        seen.update(kwargs)
        return {"request_id": "req-1", "output": {"text": "你好"}, "usage": {"input_tokens": 3, "output_tokens": 2}}

    monkeypatch.setattr("app.ai.runtime.dashscope_chat.dashscope.Generation.call", call)
    provider = DashScopeChatProvider(binding=_binding())

    result = provider.generate(system="你是助手", user="介绍一下自己")

    assert result.text == "你好"
    assert "api_key" not in seen
    assert seen["model"] == "qwen-plus"
    assert seen["messages"][-1]["content"] == "介绍一下自己"


def test_dashscope_multimodal_routes_image_messages(monkeypatch) -> None:
    seen: dict[str, object] = {}

    def call(**kwargs):
        seen.update(kwargs)
        return {"request_id": "req-2", "output": {"choices": [{"message": {"role": "assistant", "content": "图"}}]}}

    monkeypatch.setattr("app.ai.runtime.dashscope_chat.dashscope.MultiModalConversation.call", call)
    provider = DashScopeChatProvider(binding=_binding(supports_vision=True))

    result = provider.generate(
        system="识别图片",
        user=ProviderUserInput(
            text="这是什么？",
            images=[ProviderImageInput(media_id="m1", content_type="image/png", payload=b"png")],
        ),
    )

    assert result.text == "图"
    messages = seen["messages"]
    assert isinstance(messages, list)
    assert any(
        part.get("image", "").startswith("data:image/png;base64,")
        for part in messages[-1]["content"]
        if isinstance(part, dict)
    )


def test_dashscope_resolves_one_dispatch_key_for_sdk_call(monkeypatch) -> None:
    seen: dict[str, object] = {}

    def call(**kwargs):
        seen.update(kwargs)
        return {"output": {"text": "ok"}}

    monkeypatch.setattr("app.ai.runtime.dashscope_chat.dashscope.Generation.call", call)
    provider = DashScopeChatProvider(
        binding=_binding(),
        resolve_dispatch_credential=lambda binding, secret_version: DispatchCredential(
            family_id="f",
            provider_profile_id="p",
            secret_version_id=secret_version,
            api_key="sk-one-key",
        ),
    )
    provider.generate(system="", user="hi")
    assert seen["api_key"] == "sk-one-key"
