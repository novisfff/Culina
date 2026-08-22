from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from fastapi import HTTPException, status

from app.services.family_model_settings.errors import FamilyModelSettingsError
from app.services.family_model_settings.transport import ProviderTransport
from app.services.family_model_settings.types import (
    DispatchCredential,
    ResolvedCapabilityBinding,
)


AUDIO_CAPABILITY_MESSAGES: dict[str, str] = {
    "family_model_settings_not_configured": "该语音能力尚未由家庭主理人配置。",
    "family_model_capability_disabled": "该语音能力当前未启用，可以继续使用文字。",
    "family_model_secret_unavailable": "家庭语音服务凭据暂不可用，请联系家庭主理人检查设置。",
}


@dataclass(frozen=True, slots=True)
class AudioProviderDependencies:
    """The only infrastructure an audio adapter may use for provider sends.

    The resolver callback receives the secret version persisted on a dispatch
    permit.  It is deliberately invoked by provider methods only after the
    usage adapter has crossed that durable dispatch boundary.
    """

    transport: ProviderTransport
    resolve_dispatch_credential: Callable[
        [ResolvedCapabilityBinding, str | None], DispatchCredential
    ]


def audio_capability_error(exc: FamilyModelSettingsError) -> HTTPException:
    """Map family configuration failures to Member-safe voice errors."""

    code = exc.code
    message = AUDIO_CAPABILITY_MESSAGES.get(
        code,
        "当前语音服务暂不可用，请稍后重试或继续使用文字。",
    )
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={"code": code, "message": message},
    )


def audio_provider_error(*, code: str = "audio_provider_unavailable") -> HTTPException:
    """Return a content-free provider error after a remote failure.

    Provider/model/endpoint details are Owner-only configuration data and must
    never leak through Member-facing audio routes or websocket events.
    """

    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail={"code": code, "message": "当前语音服务暂不可用，请稍后重试或继续使用文字。"},
    )
