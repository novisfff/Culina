from __future__ import annotations

from sqlalchemy import UniqueConstraint

from app.db.base import Base


EXPECTED_TABLES = {
    "family_model_settings",
    "family_model_provider_profiles",
    "family_model_provider_profile_versions",
    "family_model_secret_versions",
    "family_model_config_drafts",
    "family_model_config_revisions",
    "family_model_capability_bindings",
    "family_search_profiles",
    "family_search_profile_documents",
    "family_model_operation_receipts",
    "family_model_resource_operations",
}


def unique_columns(table, name: str) -> set[str]:
    constraint = next(
        item
        for item in table.constraints
        if isinstance(item, UniqueConstraint) and item.name == name
    )
    return {column.name for column in constraint.columns}


def test_family_model_settings_metadata_contract() -> None:
    assert EXPECTED_TABLES <= set(Base.metadata.tables)

    settings = Base.metadata.tables["family_model_settings"]
    assert settings.c.active_config_revision_id.nullable is True
    assert settings.c.active_price_version_id.nullable is True
    assert settings.c.active_search_profile_id.nullable is True
    assert settings.c.version_number.nullable is False

    binding = Base.metadata.tables["family_model_capability_bindings"]
    assert unique_columns(binding, "uq_family_model_binding_revision_capability_variant") == {
        "config_revision_id",
        "capability",
        "variant_key",
    }

    revision = Base.metadata.tables["family_model_config_revisions"]
    assert unique_columns(revision, "uq_family_model_config_revision_family_checksum") == {
        "family_id",
        "config_checksum",
    }

    receipt = Base.metadata.tables["family_model_operation_receipts"]
    assert unique_columns(receipt, "uq_family_model_operation_key") == {
        "family_id",
        "operation",
        "idempotency_key",
    }
    assert {
        "request_fingerprint",
        "request_fingerprint_key_id",
        "status",
        "response_json",
    } <= set(receipt.c.keys())

    resource_operation = Base.metadata.tables["family_model_resource_operations"]
    assert unique_columns(resource_operation, "uq_family_model_resource_operation") == {
        "operation_type",
        "resource_key",
    }
    assert not resource_operation.c.family_id_snapshot.foreign_keys


def test_price_and_runtime_snapshot_metadata_contract() -> None:
    version = Base.metadata.tables["model_usage_price_versions"]
    assert {"family_id", "config_revision_id", "search_profile_id", "purpose"} <= set(
        version.c.keys()
    )

    profile_document = Base.metadata.tables["family_search_profile_documents"]
    assert unique_columns(profile_document, "uq_family_search_profile_document") == {
        "family_id",
        "search_profile_id",
        "search_document_id",
    }

    reservation = Base.metadata.tables["model_usage_reservations"]
    assert {
        "config_revision_id",
        "provider_profile_id",
        "provider_profile_version_id",
        "credential_secret_version_id",
        "search_profile_id",
    } <= set(reservation.c.keys())

    exchange = Base.metadata.tables["ai_run_llm_exchanges"]
    assert {
        "config_revision_id",
        "provider_profile_id",
        "provider_profile_version_id",
    } <= set(exchange.c.keys())
