from __future__ import annotations

import base64
from dataclasses import dataclass
import json
import os
from pathlib import Path
import secrets
import tempfile

from pydantic import SecretStr

from app.services.family_model_settings.errors import (
    FamilyModelCredentialConfigurationError,
)


_LOCAL_ACTIVE_KEY_ID = "local-auto-v1"
_MAX_KEYRING_FILE_BYTES = 64 * 1024


@dataclass(frozen=True, slots=True)
class StoredCredentialKeyringConfig:
    active_key_id: str
    keys_json: SecretStr


def _write_new_local_keyring(path: Path) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    encoded_key = base64.b64encode(secrets.token_bytes(32)).decode("ascii")
    payload = json.dumps(
        {
            "active_key_id": _LOCAL_ACTIVE_KEY_ID,
            "keys": {_LOCAL_ACTIVE_KEY_ID: encoded_key},
        },
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8") + b"\n"

    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        descriptor = -1
        try:
            os.link(temporary_path, path)
        except FileExistsError:
            pass
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary_path.unlink(missing_ok=True)


def load_local_credential_keyring(
    path_value: str,
    *,
    create_if_missing: bool,
) -> StoredCredentialKeyringConfig:
    normalized_path = path_value.strip()
    if not normalized_path:
        raise FamilyModelCredentialConfigurationError(
            "family_model_credential_keyring_file_required"
        )
    path = Path(normalized_path).expanduser()
    try:
        if path.is_symlink():
            raise FamilyModelCredentialConfigurationError(
                "family_model_credential_keyring_file_invalid"
            )
        if not path.exists():
            if not create_if_missing:
                raise FamilyModelCredentialConfigurationError(
                    "family_model_credential_keyring_file_missing"
                )
            _write_new_local_keyring(path)
        if path.is_symlink() or not path.is_file():
            raise FamilyModelCredentialConfigurationError(
                "family_model_credential_keyring_file_invalid"
            )

        os.chmod(path, 0o600)
        raw = path.read_bytes()
        if len(raw) > _MAX_KEYRING_FILE_BYTES:
            raise ValueError("keyring file is too large")
        payload = json.loads(raw)
        active_key_id = payload["active_key_id"]
        keys = payload["keys"]
        if not isinstance(active_key_id, str) or not isinstance(keys, dict):
            raise ValueError("invalid keyring document")
    except FamilyModelCredentialConfigurationError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        raise FamilyModelCredentialConfigurationError(
            "family_model_credential_keyring_file_invalid"
        ) from exc

    return StoredCredentialKeyringConfig(
        active_key_id=active_key_id,
        keys_json=SecretStr(
            json.dumps(keys, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        ),
    )
