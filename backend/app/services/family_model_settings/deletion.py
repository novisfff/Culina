from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import delete, or_, select, update
from sqlalchemy.orm import Session

from app.core.enums import ActivityAction, ModelUsageReservationStatus
from app.core.utils import utcnow
from app.models.domain import AIRunLLMExchange
from app.models.family_model_settings import (
    FamilyModelCapabilityBinding,
    FamilyModelProviderProfileVersion,
    FamilyModelSecretVersion,
    FamilySearchProfile,
)
from app.models.model_usage import ModelUsageEvent, ModelUsageReservation
from app.repos.family_model_settings.profiles import (
    get_family_model_settings,
    lock_family_model_settings,
    lock_provider_profile,
)
from app.services.activity import log_activity
from app.repos.family_model_settings.configurations import get_config_draft
from app.services.family_model_settings.errors import (
    FamilyModelOperationInProgress,
    FamilyModelProviderProfileInUse,
    FamilyModelProviderProfileVersionConflict,
)
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialCipher,
    operation_request_fingerprint,
)
from app.services.family_model_settings.types import (
    DeleteProviderProfileCommand,
    ProviderProfileDeletionCheck,
    ProviderProfileReference,
)
from app.repos.family_model_settings.idempotency import claim_operation, complete_operation


_CAPABILITY_LABELS = {
    "llm": "对话与生成",
    "image_generation": "图像生成",
    "stt": "语音识别",
    "tts": "语音合成",
    "realtime_audio": "实时语音",
    "embedding": "向量搜索",
    "rerank": "搜索排序",
}
_VARIANT_LABELS = {
    "primary": "主要模型",
    "fallback": "备用模型",
    "text": "文字生成",
    "reference": "参考图生成",
    "search": "搜索模型",
    "default": "默认模型",
}
_BLOCKING_RESERVATION_STATUSES = (
    ModelUsageReservationStatus.DISPATCHING,
    ModelUsageReservationStatus.UNCERTAIN,
)


def _reference(
    *,
    type: str,
    name: str,
    description: str,
    resource_id: str,
) -> ProviderProfileReference:
    return ProviderProfileReference(
        type=type,
        name=name,
        description=description,
        resource_id=resource_id,
    )


def _dedupe(references: Iterable[ProviderProfileReference]) -> tuple[ProviderProfileReference, ...]:
    seen: set[tuple[str, str, str]] = set()
    result: list[ProviderProfileReference] = []
    for reference in references:
        key = (reference.type, reference.resource_id, reference.description)
        if key in seen:
            continue
        seen.add(key)
        result.append(reference)
    return tuple(result)


def provider_profile_deletion_check(
    db: Session,
    *,
    family_id: str,
    profile_id: str,
) -> ProviderProfileDeletionCheck:
    references: list[ProviderProfileReference] = []
    draft = get_config_draft(db, family_id=family_id)
    payload = (
        draft.payload_json
        if draft is not None and isinstance(draft.payload_json, dict)
        else {}
    )
    for binding in payload.get("bindings", []) if isinstance(payload, dict) else []:
        if not isinstance(binding, dict) or binding.get("provider_profile_id") != profile_id:
            continue
        capability = str(binding.get("capability", "模型功能"))
        variant = str(binding.get("variant_key", "default"))
        references.append(
            _reference(
                type="config_draft",
                name="当前编辑中的配置",
                description=(
                    f"功能设置草稿中的{_CAPABILITY_LABELS.get(capability, capability)} · "
                    f"{_VARIANT_LABELS.get(variant, variant)}"
                ),
                resource_id=family_id,
            )
        )

    settings = get_family_model_settings(db, family_id=family_id)
    active_revision_id = settings.active_config_revision_id if settings else None
    if active_revision_id is not None:
        active_rows = db.scalars(
            select(FamilyModelCapabilityBinding).where(
                FamilyModelCapabilityBinding.family_id == family_id,
                FamilyModelCapabilityBinding.config_revision_id == active_revision_id,
                FamilyModelCapabilityBinding.provider_profile_id == profile_id,
                FamilyModelCapabilityBinding.enabled.is_(True),
            )
        )
        for binding in active_rows:
            capability = binding.capability.value
            references.append(
                _reference(
                    type="active_config",
                    name="当前生效配置",
                    description=(
                        f"功能设置中的{_CAPABILITY_LABELS.get(capability, capability)} · "
                        f"{_VARIANT_LABELS.get(binding.variant_key, binding.variant_key)}"
                    ),
                    resource_id=binding.config_revision_id,
                )
            )

    search_rows = db.scalars(
        select(FamilySearchProfile).where(
            FamilySearchProfile.family_id == family_id,
            FamilySearchProfile.provider_profile_id == profile_id,
        )
    )
    for search_profile in search_rows:
        references.append(
            _reference(
                type="search_profile",
                name="智能搜索",
                description=f"向量索引使用模型：{search_profile.embedding_model}",
                resource_id=search_profile.id,
            )
        )

    if db.scalar(
        select(ModelUsageReservation.id).where(
            ModelUsageReservation.family_id == family_id,
            ModelUsageReservation.provider_profile_id == profile_id,
            ModelUsageReservation.status.in_(_BLOCKING_RESERVATION_STATUSES),
        ).limit(1)
    ) is not None:
        references.append(
            _reference(
                type="active_operation",
                name="正在执行的模型调用",
                description="该服务当前仍有未完成的模型请求，请稍后重试。",
                resource_id=family_id,
            )
        )

    return ProviderProfileDeletionCheck(
        can_delete=not references,
        blocking_references=_dedupe(references),
    )


def _detach_historical_references(
    db: Session,
    *,
    family_id: str,
    profile_id: str,
    active_revision_id: str | None,
) -> None:
    capability_where = [
        FamilyModelCapabilityBinding.family_id == family_id,
        FamilyModelCapabilityBinding.provider_profile_id == profile_id,
    ]
    if active_revision_id is not None:
        capability_where.append(
            or_(
                FamilyModelCapabilityBinding.config_revision_id != active_revision_id,
                FamilyModelCapabilityBinding.enabled.is_(False),
            )
        )
    db.execute(
        update(FamilyModelCapabilityBinding)
        .where(*capability_where)
        .values(provider_profile_id=None, provider_profile_version_id=None)
    )
    db.execute(
        update(ModelUsageReservation)
        .where(
            ModelUsageReservation.family_id == family_id,
            ModelUsageReservation.provider_profile_id == profile_id,
        )
        .values(
            provider_profile_id=None,
            provider_profile_version_id=None,
            credential_secret_version_id=None,
        )
    )
    db.execute(
        update(ModelUsageEvent)
        .where(
            ModelUsageEvent.family_id == family_id,
            ModelUsageEvent.provider_profile_id == profile_id,
        )
        .values(provider_profile_id=None, provider_profile_version_id=None)
    )
    db.execute(
        update(AIRunLLMExchange)
        .where(
            AIRunLLMExchange.family_id == family_id,
            AIRunLLMExchange.provider_profile_id == profile_id,
        )
        .values(provider_profile_id=None, provider_profile_version_id=None)
    )


def delete_provider_profile(
    db: Session,
    command: DeleteProviderProfileCommand,
    *,
    cipher: FamilyModelCredentialCipher,
) -> None:
    fingerprint_for_key_id = lambda key_id: operation_request_fingerprint(
        cipher.keyring,
        key_id=key_id,
        operation="delete_provider_profile",
        public_fields={
            "family_id": command.family_id,
            "profile_id": command.profile_id,
            "base_profile_version_number": command.base_profile_version_number,
            "confirmation_name": command.confirmation_name,
        },
        secret_fields={},
    )
    claim = claim_operation(
        db,
        family_id=command.family_id,
        operation="delete_provider_profile",
        idempotency_key=command.idempotency_key,
        active_fingerprint_key_id=cipher.active_key_id,
        fingerprint_for_key_id=fingerprint_for_key_id,
    )
    if claim.completed:
        return
    if not claim.created_by_request:
        raise FamilyModelOperationInProgress()

    settings = lock_family_model_settings(db, family_id=command.family_id)
    profile = lock_provider_profile(
        db,
        family_id=command.family_id,
        profile_id=command.profile_id,
    )
    if profile.version_number != command.base_profile_version_number:
        raise FamilyModelProviderProfileVersionConflict(profile.version_number)
    if profile.display_name != command.confirmation_name:
        raise FamilyModelProviderProfileInUse(
            references=({
                "type": "confirmation",
                "name": profile.display_name,
                "description": "请输入当前服务名称确认删除。",
                "resource_id": profile.id,
                "can_unbind": False,
            },)
        )

    check = provider_profile_deletion_check(
        db,
        family_id=command.family_id,
        profile_id=profile.id,
    )
    if not check.can_delete:
        raise FamilyModelProviderProfileInUse(
            references=tuple(reference.record() for reference in check.blocking_references)
        )

    _detach_historical_references(
        db,
        family_id=command.family_id,
        profile_id=profile.id,
        active_revision_id=settings.active_config_revision_id,
    )
    log_activity(
        db,
        family_id=command.family_id,
        actor_id=command.actor_user_id,
        action=ActivityAction.UPDATE,
        entity_type="family_model_provider_profile",
        entity_id=profile.id,
        summary=f"删除了家庭 AI 服务档案“{profile.display_name}”",
    )
    current_profile_version_id = profile.current_profile_version_id
    current_secret_version_id = profile.current_secret_version_id
    profile.current_profile_version_id = None
    profile.current_secret_version_id = None
    db.flush()
    db.execute(
        delete(FamilyModelProviderProfileVersion).where(
            FamilyModelProviderProfileVersion.family_id == command.family_id,
            FamilyModelProviderProfileVersion.profile_id == profile.id,
        )
    )
    db.execute(
        delete(FamilyModelSecretVersion).where(
            FamilyModelSecretVersion.family_id == command.family_id,
            FamilyModelSecretVersion.profile_id == profile.id,
        )
    )
    del current_profile_version_id, current_secret_version_id
    db.delete(profile)
    changed_at = utcnow()
    settings.version_number += 1
    settings.updated_by = command.actor_user_id
    settings.updated_at = changed_at
    complete_operation(
        claim,
        result_id=profile.id,
        response_json={"deleted": True, "profile_id": profile.id},
        completed_at=changed_at,
    )
    db.flush()
