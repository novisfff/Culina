from __future__ import annotations

from typing import Annotated

from fastapi import Header, Response

from app.ai.draft_contracts import (
    AI_DRAFT_CONTRACTS_HEADER,
    DraftContractCapabilities,
    parse_draft_contract_capabilities,
)


def get_ai_draft_contract_capabilities(
    value: Annotated[str | None, Header(alias=AI_DRAFT_CONTRACTS_HEADER)] = None,
) -> DraftContractCapabilities:
    return parse_draft_contract_capabilities(value)


def set_ai_client_aware_headers(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Vary"] = AI_DRAFT_CONTRACTS_HEADER
