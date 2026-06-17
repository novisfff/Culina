from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.core.enums import ImageGenerationMode, MealType, MediaEntityType, MediaSource

AiImageTargetEntityType = Literal["food", "ingredient", "recipe", "food_scene", "meal_log", "user", "family"]
AiImageJobStatus = Literal["queued", "running", "succeeded", "failed"]
AiImageBindStatus = Literal["pending", "bound", "skipped", "unbound"]


class MediaVariantOut(BaseModel):
    url: str
    width: int
    height: int
    content_type: str
    byte_size: int


class MediaVariantsOut(BaseModel):
    thumb: MediaVariantOut | None = None
    card: MediaVariantOut | None = None
    large: MediaVariantOut | None = None


class MediaAssetOut(BaseModel):
    id: str
    name: str
    url: str
    source: MediaSource
    alt: str
    generation_mode: ImageGenerationMode | None = None
    reference_media_id: str | None = None
    style_key: str | None = None
    prompt_version: str | None = None
    variants: MediaVariantsOut | None = None
    created_at: datetime
    created_by: str | None = None


class UploadMediaResponse(MediaAssetOut):
    pass


class UploadMediaMetadata(BaseModel):
    source: MediaSource = MediaSource.UPLOAD
    alt: str = ""


class CreateAiRenderRequest(BaseModel):
    mode: ImageGenerationMode
    entity_type: MediaEntityType
    reference_media_id: str | None = None
    title: str = ""
    category: str = ""
    notes: str = ""
    tags: list[str] = Field(default_factory=list)
    scene: str = ""
    meal_type: MealType | None = None
    food_names: list[str] = Field(default_factory=list)
    ingredient_names: list[str] = Field(default_factory=list)
    size: str = ""
    target_entity_type: AiImageTargetEntityType | None = None
    target_entity_id: str | None = None
    replace_anchor_media_id: str | None = None


class AiRenderResponse(BaseModel):
    job_id: str | None = None
    status: AiImageJobStatus = "succeeded"
    error: str | None = None
    generated_asset: MediaAssetOut | None = None
    reference_asset: MediaAssetOut | None = None
    style_key: str | None = None
    prompt_version: str | None = None
    generation_mode: Literal["reference", "text"]
    target_entity_type: AiImageTargetEntityType | None = None
    target_entity_id: str | None = None
    target_entity_name: str | None = None
    bind_status: AiImageBindStatus | None = None
