from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.runtime.provider import ProviderImageInput
from app.core.utils import create_id
from app.models.domain import MediaAsset
from app.services.serializers import serialize_media


def normalize_chat_attachments(attachments: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen_media_ids: set[str] = set()
    for attachment in attachments or []:
        if not isinstance(attachment, dict):
            raise ValueError("附件格式不正确")
        attachment_type = str(attachment.get("type") or "image")
        if attachment_type != "image":
            raise ValueError("当前仅支持图片附件")
        media_id = str(attachment.get("media_id") or attachment.get("mediaId") or "").strip()
        if not media_id:
            raise ValueError("图片附件缺少 media_id")
        if media_id in seen_media_ids:
            continue
        seen_media_ids.add(media_id)
        normalized.append(
            {
                "type": "image",
                "media_id": media_id,
                "client_attachment_id": str(
                    attachment.get("client_attachment_id") or attachment.get("clientAttachmentId") or ""
                ).strip()
                or None,
            }
        )
    if len(normalized) > 6:
        raise ValueError("单次最多上传 6 张图片")
    return normalized


def attachment_summaries(assets: list[MediaAsset]) -> list[dict[str, Any]]:
    return [
        {
            "type": "image",
            "mediaId": asset.id,
            "name": asset.name,
            "alt": asset.alt,
            "source": "current_message",
        }
        for asset in assets
    ]


def build_user_message_parts(prompt: str, attachment_assets: list[MediaAsset]) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    if prompt.strip():
        parts.append({"id": create_id("ai_part"), "type": "text", "text": prompt.strip()})
    for asset in attachment_assets:
        parts.append(
            {
                "id": create_id("ai_part"),
                "type": "image",
                "image": {
                    "media_id": asset.id,
                    "asset": serialize_media(asset),
                    "alt": asset.alt or asset.name,
                },
            }
        )
    return parts


def provider_images_for_attachments(
    *,
    db: Session,
    family_id: str,
    attachments: list[dict[str, Any]],
    provider_supports_vision: bool,
    read_media_object: Callable[[MediaAsset], tuple[bytes, str]],
) -> list[ProviderImageInput]:
    if not attachments:
        return []
    if not provider_supports_vision:
        raise ValueError("当前 AI 模型暂不支持图片识别，请切换支持视觉输入的模型后再试。")

    media_ids = [str(item.get("mediaId") or item.get("media_id") or "").strip() for item in attachments]
    assets = list(
        db.scalars(
            select(MediaAsset).where(
                MediaAsset.family_id == family_id,
                MediaAsset.id.in_(media_ids),
            )
        )
    )
    assets_by_id = {asset.id: asset for asset in assets}
    images: list[ProviderImageInput] = []
    for media_id in media_ids:
        asset = assets_by_id.get(media_id)
        if asset is None:
            raise LookupError("图片附件不存在或不属于当前家庭")
        payload, content_type = read_media_object(asset)
        images.append(
            ProviderImageInput(
                media_id=asset.id,
                content_type=content_type,
                payload=payload,
                filename=asset.name,
            )
        )
    return images
