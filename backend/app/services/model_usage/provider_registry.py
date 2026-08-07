from __future__ import annotations

import ast
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from types import MappingProxyType

from app.core.enums import ModelUsageCapability, ModelUsageMeter
from app.services.model_usage.configured_variants import (
    ConfiguredUsageVariant,
    configured_usage_variants,
)
from app.services.model_usage.errors import ModelUsageContractError
from app.services.model_usage.types import (
    ProviderRecoveryPolicy,
    capability_meter_contract,
)


@dataclass(frozen=True, slots=True)
class ProviderUsageRegistration:
    """Static ownership contract for one enabled model-usage variant."""

    capability: ModelUsageCapability
    provider: str
    billing_model: str
    variant_key: str
    adapter_path: str
    billable_meters: frozenset[ModelUsageMeter]
    produced_guardrail_meters: frozenset[ModelUsageMeter]
    lease_boundary_cumulative_meters: frozenset[ModelUsageMeter]
    reservation_parameters: Mapping[str, Decimal]
    recovery_policy: ProviderRecoveryPolicy
    source_send_points: frozenset[str]


@dataclass(frozen=True, slots=True)
class RemoteSendPointInventory:
    """AST-discovered remote effects split by their fixed static classification."""

    model_provider: frozenset[str]
    non_model: frozenset[str]

    @property
    def all_points(self) -> frozenset[str]:
        return self.model_provider | self.non_model


class ProviderUsageRegistryError(ModelUsageContractError):
    default_code = "model_usage_provider_registry_invalid"


_LLM_SEND_POINTS = frozenset(
    {
        "app/ai/runtime/openai_chat.py:_create_chat_completion:self.openai_client.chat.completions.create",
        "app/ai/runtime/openai_chat.py:_create_chat_completion_stream:self.openai_client.chat.completions.create",
        "app/ai/runtime/openai_chat.py:_send_chat_request:self.openai_client.chat.completions.create",
        "app/ai/runtime/openai_responses.py:_create_responses_stream:self.client.responses.create",
        "app/ai/runtime/openai_responses.py:_send_responses_request:self.client.responses.create",
    }
)
_EMBEDDING_SEND_POINTS = frozenset(
    {"app/services/search/embeddings.py:_post_embeddings:client.post"}
)
_RERANK_SEND_POINTS = frozenset(
    {"app/services/search/rerank.py:_post_rerank:client.post"}
)
_OPENAI_STT_SEND_POINTS = frozenset(
    {"app/services/ai_audio/openai_audio.py:_post_transcription:client.post"}
)
_OPENAI_TTS_SEND_POINTS = frozenset(
    {"app/services/ai_audio/openai_audio.py:_post_speech:client.post"}
)
_DASHSCOPE_STT_SEND_POINTS = frozenset(
    {"app/services/ai_audio/dashscope_audio.py:_post_json:client.post"}
)
_DASHSCOPE_TTS_SEND_POINTS = frozenset(
    {
        "app/services/ai_audio/dashscope_audio.py:_post_json:client.post",
        "app/services/ai_audio/dashscope_audio.py:_download_provider_audio:client.get",
    }
)
_DASHSCOPE_REALTIME_SEND_POINTS = frozenset(
    {
        "app/services/ai_audio/dashscope_audio.py:_qwen_asr_realtime_transcribe:websockets.connect",
        "app/services/ai_audio/dashscope_audio.py:_qwen_tts_realtime_stream:websockets.connect",
        "app/services/ai_audio/dashscope_audio.py:_qwen_tts_realtime_synthesize:websockets.connect",
    }
)
_DASHSCOPE_IMAGE_SEND_POINTS = frozenset(
    {
        "app/ai/images/generation.py:_generate:client.get",
        "app/ai/images/generation.py:_generate:client.post",
    }
)
_OPENAI_IMAGE_SEND_POINTS = frozenset(
    {
        "app/ai/images/generation.py:_post_json_image:client.post",
        "app/ai/images/generation.py:_post_multipart_image:client.post",
        "app/ai/images/generation.py:_result_from_payload:client.get",
    }
)

_NON_MODEL_REMOTE_SEND_POINT_REASONS: Mapping[str, str] = MappingProxyType(
    {
        "app/services/search/vector_store.py:_ensure_payload_indexes:client.put": "Qdrant infrastructure",
        "app/services/search/vector_store.py:delete_point:client.post": "Qdrant infrastructure",
        "app/services/search/vector_store.py:ensure_collection:client.get": "Qdrant infrastructure",
        "app/services/search/vector_store.py:ensure_collection:client.put": "Qdrant infrastructure",
        "app/services/search/vector_store.py:scroll_points:client.post": "Qdrant infrastructure",
        "app/services/search/vector_store.py:search:client.post": "Qdrant infrastructure",
        "app/services/search/vector_store.py:upsert_point:client.put": "Qdrant infrastructure",
    }
)

_ADAPTER_PATHS: Mapping[ModelUsageCapability, str] = MappingProxyType(
    {
        ModelUsageCapability.LLM: "app.services.model_usage.adapters.llm.LLMUsageAdapter",
        ModelUsageCapability.EMBEDDING: "app.services.model_usage.adapters.embedding.EmbeddingUsageAdapter",
        ModelUsageCapability.RERANK: "app.services.model_usage.adapters.rerank.RerankUsageAdapter",
        ModelUsageCapability.STT: "app.services.model_usage.adapters.audio.AudioUsageAdapter",
        ModelUsageCapability.TTS: "app.services.model_usage.adapters.audio.AudioUsageAdapter",
        ModelUsageCapability.REALTIME_AUDIO: "app.services.model_usage.adapters.realtime_audio.RealtimeAudioUsageAdapter",
        ModelUsageCapability.IMAGE_GENERATION: "app.services.model_usage.adapters.image_generation.ImageGenerationUsageAdapter",
    }
)
_EMPTY_RESERVATION_PARAMETERS: Mapping[str, Decimal] = MappingProxyType({})
_HTTP_METHODS = frozenset({"delete", "get", "patch", "post", "put", "request"})
_SDK_CONSTRUCTORS_REQUIRING_RETRIES_DISABLED = frozenset({"OpenAI", "AsyncOpenAI"})


def registry_send_points() -> frozenset[str]:
    """Return every provider send point that an adapter registration may own."""

    return frozenset(
        point
        for points in (
            _LLM_SEND_POINTS,
            _EMBEDDING_SEND_POINTS,
            _RERANK_SEND_POINTS,
            _OPENAI_STT_SEND_POINTS,
            _OPENAI_TTS_SEND_POINTS,
            _DASHSCOPE_STT_SEND_POINTS,
            _DASHSCOPE_TTS_SEND_POINTS,
            _DASHSCOPE_REALTIME_SEND_POINTS,
            _DASHSCOPE_IMAGE_SEND_POINTS,
            _OPENAI_IMAGE_SEND_POINTS,
        )
        for point in points
    )


def non_model_remote_send_point_reasons() -> Mapping[str, str]:
    """Expose only fixed source-point exemptions; runtime configuration cannot add one."""

    return _NON_MODEL_REMOTE_SEND_POINT_REASONS


def provider_usage_registrations(settings: object) -> tuple[ProviderUsageRegistration, ...]:
    """Materialize one static ownership contract for each enabled configuration."""

    return tuple(_registration_for_variant(variant) for variant in configured_usage_variants(settings))


def _registration_for_variant(variant: ConfiguredUsageVariant) -> ProviderUsageRegistration:
    capability = variant.capability
    try:
        adapter_path = _ADAPTER_PATHS[capability]
    except KeyError as exc:  # Defensive: a new capability must receive explicit ownership.
        raise ProviderUsageRegistryError("model_usage_provider_adapter_missing") from exc
    return ProviderUsageRegistration(
        capability=capability,
        provider=variant.provider,
        billing_model=variant.billing_model,
        variant_key=variant.variant_key,
        adapter_path=adapter_path,
        billable_meters=variant.billable_meters,
        produced_guardrail_meters=frozenset(
            meter
            for meter in variant.produced_meters
            if capability_meter_contract(capability, meter).guardrail_eligible
        ),
        lease_boundary_cumulative_meters=variant.lease_boundary_cumulative_meters,
        reservation_parameters=_EMPTY_RESERVATION_PARAMETERS,
        recovery_policy=ProviderRecoveryPolicy.none(),
        source_send_points=_source_send_points_for_variant(variant),
    )


def _source_send_points_for_variant(variant: ConfiguredUsageVariant) -> frozenset[str]:
    provider = variant.provider.strip().lower()
    capability = variant.capability
    if capability is ModelUsageCapability.LLM:
        return _LLM_SEND_POINTS
    if capability is ModelUsageCapability.EMBEDDING:
        return _EMBEDDING_SEND_POINTS
    if capability is ModelUsageCapability.RERANK:
        return _RERANK_SEND_POINTS
    if capability is ModelUsageCapability.STT:
        if provider == "openai":
            return _OPENAI_STT_SEND_POINTS
        if provider == "dashscope":
            return _DASHSCOPE_STT_SEND_POINTS
    if capability is ModelUsageCapability.TTS:
        if provider == "openai":
            return _OPENAI_TTS_SEND_POINTS
        if provider == "dashscope":
            return _DASHSCOPE_TTS_SEND_POINTS
    if capability is ModelUsageCapability.REALTIME_AUDIO:
        if provider == "dashscope":
            return _DASHSCOPE_REALTIME_SEND_POINTS
    if capability is ModelUsageCapability.IMAGE_GENERATION:
        if provider == "dashscope":
            return _DASHSCOPE_IMAGE_SEND_POINTS
        if provider in {"openai", "openai-compatible", "compatible", "custom"}:
            return _OPENAI_IMAGE_SEND_POINTS
    raise ProviderUsageRegistryError("model_usage_provider_source_send_unregistered")


class _RemoteSendPointVisitor(ast.NodeVisitor):
    def __init__(self, *, source_path: str) -> None:
        self.source_path = source_path
        self._function_names: list[str] = []
        self.points: set[str] = set()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_function(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_function(node)

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self._function_names.append(node.name)
        self.generic_visit(node)
        self._function_names.pop()

    def visit_Attribute(self, node: ast.Attribute) -> None:
        rendered = _attribute_path(node)
        if node.attr == "create" and (
            rendered.endswith(".chat.completions.create")
            or rendered.endswith(".responses.create")
        ):
            self._add(rendered)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        rendered = _attribute_path(node.func)
        if rendered == "websockets.connect":
            self._add(rendered)
        elif isinstance(node.func, ast.Attribute) and node.func.attr in _HTTP_METHODS:
            client_path = _attribute_path(node.func.value)
            if _is_http_client_path(client_path):
                self._add(f"{client_path}.{node.func.attr}")
        self.generic_visit(node)

    def _add(self, signature: str) -> None:
        function_name = self._function_names[-1] if self._function_names else "<module>"
        self.points.add(f"{self.source_path}:{function_name}:{signature}")


class _SdkRetryConfigurationVisitor(ast.NodeVisitor):
    """Find OpenAI SDK constructions that could implicitly resend a request."""

    def __init__(self, *, source_path: str) -> None:
        self.source_path = source_path
        self._function_names: list[str] = []
        self.gaps: set[str] = set()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_function(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_function(node)

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self._function_names.append(node.name)
        self.generic_visit(node)
        self._function_names.pop()

    def visit_Call(self, node: ast.Call) -> None:
        constructor = _attribute_path(node.func).rsplit(".", 1)[-1]
        if constructor in _SDK_CONSTRUCTORS_REQUIRING_RETRIES_DISABLED:
            retry_keyword = next(
                (keyword for keyword in node.keywords if keyword.arg == "max_retries"),
                None,
            )
            retries_disabled = (
                retry_keyword is not None
                and isinstance(retry_keyword.value, ast.Constant)
                and type(retry_keyword.value.value) is int
                and retry_keyword.value.value == 0
            )
            if not retries_disabled:
                function_name = self._function_names[-1] if self._function_names else "<module>"
                self.gaps.add(f"{self.source_path}:{function_name}:{constructor}")
        self.generic_visit(node)


def discover_remote_send_points(app_root: Path) -> RemoteSendPointInventory:
    """Find SDK/httpx/WebSocket remote sends without importing application modules.

    Every discovered candidate is treated as a model-provider send unless it is
    one of the fixed Qdrant source exemptions above.  Consequently an added
    remote call cannot be silently made non-model through runtime settings.
    """

    root = Path(app_root)
    if not root.is_dir() or root.name != "app":
        raise ProviderUsageRegistryError("model_usage_provider_inventory_root_invalid")
    discovered: set[str] = set()
    for source_file in sorted(root.rglob("*.py")):
        try:
            tree = ast.parse(source_file.read_text(encoding="utf-8"), filename=str(source_file))
        except (OSError, SyntaxError) as exc:
            raise ProviderUsageRegistryError("model_usage_provider_inventory_parse_failed") from exc
        relative = source_file.relative_to(root.parent).as_posix()
        visitor = _RemoteSendPointVisitor(source_path=relative)
        visitor.visit(tree)
        discovered.update(visitor.points)
    non_model = frozenset(discovered & set(_NON_MODEL_REMOTE_SEND_POINT_REASONS))
    return RemoteSendPointInventory(
        model_provider=frozenset(discovered - non_model),
        non_model=non_model,
    )


def discover_sdk_retry_configuration_gaps(app_root: Path) -> frozenset[str]:
    """Return model SDK constructors that do not explicitly disable retries.

    The ledger gives each physical remote attempt a durable identity.  An SDK
    retry would create an extra provider send below that identity, so every
    supported OpenAI SDK client must pin ``max_retries=0`` in source.
    """

    root = Path(app_root)
    if not root.is_dir() or root.name != "app":
        raise ProviderUsageRegistryError("model_usage_provider_inventory_root_invalid")
    gaps: set[str] = set()
    for source_file in sorted(root.rglob("*.py")):
        try:
            tree = ast.parse(source_file.read_text(encoding="utf-8"), filename=str(source_file))
        except (OSError, SyntaxError) as exc:
            raise ProviderUsageRegistryError(
                "model_usage_provider_inventory_parse_failed"
            ) from exc
        relative = source_file.relative_to(root.parent).as_posix()
        visitor = _SdkRetryConfigurationVisitor(source_path=relative)
        visitor.visit(tree)
        gaps.update(visitor.gaps)
    return frozenset(gaps)


def _attribute_path(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = _attribute_path(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return ""


def _is_http_client_path(value: str) -> bool:
    if value == "httpx":
        return True
    final_name = value.rsplit(".", 1)[-1]
    return final_name == "client" or final_name.endswith("_client")
