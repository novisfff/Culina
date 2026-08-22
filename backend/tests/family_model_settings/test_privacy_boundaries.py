from __future__ import annotations

import json

import pytest

from app.ai.observability.redaction import redact_for_trace


SECRET_MARKER = "CULINA_FAMILY_MODEL_SECRET_8d71c4"


@pytest.mark.parametrize("payload_mode", ["redacted", "summary", "full"])
def test_trace_redaction_never_serializes_family_credential_markers(
    payload_mode: str,
) -> None:
    payload = {
        "Authorization": f"Bearer {SECRET_MARKER}",
        "Proxy-Authorization": SECRET_MARKER,
        "Api-Key": SECRET_MARKER,
        "X_API_KEY": SECRET_MARKER,
        "credential": {
            "secret_value": SECRET_MARKER,
            "ciphertext": SECRET_MARKER,
            "nonce": SECRET_MARKER,
            "auth_tag": SECRET_MARKER,
            "credential_secret_version_id": SECRET_MARKER,
        },
        "safe": {"adapter_kind": "openai_compatible_http", "revision": 3},
    }

    redacted = redact_for_trace(payload, payload_mode=payload_mode)

    serialized = json.dumps(redacted, ensure_ascii=False, sort_keys=True)
    assert SECRET_MARKER not in serialized
    assert "openai_compatible_http" in serialized
