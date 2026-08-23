from __future__ import annotations

import pytest

from app.services.family_model_settings.adapter_registry import (
    adapter_definition,
    require_adapter_endpoint_contract,
)
from app.services.family_model_settings.errors import FamilyModelProviderProtocolUnsupported
from app.services.family_model_settings.types import ResolvedProviderEndpoint


def test_adapter_registry_is_closed_and_explicit() -> None:
    openai_http = adapter_definition("openai_compatible_http")

    assert openai_http.capabilities == frozenset(
        {"llm", "image_generation", "stt", "tts", "embedding", "rerank"}
    )
    assert openai_http.auth_modes == frozenset({"api_key", "no_auth"})
    assert "realtime_audio" not in openai_http.capabilities
    assert adapter_definition("dashscope_realtime").capabilities == frozenset(
        {"realtime_audio"}
    )
    with pytest.raises(FamilyModelProviderProtocolUnsupported):
        adapter_definition("arbitrary_python_module")


def test_adapter_registry_exposes_only_fixed_billing_schemes_and_safe_probe_paths() -> None:
    definition = adapter_definition("openai_compatible_http")

    assert definition.billing_schemes["llm"] == ("llm-split-v1",)
    assert definition.billing_schemes["embedding"] == ("embedding-token-v1",)
    assert definition.free_probe_path == "/models"
    with pytest.raises(TypeError):
        definition.billing_schemes["llm"] = ("owner-defined-scheme",)  # type: ignore[index]


def test_no_auth_is_limited_to_an_allowlisted_private_openai_compatible_endpoint() -> None:
    public_endpoint = ResolvedProviderEndpoint(
        normalized_url="https://provider.example/v1",
        scheme="https",
        host="provider.example",
        port=443,
        base_path="/v1",
        resolved_addresses=("93.184.216.34",),
        private_target=False,
    )

    with pytest.raises(FamilyModelProviderProtocolUnsupported):
        require_adapter_endpoint_contract(
            kind="openai_compatible_http",
            auth_mode="no_auth",
            endpoint=public_endpoint,
        )
