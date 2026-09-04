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

    class _Completions:
        def create(self, **kwargs):
            seen.update(kwargs)
            return {
                "id": "req-1",
                "model": "qwen-plus",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "你好"}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2},
            }

    class _Client:
        def __init__(self, **kwargs):
            seen["client_kwargs"] = kwargs
            self.chat = type("_Chat", (), {"completions": _Completions()})()

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    monkeypatch.setattr("app.ai.runtime.dashscope_chat.openai.OpenAI", _Client)
    provider = DashScopeChatProvider(binding=_binding())

    result = provider.generate(system="你是助手", user="介绍一下自己")

    assert result.text == "你好"
    assert seen["client_kwargs"] == {
        "api_key": None,
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "max_retries": 0,
    }
    assert seen["model"] == "qwen-plus"
    assert seen["messages"][-1]["content"] == "介绍一下自己"


def test_dashscope_multimodal_uses_same_openai_compatible_path(monkeypatch) -> None:
    seen: dict[str, object] = {}

    class _Completions:
        def create(self, **kwargs):
            seen.update(kwargs)
            return {
                "id": "req-2",
                "model": "qwen-plus",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "图"}}],
            }

    class _Client:
        def __init__(self, **kwargs):
            seen["client_kwargs"] = kwargs
            self.chat = type("_Chat", (), {"completions": _Completions()})()

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    monkeypatch.setattr("app.ai.runtime.dashscope_chat.openai.OpenAI", _Client)
    provider = DashScopeChatProvider(binding=_binding(supports_vision=True))

    result = provider.generate(
        system="识别图片",
        user=ProviderUserInput(
            text="这是什么？",
            images=[ProviderImageInput(media_id="m1", content_type="image/png", payload=b"png")],
        ),
    )

    assert result.text == "图"
    assert seen["client_kwargs"] == {
        "api_key": None,
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "max_retries": 0,
    }
    messages = seen["messages"]
    assert isinstance(messages, list)
    assert any(
        part.get("type") == "image_url"
        and part.get("image_url", {}).get("url", "").startswith("data:image/png;base64,")
        for part in messages[-1]["content"]
        if isinstance(part, dict)
    )


def test_dashscope_resolves_one_dispatch_key_for_sdk_call(monkeypatch) -> None:
    seen: dict[str, object] = {}

    def call(**kwargs):
        seen.update(kwargs)
        return {"output": {"text": "ok"}}

    class _Client:
        def __init__(self, **kwargs):
            seen["client_kwargs"] = kwargs
            self.chat = type(
                "_Chat",
                (),
                {"completions": type("_Completions", (), {"create": staticmethod(call)})()},
            )()

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    monkeypatch.setattr("app.ai.runtime.dashscope_chat.openai.OpenAI", _Client)
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
    assert seen["client_kwargs"] == {
        "api_key": "sk-one-key",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "max_retries": 0,
    }
    assert seen["messages"][-1]["content"] == "hi"
