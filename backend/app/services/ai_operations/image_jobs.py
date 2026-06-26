from __future__ import annotations

from collections.abc import Iterable
from dataclasses import replace
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.images.generation import ImageGenerationRequest
from app.ai.images.jobs import enqueue_image_generation
from app.core.enums import ImageGenerationMode, MediaEntityType, MediaSource
from app.models.domain import AIImageGenerationJob, MediaAsset

AI_IMAGE_BIND_STRATEGY_APPEND = "append"


def _first_uploaded_reference_media_id(db: Session, *, family_id: str, media_ids: Iterable[str]) -> str | None:
    ids = [media_id for media_id in dict.fromkeys(media_ids) if media_id]
    if not ids:
        return None
    assets = list(
        db.scalars(
            select(MediaAsset).where(
                MediaAsset.family_id == family_id,
                MediaAsset.id.in_(ids),
                MediaAsset.source == MediaSource.UPLOAD,
            )
        )
    )
    assets_by_id = {asset.id: asset for asset in assets}
    for media_id in ids:
        if media_id in assets_by_id:
            return media_id
    return None


def enqueue_ai_entity_image_generation(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    request: ImageGenerationRequest,
    media_ids: Iterable[str],
    target_entity_type: str | None = None,
    target_entity_id: str | None = None,
) -> AIImageGenerationJob:
    reference_media_id = _first_uploaded_reference_media_id(db, family_id=family_id, media_ids=media_ids)
    request_mode = ImageGenerationMode.REFERENCE if reference_media_id else ImageGenerationMode.TEXT
    job = enqueue_image_generation(
        db,
        family_id=family_id,
        user_id=user_id,
        request=replace(request, mode=request_mode),
        reference_media_id=reference_media_id,
        target_entity_type=target_entity_type,
        target_entity_id=target_entity_id,
    )
    job.request_payload = {
        **job.request_payload,
        "bind_strategy": AI_IMAGE_BIND_STRATEGY_APPEND,
    }
    return job


def build_ingredient_image_request(payload: dict[str, Any]) -> ImageGenerationRequest:
    return ImageGenerationRequest(
        entity_type=MediaEntityType.INGREDIENT,
        mode=ImageGenerationMode.TEXT,
        title=str(payload.get("name") or ""),
        category=str(payload.get("category") or ""),
        notes=str(payload.get("notes") or ""),
    )


def build_food_image_request(payload: dict[str, Any]) -> ImageGenerationRequest:
    return ImageGenerationRequest(
        entity_type=MediaEntityType.FOOD,
        mode=ImageGenerationMode.TEXT,
        title=str(payload.get("name") or ""),
        category=str(payload.get("category") or ""),
        notes="\n".join([str(payload.get("notes") or ""), str(payload.get("routine_note") or "")]).strip(),
        tags=[
            *[str(item) for item in payload.get("flavor_tags") or [] if str(item)],
            *[str(item) for item in payload.get("scene_tags") or [] if str(item)],
        ],
        scene=str(payload.get("scene") or ""),
    )


def build_recipe_image_request(payload: dict[str, Any]) -> ImageGenerationRequest:
    ingredient_names = [
        str(item.get("ingredient_name") or "").strip()
        for item in payload.get("ingredient_items") or []
        if isinstance(item, dict) and str(item.get("ingredient_name") or "").strip()
    ]
    scene_tags = list(dict.fromkeys(str(tag).strip() for tag in payload.get("scene_tags") or [] if str(tag).strip()))
    title = str(payload.get("title") or "")
    return ImageGenerationRequest(
        entity_type=MediaEntityType.RECIPE,
        mode=ImageGenerationMode.TEXT,
        title=title,
        category="AI 生成菜谱",
        notes="\n".join(
            [
                str(payload.get("tips") or ""),
                "根据 AI 生成菜谱自动生成封面图，画面必须呈现成菜状态。",
                "构图要饱满均衡，主菜清晰自然，画面中保留真实餐桌、浅色餐具或相关食材细节，不要生成大片空白。",
            ]
        ).strip(),
        tags=scene_tags,
        scene=" / ".join(scene_tags) or "家庭日常",
        food_names=[title] if title else [],
        ingredient_names=ingredient_names,
    )
