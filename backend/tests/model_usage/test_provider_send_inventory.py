from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
from dataclasses import replace

from app.core.enums import ModelUsageCapability
from app.services.model_usage import provider_registry
from app.services.model_usage.provider_registry import (
    discover_remote_send_points,
    discover_sdk_retry_configuration_gaps,
    provider_usage_registrations,
    registry_send_points,
)
from tests.model_usage.test_price_manifest import configured_test_variants


EXPECTED_MODEL_PROVIDER_SEND_POINTS = {
    "app/ai/images/generation.py:_download_media:self.dependencies.transport.download_media",
    "app/ai/images/generation.py:_post_json:self.dependencies.transport.request",
    "app/ai/runtime/family_transport.py:request_json:self.transport.request",
    "app/ai/runtime/dashscope_chat.py:_dispatch_openai_request:client.chat.completions.create",
    "app/ai/runtime/dashscope_chat.py:iterate:client.chat.completions.create",
    "app/services/ai_audio/dashscope_audio.py:_request_json:self.dependencies.transport.request",
    "app/services/ai_audio/dashscope_audio.py:_websocket:self.dependencies.transport.connect_websocket",
    "app/services/ai_audio/dashscope_audio.py:synthesize:self.dependencies.transport.download_media",
    "app/services/ai_audio/openai_audio.py:_request:self.dependencies.transport.request",
    "app/services/search/embeddings.py:embed_batch:self.transport.request",
    "app/services/search/embeddings.py:_post_embeddings:client.post",
    "app/services/search/rerank.py:_post_rerank:client.post",
}


EXPECTED_NON_MODEL_REMOTE_SEND_POINTS = {
    "app/services/search/vector_store.py:_ensure_payload_indexes:client.put",
    "app/services/search/vector_store.py:delete_point:client.post",
    "app/services/search/vector_store.py:delete_collection:client.delete",
    "app/services/search/vector_store.py:ensure_collection:client.get",
    "app/services/search/vector_store.py:ensure_collection:client.put",
    "app/services/search/vector_store.py:scroll_points:client.post",
    "app/services/search/vector_store.py:search:client.post",
    "app/services/search/vector_store.py:upsert_point:client.put",
}


def test_every_remote_send_point_has_registered_adapter() -> None:
    app_root = Path(__file__).resolve().parents[2] / "app"

    discovered = discover_remote_send_points(app_root)

    assert discovered.model_provider == EXPECTED_MODEL_PROVIDER_SEND_POINTS
    assert discovered.non_model == EXPECTED_NON_MODEL_REMOTE_SEND_POINTS
    assert registry_send_points() == EXPECTED_MODEL_PROVIDER_SEND_POINTS


def test_adapter_coverage_cli_reports_the_current_inventory_as_covered() -> None:
    backend_root = Path(__file__).resolve().parents[2]
    script = backend_root / "scripts" / "check_model_usage_adapter_coverage.py"
    environment = {**os.environ, "PYTHONPATH": str(backend_root)}

    result = subprocess.run(
        [sys.executable, str(script)],
        cwd=backend_root,
        env=environment,
        capture_output=True,
        check=False,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["status"] == "covered"


def test_dashscope_audio_registrations_own_only_their_real_send_paths() -> None:
    registrations = provider_usage_registrations(
        tuple(
            replace(variant, provider="dashscope")
            for variant in configured_test_variants()
            if variant.capability
            in {ModelUsageCapability.STT, ModelUsageCapability.TTS}
        )
    )
    source_points = {
        registration.capability: registration.source_send_points
        for registration in registrations
    }

    assert source_points[ModelUsageCapability.STT] == {
        "app/services/ai_audio/dashscope_audio.py:_request_json:self.dependencies.transport.request",
    }
    assert source_points[ModelUsageCapability.TTS] == {
        "app/services/ai_audio/dashscope_audio.py:_request_json:self.dependencies.transport.request",
        "app/services/ai_audio/dashscope_audio.py:synthesize:self.dependencies.transport.download_media",
    }


def test_sdk_retry_inventory_requires_explicit_zero_retries(tmp_path: Path) -> None:
    app_root = tmp_path / "app"
    app_root.mkdir()
    source = app_root / "runtime.py"
    source.write_text(
        "from openai import OpenAI\n"
        "\n"
        "def build_client():\n"
        "    return OpenAI()\n",
        encoding="utf-8",
    )

    assert discover_sdk_retry_configuration_gaps(app_root) == {
        "app/runtime.py:build_client:OpenAI"
    }

    source.write_text(
        "from openai import OpenAI\n"
        "\n"
        "def build_client():\n"
        "    return OpenAI(max_retries=0)\n",
        encoding="utf-8",
    )

    assert discover_sdk_retry_configuration_gaps(app_root) == frozenset()


def test_provider_source_analysis_is_shared_for_unchanged_files(
    tmp_path: Path,
    monkeypatch,
) -> None:
    app_root = tmp_path / "app"
    app_root.mkdir()
    (app_root / "runtime.py").write_text(
        "from openai import OpenAI\n\n"
        "def send(client):\n"
        "    client.post('https://provider.example')\n"
        "    return OpenAI(max_retries=0)\n",
        encoding="utf-8",
    )
    real_parse = provider_registry.ast.parse
    parse_calls = 0

    def counting_parse(*args, **kwargs):
        nonlocal parse_calls
        parse_calls += 1
        return real_parse(*args, **kwargs)

    monkeypatch.setattr(provider_registry.ast, "parse", counting_parse)
    discover_remote_send_points(app_root)
    discover_sdk_retry_configuration_gaps(app_root)
    discover_remote_send_points(app_root)

    assert parse_calls == 1
