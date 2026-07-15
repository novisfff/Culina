from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import timedelta
import logging
from threading import Event, Thread
from typing import Literal

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.ai.images.generation import ImageGenerationClient, ImageGenerationRequest, ImageGenerationResult
from app.core.enums import ImageGenerationMode, MealType, MediaEntityType, MediaSource, MembershipStatus
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

ImageJobStatus = Literal["queued", "running", "succeeded", "failed"]
ImageJobBindStatus = Literal["pending", "bound", "skipped", "unbound"]
IMAGE_BIND_STRATEGY_APPEND = "append"

MAX_ATTEMPTS = 3
JOB_LOCK_STALE_AFTER = timedelta(minutes=10)
ACTIVE_COMPLETED_WINDOW = timedelta(minutes=10)
WORKER_SCAN_INTERVAL_SECONDS = 2.0
MAX_ATTEMPTS_EXHAUSTED_ERROR = "服务重启或后台任务中断，图片生成已达到最大重试次数，请重新发起图片生成。"

logger = logging.getLogger(__name__)


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
    job = get_image_generation_job(db, family_id=family_id, job_id=job_id)
    if job is None:
        return None
    if job.status != "failed":
        raise ValueError("Only failed AI image render jobs can be retried")

    now = utcnow()
    job.status = "queued"
    job.error = None
    job.attempt_count = 0
    job.locked_at = None
    job.started_at = None
    job.completed_at = None
    job.generated_media_id = None
    job.bind_status = "pending" if job.target_entity_type and job.target_entity_id else "unbound"
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
        job.locked_at = None
        job.updated_at = now
        if job.attempt_count >= MAX_ATTEMPTS:
            job.status = "failed"
            job.error = MAX_ATTEMPTS_EXHAUSTED_ERROR
            job.completed_at = now
        else:
            job.status = "queued"
            job.error = None
            job.completed_at = None
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
        _bind_generated_asset_to_target(db, job)
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


def _bind_generated_asset_to_target(db: Session, job: AIImageGenerationJob) -> ImageJobBindStatus:
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

    # Late skip decisions run before any MealLog locks: skipped/unbound paths take no
    # MealLog locks and do not bump. Only the actual bind path locks Food+MealLog.
    current_assets = list(
        db.scalars(
            select(MediaAsset).where(
                MediaAsset.family_id == job.family_id,
                MediaAsset.entity_type == job.target_entity_type,
                MediaAsset.entity_id == job.target_entity_id,
            )
        )
    )
    append_to_existing = (job.request_payload or {}).get("bind_strategy") == IMAGE_BIND_STRATEGY_APPEND
    if not append_to_existing:
        non_ai_assets = [asset for asset in current_assets if asset.source != MediaSource.AI]
        if non_ai_assets:
            job.bind_status = "skipped"
            return "skipped"
        if job.replace_anchor_media_id and current_assets and not any(asset.id == job.replace_anchor_media_id for asset in current_assets):
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

    if append_to_existing:
        generated.entity_type = job.target_entity_type
        generated.entity_id = job.target_entity_id
        if job.target_entity_type == "recipe":
            _sync_recipe_image_to_food(db, job=job, generated=generated, append_to_existing=True)
        if locked_meal_log is not None:
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
    if locked_meal_log is not None:
        # Bind only attaches media; never overwrite MealLog business fields.
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


def process_image_generation_job(
    job_id: str,
    *,
    session_factory: Callable[[], Session] = SessionLocal,
    client_factory: Callable[[], ImageGenerationClient] = ImageGenerationClient,
    claimed: bool = False,
) -> None:
    generated_asset: MediaAsset | None = None
    with session_factory() as db:
        job = db.get(AIImageGenerationJob, job_id)
        if job is None:
            return
        now = utcnow()
        stale_lock_cutoff = now - JOB_LOCK_STALE_AFTER
        if not claimed and job.status == "running" and job.locked_at and job.locked_at > stale_lock_cutoff:
            return
        if job.status == "succeeded":
            return
        if job.status == "failed" and job.attempt_count >= MAX_ATTEMPTS:
            return
        job.status = "running"
        job.error = None
        job.attempt_count += 1
        job.locked_at = now
        job.started_at = job.started_at or now
        job.updated_at = now
        db.commit()

    try:
        with session_factory() as db:
            job = db.get(AIImageGenerationJob, job_id)
            if job is None:
                return
            request = _request_from_payload(
                db,
                family_id=job.family_id,
                payload=job.request_payload,
                reference_media_id=job.reference_media_id,
            )
        client = client_factory()
        result = client.generate_from_reference(request) if request.mode == ImageGenerationMode.REFERENCE else client.generate_from_text(request)
        with session_factory() as db:
            job = db.get(AIImageGenerationJob, job_id)
            if job is None:
                return
            generated_asset = _save_render_result(db, job=job, request=request, result=result)
            job.generated_media_id = generated_asset.id
            job.status = "succeeded"
            job.error = None
            job.locked_at = None
            job.completed_at = utcnow()
            job.updated_at = job.completed_at
            _bind_generated_asset_to_target(db, job)
            commit_session(db, on_error=lambda: delete_media_file(generated_asset) if generated_asset else None)
    except Exception as exc:  # pragma: no cover - provider failures depend on network/config
        with session_factory() as db:
            job = db.get(AIImageGenerationJob, job_id)
            if job is not None:
                if job.attempt_count >= MAX_ATTEMPTS:
                    job.status = "failed"
                    job.completed_at = utcnow()
                else:
                    job.status = "queued"
                    job.completed_at = None
                job.error = str(exc) or "AI 主图生成失败"
                job.locked_at = None
                job.updated_at = utcnow()
                db.commit()
        logger.warning("AI image generation failed job_id=%s error=%s", job_id, exc)


def claim_pending_image_generation_jobs(db: Session, *, limit: int = 2) -> list[str]:
    now = utcnow()
    stale_lock_cutoff = now - JOB_LOCK_STALE_AFTER
    statement = (
        select(AIImageGenerationJob)
        .where(
            or_(
                AIImageGenerationJob.status == "queued",
                and_(AIImageGenerationJob.status == "failed", AIImageGenerationJob.attempt_count < MAX_ATTEMPTS),
                and_(AIImageGenerationJob.status == "running", AIImageGenerationJob.locked_at < stale_lock_cutoff),
            )
        )
        .order_by(AIImageGenerationJob.created_at, AIImageGenerationJob.id)
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    jobs = list(db.scalars(statement))
    job_ids: list[str] = []
    for job in jobs:
        job.status = "running"
        job.locked_at = now
        job.started_at = job.started_at or now
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
