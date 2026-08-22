"""Safe, family-scoped capability status for every signed-in member.

This module deliberately projects only operational capability state.  Provider
profiles, endpoint URLs, model names, price identities and credential metadata
remain Owner-only configuration data and must not be added to this response.
"""

from __future__ import annotations

from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import FamilyModelSearchProfileStatus, ModelUsageCapability
from app.models.family_model_settings import (
    FamilyModelCapabilityBinding,
    FamilySearchProfile,
)
from app.repos.family_model_settings.profiles import get_family_model_settings


MemberCapabilityState = Literal[
    "available",
    "unavailable",
    "provisioning",
    "failed",
    "budget_blocked",
]

_CAPABILITIES = tuple(capability.value for capability in ModelUsageCapability)


def _active_search_state(
    db: Session,
    *,
    family_id: str,
    active_search_profile_id: str | None,
) -> MemberCapabilityState:
    """Return a coarse Embedding state without leaking the profile identity."""

    profile: FamilySearchProfile | None = None
    if active_search_profile_id:
        profile = db.scalar(
            select(FamilySearchProfile).where(
                FamilySearchProfile.family_id == family_id,
                FamilySearchProfile.id == active_search_profile_id,
            )
        )
    if profile is None:
        # A first provision or replacement has no active pointer yet.  Members
        # may see that semantic search is being prepared, but not which model
        # or provider is doing that work.
        profile = db.scalar(
            select(FamilySearchProfile)
            .where(
                FamilySearchProfile.family_id == family_id,
                FamilySearchProfile.status.in_(
                    (
                        FamilyModelSearchProfileStatus.PROVISIONING,
                        FamilyModelSearchProfileStatus.FAILED,
                    )
                ),
            )
            .order_by(FamilySearchProfile.created_at.desc(), FamilySearchProfile.id.desc())
        )
    if profile is None:
        return "unavailable"
    if profile.status is FamilyModelSearchProfileStatus.ACTIVE:
        return "available"
    if profile.status is FamilyModelSearchProfileStatus.PROVISIONING:
        return "provisioning"
    if profile.status is FamilyModelSearchProfileStatus.FAILED:
        return "failed"
    return "unavailable"


def project_member_safe_ai_status(
    db: Session,
    *,
    family_id: str,
) -> dict[str, object]:
    """Project the active family configuration into a Member-safe contract.

    The input family id always comes from the authenticated membership.  This
    function never resolves an endpoint or decrypts a credential, so its
    output remains safe for any active family member.
    """

    states: dict[str, MemberCapabilityState] = {
        capability: "unavailable" for capability in _CAPABILITIES
    }
    settings = get_family_model_settings(db, family_id=family_id)
    if settings is None or settings.active_config_revision_id is None:
        return {
            "configured": False,
            "enabled": False,
            "supports_vision": False,
            "status": "not_configured",
            "detail": "家庭 AI 服务尚未配置。",
            "capabilities": states,
        }

    bindings = tuple(
        db.scalars(
            select(FamilyModelCapabilityBinding).where(
                FamilyModelCapabilityBinding.family_id == family_id,
                FamilyModelCapabilityBinding.config_revision_id
                == settings.active_config_revision_id,
            )
        )
    )
    primary_llm: FamilyModelCapabilityBinding | None = None
    for binding in bindings:
        capability = binding.capability.value
        if capability not in states:
            continue
        if capability == "embedding":
            # A published embedding binding becomes available only after the
            # matching family search profile is active.
            states[capability] = (
                _active_search_state(
                    db,
                    family_id=family_id,
                    active_search_profile_id=settings.active_search_profile_id,
                )
                if binding.enabled
                else "unavailable"
            )
            continue
        states[capability] = "available" if binding.enabled else "unavailable"
        if capability == "llm" and binding.variant_key == "primary":
            primary_llm = binding

    enabled = states["llm"] == "available"
    supports_vision = bool(
        enabled
        and primary_llm is not None
        and isinstance(primary_llm.options_json, dict)
        and primary_llm.options_json.get("supports_vision") is True
    )
    if enabled:
        status: Literal["ready", "not_configured", "disabled", "degraded"] = "ready"
        detail = "家庭 AI 服务已就绪。"
    elif any(state in {"failed", "budget_blocked"} for state in states.values()):
        status = "degraded"
        detail = "家庭 AI 服务部分不可用。"
    else:
        status = "disabled"
        detail = "家庭 AI 服务尚未启用。"

    return {
        "configured": True,
        "enabled": enabled,
        "supports_vision": supports_vision,
        "status": status,
        "detail": detail,
        "capabilities": states,
    }
