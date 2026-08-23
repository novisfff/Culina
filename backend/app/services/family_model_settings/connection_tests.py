from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from time import perf_counter
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy.orm import Session

from app.core.utils import utcnow
from app.models.family_model_settings import (
    FamilyModelProviderProfile,
    FamilyModelProviderProfileVersion,
)
from app.repos.family_model_settings.idempotency import claim_operation, complete_operation
from app.repos.family_model_settings.profiles import (
    get_current_provider_profile_version,
    require_provider_profile,
)
from app.services.family_model_settings.adapter_registry import adapter_definition
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialCipher,
    operation_request_fingerprint,
    resolve_dispatch_credential,
)
from app.services.family_model_settings.errors import (
    FamilyModelOperationInProgress,
    FamilyModelProviderTransportError,
)
from app.services.family_model_settings.transport import ProviderTransport


_NOT_SUPPORTED_DETAIL = "此服务没有可确认的免费连接检查；保存完整能力配置后可运行真实能力测试。"
_MAX_DISCOVERED_MODELS = 200
_MAX_MODEL_ID_LENGTH = 160


@dataclass(frozen=True, slots=True)
class ConnectionCheckCommand:
    family_id: str
    actor_user_id: str
    profile_id: str
    idempotency_key: str


@dataclass(frozen=True, slots=True)
class ConnectionCheckResult:
    status: str
    detail: str | None
    checked_at: datetime
    latency_ms: int | None
    profile_version_number: int
    models: tuple[str, ...] = ()

    def response_record(self) -> dict[str, object]:
        return {
            "status": self.status,
            "detail": self.detail,
            "checked_at": self.checked_at.isoformat(),
            "latency_ms": self.latency_ms,
            "profile_version_number": self.profile_version_number,
            "models": list(self.models),
        }


def _result_from_response(response: object) -> ConnectionCheckResult:
    if not isinstance(response, dict):
        raise FamilyModelOperationInProgress()
    try:
        status = response["status"]
        detail = response.get("detail")
        checked_at = response["checked_at"]
        latency_ms = response.get("latency_ms")
        profile_version_number = response["profile_version_number"]
        models = response.get("models", [])
        if (
            status not in {"reachable", "not_supported"}
            or not isinstance(detail, (str, type(None)))
            or not isinstance(checked_at, str)
            or not isinstance(latency_ms, (int, type(None)))
            or isinstance(latency_ms, bool)
            or not isinstance(profile_version_number, int)
            or not isinstance(models, list)
            or len(models) > _MAX_DISCOVERED_MODELS
            or any(
                not isinstance(model, str)
                or not model
                or len(model) > _MAX_MODEL_ID_LENGTH
                for model in models
            )
        ):
            raise TypeError
        parsed_at = datetime.fromisoformat(checked_at.replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError) as exc:
        raise FamilyModelOperationInProgress() from exc
    return ConnectionCheckResult(
        status=status,
        detail=detail,
        checked_at=parsed_at,
        latency_ms=latency_ms,
        profile_version_number=profile_version_number,
        models=tuple(models),
    )


def _probe_url(api_base_url: str, path: str) -> str:
    """Append an adapter-owned relative probe path without accepting a URL."""

    parsed = urlsplit(api_base_url)
    base_path = parsed.path.rstrip("/")
    probe_path = f"{base_path}/{path.lstrip('/')}"
    return urlunsplit((parsed.scheme, parsed.netloc, probe_path, "", ""))


def _discovered_model_ids(content: bytes) -> tuple[str, ...]:
    """Extract only bounded model identifiers from an OpenAI-compatible catalog."""

    try:
        payload = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return ()
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        return ()

    models: list[str] = []
    seen: set[str] = set()
    for item in payload["data"]:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        model_id = item["id"].strip()
        if (
            not model_id
            or len(model_id) > _MAX_MODEL_ID_LENGTH
            or any(ord(character) < 32 or ord(character) == 127 for character in model_id)
            or model_id in seen
        ):
            continue
        seen.add(model_id)
        models.append(model_id)
        if len(models) >= _MAX_DISCOVERED_MODELS:
            break
    return tuple(models)


def _probe_provider_catalog(
    db: Session,
    *,
    family_id: str,
    profile: FamilyModelProviderProfile,
    version: FamilyModelProviderProfileVersion,
    cipher: FamilyModelCredentialCipher,
    transport: ProviderTransport,
) -> ConnectionCheckResult:
    definition = adapter_definition(version.adapter_kind)
    checked_at = utcnow()
    if definition.free_probe_path is None:
        return ConnectionCheckResult(
            status="not_supported",
            detail=_NOT_SUPPORTED_DETAIL,
            checked_at=checked_at,
            latency_ms=None,
            profile_version_number=version.version_number,
            models=(),
        )

    credential = resolve_dispatch_credential(
        db,
        cipher=cipher,
        family_id=family_id,
        provider_profile_id=profile.id,
        credential_secret_version_id=None,
    )
    headers: dict[str, str] = {"Accept": "application/json"}
    if credential.api_key is not None:
        headers["Authorization"] = f"Bearer {credential.api_key}"
    started_at = perf_counter()
    try:
        response = transport.request(
            "GET",
            _probe_url(version.api_base_url, definition.free_probe_path),
            headers=headers,
        )
    finally:
        # Keep the decrypted string's lifetime bounded to this request path.
        credential = None  # type: ignore[assignment]
    latency_ms = max(0, round((perf_counter() - started_at) * 1000))
    if not 200 <= response.status_code < 300:
        raise FamilyModelProviderTransportError("family_model_provider_connection_rejected")
    return ConnectionCheckResult(
        status="reachable",
        detail=None,
        checked_at=utcnow(),
        latency_ms=latency_ms,
        profile_version_number=version.version_number,
        models=_discovered_model_ids(response.content),
    )


def discover_provider_models(
    db: Session,
    *,
    family_id: str,
    profile_id: str,
    cipher: FamilyModelCredentialCipher,
    transport: ProviderTransport,
) -> ConnectionCheckResult:
    """Read a safe model catalog without creating an idempotency receipt."""

    profile = require_provider_profile(db, family_id=family_id, profile_id=profile_id)
    version = get_current_provider_profile_version(
        db,
        family_id=family_id,
        profile=profile,
    )
    if version is None:
        raise FamilyModelProviderTransportError("family_model_provider_profile_incomplete")
    return _probe_provider_catalog(
        db,
        family_id=family_id,
        profile=profile,
        version=version,
        cipher=cipher,
        transport=transport,
    )


def run_connection_check(
    db: Session,
    command: ConnectionCheckCommand,
    *,
    cipher: FamilyModelCredentialCipher,
    transport: ProviderTransport,
) -> ConnectionCheckResult:
    """Run an adapter-declared metadata probe and nothing billable.

    The registry owns both the method and path.  This service never takes a
    caller-supplied path or body, which rules out silently turning a green
    connection check into a model-generation request.
    """

    profile = require_provider_profile(
        db,
        family_id=command.family_id,
        profile_id=command.profile_id,
    )
    version = get_current_provider_profile_version(
        db,
        family_id=command.family_id,
        profile=profile,
    )
    if version is None:
        raise FamilyModelProviderTransportError("family_model_provider_profile_incomplete")
    fingerprint_for_key_id = lambda key_id: operation_request_fingerprint(
        cipher.keyring,
        key_id=key_id,
        operation="provider_connection_check",
        public_fields={
            "family_id": command.family_id,
            "profile_id": command.profile_id,
            "profile_version_id": version.id,
            "adapter_kind": version.adapter_kind,
        },
        secret_fields={},
    )
    claim = claim_operation(
        db,
        family_id=command.family_id,
        operation="provider_connection_check",
        idempotency_key=command.idempotency_key,
        active_fingerprint_key_id=cipher.active_key_id,
        fingerprint_for_key_id=fingerprint_for_key_id,
    )
    if claim.completed:
        return _result_from_response(claim.receipt.response_json)
    if not claim.created_by_request:
        raise FamilyModelOperationInProgress()

    result = _probe_provider_catalog(
        db,
        family_id=command.family_id,
        profile=profile,
        version=version,
        cipher=cipher,
        transport=transport,
    )
    complete_operation(
        claim,
        result_id=version.id,
        response_json=result.response_record(),
        completed_at=result.checked_at,
    )
    db.flush()
    return result
