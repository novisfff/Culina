from __future__ import annotations

from typing import Any

from app.schemas.ai import AIResultCardDTO


def validate_result_cards(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    validated: list[dict[str, Any]] = []
    for card in cards:
        validated.append(AIResultCardDTO.model_validate(card).model_dump(mode="json"))
    return validated
