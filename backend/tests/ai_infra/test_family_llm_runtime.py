from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import json
from threading import Lock
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select

from app.ai.observability.llm_exchange import LLMExchangeRecorder
from app.ai.runtime.family_transport import DeferredBindingTransport
from app.ai.runtime.factory import FamilyChatProviderSelection
from app.ai.runtime.openai_chat import OpenAICompatibleChatProvider
from app.ai.workflows.runner import WorkspaceGraphRunner
from app.ai.workflows.runner_support.stream_bridge import make_stream_worker_runner
from app.ai.workflows.runner_support.user_message_preparer import UserMessagePreparer
from app.core.enums import ModelUsageAttributionKind, ModelUsageOperationSource
from app.models.domain import AIAgentRun, AIRunLLMExchange
from app.models.family_model_settings import FamilyModelSettings
from app.services.family_model_settings.resolver import FamilyModelConfigurationResolver
from app.services.family_model_settings.transport import ProviderResponse
from app.services.family_model_settings.types import (
    DispatchCredential,
    ResolvedCapabilityBinding,
    ResolvedProviderEndpoint,
)
from app.services.model_usage.types import UsageAttribution

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api


def _llm_payload(profile_id: str, *, model: str) -> dict[str, object]:
    return {
        "bindings": [
            {
                "capability": "llm",
                "variant_key": "primary",
                "enabled": True,
                "provider_profile_id": profile_id,
                "requested_model": model,
                "max_output_tokens": 256,
            }
        ],
        "price_rates": [
            {
                "capability": "llm",
                "variant_key": "primary",
                "meter": meter,
                "unit_quantity": "1000",
                "unit_price": "0.01",
                "source_currency": "CNY",
                "fx_to_cny": "1",
            }
            for meter in (
                "uncached_input_tokens",
                "cached_input_tokens",
                "output_tokens",
            )
        ],
        "change_note": "LLM runtime snapshot test",
    }


def _publish_llm(
    context: FamilyModelApiContext,
    *,
    family_id: str,
    model: str,
    api_key: str,
) -> dict[str, Any]:
    context.use_owner(family_id)
    profile = context.create_profile(
        display_name=f"{family_id} {model}",
        api_key=api_key,
        idempotency_key=f"llm-runtime-profile-{family_id}-{model}",
    )
    draft_response = context.client.get("/api/family/model-settings/draft")
    assert draft_response.status_code == 200, draft_response.text
    draft_state = draft_response.json()
    saved = context.client.put(
        "/api/family/model-settings/draft",
        json=_llm_payload(str(profile["id"]), model=model)
        | {
            "base_config_revision_id": draft_state.get("base_config_revision_id"),
            "base_draft_version_number": draft_state["draft_version_number"],
            "idempotency_key": f"llm-runtime-draft-{family_id}-{model}",
        },
    )
    assert saved.status_code == 200, saved.text
    draft = saved.json()
    validated = context.client.post(
        "/api/family/model-settings/draft/validate",
        json={"base_draft_version_number": draft["draft_version_number"]},
    )
    assert validated.status_code == 200, validated.text
    settings = context.client.get("/api/family/model-settings")
    assert settings.status_code == 200, settings.text
    published = context.client.post(
        "/api/family/model-settings/publish",
        json={
            "base_settings_version_number": settings.json()["version_number"],
            "base_draft_version_number": draft["draft_version_number"],
            "idempotency_key": f"llm-runtime-publish-{family_id}-{model}",
            "config_checksum": validated.json()["config_checksum"],
            "price_checksum": validated.json()["price_checksum"],
            "current_password": "OwnerPass123",
        },
    )
    assert published.status_code == 200, published.text
    return {"profile": profile, "published": published.json()}


@dataclass(slots=True)
class _RecordingProvider:
    model_name: str
    supports_vision: bool = False


class _RevisionFactory:
    """A deliberately explicit provider factory for run-boundary tests."""

    def __init__(self, models: dict[tuple[str, str], str]) -> None:
        self.models = models
        self.active_calls: list[tuple[str, str]] = []
        self.revision_calls: list[tuple[str, str]] = []

    def _selection(self, family_id: str, config_revision_id: str) -> FamilyChatProviderSelection:
        model = self.models[(family_id, config_revision_id)]
        return FamilyChatProviderSelection(
            config_revision_id=config_revision_id,
            primary=_RecordingProvider(model),
        )

    def for_active_family(self, db: Any, *, family_id: str) -> FamilyChatProviderSelection:
        settings = db.get(FamilyModelSettings, family_id)
        assert settings is not None and settings.active_config_revision_id is not None
        self.active_calls.append((family_id, settings.active_config_revision_id))
        return self._selection(family_id, settings.active_config_revision_id)

    def for_run_revision(
        self,
        db: Any,
        *,
        family_id: str,
        config_revision_id: str,
    ) -> FamilyChatProviderSelection:
        del db
        self.revision_calls.append((family_id, config_revision_id))
        return self._selection(family_id, config_revision_id)


def _prepare_run(
    context: FamilyModelApiContext,
    factory: _RevisionFactory,
    *,
    family_id: str,
    user_id: str,
) -> str:
    with context.session_factory() as db:
        prepared = UserMessagePreparer(
            db=db,
            provider_factory=factory,
            json_record=lambda value: value,
        ).prepare(
            family_id=family_id,
            user_id=user_id,
            conversation_id=None,
            prompt="晚餐吃什么",
            message_summary="晚餐吃什么",
            client_message_id=None,
            client_run_id=None,
            quick_task=None,
            subject=None,
        )
        run = db.get(AIAgentRun, prepared.run_id)
        assert run is not None
        return run.id


def _binding(*, family_id: str, model: str) -> ResolvedCapabilityBinding:
    return ResolvedCapabilityBinding(
        family_id=family_id,
        config_revision_id=f"revision-{family_id}",
        provider_profile_id=f"profile-{family_id}",
        provider_profile_version_id=f"profile-version-{family_id}",
        adapter_kind="openai_compatible_http",
        auth_mode="api_key",
        endpoint=ResolvedProviderEndpoint(
            normalized_url=f"https://{family_id}.provider.example/v1",
            scheme="https",
            host=f"{family_id}.provider.example",
            port=443,
            base_path="/v1",
            resolved_addresses=("93.184.216.34",),
            private_target=False,
        ),
        websocket_endpoint=None,
        requested_model=model,
        billing_model=model,
        capability="llm",
        variant_key="primary",
        billing_scheme_key="llm-split-v1",
        options={"max_output_tokens": 64},
    )


class _ThreadSafeTransport:
    def __init__(self, response: ProviderResponse) -> None:
        self.response = response
        self.calls: list[dict[str, Any]] = []
        self._lock = Lock()

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        json: object | None = None,
    ) -> ProviderResponse:
        with self._lock:
            self.calls.append(
                {"method": method, "url": url, "headers": dict(headers), "json": json}
            )
        return self.response


def test_run_snapshot_keeps_its_revision_for_worker_reconstruction(
    family_model_api: FamilyModelApiContext,
) -> None:
    first = _publish_llm(
        family_model_api,
        family_id="family-a",
        model="family-old-model",
        api_key="key-old",
    )
    old_revision = str(first["published"]["config_revision_id"])
    factory = _RevisionFactory({("family-a", old_revision): "family-old-model"})
    run_id = _prepare_run(family_model_api, factory, family_id="family-a", user_id="owner-a")

    with family_model_api.session_factory() as db:
        run = db.get(AIAgentRun, run_id)
        assert run is not None
        assert run.config_revision_id == old_revision
        assert run.model == "family-old-model"

    second = _publish_llm(
        family_model_api,
        family_id="family-a",
        model="family-new-model",
        api_key="key-new",
    )
    new_revision = str(second["published"]["config_revision_id"])
    factory.models[("family-a", new_revision)] = "family-new-model"

    with family_model_api.session_factory() as db:
        runner = WorkspaceGraphRunner.__new__(WorkspaceGraphRunner)
        runner.db = db
        runner.service = SimpleNamespace(provider_factory=factory)
        runner.approval_followup_streamer = SimpleNamespace(provider=None)
        runner._bind_provider_for_run(family_id="family-a", run_id=run_id)
        assert runner.provider.model_name == "family-old-model"

        worker_runner, close_worker = make_stream_worker_runner(
            db_bind=db.get_bind(),
            provider_factory=factory,
            runner_factory=None,
        )
        try:
            worker_runner._bind_provider_for_run(family_id="family-a", run_id=run_id)
            assert worker_runner.provider.model_name == "family-old-model"
        finally:
            close_worker()

    assert factory.active_calls == [("family-a", old_revision)]
    assert factory.revision_calls == [
        ("family-a", old_revision),
        ("family-a", old_revision),
    ]


def test_parallel_families_never_share_provider_identity() -> None:
    response = ProviderResponse(status_code=200, headers={}, content=b'{"ok":true}')
    transport = _ThreadSafeTransport(response)
    bindings = {
        "family-a": _binding(family_id="family-a", model="model-a"),
        "family-b": _binding(family_id="family-b", model="model-b"),
    }
    keys = {"family-a": "key-a", "family-b": "key-b"}

    def dispatch(family_id: str) -> None:
        binding = bindings[family_id]
        DeferredBindingTransport(
            binding=binding,
            transport=transport,  # type: ignore[arg-type]
            resolve_credential=lambda resolved, secret_id: DispatchCredential(
                family_id=resolved.family_id,
                provider_profile_id=resolved.provider_profile_id,
                secret_version_id=secret_id,
                api_key=keys[resolved.family_id],
            ),
        ).request_json(
            suffix="chat/completions",
            payload={"model": binding.requested_model},
            permit=SimpleNamespace(
                credential_secret_version_id=f"secret-{family_id}",
                provider_idempotency_key=None,
            ),
            stream=False,
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        list(executor.map(dispatch, ("family-a", "family-b")))

    calls = {str(call["json"]["model"]): call for call in transport.calls}
    assert calls["model-a"]["headers"]["Authorization"] == "Bearer key-a"
    assert calls["model-b"]["headers"]["Authorization"] == "Bearer key-b"
    assert calls["model-a"]["url"].startswith("https://family-a.provider.example/")
    assert calls["model-b"]["url"].startswith("https://family-b.provider.example/")


def test_chat_transport_decrypts_only_after_dispatch_and_uses_permit_secret() -> None:
    timeline: list[str] = []
    binding = _binding(family_id="family-a", model="model-a")
    response = ProviderResponse(
        status_code=200,
        headers={},
        content=json.dumps(
            {
                "choices": [{"message": {"content": "连接正常"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                "id": "request-a",
            },
            ensure_ascii=False,
        ).encode("utf-8"),
    )

    class Attempt:
        def prepare_dispatch(self) -> Any:
            timeline.append("dispatch")
            return SimpleNamespace(
                credential_secret_version_id="secret-authorized-before-rotation",
                provider_idempotency_key="provider-attempt-a",
            )

        def settle(self, receipt: object) -> None:
            assert receipt == "signed"
            timeline.append("settle")

        def mark_uncertain(self, code: str) -> None:
            timeline.append(f"uncertain:{code}")

    class Adapter:
        def start_round(self, attribution: UsageAttribution, **_kwargs: Any) -> Attempt:
            assert attribution.family_id == "family-a"
            timeline.append("reserve")
            return Attempt()

        def receipt_from_openai_usage(self, _permit: Any, **_kwargs: Any) -> str:
            timeline.append("receipt")
            return "signed"

    class Transport:
        def request(
            self,
            _method: str,
            _url: str,
            *,
            headers: dict[str, str],
            json: object | None = None,
        ) -> ProviderResponse:
            assert headers["Authorization"] == "Bearer old-key"
            assert headers["Idempotency-Key"] == "provider-attempt-a"
            assert isinstance(json, dict) and json["model"] == "model-a"
            timeline.append("transport")
            return response

    def credential_loader(_binding: ResolvedCapabilityBinding, secret_id: str | None) -> DispatchCredential:
        assert secret_id == "secret-authorized-before-rotation"
        timeline.append("decrypt")
        return DispatchCredential(
            family_id="family-a",
            provider_profile_id="profile-family-a",
            secret_version_id=secret_id,
            api_key="old-key",
        )

    provider = OpenAICompatibleChatProvider(
        binding=binding,
        transport=Transport(),  # type: ignore[arg-type]
        resolve_dispatch_credential=credential_loader,
        usage_adapter=Adapter(),  # type: ignore[arg-type]
        model_usage_required=True,
    )
    result = provider.generate(
        system="只回复连接正常",
        user="测试",
        usage_attribution=UsageAttribution(
            family_id="family-a",
            attribution_kind=ModelUsageAttributionKind.USER,
            actor_user_id="owner-a",
            operation_source=ModelUsageOperationSource.INTERACTIVE,
            logical_operation_id="run-a",
        ),
    )

    assert result.text == "连接正常"
    assert timeline == ["reserve", "dispatch", "decrypt", "transport", "receipt", "settle"]


def test_deferred_transport_parses_sse_without_retaining_credential() -> None:
    binding = _binding(family_id="family-a", model="model-a")
    transport = _ThreadSafeTransport(
        ProviderResponse(
            status_code=200,
            headers={"content-type": "text/event-stream"},
            content=b'data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: [DONE]\n\n',
        )
    )
    events = DeferredBindingTransport(
        binding=binding,
        transport=transport,  # type: ignore[arg-type]
        resolve_credential=lambda resolved, secret_id: DispatchCredential(
            family_id=resolved.family_id,
            provider_profile_id=resolved.provider_profile_id,
            secret_version_id=secret_id,
            api_key="key-a",
        ),
    ).request_json(
        suffix="chat/completions",
        payload={"model": "model-a", "stream": True},
        permit=SimpleNamespace(credential_secret_version_id="secret-a", provider_idempotency_key=None),
        stream=True,
    )

    assert list(events) == [{"choices": [{"delta": {"content": "A"}}]}]
    assert transport.calls[0]["headers"]["Accept"] == "text/event-stream"
    assert transport.calls[0]["headers"]["Authorization"] == "Bearer key-a"


def test_llm_exchange_persists_binding_identity_and_keeps_historical_nulls(
    family_model_api: FamilyModelApiContext,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    published = _publish_llm(
        family_model_api,
        family_id="family-a",
        model="trace-model",
        api_key="trace-key",
    )
    monkeypatch.setattr(
        "app.ai.observability.llm_exchange.get_settings",
        lambda: SimpleNamespace(
            ai_trace_enabled=True,
            ai_trace_capture_llm_exchanges=True,
            ai_trace_capture_stream_chunks=False,
            ai_trace_capture_image_bytes=False,
            ai_trace_capture_message_content=False,
            ai_trace_payload_mode="redacted",
            ai_trace_max_request_bytes=1024,
            ai_trace_max_response_bytes=1024,
        ),
    )
    with family_model_api.session_factory() as db:
        binding = FamilyModelConfigurationResolver(
            db,
            network_policy=family_model_api.policy,
            cipher=family_model_api.cipher,
        ).resolve_active("family-a", "llm", "primary")
        recorder = LLMExchangeRecorder(
            db=db,
            family_id="family-a",
            run_id="trace-run",
            conversation_id=None,
            trace_id="trace-id",
            binding=binding,
        )
        handle = recorder.start_exchange(
            span_id=None,
            provider_round=1,
            attempt_index=1,
            mode="blocking",
            model="trace-model",
            request_messages=[],
            request_tools=[],
            request_options={},
        )
        assert handle.exchange is not None
        exchange_id = handle.exchange.id
        db.add(
            AIRunLLMExchange(
                id="historical-llm-exchange",
                family_id="family-a",
                run_id="historical-run",
                conversation_id=None,
                trace_id="historical-trace",
                span_id=None,
                provider_round=1,
                attempt_index=1,
                mode="blocking",
                model="historical-model",
                status="completed",
            )
        )
        db.commit()

    with family_model_api.session_factory() as db:
        exchange = db.get(AIRunLLMExchange, exchange_id)
        historical = db.get(AIRunLLMExchange, "historical-llm-exchange")

    assert exchange is not None
    assert exchange.config_revision_id == published["published"]["config_revision_id"]
    assert exchange.provider_profile_id == published["profile"]["id"]
    assert exchange.provider_profile_version_id == binding.provider_profile_version_id
    assert historical is not None
    assert historical.config_revision_id is None
    assert historical.provider_profile_id is None
    assert historical.provider_profile_version_id is None
