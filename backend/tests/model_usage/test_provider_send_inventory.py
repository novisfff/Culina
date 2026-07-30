from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

from app.core.enums import ModelUsageCapability
from app.services.model_usage.provider_registry import (
    discover_remote_send_points,
    discover_sdk_retry_configuration_gaps,
    provider_usage_registrations,
    registry_send_points,
)


EXPECTED_MODEL_PROVIDER_SEND_POINTS = {
    "app/ai/runtime/openai_chat.py:_create_chat_completion:self.openai_client.chat.completions.create",
    "app/ai/runtime/openai_chat.py:_create_chat_completion_stream:self.openai_client.chat.completions.create",
    "app/ai/runtime/openai_chat.py:_send_chat_request:self.openai_client.chat.completions.create",
    "app/ai/runtime/openai_responses.py:_create_responses_stream:self.client.responses.create",
    "app/ai/runtime/openai_responses.py:_send_responses_request:self.client.responses.create",
    "app/ai/images/generation.py:_generate:client.get",
    "app/ai/images/generation.py:_generate:client.post",
    "app/ai/images/generation.py:_post_json_image:client.post",
    "app/ai/images/generation.py:_post_multipart_image:client.post",
    "app/ai/images/generation.py:_result_from_payload:client.get",
    "app/services/ai_audio/dashscope_audio.py:_download_provider_audio:client.get",
    "app/services/ai_audio/dashscope_audio.py:_post_json:client.post",
    "app/services/ai_audio/dashscope_audio.py:_qwen_asr_realtime_transcribe:websockets.connect",
    "app/services/ai_audio/dashscope_audio.py:_qwen_tts_realtime_stream:websockets.connect",
    "app/services/ai_audio/dashscope_audio.py:_qwen_tts_realtime_synthesize:websockets.connect",
    "app/services/ai_audio/openai_audio.py:_post_speech:client.post",
    "app/services/ai_audio/openai_audio.py:_post_transcription:client.post",
    "app/services/search/embeddings.py:_post_embeddings:client.post",
    "app/services/search/rerank.py:_post_rerank:client.post",
}


EXPECTED_NON_MODEL_REMOTE_SEND_POINTS = {
    "app/services/search/vector_store.py:_ensure_payload_indexes:client.put",
    "app/services/search/vector_store.py:delete_point:client.post",
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
        SimpleNamespace(
            ai_stt_provider="dashscope",
            ai_stt_model="qwen-asr-test",
            ai_stt_audio_format="webm",
            ai_tts_provider="dashscope",
            ai_tts_model="qwen-tts-test",
            ai_tts_voice="Cherry",
        )
    )
    source_points = {
        registration.capability: registration.source_send_points
        for registration in registrations
    }

    assert source_points[ModelUsageCapability.STT] == {
        "app/services/ai_audio/dashscope_audio.py:_post_json:client.post",
    }
    assert source_points[ModelUsageCapability.TTS] == {
        "app/services/ai_audio/dashscope_audio.py:_post_json:client.post",
        "app/services/ai_audio/dashscope_audio.py:_download_provider_audio:client.get",
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
