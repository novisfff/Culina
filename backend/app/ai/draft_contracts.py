from __future__ import annotations

from dataclasses import dataclass

RECIPE_COOK_V1 = "recipe_cook_operation.v1"  # historical only; no longer accepted/generated
RECIPE_COOK_V2 = "recipe_cook_operation.v2"
RECIPE_COOK_ACCEPTED_VERSIONS = frozenset({RECIPE_COOK_V2})
RECIPE_COOK_GENERATED_VERSION = RECIPE_COOK_V2
RECIPE_COOK_PROJECTION_VERSION = 1

# Capability header may still advertise historical tokens for older clients.
KNOWN_DRAFT_CONTRACTS = frozenset({RECIPE_COOK_V1, RECIPE_COOK_V2})

AI_DRAFT_CONTRACTS_HEADER = "X-Culina-AI-Draft-Contracts"


class ClientContractUpgradeRequired(Exception):
    """Client cannot generate or continue with the required draft contract version."""

    code = "client_contract_upgrade_required"
    default_message = "当前应用版本不支持新的做菜确认，请刷新并更新后继续。原草稿仍会安全保留。"

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.default_message)
        self.message = message or self.default_message

    def to_detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


@dataclass(frozen=True, slots=True)
class DraftContractCapabilities:
    values: frozenset[str]

    @property
    def recipe_cook_versions(self) -> frozenset[str]:
        return frozenset(value for value in self.values if value in RECIPE_COOK_ACCEPTED_VERSIONS)


def parse_draft_contract_capabilities(raw: str | None) -> DraftContractCapabilities:
    values = frozenset(
        token.strip()
        for token in (raw or "").split(",")
        if token.strip() in KNOWN_DRAFT_CONTRACTS
    )
    return DraftContractCapabilities(values=values)


def select_recipe_cook_generation_version(
    capabilities: DraftContractCapabilities,
    *,
    generated_version: str,
) -> str:
    if generated_version != RECIPE_COOK_V2:
        raise ClientContractUpgradeRequired()
    if RECIPE_COOK_V2 in capabilities.recipe_cook_versions:
        return RECIPE_COOK_V2
    raise ClientContractUpgradeRequired()


def accepted_recipe_cook_versions() -> set[str]:
    return set(RECIPE_COOK_ACCEPTED_VERSIONS)


def generated_recipe_cook_version() -> str:
    return RECIPE_COOK_GENERATED_VERSION


def recipe_cook_contracts_probe() -> dict[str, object]:
    return {
        "accepted_versions": sorted(RECIPE_COOK_ACCEPTED_VERSIONS),
        "generated_version": RECIPE_COOK_GENERATED_VERSION,
        "projection_version": RECIPE_COOK_PROJECTION_VERSION,
    }


def require_recipe_cook_schema_version(payload: dict) -> str:
    schema_version = str(payload.get("schemaVersion") or payload.get("schema_version") or "").strip()
    if not schema_version:
        schema_version = RECIPE_COOK_GENERATED_VERSION
    if schema_version not in RECIPE_COOK_ACCEPTED_VERSIONS:
        raise ValueError(f"不支持的做菜草稿版本: {schema_version}")
    return schema_version
