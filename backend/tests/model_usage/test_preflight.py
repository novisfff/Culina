from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from pydantic import SecretStr, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

import app.main as main
from app.core.config import Settings
from app.models.domain import Family
from app.services.model_usage.preflight import (
    ModelUsagePreflightError,
    decode_receipt_integrity_keyring,
)


def test_production_rejects_optional_model_usage() -> None:
    with pytest.raises(ValidationError, match="MODEL_USAGE_REQUIRED"):
        Settings(
            environment="production",
            mysql_password="secret",
            jwt_secret="jwt-secret-not-default",
            minio_secret_key="minio-secret-not-default",
            model_usage_required=False,
        )


def test_fail_open_proof_ttl_must_be_below_provider_timeout() -> None:
    with pytest.raises(ValidationError, match="MODEL_USAGE_FAIL_OPEN_PROOF_TTL_SECONDS"):
        Settings(model_usage_fail_open_proof_ttl_seconds=45, ai_stt_timeout_seconds=45)


def test_receipt_keyring_requires_active_unexpired_key() -> None:
    settings = Settings(
        model_usage_receipt_integrity_active_key_id="old",
        model_usage_receipt_integrity_keys_json=SecretStr(
            json.dumps(
                {
                    "old": {
                        "key": "not-printed",
                        "retireAfter": "2020-01-01T00:00:00+00:00",
                    }
                }
            )
        ),
    )
    with pytest.raises(ModelUsagePreflightError, match="receipt_integrity_key_expired"):
        decode_receipt_integrity_keyring(settings)


def test_receipt_keyring_never_exposes_key_material() -> None:
    settings = Settings(
        model_usage_receipt_integrity_active_key_id="active",
        model_usage_receipt_integrity_keys_json=SecretStr(
            json.dumps({"active": {"key": "super-secret", "retireAfter": None}})
        ),
    )
    keyring = decode_receipt_integrity_keyring(settings)
    assert keyring.active_key_id == "active"
    assert keyring.health_payload == {
        "activeKeyId": "active",
        "keys": [{"keyId": "active", "retireAfter": None}],
    }
    assert "super-secret" not in json.dumps(keyring.health_payload)


def test_required_mode_rolls_back_bootstrap_when_preflight_fails(
    model_usage_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)

    def bootstrap(db: Session, *, commit: bool = True) -> bool:
        db.add(Family(id="family-bootstrap-rollback", name="启动家庭", motto="", location=""))
        db.flush()
        if commit:
            db.commit()
        return True

    def fail_preflight(*_args, db: Session | None = None, **_kwargs) -> None:
        assert db is not None
        raise ModelUsagePreflightError("preflight_failed")

    async def start() -> None:
        async with main.lifespan(object()):
            raise AssertionError("preflight failure must prevent startup")

    monkeypatch.setattr(main, "SessionLocal", factory)
    monkeypatch.setattr(
        main,
        "settings",
        SimpleNamespace(
            model_usage_required=True,
            model_usage_maintenance_enabled=False,
        ),
    )
    monkeypatch.setattr(main, "initialize_configured_admin", bootstrap)
    monkeypatch.setattr(main, "run_model_usage_preflight", fail_preflight)

    with pytest.raises(ModelUsagePreflightError, match="preflight_failed"):
        asyncio.run(start())

    with factory() as check_db:
        assert check_db.scalar(
            select(Family.id).where(Family.id == "family-bootstrap-rollback")
        ) is None
