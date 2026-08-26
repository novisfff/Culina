from __future__ import annotations

import base64
import json
import stat

import pytest
from pydantic import SecretStr, ValidationError

from app.core.config import Settings
from app.models.family_model_settings import FamilyModelSecretVersion
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialCipher,
    FamilyModelCredentialConfigurationError,
    FamilyModelSecretUnavailable,
    decode_family_model_credential_keyring,
)


SECRET_MARKER = "sk-family-model-secret-marker"


def _encoded_key(seed: bytes) -> str:
    return base64.b64encode(seed * 32).decode("ascii")


def _keyring_json() -> SecretStr:
    return SecretStr(json.dumps({"k1": _encoded_key(b"a"), "k2": _encoded_key(b"b")}))


def _production_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "production",
        "frontend_origin": "https://culina.example.com",
        "model_usage_required": True,
        "mysql_password": "test-mysql-password",
        "jwt_secret": "test-jwt-secret",
        "minio_secret_key": "test-minio-secret",
        "family_model_credential_active_key_id": "",
        "family_model_credential_keys_json": SecretStr(""),
    }
    values.update(overrides)
    return Settings(**values)


def _secret_version(*, envelope, encryption_key_id: str | None = None) -> FamilyModelSecretVersion:
    return FamilyModelSecretVersion(
        id="family-model-secret-1",
        family_id="family-1",
        profile_id="family-model-profile-1",
        version_number=1,
        encryption_key_id=encryption_key_id or envelope.encryption_key_id,
        nonce=envelope.nonce,
        ciphertext=envelope.ciphertext,
        auth_tag=envelope.auth_tag,
        secret_fingerprint=envelope.secret_fingerprint,
        status="active",
    )


def test_production_requires_family_model_credential_keyring() -> None:
    with pytest.raises(ValidationError, match="FAMILY_MODEL_CREDENTIAL"):
        _production_settings()


def test_keyring_rejects_non_32_byte_keys() -> None:
    with pytest.raises(FamilyModelCredentialConfigurationError):
        decode_family_model_credential_keyring(
            active_key_id="k1",
            keys_json=SecretStr('{"k1":"c2hvcnQ="}'),
        )


def test_cipher_round_trip_uses_aad_bound_to_secret_identity() -> None:
    cipher = FamilyModelCredentialCipher(
        decode_family_model_credential_keyring(active_key_id="k1", keys_json=_keyring_json())
    )
    envelope = cipher.encrypt(
        family_id="family-1",
        profile_id="family-model-profile-1",
        secret_version_id="family-model-secret-1",
        plaintext=SECRET_MARKER,
    )
    version = _secret_version(envelope=envelope)

    assert cipher.decrypt(
        version=version,
        family_id="family-1",
        profile_id="family-model-profile-1",
        secret_version_id="family-model-secret-1",
    ) == SECRET_MARKER
    assert SECRET_MARKER.encode("utf-8") not in envelope.ciphertext
    assert SECRET_MARKER.encode("utf-8") not in envelope.auth_tag
    assert SECRET_MARKER.encode("utf-8") not in envelope.nonce


@pytest.mark.parametrize("changed", ["family_id", "profile_id", "secret_version_id"])
def test_aead_rejects_cross_identity_ciphertext(changed: str, caplog: pytest.LogCaptureFixture) -> None:
    cipher = FamilyModelCredentialCipher(
        decode_family_model_credential_keyring(active_key_id="k1", keys_json=_keyring_json())
    )
    envelope = cipher.encrypt(
        family_id="family-1",
        profile_id="family-model-profile-1",
        secret_version_id="family-model-secret-1",
        plaintext=SECRET_MARKER,
    )
    version = _secret_version(envelope=envelope)
    identity = {
        "family_id": "family-1",
        "profile_id": "family-model-profile-1",
        "secret_version_id": "family-model-secret-1",
    }
    identity[changed] = f"different-{changed}"

    with pytest.raises(FamilyModelSecretUnavailable) as error:
        cipher.decrypt(version=version, **identity)

    assert SECRET_MARKER not in str(error.value)
    assert SECRET_MARKER not in caplog.text


def test_aead_rejects_a_ciphertext_with_a_different_key_id() -> None:
    cipher = FamilyModelCredentialCipher(
        decode_family_model_credential_keyring(active_key_id="k1", keys_json=_keyring_json())
    )
    envelope = cipher.encrypt(
        family_id="family-1",
        profile_id="family-model-profile-1",
        secret_version_id="family-model-secret-1",
        plaintext=SECRET_MARKER,
    )
    version = _secret_version(envelope=envelope, encryption_key_id="k2")

    with pytest.raises(FamilyModelSecretUnavailable):
        cipher.decrypt(
            version=version,
            family_id="family-1",
            profile_id="family-model-profile-1",
            secret_version_id="family-model-secret-1",
        )


def test_cipher_from_settings_uses_the_explicit_deployment_keyring() -> None:
    settings = _production_settings(
        family_model_credential_active_key_id="k1",
        family_model_credential_keys_json=_keyring_json(),
    )

    cipher = FamilyModelCredentialCipher.from_settings(settings)

    assert cipher.active_key_id == "k1"


def test_local_settings_generate_and_reuse_a_private_persistent_keyring(tmp_path) -> None:
    keyring_path = tmp_path / "secrets" / "family-model-keyring.json"
    settings = Settings(
        environment="local",
        family_model_credential_active_key_id="",
        family_model_credential_keys_json=SecretStr(""),
        family_model_credential_keyring_file=str(keyring_path),
    )

    first = FamilyModelCredentialCipher.from_settings(
        settings,
        allow_local_keyring_creation=True,
    )
    first_contents = keyring_path.read_bytes()
    second = FamilyModelCredentialCipher.from_settings(settings)

    assert first.active_key_id == second.active_key_id
    assert first.keyring.keys == second.keyring.keys
    assert keyring_path.read_bytes() == first_contents
    assert stat.S_IMODE(keyring_path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(keyring_path.stat().st_mode) == 0o600


def test_local_settings_do_not_silently_create_a_missing_keyring_by_default(tmp_path) -> None:
    keyring_path = tmp_path / "secrets" / "family-model-keyring.json"
    settings = Settings(
        environment="local",
        family_model_credential_active_key_id="",
        family_model_credential_keys_json=SecretStr(""),
        family_model_credential_keyring_file=str(keyring_path),
    )

    with pytest.raises(
        FamilyModelCredentialConfigurationError,
        match="family_model_credential_keyring_file_missing",
    ):
        FamilyModelCredentialCipher.from_settings(settings)

    assert not keyring_path.exists()


def test_local_keyring_storage_failures_use_a_stable_configuration_error(tmp_path) -> None:
    invalid_parent = tmp_path / "not-a-directory"
    invalid_parent.write_text("occupied", encoding="utf-8")
    settings = Settings(
        environment="local",
        family_model_credential_active_key_id="",
        family_model_credential_keys_json=SecretStr(""),
        family_model_credential_keyring_file=str(invalid_parent / "keyring.json"),
    )

    with pytest.raises(
        FamilyModelCredentialConfigurationError,
        match="family_model_credential_keyring_file_invalid",
    ):
        FamilyModelCredentialCipher.from_settings(
            settings,
            allow_local_keyring_creation=True,
        )
