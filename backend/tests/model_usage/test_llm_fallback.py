from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest

from app.ai.errors import ApprovalRequired
from app.ai.runtime.openai_chat import OpenAICompatibleChatProvider
from app.ai.runtime.openai_responses import OpenAIResponsesChatProvider
from app.core.enums import ModelUsageAttributionKind, ModelUsageOperationSource
from app.services.model_usage.errors import ModelUsageBlocked
from app.services.model_usage.types import UsageAttribution


ATTRIBUTION = UsageAttribution(
    family_id="family-llm-fallback",
    attribution_kind=ModelUsageAttributionKind.USER,
    actor_user_id="user-llm-fallback",
    operation_source=ModelUsageOperationSource.INTERACTIVE,
    logical_operation_id="run-llm-fallback",
)


@dataclass
class _Permit:
    attempt_key: str


class _Attempt:
    def __init__(self, *, attempt_key: str, log: list[str]) -> None:
        self._permit = _Permit(attempt_key)
        self._log = log

    def prepare_dispatch(self) -> _Permit:
        self._log.append(f"dispatch:{self._permit.attempt_key}")
        return self._permit

    def settle(self, receipt: object) -> None:
        self._log.append(f"settle:{receipt}")

    def mark_uncertain(self, stable_error_code: str) -> None:
        self._log.append(f"uncertain:{stable_error_code}")


class _Adapter:
    def __init__(self) -> None:
        self.log: list[str] = []
        self.rounds: list[dict[str, Any]] = []

    def request_fingerprint(self, payload: object) -> str:
        return f"fingerprint-{len(self.rounds) + 1}-{len(str(payload))}"

    def start_round(self, attribution: UsageAttribution, **kwargs: Any) -> _Attempt:
        assert attribution == ATTRIBUTION
        self.rounds.append(kwargs)
        key = f"attempt-{kwargs['attempt_index']}"
        self.log.append(f"reserve:{key}")
        return _Attempt(attempt_key=key, log=self.log)

    def confirmed_not_executed_receipt(self, permit: _Permit, **kwargs: Any) -> str:
        return f"not-billed:{permit.attempt_key}:{kwargs['stable_provider_request_id']}"

    def receipt_from_openai_usage(self, permit: _Permit, **_kwargs: Any) -> str:
        return f"succeeded:{permit.attempt_key}"


class _PrimaryBlockedAdapter(_Adapter):
    def start_round(self, attribution: UsageAttribution, **kwargs: Any) -> _Attempt:
        if kwargs["model"] == "gpt-large":
            self.rounds.append(kwargs)
            self.log.append("reserve:blocked-primary")
            raise ModelUsageBlocked("model_usage_budget_exceeded")
        return super().start_round(attribution, **kwargs)


def _strict_provider(adapter: _Adapter, create) -> OpenAICompatibleChatProvider:
    provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
    provider.model_name = "gpt-test"
    provider.supports_vision = False
    provider.prompt_cache_enabled = True
    provider.max_output_tokens = 64
    provider.model_usage_required = True
    provider.usage_adapter = adapter
    provider.openai_client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    return provider


def test_confirmed_unsupported_option_settles_then_uses_new_metered_attempt() -> None:
    adapter = _Adapter()
    requests: list[dict[str, Any]] = []

    def create(**request: Any) -> Any:
        requests.append(request)
        if len(requests) == 1:
            raise TypeError("unexpected keyword argument 'prompt_cache_key'")
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="已降级"))],
            usage={"prompt_tokens": 3, "completion_tokens": 1},
        )

    result = _strict_provider(adapter, create).generate(
        system="system",
        user="hello",
        usage_attribution=ATTRIBUTION,
    )

    assert result.status == "completed"
    assert [item["attempt_index"] for item in adapter.rounds] == [1, 2]
    assert "prompt_cache_key" in requests[0]
    assert "prompt_cache_key" not in requests[1]
    assert adapter.log == [
        "reserve:attempt-1",
        "dispatch:attempt-1",
        "settle:not-billed:attempt-1:provider_unsupported_prompt_cache",
        "reserve:attempt-2",
        "dispatch:attempt-2",
        "settle:succeeded:attempt-2",
    ]


def test_ambiguous_primary_failure_never_starts_a_fallback_attempt() -> None:
    adapter = _Adapter()
    calls = 0

    def create(**_request: Any) -> Any:
        nonlocal calls
        calls += 1
        raise TimeoutError("provider transport timed out")

    result = _strict_provider(adapter, create).generate(
        system="system",
        user="hello",
        usage_attribution=ATTRIBUTION,
    )

    assert result.status == "fallback"
    assert calls == 1
    assert [item["attempt_index"] for item in adapter.rounds] == [1]
    assert adapter.log == [
        "reserve:attempt-1",
        "dispatch:attempt-1",
        "uncertain:provider_chat_transport_ambiguous",
    ]


def test_pre_dispatch_budget_block_uses_configured_light_model_with_new_attempt() -> None:
    adapter = _PrimaryBlockedAdapter()
    requests: list[dict[str, Any]] = []

    def create(**request: Any) -> Any:
        requests.append(request)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="轻量回复"))],
            usage={"prompt_tokens": 3, "completion_tokens": 1},
        )

    provider = _strict_provider(adapter, create)
    provider.model_name = "gpt-large"
    provider.fallback_model = "gpt-light"
    provider.fallback_max_output_tokens = 16

    result = provider.generate(
        system="system",
        user="hello",
        usage_attribution=ATTRIBUTION,
    )

    assert result.status == "completed"
    assert result.model == "gpt-light"
    assert result.fallback_used is True
    assert result.fallback_reason_code == "model_usage_budget_exceeded"
    assert [item["model"] for item in adapter.rounds] == ["gpt-large", "gpt-light"]
    assert requests[0]["model"] == "gpt-light"
    assert requests[0]["max_tokens"] == 16


def test_responses_pre_dispatch_budget_block_uses_configured_light_model() -> None:
    adapter = _PrimaryBlockedAdapter()
    requests: list[dict[str, Any]] = []

    def create(**request: Any) -> Any:
        requests.append(request)
        return iter(
            [
                SimpleNamespace(type="response.output_text.delta", delta="轻量回复"),
                SimpleNamespace(
                    type="response.completed",
                    response=SimpleNamespace(
                        usage={"prompt_tokens": 3, "completion_tokens": 1},
                        output=[],
                    ),
                ),
            ]
        )

    provider = OpenAIResponsesChatProvider.__new__(OpenAIResponsesChatProvider)
    provider.model_name = "gpt-large"
    provider.supports_vision = False
    provider.prompt_cache_enabled = False
    provider.max_output_tokens = 64
    provider.fallback_model = "gpt-light"
    provider.fallback_max_output_tokens = 16
    provider.model_usage_required = True
    provider.usage_adapter = adapter
    provider.client = SimpleNamespace(responses=SimpleNamespace(create=create))

    result = provider.generate(
        system="system",
        user="hello",
        usage_attribution=ATTRIBUTION,
    )

    assert result.status == "completed"
    assert result.model == "gpt-light"
    assert result.fallback_used is True
    assert result.fallback_reason_code == "model_usage_budget_exceeded"
    assert [item["model"] for item in adapter.rounds] == ["gpt-large", "gpt-light"]
    assert requests[0]["model"] == "gpt-light"
    assert requests[0]["max_output_tokens"] == 16


def test_responses_tool_loop_preserves_first_round_fallback_metadata() -> None:
    class FirstRoundPrimaryBlockedAdapter(_Adapter):
        def start_round(self, attribution: UsageAttribution, **kwargs: Any) -> _Attempt:
            if kwargs["model"] == "gpt-large" and kwargs["provider_round"] == 1:
                self.rounds.append(kwargs)
                self.log.append("reserve:blocked-primary")
                raise ModelUsageBlocked("model_usage_budget_exceeded")
            return super().start_round(attribution, **kwargs)

    adapter = FirstRoundPrimaryBlockedAdapter()
    function_call = {
        "type": "function_call",
        "call_id": "call-read-items",
        "name": "inventory_read_available_items",
        "arguments": "{}",
        "status": "completed",
    }

    def create(**_request: Any) -> Any:
        if len(adapter.rounds) == 2:
            return iter(
                [
                    SimpleNamespace(type="response.output_item.done", item=function_call),
                    SimpleNamespace(type="response.completed", response=SimpleNamespace(output=[function_call], usage=None)),
                ]
            )
        return iter(
            [
                SimpleNamespace(type="response.output_text.delta", delta="已继续完成。"),
                SimpleNamespace(type="response.completed", response=SimpleNamespace(output=[], usage=None)),
            ]
        )

    provider = OpenAIResponsesChatProvider.__new__(OpenAIResponsesChatProvider)
    provider.model_name = "gpt-large"
    provider.supports_vision = False
    provider.prompt_cache_enabled = False
    provider.max_output_tokens = 64
    provider.fallback_model = "gpt-light"
    provider.fallback_max_output_tokens = 16
    provider.model_usage_required = True
    provider.usage_adapter = adapter
    provider.client = SimpleNamespace(responses=SimpleNamespace(create=create))

    result = provider.generate_with_tools(
        system="system",
        user="hello",
        tools=lambda: [],
        tool_handler=lambda _name, _payload, _event_id=None: {},
        max_rounds=2,
        usage_attribution=ATTRIBUTION,
    )

    assert result.status == "completed"
    assert result.model == "gpt-large"
    assert result.fallback_used is True
    assert result.fallback_reason_code == "model_usage_budget_exceeded"


def test_chat_fallback_metadata_survives_draft_approval_interrupt() -> None:
    adapter = _PrimaryBlockedAdapter()

    def create(**_request: Any) -> Any:
        return [
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call-draft",
                                    "function": {
                                        "name": "recipe_create_draft",
                                        "arguments": '{"draft":{"title":"番茄炒蛋"}}',
                                    },
                                }
                            ]
                        }
                    }
                ],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1},
            }
        ]

    provider = _strict_provider(adapter, create)
    provider.model_name = "gpt-large"
    provider.fallback_model = "gpt-light"
    provider.fallback_max_output_tokens = 16

    with pytest.raises(ApprovalRequired) as exc_info:
        provider.generate_with_tools(
            system="system",
            user="hello",
            tools=lambda: [],
            tool_handler=lambda _name, _payload, _event_id=None: (_ for _ in ()).throw(
                ApprovalRequired("approval required")
            ),
            usage_attribution=ATTRIBUTION,
        )

    control_flow = getattr(exc_info.value, "_culina_provider_control_flow", None)
    assert control_flow is not None
    assert control_flow.model == "gpt-light"
    assert control_flow.fallback_used is True
    assert control_flow.fallback_reason_code == "model_usage_budget_exceeded"


def test_responses_fallback_metadata_survives_draft_approval_interrupt() -> None:
    adapter = _PrimaryBlockedAdapter()
    function_call = {
        "type": "function_call",
        "call_id": "call-draft",
        "name": "recipe_create_draft",
        "arguments": '{"draft":{"title":"番茄炒蛋"}}',
        "status": "completed",
    }

    def create(**_request: Any) -> Any:
        return iter(
            [
                SimpleNamespace(type="response.output_item.done", item=function_call),
                SimpleNamespace(
                    type="response.completed",
                    response=SimpleNamespace(
                        usage={"prompt_tokens": 3, "completion_tokens": 1},
                        output=[function_call],
                    ),
                ),
            ]
        )

    provider = OpenAIResponsesChatProvider.__new__(OpenAIResponsesChatProvider)
    provider.model_name = "gpt-large"
    provider.supports_vision = False
    provider.prompt_cache_enabled = False
    provider.max_output_tokens = 64
    provider.fallback_model = "gpt-light"
    provider.fallback_max_output_tokens = 16
    provider.model_usage_required = True
    provider.usage_adapter = adapter
    provider.client = SimpleNamespace(responses=SimpleNamespace(create=create))

    with pytest.raises(ApprovalRequired) as exc_info:
        provider.generate_with_tools(
            system="system",
            user="hello",
            tools=lambda: [],
            tool_handler=lambda _name, _payload, _event_id=None: (_ for _ in ()).throw(
                ApprovalRequired("approval required")
            ),
            usage_attribution=ATTRIBUTION,
        )

    control_flow = getattr(exc_info.value, "_culina_provider_control_flow", None)
    assert control_flow is not None
    assert control_flow.model == "gpt-light"
    assert control_flow.fallback_used is True
    assert control_flow.fallback_reason_code == "model_usage_budget_exceeded"
