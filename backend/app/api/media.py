from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.core.deps import get_current_auth
from app.core.enums import ImageGenerationMode, MediaSource
from app.db.session import get_db
from app.schemas.domain import AiRenderResponse, CreateAiRenderRequest, UploadMediaResponse
from app.services.image_generation import ImageGenerationClient, ImageGenerationRequest
from app.services.media import get_media_asset, save_generated_asset, save_svg_asset, save_upload
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
    db.commit()
    return serialize_media(asset)


@router.post("/api/media/ai-render", response_model=AiRenderResponse, status_code=status.HTTP_201_CREATED)
def render_ai_image(
    payload: CreateAiRenderRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    reference_asset = None
    reference_bytes = None
    reference_filename = None
    if payload.mode == ImageGenerationMode.REFERENCE:
        if not payload.reference_media_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing reference media")
        reference_asset = get_media_asset(db, family_id=membership.family_id, media_id=payload.reference_media_id)
        if reference_asset is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reference media not found")
        if reference_asset.source != MediaSource.UPLOAD:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Reference media must be an uploaded image")
        with open(reference_asset.file_path, "rb") as reference_file:
            reference_bytes = reference_file.read()
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
    try:
        client = ImageGenerationClient()
        result = (
            client.generate_from_reference(request)
            if payload.mode == ImageGenerationMode.REFERENCE
            else client.generate_from_text(request)
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    generated_title = payload.title or "culina-ai-image"
    generated_alt = f"{payload.title or '家庭厨房图片'} 的 AI 主图"
    if result.svg_markup is not None:
        generated_asset = save_svg_asset(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            title=generated_title,
            alt=generated_alt,
            svg_markup=result.svg_markup,
            source=MediaSource.AI,
            generation_mode=payload.mode,
            reference_media_id=reference_asset.id if reference_asset else None,
            style_key=result.style_key,
            prompt_version=result.prompt_version,
        )
    else:
        if result.binary_content is None:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="AI 主图生成失败")
        generated_asset = save_generated_asset(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            title=generated_title,
            alt=generated_alt,
            binary_payload=result.binary_content,
            file_extension=result.file_extension,
            source=MediaSource.AI,
            generation_mode=payload.mode,
            reference_media_id=reference_asset.id if reference_asset else None,
            style_key=result.style_key,
            prompt_version=result.prompt_version,
        )
    db.commit()
    return {
        "generated_asset": serialize_media(generated_asset),
        "reference_asset": serialize_media(reference_asset) if reference_asset else None,
        "style_key": result.style_key,
        "prompt_version": result.prompt_version,
        "generation_mode": payload.mode.value,
    }
