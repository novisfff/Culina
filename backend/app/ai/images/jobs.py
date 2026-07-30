from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import timedelta
import hashlib
import logging
from threading import Event, Thread
from typing import Literal

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.ai.images.generation import (
    ImageGenerationClient,
    ImageGenerationProviderOutcomeUncertain,
    ImageGenerationProviderRejected,
    ImageGenerationRequest,
    ImageGenerationResult,
    MeteredImageGenerationResult,
    image_provider_config_for_mode,
    normalize_image_generation_request,
)
from app.core.config import get_settings
from app.core.enums import (
    ImageGenerationMode,
    MealType,
    MediaEntityType,
    MediaSource,
    MembershipStatus,
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageMeter,
    ModelUsageOperationSource,
)
from app.core.utils import create_id, utcnow
from app.db.session import SessionLocal
from app.db.transactions import commit_session
from app.models.domain import (
    AIImageGenerationJob,
    Family,
    Food,
    FoodScene,
    Ingredient,
    MealLog,
    MediaAsset,
    Membership,
    Recipe,
    User,
)
from app.services.meal_log_versions import (
    MealLogConflictError,
    bump_meal_log_collection,
    lock_meal_log_write_targets,
)
from app.services.media import delete_media_file, get_media_asset, read_media_object, save_generated_asset, save_svg_asset
from app.services.model_usage.adapters.base import MeteredProviderAttempt
from app.services.model_usage.adapters.image_generation import ImageGenerationUsageAdapter
from app.services.model_usage.configured_variants import configured_usage_variants
from app.services.model_usage.errors import (
    ModelUsageAttemptAlreadyAccounted,
    ModelUsageBlocked,
    ModelUsageContractError,
    ModelUsageDispatchRecoveryRequired,
    ModelUsageError,
)
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.preflight import decode_receipt_integrity_keyring
from app.services.model_usage.types import UsageAttribution

ImageJobStatus = Literal["queued", "running", "succeeded", "failed"]
ImageJobBindStatus = Literal["pending", "bound", "skipped", "unbound"]
ImageProviderExecutionStatus = Literal[
    "not_started",
    "dispatching",
    "confirmed_not_executed",
    "uncertain",
    "confirmed",
]
IMAGE_BIND_STRATEGY_APPEND = "append"

MAX_ATTEMPTS = 3
JOB_LOCK_STALE_AFTER = timedelta(minutes=10)
ACTIVE_COMPLETED_WINDOW = timedelta(minutes=10)
WORKER_SCAN_INTERVAL_SECONDS = 2.0
MAX_ATTEMPTS_EXHAUSTED_ERROR = "服务重启或后台任务中断，图片生成已达到最大重试次数，请重新发起图片生成。"

logger = logging.getLogger(__name__)


_IMAGE_JOB_ERROR_MESSAGES: dict[str, str] = {
    "image_provider_request_rejected": "图片生成请求暂时无法处理，请检查图片设置后再试。",
    "image_reference_invalid": "参考图片暂时无法使用，请重新选择一张图片后再试。",
    "image_provider_outcome_uncertain": "图片生成服务的执行结果暂时无法确认；为避免重复生成，本次不会自动重试。",
    "image_usage_settlement_failed": "图片生成已发送，但用量记录未能确认；为避免重复生成，本次不会自动重试。",
    "image_post_provider_persistence_failed": "图片已生成，但保存生成图时失败；为避免重复生成，本次不能直接重试。",
    "image_bind_failed": "图片已生成，但暂时无法绑定到目标资料；可以重试绑定。",
    "image_request_unavailable": "图片生成所需的资料暂时不可用，请检查后重新发起生成。",
    "model_usage_budget_exceeded": "当前家庭的模型使用预算已达到上限，暂不能生成图片。",
    "model_usage_capability_limit_exceeded": "当前图片生成额度已达到上限，暂不能生成图片。",
    "model_usage_image_variant_not_configured": "图片生成的计量配置暂不可用，请稍后再试。",
    "model_usage_adapter_required": "图片生成的计量服务暂不可用，请稍后再试。",
    "model_usage_contract_error": "图片生成的计量服务暂不可用，请稍后再试。",
}


def _image_job_error_message(error_code: str | None) -> str:
    if error_code and error_code.startswith("model_usage_"):
        return _IMAGE_JOB_ERROR_MESSAGES.get(error_code, "图片生成的计量服务暂不可用，请稍后再试。")
    return _IMAGE_JOB_ERROR_MESSAGES.get(error_code or "", "AI 图片生成未完成，请稍后查看任务状态。")


def safe_image_job_error(job: AIImageGenerationJob) -> str | None:
    """Return only stable, user-safe failure text to API consumers."""

    if job.error_code:
        return _image_job_error_message(job.error_code)
    if job.status == "failed":
        return "AI 图片生成未完成，请稍后查看任务状态。"
    return job.error


def image_job_can_retry(job: AIImageGenerationJob) -> bool:
    if job.status != "failed":
        return False
    if job.error_code and job.error_code.startswith("model_usage_"):
        return False
    if job.generated_media_id and job.error_code == "image_bind_failed":
        return True
    return job.provider_execution_status == "confirmed_not_executed"


def retry_mode_for_image_job(job: AIImageGenerationJob) -> Literal["bind_only", "new_provider_attempt"]:
    if job.generated_media_id and job.error_code == "image_bind_failed":
        return "bind_only"
    if (
        job.provider_execution_status == "confirmed_not_executed"
        and not (job.error_code or "").startswith("model_usage_")
    ):
        return "new_provider_attempt"
    raise ValueError("Image job cannot safely re-run the provider")


def _request_to_payload(request: ImageGenerationRequest) -> dict:
    payload = asdict(request)
    payload.pop("reference_image_bytes", None)
    payload.pop("reference_filename", None)
    payload["entity_type"] = request.entity_type.value
    payload["mode"] = request.mode.value
    payload["meal_type"] = request.meal_type.value if request.meal_type else None
    return payload


def _request_from_payload(
    db: Session,
    *,
    family_id: str,
    payload: dict,
    reference_media_id: str | None,
) -> ImageGenerationRequest:
    mode = ImageGenerationMode(str(payload.get("mode") or ImageGenerationMode.TEXT.value))
    reference_image_bytes = None
    reference_filename = None
    if mode == ImageGenerationMode.REFERENCE:
        if not reference_media_id:
            raise ValueError("Missing reference media")
        reference_asset = get_media_asset(db, family_id=family_id, media_id=reference_media_id)
        if reference_asset is None:
            raise ValueError("Reference media not found")
        if reference_asset.source != MediaSource.UPLOAD:
            raise ValueError("Reference media must be an uploaded image")
        reference_image_bytes = read_media_object(reference_asset)
        reference_filename = reference_asset.name

    meal_type = payload.get("meal_type")
    return ImageGenerationRequest(
        entity_type=MediaEntityType(str(payload.get("entity_type") or MediaEntityType.FOOD.value)),
        mode=mode,
        title=str(payload.get("title") or ""),
        category=str(payload.get("category") or ""),
        notes=str(payload.get("notes") or ""),
        tags=[str(item) for item in payload.get("tags") or []],
        scene=str(payload.get("scene") or ""),
        meal_type=MealType(str(meal_type)) if meal_type else None,
        food_names=[str(item) for item in payload.get("food_names") or []],
        ingredient_names=[str(item) for item in payload.get("ingredient_names") or []],
        size=str(payload.get("size") or ""),
        reference_image_bytes=reference_image_bytes,
        reference_filename=reference_filename,
    )


def enqueue_image_generation(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    request: ImageGenerationRequest,
    reference_media_id: str | None = None,
    target_entity_type: str | None = None,
    target_entity_id: str | None = None,
    replace_anchor_media_id: str | None = None,
) -> AIImageGenerationJob:
    now = utcnow()
    job = AIImageGenerationJob(
        id=create_id("image-job"),
        family_id=family_id,
        user_id=user_id,
        status="queued",
        request_payload=_request_to_payload(request),
        reference_media_id=reference_media_id,
        target_entity_type=target_entity_type,
        target_entity_id=target_entity_id,
        replace_anchor_media_id=replace_anchor_media_id,
        bind_status="pending" if target_entity_type and target_entity_id else "unbound",
        created_at=now,
        updated_at=now,
    )
    db.add(job)
    db.flush()
    return job


def get_image_generation_job(db: Session, *, family_id: str, job_id: str) -> AIImageGenerationJob | None:
    return db.scalar(select(AIImageGenerationJob).where(AIImageGenerationJob.family_id == family_id, AIImageGenerationJob.id == job_id))


def retry_failed_image_generation_job(db: Session, *, family_id: str, job_id: str) -> AIImageGenerationJob | None:
    job = db.scalar(
        select(AIImageGenerationJob)
        .where(
            AIImageGenerationJob.family_id == family_id,
            AIImageGenerationJob.id == job_id,
        )
        .with_for_update()
    )
    if job is None:
        return None
    if job.status != "failed":
        raise ValueError("Only failed AI image render jobs can be retried")

    mode = retry_mode_for_image_job(job)

    now = utcnow()
    job.status = "queued"
    job.error = None
    job.error_code = None
    job.locked_at = None
    job.completed_at = None
    if mode == "bind_only":
        # The generated asset and confirmed usage event are the recovery
        # boundary.  Retrying this job must not allocate another image.
        job.bind_status = "pending" if job.target_entity_type and job.target_entity_id else "unbound"
    else:
        # Preserve the monotonic provider-attempt counter.  The next worker
        # execution derives a fresh attempt key from it.
        job.usage_reservation_id = None
        job.usage_event_id = None
        job.provider_execution_status = "not_started"
        job.provider_completed_at = None
    job.updated_at = now
    db.flush()
    return job


def list_active_image_generation_jobs(db: Session, *, family_id: str) -> list[AIImageGenerationJob]:
    cutoff = utcnow() - ACTIVE_COMPLETED_WINDOW
    statement = (
        select(AIImageGenerationJob)
        .where(
            AIImageGenerationJob.family_id == family_id,
            or_(
                AIImageGenerationJob.status.in_(("queued", "running")),
                AIImageGenerationJob.completed_at >= cutoff,
            ),
        )
        .order_by(AIImageGenerationJob.created_at.desc(), AIImageGenerationJob.id)
        .limit(100)
    )
    return list(db.scalars(statement))


def recover_interrupted_image_generation_jobs(
    db: Session,
    *,
    include_all_running: bool = False,
    limit: int = 100,
) -> int:
    now = utcnow()
    stale_lock_cutoff = now - JOB_LOCK_STALE_AFTER
    running_filter = AIImageGenerationJob.status == "running"
    if not include_all_running:
        running_filter = and_(
            running_filter,
            or_(
                AIImageGenerationJob.locked_at.is_(None),
                AIImageGenerationJob.locked_at < stale_lock_cutoff,
            ),
        )
    statement = (
        select(AIImageGenerationJob)
        .where(running_filter)
        .order_by(AIImageGenerationJob.created_at, AIImageGenerationJob.id)
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    jobs = list(db.scalars(statement))
    for job in jobs:
        # A running job may have crossed the provider boundary even when the
        # process died before it could store the response.  Never turn that
        # ambiguous state into a second image generation request.
        if job.provider_execution_status == "confirmed" and job.generated_media_id:
            job.status = "queued"
            job.error = None
            job.error_code = None
            job.bind_status = "pending" if job.target_entity_type and job.target_entity_id else "unbound"
            job.completed_at = None
        elif job.provider_execution_status == "confirmed_not_executed":
            job.status = "queued"
            job.error = None
            job.error_code = None
            job.completed_at = None
        elif job.provider_execution_status == "confirmed":
            job.status = "failed"
            job.error_code = "image_post_provider_persistence_failed"
            job.error = _image_job_error_message(job.error_code)
            job.completed_at = now
        else:
            job.status = "failed"
            job.error_code = "image_provider_outcome_uncertain"
            job.error = _image_job_error_message(job.error_code)
            job.provider_execution_status = "uncertain"
            job.completed_at = now
        job.locked_at = None
        job.updated_at = now
    if jobs:
        db.commit()
    return len(jobs)


def _target_exists(db: Session, *, family_id: str, entity_type: str, entity_id: str) -> bool:
    if entity_type == "family":
        return db.scalar(select(Family.id).where(Family.id == family_id, Family.id == entity_id)) is not None
    if entity_type == "user":
        return (
            db.scalar(
                select(User.id)
                .join(Membership, Membership.user_id == User.id)
                .where(
                    User.id == entity_id,
                    Membership.family_id == family_id,
                    Membership.status == MembershipStatus.ACTIVE,
                )
            )
            is not None
        )
    model_by_type = {
        "food": Food,
        "ingredient": Ingredient,
        "recipe": Recipe,
        "food_scene": FoodScene,
        "meal_log": MealLog,
    }
    model = model_by_type.get(entity_type)
    if model is None:
        return False
    return db.scalar(select(model.id).where(model.family_id == family_id, model.id == entity_id)) is not None


def attach_image_generation_job_to_entity(
    db: Session,
    *,
    family_id: str,
    job_id: str | None,
    entity_type: str,
    entity_id: str,
    replace_anchor_media_id: str | None = None,
    bump_parent: bool = True,
) -> AIImageGenerationJob | None:
    if not job_id:
        return None
    job = get_image_generation_job(db, family_id=family_id, job_id=job_id)
    if job is None:
        raise ValueError("AI image render job not found")
    if job.target_entity_type and job.target_entity_type != entity_type:
        raise ValueError("AI image render job target does not match")
    if job.target_entity_id and job.target_entity_id != entity_id:
        raise ValueError("AI image render job target does not match")
    if not _target_exists(db, family_id=family_id, entity_type=entity_type, entity_id=entity_id):
        raise ValueError("AI image render target not found")

    job.target_entity_type = entity_type
    job.target_entity_id = entity_id
    if replace_anchor_media_id is not None:
        job.replace_anchor_media_id = replace_anchor_media_id
    if job.bind_status in {None, "unbound"}:
        job.bind_status = "pending"
    job.updated_at = utcnow()
    if job.status == "succeeded" and job.generated_media_id:
        _bind_generated_asset_to_target(db, job, bump_parent=bump_parent)
    db.flush()
    return job


def _save_render_result(db: Session, *, job: AIImageGenerationJob, request: ImageGenerationRequest, result: ImageGenerationResult) -> MediaAsset:
    generated_title = request.title or "culina-ai-image"
    generated_alt = f"{request.title or '家庭厨房图片'} 的 AI 主图"
    if result.svg_markup is not None:
        return save_svg_asset(
            db,
            family_id=job.family_id,
            user_id=job.user_id,
            title=generated_title,
            alt=generated_alt,
            svg_markup=result.svg_markup,
            source=MediaSource.AI,
            generation_mode=request.mode,
            reference_media_id=job.reference_media_id,
            style_key=result.style_key,
            prompt_version=result.prompt_version,
        )
    if result.binary_content is None:
        raise ValueError("AI 主图生成失败")
    return save_generated_asset(
        db,
        family_id=job.family_id,
        user_id=job.user_id,
        title=generated_title,
        alt=generated_alt,
        binary_payload=result.binary_content,
        file_extension=result.file_extension,
        source=MediaSource.AI,
        generation_mode=request.mode,
        reference_media_id=job.reference_media_id,
        style_key=result.style_key,
        prompt_version=result.prompt_version,
    )


def _list_target_assets(db: Session, *, family_id: str, entity_type: str, entity_id: str) -> list[MediaAsset]:
    return list(
        db.scalars(
            select(MediaAsset).where(
                MediaAsset.family_id == family_id,
                MediaAsset.entity_type == entity_type,
                MediaAsset.entity_id == entity_id,
            )
        )
    )


def _should_skip_late_bind(
    *,
    current_assets: list[MediaAsset],
    append_to_existing: bool,
    replace_anchor_media_id: str | None,
) -> bool:
    if append_to_existing:
        return False
    if any(asset.source != MediaSource.AI for asset in current_assets):
        return True
    if replace_anchor_media_id and current_assets and not any(asset.id == replace_anchor_media_id for asset in current_assets):
        return True
    return False


def _bind_generated_asset_to_target(
    db: Session,
    job: AIImageGenerationJob,
    *,
    bump_parent: bool = True,
) -> ImageJobBindStatus:
    if not job.target_entity_type or not job.target_entity_id or not job.generated_media_id:
        job.bind_status = "unbound"
        return "unbound"
    if not _target_exists(db, family_id=job.family_id, entity_type=job.target_entity_type, entity_id=job.target_entity_id):
        job.bind_status = "skipped"
        return "skipped"
    generated = get_media_asset(db, family_id=job.family_id, media_id=job.generated_media_id)
    if generated is None:
        job.bind_status = "skipped"
        return "skipped"

    # Late skip decisions run before any MealLog locks: pure skip paths take no
    # MealLog locks and do not bump. Only the actual bind path locks Food+MealLog.
    append_to_existing = (job.request_payload or {}).get("bind_strategy") == IMAGE_BIND_STRATEGY_APPEND
    current_assets = _list_target_assets(
        db,
        family_id=job.family_id,
        entity_type=job.target_entity_type,
        entity_id=job.target_entity_id,
    )
    if _should_skip_late_bind(
        current_assets=current_assets,
        append_to_existing=append_to_existing,
        replace_anchor_media_id=job.replace_anchor_media_id,
    ):
        job.bind_status = "skipped"
        return "skipped"

    locked_meal_log = None
    if job.target_entity_type == "meal_log":
        try:
            locked_meal_log = lock_meal_log_write_targets(
                db,
                family_id=job.family_id,
                meal_log_id=job.target_entity_id,
            ).meal_log
        except MealLogConflictError:
            job.bind_status = "skipped"
            return "skipped"
        # Revalidate under the lock so concurrent non-AI attaches / anchor changes
        # cannot be bypassed by a stale pre-lock asset list.
        current_assets = _list_target_assets(
            db,
            family_id=job.family_id,
            entity_type=job.target_entity_type,
            entity_id=job.target_entity_id,
        )
        if _should_skip_late_bind(
            current_assets=current_assets,
            append_to_existing=append_to_existing,
            replace_anchor_media_id=job.replace_anchor_media_id,
        ):
            job.bind_status = "skipped"
            return "skipped"

    if append_to_existing:
        generated.entity_type = job.target_entity_type
        generated.entity_id = job.target_entity_id
        if job.target_entity_type == "recipe":
            _sync_recipe_image_to_food(db, job=job, generated=generated, append_to_existing=True)
        if locked_meal_log is not None and bump_parent:
            bump_meal_log_collection(locked_meal_log, user_id=job.user_id)
        job.bind_status = "bound"
        return "bound"

    for asset in current_assets:
        asset.entity_type = None
        asset.entity_id = None
    generated.entity_type = job.target_entity_type
    generated.entity_id = job.target_entity_id
    if job.target_entity_type == "recipe":
        _sync_recipe_image_to_food(db, job=job, generated=generated)
    if locked_meal_log is not None and bump_parent:
        # Bind only attaches media; never overwrite MealLog business fields.
        # When called from a versioned writer (create/update meal log), bump_parent=False
        # so the outer writer performs the single logical row_version bump.
        bump_meal_log_collection(locked_meal_log, user_id=job.user_id)
    job.bind_status = "bound"
    return "bound"


def _sync_recipe_image_to_food(db: Session, *, job: AIImageGenerationJob, generated: MediaAsset, append_to_existing: bool = False) -> None:
    if not job.target_entity_id:
        return
    food = db.scalar(select(Food).where(Food.family_id == job.family_id, Food.recipe_id == job.target_entity_id))
    if food is None:
        return
    current_food_assets = list(
        db.scalars(
            select(MediaAsset).where(
                MediaAsset.family_id == job.family_id,
                MediaAsset.entity_type == "food",
                MediaAsset.entity_id == food.id,
            )
        )
    )
    if append_to_existing:
        current_food_assets = []
    if any(asset.source != MediaSource.AI for asset in current_food_assets):
        return
    for asset in current_food_assets:
        asset.entity_type = None
        asset.entity_id = None
    db.add(
        MediaAsset(
            id=create_id("photo"),
            family_id=generated.family_id,
            name=generated.name,
            url=generated.url,
            file_path=generated.file_path,
            source=generated.source,
            alt=generated.alt,
            generation_mode=generated.generation_mode,
            reference_media_id=generated.reference_media_id,
            style_key=generated.style_key,
            prompt_version=generated.prompt_version,
            variants=generated.variants,
            entity_type="food",
            entity_id=food.id,
            created_by=job.user_id,
        )
    )


def _image_usage_adapter_for_request(
    request: ImageGenerationRequest,
) -> ImageGenerationUsageAdapter | None:
    """Build the required-mode adapter for the exact image variant.

    A configured catalog variant is the authority for whether a separate
    request unit is billable.  Required mode must fail closed before a provider
    call instead of silently generating an unmetered image.
    """

    settings = get_settings()
    if not bool(getattr(settings, "model_usage_required", False)):
        return None
    normalized = normalize_image_generation_request(request)
    config = image_provider_config_for_mode(normalized.mode)
    provider = config.provider.strip()
    model = config.model.strip()
    if provider.lower() in {"", "disabled", "mock"} or not model:
        raise ModelUsageContractError("model_usage_image_variant_not_configured")
    variant_key = (
        f"mode={normalized.mode.value}|size={normalized.size}|quality={normalized.quality.strip().lower()}"
    )
    try:
        matches = [
            variant
            for variant in configured_usage_variants(settings)
            if variant.capability is ModelUsageCapability.IMAGE_GENERATION
            and variant.provider == provider
            and variant.billing_model == model
            and variant.variant_key == variant_key
        ]
    except Exception as exc:
        raise ModelUsageContractError("model_usage_image_variant_not_configured") from exc
    if len(matches) != 1:
        raise ModelUsageContractError("model_usage_image_variant_not_configured")
    variant = matches[0]
    return ImageGenerationUsageAdapter(
        provider=provider,
        model=model,
        include_request_fee_by_default=ModelUsageMeter.REQUEST_UNITS in variant.billable_meters,
        usage_facade=ModelUsageFacade(session_factory=SessionLocal),
        session_factory=SessionLocal,
        signer=decode_receipt_integrity_keyring(settings).signer(),
    )


def _claim_image_generation_job(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
    claimed: bool,
) -> bool:
    """Claim worker ownership without falsely recording a provider attempt."""

    with session_factory() as db:
        job = db.scalar(
            select(AIImageGenerationJob)
            .where(AIImageGenerationJob.id == job_id)
            .with_for_update()
        )
        if job is None or job.status != "queued":
            return False
        now = utcnow()
        stale_lock_cutoff = now - JOB_LOCK_STALE_AFTER
        if (
            not claimed
            and job.locked_at is not None
            and job.locked_at > stale_lock_cutoff
        ):
            return False
        job.locked_at = now
        job.updated_at = now
        db.commit()
    return True


def _prepare_image_job_request(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
) -> tuple[
    Literal["bind_only", "provider"],
    ImageGenerationRequest | None,
    UsageAttribution | None,
    str | None,
    dict[str, object] | None,
] | None:
    """Load sensitive request material and durable attempt identity before reserve."""

    with session_factory() as db:
        job = db.scalar(
            select(AIImageGenerationJob)
            .where(AIImageGenerationJob.id == job_id)
            .with_for_update()
        )
        if job is None or job.status != "queued":
            return None
        if (
            job.generated_media_id
            and job.provider_execution_status == "confirmed"
            and job.bind_status != "bound"
        ):
            return ("bind_only", None, None, None, None)

        request = normalize_image_generation_request(
            _request_from_payload(
                db,
                family_id=job.family_id,
                payload=job.request_payload,
                reference_media_id=job.reference_media_id,
            )
        )
        attempt_key = f"image-job:{job.id}:attempt:{(job.attempt_count or 0) + 1}"
        # Persist this before reservation so a process crash can replay the
        # same reservation; do not increment attempt_count until reserve has
        # succeeded and the request is about to cross the provider boundary.
        job.usage_attempt_key = attempt_key
        job.usage_reservation_id = None
        job.usage_event_id = None
        job.provider_execution_status = "not_started"
        job.provider_completed_at = None
        job.updated_at = utcnow()
        attribution = UsageAttribution(
            family_id=job.family_id,
            attribution_kind=ModelUsageAttributionKind.USER,
            actor_user_id=job.user_id,
            operation_source=ModelUsageOperationSource.IMAGE_JOB,
            logical_operation_id=job.id,
        )
        fingerprint_payload: dict[str, object] = {
            "job_id": job.id,
            "family_id": job.family_id,
            "attempt_key": attempt_key,
            "request_payload": dict(job.request_payload or {}),
            "reference_media_id": job.reference_media_id,
            "reference_content_sha256": (
                hashlib.sha256(request.reference_image_bytes).hexdigest()
                if request.reference_image_bytes is not None
                else None
            ),
        }
        db.commit()
    return ("provider", request, attribution, attempt_key, fingerprint_payload)


def _mark_image_job_budget_blocked(
    job_id: str,
    *,
    error_code: str,
    session_factory: Callable[[], Session],
) -> None:
    with session_factory() as db:
        job = db.scalar(
            select(AIImageGenerationJob)
            .where(AIImageGenerationJob.id == job_id)
            .with_for_update()
        )
        if job is None:
            return
        now = utcnow()
        job.status = "failed"
        job.error_code = error_code
        job.error = _image_job_error_message(error_code)
        job.usage_attempt_key = None
        job.usage_reservation_id = None
        job.usage_event_id = None
        job.provider_execution_status = "not_started"
        job.provider_completed_at = None
        job.locked_at = None
        job.completed_at = now
        job.updated_at = now
        db.commit()


def _mark_image_job_failure(
    job_id: str,
    *,
    error_code: str,
    provider_execution_status: ImageProviderExecutionStatus,
    session_factory: Callable[[], Session],
    usage_event_id: str | None = None,
    provider_completed: bool = False,
) -> None:
    with session_factory() as db:
        job = db.scalar(
            select(AIImageGenerationJob)
            .where(AIImageGenerationJob.id == job_id)
            .with_for_update()
        )
        if job is None:
            return
        now = utcnow()
        job.status = "failed"
        job.error_code = error_code
        job.error = _image_job_error_message(error_code)
        job.provider_execution_status = provider_execution_status
        if usage_event_id is not None:
            job.usage_event_id = usage_event_id
        if provider_completed:
            job.provider_completed_at = now
        job.locked_at = None
        job.completed_at = now
        job.updated_at = now
        db.commit()


def _mark_image_job_provider_start(
    job_id: str,
    *,
    attempt_key: str,
    usage_attempt: MeteredProviderAttempt | None,
    session_factory: Callable[[], Session],
) -> bool:
    with session_factory() as db:
        job = db.scalar(
            select(AIImageGenerationJob)
            .where(AIImageGenerationJob.id == job_id)
            .with_for_update()
        )
        if (
            job is None
            or job.status != "queued"
            or job.usage_attempt_key != attempt_key
        ):
            return False
        now = utcnow()
        job.status = "running"
        job.error = None
        job.error_code = None
        job.attempt_count = (job.attempt_count or 0) + 1
        job.usage_reservation_id = usage_attempt.reservation_id if usage_attempt is not None else None
        job.usage_event_id = None
        job.provider_execution_status = "dispatching"
        job.locked_at = now
        job.started_at = job.started_at or now
        job.updated_at = now
        db.commit()
    return True


def _mark_image_job_provider_completed(
    job_id: str,
    *,
    attempt_key: str,
    usage_event_id: str | None,
    session_factory: Callable[[], Session],
) -> bool:
    with session_factory() as db:
        job = db.scalar(
            select(AIImageGenerationJob)
            .where(AIImageGenerationJob.id == job_id)
            .with_for_update()
        )
        if job is None or job.usage_attempt_key != attempt_key:
            return False
        now = utcnow()
        job.provider_execution_status = "confirmed"
        job.provider_completed_at = now
        job.usage_event_id = usage_event_id
        job.error = None
        job.error_code = None
        job.updated_at = now
        db.commit()
    return True


def _persist_generated_image_asset(
    job_id: str,
    *,
    request: ImageGenerationRequest,
    result: ImageGenerationResult,
    session_factory: Callable[[], Session],
) -> bool:
    generated_asset: MediaAsset | None = None
    with session_factory() as db:
        job = db.scalar(
            select(AIImageGenerationJob)
            .where(AIImageGenerationJob.id == job_id)
            .with_for_update()
        )
        if job is None or job.provider_execution_status != "confirmed":
            return False
        generated_asset = _save_render_result(db, job=job, request=request, result=result)
        job.generated_media_id = generated_asset.id
        job.bind_status = "pending" if job.target_entity_type and job.target_entity_id else "unbound"
        job.updated_at = utcnow()
        commit_session(
            db,
            on_error=lambda: delete_media_file(generated_asset) if generated_asset else None,
        )
    return True


def _bind_persisted_generated_image(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
) -> bool:
    with session_factory() as db:
        job = db.scalar(
            select(AIImageGenerationJob)
            .where(AIImageGenerationJob.id == job_id)
            .with_for_update()
        )
        if (
            job is None
            or job.provider_execution_status != "confirmed"
            or not job.generated_media_id
        ):
            return False
        bind_status = _bind_generated_asset_to_target(db, job)
        # The production helper mutates the job itself.  Preserve the returned
        # status as the transaction contract as well, so a bind-only recovery
        # cannot report success with a stale pending/unbound marker.
        job.bind_status = bind_status
        now = utcnow()
        job.status = "succeeded"
        job.error = None
        job.error_code = None
        job.locked_at = None
        job.completed_at = now
        job.updated_at = now
        db.commit()
    return True


def _unpack_provider_result(
    result: object,
) -> tuple[ImageGenerationResult, str | None] | None:
    if isinstance(result, MeteredImageGenerationResult):
        return result.image, result.usage_event_id
    image = getattr(result, "image", None)
    usage_event_id = getattr(result, "usage_event_id", None)
    if isinstance(image, ImageGenerationResult) and isinstance(usage_event_id, str):
        return image, usage_event_id
    if isinstance(result, ImageGenerationResult):
        return result, None
    return None


def process_image_generation_job(
    job_id: str,
    *,
    session_factory: Callable[[], Session] = SessionLocal,
    client_factory: Callable[[], ImageGenerationClient] = ImageGenerationClient,
    usage_adapter_factory: Callable[[ImageGenerationRequest], ImageGenerationUsageAdapter | None] = _image_usage_adapter_for_request,
    claimed: bool = False,
) -> None:
    if not _claim_image_generation_job(
        job_id,
        session_factory=session_factory,
        claimed=claimed,
    ):
        return

    try:
        prepared = _prepare_image_job_request(job_id, session_factory=session_factory)
    except Exception:
        # Loading a reference asset is entirely local, so no provider attempt
        # has occurred.  It is safe for a user to correct the input and retry.
        _mark_image_job_failure(
            job_id,
            error_code="image_request_unavailable",
            provider_execution_status="confirmed_not_executed",
            session_factory=session_factory,
        )
        logger.warning("AI image job request unavailable job_id=%s", job_id)
        return
    if prepared is None:
        return
    mode, request, attribution, attempt_key, fingerprint_payload = prepared
    if mode == "bind_only":
        try:
            if not _bind_persisted_generated_image(job_id, session_factory=session_factory):
                return
        except Exception:
            _mark_image_job_failure(
                job_id,
                error_code="image_bind_failed",
                provider_execution_status="confirmed",
                session_factory=session_factory,
            )
            logger.warning("AI image bind-only recovery failed job_id=%s", job_id)
        return

    assert request is not None
    assert attribution is not None
    assert attempt_key is not None
    assert fingerprint_payload is not None
    usage_attempt: MeteredProviderAttempt | None = None
    try:
        usage_adapter = usage_adapter_factory(request)
        if usage_adapter is not None:
            usage_attempt = usage_adapter.begin(
                attribution=attribution,
                attempt_key=attempt_key,
                mode=request.mode.value,
                image_count=1,
                size=request.size,
                quality=request.quality,
                fingerprint=usage_adapter.request_fingerprint(fingerprint_payload),
            )
    except ModelUsageBlocked as exc:
        _mark_image_job_budget_blocked(
            job_id,
            error_code=exc.code,
            session_factory=session_factory,
        )
        return
    except ModelUsageAttemptAlreadyAccounted as exc:
        _mark_image_job_failure(
            job_id,
            error_code=exc.code,
            provider_execution_status="uncertain",
            session_factory=session_factory,
        )
        return
    except ModelUsageError as exc:
        _mark_image_job_failure(
            job_id,
            error_code=exc.code,
            provider_execution_status="not_started",
            session_factory=session_factory,
        )
        return
    except Exception:
        _mark_image_job_failure(
            job_id,
            error_code="model_usage_contract_error",
            provider_execution_status="not_started",
            session_factory=session_factory,
        )
        logger.warning("AI image usage preparation failed job_id=%s", job_id)
        return

    try:
        if usage_attempt is not None:
            # Dispatch authorization is the final ledger gate before a real
            # provider attempt.  It intentionally precedes both the durable
            # attempt counter and the provider call.
            usage_attempt.prepare_dispatch()
    except ModelUsageDispatchRecoveryRequired as exc:
        _mark_image_job_failure(
            job_id,
            error_code=exc.code,
            provider_execution_status="uncertain",
            session_factory=session_factory,
        )
        return
    except ModelUsageError as exc:
        _mark_image_job_failure(
            job_id,
            error_code=exc.code,
            provider_execution_status="not_started",
            session_factory=session_factory,
        )
        return
    except Exception:
        _mark_image_job_failure(
            job_id,
            error_code="model_usage_contract_error",
            provider_execution_status="not_started",
            session_factory=session_factory,
        )
        logger.warning("AI image usage dispatch preparation failed job_id=%s", job_id)
        return

    if not _mark_image_job_provider_start(
        job_id,
        attempt_key=attempt_key,
        usage_attempt=usage_attempt,
        session_factory=session_factory,
    ):
        return

    try:
        client = client_factory()
        if usage_attempt is not None:
            provider_result = client.generate(
                request,
                usage_attempt=usage_attempt,
                usage_adapter=usage_adapter,
            )
        elif hasattr(client, "generate"):
            provider_result = client.generate(request)
        elif request.mode == ImageGenerationMode.REFERENCE:
            provider_result = client.generate_from_reference(request)
        else:
            provider_result = client.generate_from_text(request)
    except ImageGenerationProviderRejected as exc:
        _mark_image_job_failure(
            job_id,
            error_code=exc.code,
            provider_execution_status="confirmed_not_executed",
            usage_event_id=exc.usage_event_id,
            provider_completed=True,
            session_factory=session_factory,
        )
        return
    except ImageGenerationProviderOutcomeUncertain as exc:
        _mark_image_job_failure(
            job_id,
            error_code=exc.code,
            provider_execution_status="uncertain",
            session_factory=session_factory,
        )
        return
    except ModelUsageError as exc:
        _mark_image_job_failure(
            job_id,
            error_code=exc.code,
            provider_execution_status="uncertain",
            session_factory=session_factory,
        )
        return
    except Exception:
        _mark_image_job_failure(
            job_id,
            error_code="image_provider_outcome_uncertain",
            provider_execution_status="uncertain",
            session_factory=session_factory,
        )
        logger.warning("AI image provider outcome uncertain job_id=%s", job_id)
        return

    unpacked = _unpack_provider_result(provider_result)
    if unpacked is None:
        _mark_image_job_failure(
            job_id,
            error_code="image_provider_outcome_uncertain",
            provider_execution_status="uncertain",
            session_factory=session_factory,
        )
        return
    result, usage_event_id = unpacked
    if usage_attempt is not None and not usage_event_id:
        # A metered provider result is only safe to persist after its receipt
        # has become a durable ledger event.  A custom provider boundary that
        # returns bytes without settlement may have generated an image, so
        # preserve the reservation as uncertain and never save or resend it.
        try:
            usage_attempt.mark_uncertain("image_usage_settlement_failed")
        except Exception:
            # The terminal job still prevents a duplicate provider call if the
            # ledger transition itself is unavailable.
            pass
        _mark_image_job_failure(
            job_id,
            error_code="image_usage_settlement_failed",
            provider_execution_status="uncertain",
            session_factory=session_factory,
        )
        return
    if not _mark_image_job_provider_completed(
        job_id,
        attempt_key=attempt_key,
        usage_event_id=usage_event_id,
        session_factory=session_factory,
    ):
        return

    try:
        if not _persist_generated_image_asset(
            job_id,
            request=request,
            result=result,
            session_factory=session_factory,
        ):
            return
    except Exception:
        _mark_image_job_failure(
            job_id,
            error_code="image_post_provider_persistence_failed",
            provider_execution_status="confirmed",
            session_factory=session_factory,
        )
        logger.warning("AI image post-provider persistence failed job_id=%s", job_id)
        return

    try:
        if not _bind_persisted_generated_image(job_id, session_factory=session_factory):
            return
    except Exception:
        _mark_image_job_failure(
            job_id,
            error_code="image_bind_failed",
            provider_execution_status="confirmed",
            session_factory=session_factory,
        )
        logger.warning("AI image binding failed job_id=%s", job_id)


def claim_pending_image_generation_jobs(db: Session, *, limit: int = 2) -> list[str]:
    now = utcnow()
    stale_lock_cutoff = now - JOB_LOCK_STALE_AFTER
    statement = (
        select(AIImageGenerationJob)
        .where(
            AIImageGenerationJob.status == "queued",
            or_(
                AIImageGenerationJob.locked_at.is_(None),
                AIImageGenerationJob.locked_at < stale_lock_cutoff,
            ),
        )
        .order_by(AIImageGenerationJob.created_at, AIImageGenerationJob.id)
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    jobs = list(db.scalars(statement))
    job_ids: list[str] = []
    for job in jobs:
        # This is a worker claim, not a provider attempt.  Budget reserve and
        # dispatch remain inside ``process_image_generation_job`` and must
        # happen before ``attempt_count`` or a visible running state changes.
        job.locked_at = now
        job.updated_at = now
        job_ids.append(job.id)
    if job_ids:
        db.commit()
    return job_ids


class ImageGenerationWorker:
    def __init__(self, *, session_factory: Callable[[], Session] = SessionLocal) -> None:
        self._session_factory = session_factory
        self._stop_event = Event()
        self._thread: Thread | None = None
        self._executor: ThreadPoolExecutor | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop_event.clear()
        self._recover_startup_jobs()
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="culina-image")
        self._thread = Thread(target=self._run, name="culina-image-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                with self._session_factory() as db:
                    recover_interrupted_image_generation_jobs(db)
                    job_ids = claim_pending_image_generation_jobs(db)
                if self._executor is None:
                    return
                for job_id in job_ids:
                    self._executor.submit(process_image_generation_job, job_id, session_factory=self._session_factory, claimed=True)
            except Exception:
                logger.exception("AI image worker scan failed")
            self._stop_event.wait(WORKER_SCAN_INTERVAL_SECONDS)

    def _recover_startup_jobs(self) -> None:
        try:
            with self._session_factory() as db:
                recovered_count = recover_interrupted_image_generation_jobs(db, include_all_running=True)
            if recovered_count:
                logger.info("Recovered interrupted AI image generation jobs count=%s", recovered_count)
        except Exception:
            logger.exception("AI image worker startup recovery failed")
