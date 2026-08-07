from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest

from app.ai.runtime import factory as runtime_factory
from app.ai.errors import AIExecutionCancelled
from app.ai.runtime.openai_chat import OpenAICompatibleChatProvider
from app.ai.runtime.openai_responses import OpenAIResponsesChatProvider
from app.core.enums import ModelUsageAttributionKind, ModelUsageOperationSource
from app.services.model_usage.types import UsageAttribution


ATTRIBUTION = UsageAttribution(
    family_id="family-provider-contract",
    attribution_kind=ModelUsageAttributionKind.USER,
    actor_user_id="user-provider-contract",
    operation_source=ModelUsageOperationSource.INTERACTIVE,
    logical_operation_id="run-provider-contract",
)


@dataclass
class _Permit:
    attempt_key: str = "attempt-1"


class _Attempt:
    def __init__(self, timeline: list[str]) -> None:
        self.timeline = timeline

    def prepare_dispatch(self) -> _Permit:
        self.timeline.append("dispatch")
        return _Permit()

    def settle(self, receipt: object) -> None:
        assert receipt == "signed-receipt"
        self.timeline.append("settle")

    def mark_uncertain(self, stable_error_code: str) -> None:
        self.timeline.append(f"uncertain:{stable_error_code}")


class _Adapter:
    def __init__(self) -> None:
        self.timeline: list[str] = []
        self.rounds: list[dict[str, Any]] = []

    def start_round(self, attribution: UsageAttribution, **kwargs: Any) -> _Attempt:
        assert attribution == ATTRIBUTION
        self.timeline.append("reserve")
        self.rounds.append(kwargs)
        return _Attempt(self.timeline)

    def receipt_from_openai_usage(self, permit: _Permit, **kwargs: Any) -> str:
        assert permit.attempt_key == "attempt-1"
        assert kwargs["raw_usage"] == {"prompt_tokens": 4, "completion_tokens": 2}
        self.timeline.append("receipt")
        return "signed-receipt"


class _ChatCompletions:
    def __init__(self, timeline: list[str]) -> None:
        self.timeline = timeline
        self.request: dict[str, Any] | None = None

    def create(self, **request: Any) -> Any:
        self.timeline.append("provider_create")
        self.request = request
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="已完成"))],
            usage={"prompt_tokens": 4, "completion_tokens": 2},
            model="provider-alias",
            id="request-1",
        )


class _Responses:
    def __init__(self, timeline: list[str]) -> None:
        self.timeline = timeline
        self.request: dict[str, Any] | None = None

    def create(self, **request: Any) -> Any:
        self.timeline.append("provider_create")
        self.request = request
        return iter(
            [
                SimpleNamespace(type="response.output_text.delta", delta="已完成"),
                SimpleNamespace(
                    type="response.completed",
                    response=SimpleNamespace(
                        usage={"prompt_tokens": 4, "completion_tokens": 2},
                        model="provider-alias",
                        id="request-2",
                        output=[],
                    ),
                ),
            ]
        )


def _chat_provider(adapter: _Adapter) -> tuple[OpenAICompatibleChatProvider, _ChatCompletions]:
    provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
    provider.model_name = "gpt-test"
    provider.supports_vision = False
    provider.prompt_cache_enabled = False
    provider.max_output_tokens = 77
    provider.model_usage_required = True
    provider.usage_adapter = adapter
    completions = _ChatCompletions(adapter.timeline)
    provider.openai_client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    return provider, completions


def _responses_provider(adapter: _Adapter) -> tuple[OpenAIResponsesChatProvider, _Responses]:
    provider = OpenAIResponsesChatProvider.__new__(OpenAIResponsesChatProvider)
    provider.model_name = "gpt-test"
    provider.supports_vision = False
    provider.prompt_cache_enabled = False
    provider.max_output_tokens = 77
    provider.model_usage_required = True
    provider.usage_adapter = adapter
    responses = _Responses(adapter.timeline)
    provider.client = SimpleNamespace(responses=responses)
    return provider, responses


def test_chat_provider_dispatches_before_send_and_caps_output() -> None:
    adapter = _Adapter()
    provider, completions = _chat_provider(adapter)

    result = provider.generate(
        system="system",
        user="hello",
        usage_attribution=ATTRIBUTION,
    )

    assert result.status == "completed"
    assert completions.request is not None
    assert completions.request["max_tokens"] == 77
    assert adapter.timeline[:3] == ["reserve", "dispatch", "provider_create"]
    assert adapter.timeline[-2:] == ["receipt", "settle"]
    assert adapter.rounds[0]["output_cap"] == 77


def test_chat_provider_rejects_strict_remote_send_without_trusted_attribution() -> None:
    adapter = _Adapter()
    provider, completions = _chat_provider(adapter)

    result = provider.generate(system="system", user="hello")

    assert result.status == "failed"
    assert result.error == "model_usage_attribution_required"
    assert completions.request is None
    assert adapter.timeline == []


def test_responses_provider_dispatches_before_send_and_caps_output() -> None:
    adapter = _Adapter()
    provider, responses = _responses_provider(adapter)

    result = provider.generate(
        system="system",
        user="hello",
        usage_attribution=ATTRIBUTION,
    )

    assert result.status == "completed"
    assert responses.request is not None
    assert responses.request["max_output_tokens"] == 77
    assert adapter.timeline[:3] == ["reserve", "dispatch", "provider_create"]
    assert adapter.timeline[-2:] == ["receipt", "settle"]


def test_responses_stream_without_completed_event_is_marked_uncertain() -> None:
    adapter = _Adapter()
    provider, _responses = _responses_provider(adapter)

    def create(**_request: Any) -> Any:
        adapter.timeline.append("provider_create")
        return iter([SimpleNamespace(type="response.output_text.delta", delta="不完整")])

    provider.client = SimpleNamespace(responses=SimpleNamespace(create=create))
    result = provider.generate(
        system="system",
        user="hello",
        usage_attribution=ATTRIBUTION,
    )

    assert result.status == "failed"
    assert result.error == "provider_responses_completion_missing"
    assert adapter.timeline == [
        "reserve",
        "dispatch",
        "provider_create",
        "uncertain:provider_responses_stream_transport_ambiguous",
    ]


def test_streaming_chat_settles_provider_usage_without_trace_recorder() -> None:
    adapter = _Adapter()
    provider, _completions = _chat_provider(adapter)

    def create(**_request: Any) -> Any:
        adapter.timeline.append("provider_create")
        return iter(
            [
                {"choices": [{"delta": {"content": "流式完成"}}], "usage": None},
                {
                    "choices": [],
                    "usage": {"prompt_tokens": 4, "completion_tokens": 2},
                },
            ]
        )

    provider.openai_client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    result = provider.generate_with_tools(
        system="system",
        user="hello",
        tools=lambda: [],
        tool_handler=lambda _name, _payload, _event_id=None: {},
        usage_attribution=ATTRIBUTION,
    )

    assert result.status == "completed"
    assert adapter.timeline[:3] == ["reserve", "dispatch", "provider_create"]
    assert adapter.timeline[-2:] == ["receipt", "settle"]


def test_streaming_chat_cancellation_marks_only_the_dispatched_attempt_uncertain() -> None:
    adapter = _Adapter()
    provider, _completions = _chat_provider(adapter)

    class _CancelledStream:
        def __iter__(self):
            raise AIExecutionCancelled("cancelled")
            yield None  # pragma: no cover - keeps this a generator for typing

    def create(**_request: Any) -> Any:
        adapter.timeline.append("provider_create")
        return _CancelledStream()

    provider.openai_client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))

    with pytest.raises(AIExecutionCancelled):
        provider.generate_with_tools(
            system="system",
            user="hello",
            tools=lambda: [],
            tool_handler=lambda _name, _payload, _event_id=None: {},
            usage_attribution=ATTRIBUTION,
        )

    assert adapter.timeline == [
        "reserve",
        "dispatch",
        "provider_create",
        "uncertain:provider_stream_cancelled",
    ]


def test_chat_provider_constructor_disables_sdk_retries(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    class _OpenAI:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

    monkeypatch.setattr("app.ai.runtime.openai_chat.OpenAI", _OpenAI)

    OpenAICompatibleChatProvider(
        api_base="https://example.invalid/v1",
        api_key="test-key",
        model_name="gpt-test",
    )

    assert captured["max_retries"] == 0


def test_responses_provider_constructor_disables_sdk_retries(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    class _OpenAI:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

    monkeypatch.setattr("app.ai.runtime.openai_responses.OpenAI", _OpenAI)

    OpenAIResponsesChatProvider(
        api_base="https://example.invalid/v1",
        api_key="test-key",
        model_name="gpt-test",
    )

    assert captured["max_retries"] == 0


@pytest.mark.parametrize(
    ("configured_provider", "constructor_name"),
    (
        ("openai-compatible", "OpenAICompatibleChatProvider"),
        ("openai-responses", "OpenAIResponsesChatProvider"),
    ),
)
def test_runtime_factory_preserves_configured_provider_identity_for_usage_pricing(
    monkeypatch: pytest.MonkeyPatch,
    configured_provider: str,
    constructor_name: str,
) -> None:
    adapter_providers: list[str] = []
    constructor_arguments: dict[str, Any] = {}

    def build_adapter(_settings: object, *, provider: str) -> object:
        adapter_providers.append(provider)
        return object()

    def build_provider(**kwargs: Any) -> object:
        constructor_arguments.update(kwargs)
        return object()

    monkeypatch.setattr(runtime_factory, "_model_usage_adapter", build_adapter)
    monkeypatch.setattr(runtime_factory, constructor_name, build_provider)
    settings = SimpleNamespace(
        ai_provider=configured_provider,
        ai_model="gpt-test",
        ai_supports_vision=False,
        ai_api_key="test-key",
        ai_prompt_cache_enabled=False,
        ai_max_output_tokens=16,
        ai_fallback_model="",
        ai_fallback_max_output_tokens=0,
        model_usage_required=True,
        ai_api_base="https://example.invalid/v1",
        ai_timeout_seconds=5,
    )

    runtime_factory.build_chat_provider(settings)

    assert adapter_providers == [configured_provider]
    assert constructor_arguments["usage_adapter"] is not None
