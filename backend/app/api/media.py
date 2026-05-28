from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.core.deps import get_current_auth
from app.core.enums import ImageGenerationMode, MediaSource
from app.db.session import get_db
from app.db.transactions import commit_session
from app.schemas.media import AiRenderResponse, CreateAiRenderRequest, UploadMediaResponse
from app.ai.images.generation import ImageGenerationRequest, ImageGenerationResult
from app.ai.images.jobs import (
    claim_image_generation_job_result,
    enqueue_image_generation,
    get_image_generation_job,
    mark_image_generation_job_finalized,
    release_image_generation_job_result,
)
from app.services.media import delete_media_file, get_media_asset, read_media_object, save_generated_asset, save_svg_asset, save_upload
from app.services.serializers import serialize_media

router = APIRouter(tags=["media"])


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


def _save_render_result(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: CreateAiRenderRequest,
    result: ImageGenerationResult,
    reference_media_id: str | None,
) -> dict:
    generated_title = payload.title or "culina-ai-image"
    generated_alt = f"{payload.title or '家庭厨房图片'} 的 AI 主图"
    if result.svg_markup is not None:
        generated_asset = save_svg_asset(
            db,
            family_id=family_id,
            user_id=user_id,
            title=generated_title,
            alt=generated_alt,
            svg_markup=result.svg_markup,
            source=MediaSource.AI,
            generation_mode=payload.mode,
            reference_media_id=reference_media_id,
            style_key=result.style_key,
            prompt_version=result.prompt_version,
        )
    else:
        if result.binary_content is None:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="AI 主图生成失败")
        generated_asset = save_generated_asset(
            db,
            family_id=family_id,
            user_id=user_id,
            title=generated_title,
            alt=generated_alt,
            binary_payload=result.binary_content,
            file_extension=result.file_extension,
            source=MediaSource.AI,
            generation_mode=payload.mode,
            reference_media_id=reference_media_id,
            style_key=result.style_key,
            prompt_version=result.prompt_version,
        )
    commit_session(db, on_error=lambda: delete_media_file(generated_asset))
    return serialize_media(generated_asset)


def _render_job_response(job_id: str, *, db: Session, family_id: str, user_id: str) -> dict:
    job = get_image_generation_job(job_id)
    if job is None or job.family_id != family_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="AI image render job not found")

    reference_asset = get_media_asset(db, family_id=family_id, media_id=job.reference_media_id) if job.reference_media_id else None
    generated_asset = None
    style_key = None
    prompt_version = None

    if job.status == "succeeded":
        if job.finalized_asset_id:
            finalized_asset = get_media_asset(db, family_id=family_id, media_id=job.finalized_asset_id)
            if finalized_asset is not None:
                generated_asset = serialize_media(finalized_asset)
                style_key = finalized_asset.style_key
                prompt_version = finalized_asset.prompt_version
        else:
            claimed_result = claim_image_generation_job_result(job.id)
            if claimed_result is not None:
                try:
                    generated_asset = _save_render_result(
                        db,
                        family_id=family_id,
                        user_id=user_id,
                        payload=CreateAiRenderRequest(
                            mode=job.request.mode,
                            entity_type=job.request.entity_type,
                            reference_media_id=job.reference_media_id,
                            title=job.request.title,
                            category=job.request.category,
                            notes=job.request.notes,
                            tags=job.request.tags,
                            scene=job.request.scene,
                            meal_type=job.request.meal_type,
                            food_names=job.request.food_names,
                            ingredient_names=job.request.ingredient_names,
                            size=job.request.size,
                        ),
                        result=claimed_result,
                        reference_media_id=job.reference_media_id,
                    )
                except Exception:
                    release_image_generation_job_result(job.id)
                    raise
                mark_image_generation_job_finalized(job.id, generated_asset["id"])
                style_key = claimed_result.style_key
                prompt_version = claimed_result.prompt_version

    return {
        "job_id": job.id,
        "status": job.status,
        "error": job.error,
        "generated_asset": generated_asset,
        "reference_asset": serialize_media(reference_asset) if reference_asset else None,
        "style_key": style_key,
        "prompt_version": prompt_version,
        "generation_mode": job.request.mode.value,
    }


@router.post("/api/media/ai-render", response_model=AiRenderResponse, status_code=status.HTTP_202_ACCEPTED)
def render_ai_image(
    payload: CreateAiRenderRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    request, reference_asset = _build_image_generation_request(payload=payload, family_id=membership.family_id, db=db)
    job = enqueue_image_generation(
        family_id=membership.family_id,
        user_id=user.id,
        request=request,
        reference_media_id=payload.reference_media_id,
    )
    return {
        "job_id": job.id,
        "status": job.status,
        "error": None,
        "generated_asset": None,
        "reference_asset": reference_asset,
        "style_key": None,
        "prompt_version": None,
        "generation_mode": payload.mode.value,
    }


@router.get("/api/media/ai-render/{job_id}", response_model=AiRenderResponse)
def get_ai_image_render_job(
    job_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    return _render_job_response(job_id, db=db, family_id=membership.family_id, user_id=user.id)
