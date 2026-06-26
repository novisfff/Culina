from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.deps import get_current_auth
from app.core.enums import ImageGenerationMode, MediaSource
from app.db.session import get_db
from app.db.transactions import commit_session
from app.schemas.media import AiRenderResponse, CreateAiRenderRequest, UploadMediaResponse
from app.ai.images.generation import ImageGenerationRequest
from app.ai.images.jobs import (
    attach_image_generation_job_to_entity,
    enqueue_image_generation,
    get_image_generation_job,
    list_active_image_generation_jobs,
    retry_failed_image_generation_job,
)
from app.services.media import (
    delete_media_file,
    get_media_asset,
    read_media_object,
    read_media_object_by_key,
    save_upload,
)
from app.services.serializers import serialize_media
from app.models.domain import AIImageGenerationJob, Family, Food, FoodScene, Ingredient, MealLog, Membership, Recipe, User

router = APIRouter(tags=["media"])

MEAL_TYPE_LABELS = {
    "breakfast": "早餐",
    "lunch": "午餐",
    "dinner": "晚餐",
    "snack": "加餐",
}


@router.post("/api/media/upload", response_model=UploadMediaResponse, status_code=status.HTTP_201_CREATED)
def upload_media(
    file: UploadFile = File(...),
    source: MediaSource = Form(MediaSource.UPLOAD),
    alt: str = Form(""),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    asset = save_upload(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        upload=file,
        source=source,
        alt=alt,
    )
    commit_session(db, on_error=lambda: delete_media_file(asset))
    return serialize_media(asset)


def _build_image_generation_request(
    *,
    payload: CreateAiRenderRequest,
    family_id: str,
    db: Session,
) -> tuple[ImageGenerationRequest, dict | None]:
    reference_asset = None
    reference_bytes = None
    reference_filename = None
    if payload.mode == ImageGenerationMode.REFERENCE:
        if not payload.reference_media_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing reference media")
        reference_asset = get_media_asset(db, family_id=family_id, media_id=payload.reference_media_id)
        if reference_asset is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reference media not found")
        if reference_asset.source != MediaSource.UPLOAD:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Reference media must be an uploaded image")
        reference_bytes = read_media_object(reference_asset)
        reference_filename = reference_asset.name

    request = ImageGenerationRequest(
        entity_type=payload.entity_type,
        mode=payload.mode,
        title=payload.title,
        category=payload.category,
        notes=payload.notes,
        tags=payload.tags,
        scene=payload.scene,
        meal_type=payload.meal_type,
        food_names=payload.food_names,
        ingredient_names=payload.ingredient_names,
        size=payload.size,
        reference_image_bytes=reference_bytes,
        reference_filename=reference_filename,
    )
    return request, serialize_media(reference_asset) if reference_asset else None


def _resolve_job_target_name(job: AIImageGenerationJob, *, db: Session, family_id: str) -> str | None:
    request_payload = job.request_payload or {}
    fallback = str(request_payload.get("title") or "").strip() or None
    if not job.target_entity_type or not job.target_entity_id:
        return fallback

    entity_type = job.target_entity_type
    entity_id = job.target_entity_id
    if entity_type == "food":
        return db.scalar(select(Food.name).where(Food.family_id == family_id, Food.id == entity_id)) or fallback
    if entity_type == "ingredient":
        return db.scalar(select(Ingredient.name).where(Ingredient.family_id == family_id, Ingredient.id == entity_id)) or fallback
    if entity_type == "recipe":
        return db.scalar(select(Recipe.title).where(Recipe.family_id == family_id, Recipe.id == entity_id)) or fallback
    if entity_type == "food_scene":
        return db.scalar(select(FoodScene.name).where(FoodScene.family_id == family_id, FoodScene.id == entity_id)) or fallback
    if entity_type == "family":
        return db.scalar(select(Family.name).where(Family.id == family_id, Family.id == entity_id)) or fallback
    if entity_type == "user":
        return db.scalar(
            select(User.display_name)
            .join(Membership, Membership.user_id == User.id)
            .where(Membership.family_id == family_id, User.id == entity_id)
        ) or fallback
    if entity_type == "meal_log":
        meal_log = db.scalar(select(MealLog).where(MealLog.family_id == family_id, MealLog.id == entity_id))
        if meal_log:
            meal_type = getattr(meal_log.meal_type, "value", str(meal_log.meal_type))
            return f"{meal_log.date.isoformat()} {MEAL_TYPE_LABELS.get(meal_type, '餐食')}记录"
    return fallback


def _render_job_response(job: AIImageGenerationJob, *, db: Session, family_id: str) -> dict:
    reference_asset = get_media_asset(db, family_id=family_id, media_id=job.reference_media_id) if job.reference_media_id else None
    generated_asset_model = get_media_asset(db, family_id=family_id, media_id=job.generated_media_id) if job.generated_media_id else None
    request_payload = job.request_payload or {}
    return {
        "job_id": job.id,
        "status": job.status,
        "error": job.error,
        "generated_asset": serialize_media(generated_asset_model) if generated_asset_model else None,
        "reference_asset": serialize_media(reference_asset) if reference_asset else None,
        "style_key": generated_asset_model.style_key if generated_asset_model else None,
        "prompt_version": generated_asset_model.prompt_version if generated_asset_model else None,
        "generation_mode": str(request_payload.get("mode") or ImageGenerationMode.TEXT.value),
        "target_entity_type": job.target_entity_type,
        "target_entity_id": job.target_entity_id,
        "target_entity_name": _resolve_job_target_name(job, db=db, family_id=family_id),
        "bind_status": job.bind_status,
    }


@router.post("/api/media/ai-render", response_model=AiRenderResponse, status_code=status.HTTP_202_ACCEPTED)
def render_ai_image(
    payload: CreateAiRenderRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    if (payload.target_entity_type and not payload.target_entity_id) or (payload.target_entity_id and not payload.target_entity_type):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Image render target is incomplete")
    request, reference_asset = _build_image_generation_request(payload=payload, family_id=membership.family_id, db=db)
    job = enqueue_image_generation(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        request=request,
        reference_media_id=payload.reference_media_id,
        target_entity_type=payload.target_entity_type,
        target_entity_id=payload.target_entity_id,
        replace_anchor_media_id=payload.replace_anchor_media_id,
    )
    if payload.target_entity_type and payload.target_entity_id:
        try:
            attach_image_generation_job_to_entity(
                db,
                family_id=membership.family_id,
                job_id=job.id,
                entity_type=payload.target_entity_type,
                entity_id=payload.target_entity_id,
                replace_anchor_media_id=payload.replace_anchor_media_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    commit_session(db)
    return {
        "job_id": job.id,
        "status": job.status,
        "error": None,
        "generated_asset": None,
        "reference_asset": reference_asset,
        "style_key": None,
        "prompt_version": None,
        "generation_mode": payload.mode.value,
        "target_entity_type": job.target_entity_type,
        "target_entity_id": job.target_entity_id,
        "target_entity_name": _resolve_job_target_name(job, db=db, family_id=membership.family_id),
        "bind_status": job.bind_status,
    }


@router.get("/api/media/ai-render/active", response_model=list[AiRenderResponse])
def list_active_ai_image_render_jobs(
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> list[dict]:
    _, membership = auth
    return [_render_job_response(job, db=db, family_id=membership.family_id) for job in list_active_image_generation_jobs(db, family_id=membership.family_id)]


@router.get("/api/media/ai-render/{job_id}", response_model=AiRenderResponse)
def get_ai_image_render_job(
    job_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    job = get_image_generation_job(db, family_id=membership.family_id, job_id=job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="AI image render job not found")
    return _render_job_response(job, db=db, family_id=membership.family_id)


@router.post("/api/media/ai-render/{job_id}/retry", response_model=AiRenderResponse, status_code=status.HTTP_202_ACCEPTED)
def retry_ai_image_render_job(
    job_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    try:
        job = retry_failed_image_generation_job(db, family_id=membership.family_id, job_id=job_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="AI image render job not found")
    commit_session(db)
    return _render_job_response(job, db=db, family_id=membership.family_id)


@router.get("/media/{object_key:path}")
def get_media_object(object_key: str) -> Response:
    payload, content_type = read_media_object_by_key(object_key)
    return Response(content=payload, media_type=content_type)
