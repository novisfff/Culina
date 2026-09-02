from __future__ import annotations

from app.services.ai_operations.commit_coordinator import derive_draft_payload_hash


def test_payload_hash_ignores_legacy_intent_evidence_field() -> None:
    payload = {
        "draftType": "food_profile",
        "name": "番茄炒蛋",
        "intentEvidence": {"certainty": "explicit"},
    }
    without_evidence = {key: value for key, value in payload.items() if key != "intentEvidence"}

    assert derive_draft_payload_hash(payload) == derive_draft_payload_hash(without_evidence)
