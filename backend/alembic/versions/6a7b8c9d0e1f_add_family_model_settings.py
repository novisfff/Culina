"""add family managed model settings

Revision ID: 6a7b8c9d0e1f
Revises: 5f6a7b8c9d0e
Create Date: 2026-08-18 23:00:00.000000

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "6a7b8c9d0e1f"
down_revision = "5f6a7b8c9d0e"
branch_labels = None
depends_on = None


def _create_family_model_identity_tables() -> None:
    op.create_table(
        "family_model_provider_profiles",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("display_name", sa.String(length=160), nullable=False),
        sa.Column("credential_scope_checksum", sa.String(length=64), nullable=False),
        sa.Column("current_profile_version_id", sa.String(length=64), nullable=True),
        sa.Column("current_secret_version_id", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "family_id", "display_name", name="uq_family_model_provider_profile_display_name"
        ),
    )
    op.create_index(
        "ix_family_model_provider_profile_family_status",
        "family_model_provider_profiles",
        ["family_id", "status"],
        unique=False,
    )

    op.create_table(
        "family_model_provider_profile_versions",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("profile_id", sa.String(length=64), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("adapter_kind", sa.String(length=64), nullable=False),
        sa.Column("auth_mode", sa.String(length=32), nullable=False),
        sa.Column("api_base_url", sa.String(length=2048), nullable=False),
        sa.Column("websocket_base_url", sa.String(length=2048), nullable=True),
        sa.Column("options_json", sa.JSON(), nullable=False),
        sa.Column("credential_scope_checksum", sa.String(length=64), nullable=False),
        sa.Column("endpoint_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["profile_id"], ["family_model_provider_profiles.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("profile_id", "version_number", name="uq_family_model_profile_version_number"),
    )
    op.create_index(
        "ix_family_model_profile_version_family_profile",
        "family_model_provider_profile_versions",
        ["family_id", "profile_id"],
        unique=False,
    )

    op.create_table(
        "family_model_secret_versions",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("profile_id", sa.String(length=64), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("encryption_key_id", sa.String(length=120), nullable=False),
        sa.Column("nonce", sa.LargeBinary(), nullable=True),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=True),
        sa.Column("auth_tag", sa.LargeBinary(), nullable=True),
        sa.Column("secret_fingerprint", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("destroyed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["profile_id"], ["family_model_provider_profiles.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("profile_id", "version_number", name="uq_family_model_secret_version_number"),
    )
    op.create_index(
        "ix_family_model_secret_version_family_profile",
        "family_model_secret_versions",
        ["family_id", "profile_id"],
        unique=False,
    )

    op.create_table(
        "family_search_profiles",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("base_search_profile_id", sa.String(length=64), nullable=True),
        sa.Column("provider_profile_id", sa.String(length=64), nullable=False),
        sa.Column("provider_profile_version_id", sa.String(length=64), nullable=False),
        sa.Column("adapter_kind", sa.String(length=64), nullable=False),
        sa.Column("embedding_model", sa.String(length=160), nullable=False),
        sa.Column("dimensions", sa.Integer(), nullable=False),
        sa.Column("distance", sa.String(length=32), nullable=False),
        sa.Column("document_builder_version", sa.String(length=64), nullable=False),
        sa.Column("index_identity_checksum", sa.String(length=64), nullable=False),
        sa.Column("qdrant_collection", sa.String(length=255), nullable=False),
        sa.Column("candidate_price_version_id", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("total_documents", sa.Integer(), nullable=False),
        sa.Column("indexed_documents", sa.Integer(), nullable=False),
        sa.Column("failed_documents", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["base_search_profile_id"],
            ["family_search_profiles.id"],
            ondelete="RESTRICT",
            name="fk_family_search_profile_base",
        ),
        sa.ForeignKeyConstraint(
            ["provider_profile_id"], ["family_model_provider_profiles.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["provider_profile_version_id"],
            ["family_model_provider_profile_versions.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["candidate_price_version_id"],
            ["model_usage_price_versions.id"],
            ondelete="RESTRICT",
            name="fk_family_search_profile_candidate_price",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("qdrant_collection", name="uq_family_search_profile_collection"),
        sa.UniqueConstraint(
            "family_id", "index_identity_checksum", name="uq_family_search_profile_identity"
        ),
    )
    op.create_index(
        "ix_family_search_profile_family_status",
        "family_search_profiles",
        ["family_id", "status"],
        unique=False,
    )

    op.create_table(
        "family_model_config_revisions",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("base_revision_id", sa.String(length=64), nullable=True),
        sa.Column("config_checksum", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("search_profile_id", sa.String(length=64), nullable=True),
        sa.Column("change_note", sa.Text(), nullable=False),
        sa.Column("published_by", sa.String(length=64), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["base_revision_id"], ["family_model_config_revisions.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["search_profile_id"], ["family_search_profiles.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "family_id",
            "config_checksum",
            name="uq_family_model_config_revision_family_checksum",
        ),
        sa.UniqueConstraint(
            "family_id", "version_number", name="uq_family_model_config_revision_number"
        ),
    )
    op.create_index(
        "ix_family_model_config_revision_family_status",
        "family_model_config_revisions",
        ["family_id", "status"],
        unique=False,
    )

    op.create_table(
        "family_model_config_drafts",
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("base_config_revision_id", sa.String(length=64), nullable=True),
        sa.Column("draft_version_number", sa.Integer(), nullable=False),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("validation_status", sa.String(length=32), nullable=False),
        sa.Column("validation_errors_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(
            ["base_config_revision_id"], ["family_model_config_revisions.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("family_id"),
    )

    op.create_table(
        "family_model_capability_bindings",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("config_revision_id", sa.String(length=64), nullable=False),
        sa.Column("capability", sa.String(length=32), nullable=False),
        sa.Column("variant_key", sa.String(length=120), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("provider_profile_id", sa.String(length=64), nullable=True),
        sa.Column("provider_profile_version_id", sa.String(length=64), nullable=True),
        sa.Column("requested_model", sa.String(length=160), nullable=False),
        sa.Column("options_json", sa.JSON(), nullable=False),
        sa.Column("billing_scheme_key", sa.String(length=160), nullable=False),
        sa.Column("identity_checksum", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["config_revision_id"], ["family_model_config_revisions.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["provider_profile_id"], ["family_model_provider_profiles.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["provider_profile_version_id"],
            ["family_model_provider_profile_versions.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "config_revision_id",
            "capability",
            "variant_key",
            name="uq_family_model_binding_revision_capability_variant",
        ),
    )
    op.create_index(
        "ix_family_model_binding_family_revision",
        "family_model_capability_bindings",
        ["family_id", "config_revision_id"],
        unique=False,
    )

    op.create_table(
        "family_search_profile_documents",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("search_profile_id", sa.String(length=64), nullable=False),
        sa.Column("search_document_id", sa.String(length=64), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("vector_json", sa.JSON(), nullable=True),
        sa.Column("vector_dimensions", sa.Integer(), nullable=True),
        sa.Column("error_code", sa.String(length=120), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("indexed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["search_document_id"], ["search_documents.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["search_profile_id"], ["family_search_profiles.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "family_id",
            "search_profile_id",
            "search_document_id",
            name="uq_family_search_profile_document",
        ),
    )
    op.create_index(
        "ix_family_search_profile_document_status",
        "family_search_profile_documents",
        ["family_id", "search_profile_id", "status"],
        unique=False,
    )

    op.create_table(
        "family_model_operation_receipts",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("operation", sa.String(length=120), nullable=False),
        sa.Column("idempotency_key", sa.String(length=255), nullable=False),
        sa.Column("request_fingerprint", sa.String(length=128), nullable=False),
        sa.Column("request_fingerprint_key_id", sa.String(length=120), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("result_id", sa.String(length=64), nullable=True),
        sa.Column("response_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "family_id", "operation", "idempotency_key", name="uq_family_model_operation_key"
        ),
    )
    op.create_index(
        "ix_family_model_operation_receipt_family_status",
        "family_model_operation_receipts",
        ["family_id", "status"],
        unique=False,
    )

    op.create_table(
        "family_model_resource_operations",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("operation_type", sa.String(length=64), nullable=False),
        sa.Column("resource_key", sa.String(length=255), nullable=False),
        sa.Column("family_id_snapshot", sa.String(length=64), nullable=False),
        sa.Column("search_profile_id_snapshot", sa.String(length=64), nullable=True),
        sa.Column("qdrant_collection_snapshot", sa.String(length=255), nullable=False),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_owner", sa.String(length=160), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_code", sa.String(length=120), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("attempt_count >= 0", name="ck_family_model_resource_operation_attempt_count"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "operation_type", "resource_key", name="uq_family_model_resource_operation"
        ),
    )
    op.create_index(
        "ix_family_model_resource_operation_status_available",
        "family_model_resource_operations",
        ["status", "available_at"],
        unique=False,
    )


def _extend_model_usage_and_runtime_snapshot_tables() -> None:
    op.drop_constraint(
        "uq_model_usage_price_manifest_checksum", "model_usage_price_versions", type_="unique"
    )
    op.add_column("model_usage_price_versions", sa.Column("family_id", sa.String(length=64), nullable=True))
    op.add_column(
        "model_usage_price_versions", sa.Column("config_revision_id", sa.String(length=64), nullable=True)
    )
    op.add_column(
        "model_usage_price_versions", sa.Column("search_profile_id", sa.String(length=64), nullable=True)
    )
    op.add_column(
        "model_usage_price_versions", sa.Column("base_price_version_id", sa.String(length=64), nullable=True)
    )
    op.add_column(
        "model_usage_price_versions",
        sa.Column("purpose", sa.String(length=40), nullable=False, server_default="legacy_global"),
    )
    op.add_column("model_usage_price_versions", sa.Column("published_by", sa.String(length=64), nullable=True))
    op.execute("UPDATE model_usage_price_versions SET purpose='legacy_global' WHERE purpose IS NULL")
    op.alter_column(
        "model_usage_price_versions",
        "purpose",
        existing_type=sa.String(length=40),
        existing_nullable=False,
        server_default=None,
    )
    op.create_foreign_key(
        "fk_model_usage_price_version_family",
        "model_usage_price_versions",
        "families",
        ["family_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_model_usage_price_version_config_revision",
        "model_usage_price_versions",
        "family_model_config_revisions",
        ["config_revision_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_model_usage_price_version_search_profile",
        "model_usage_price_versions",
        "family_search_profiles",
        ["search_profile_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_model_usage_price_version_base",
        "model_usage_price_versions",
        "model_usage_price_versions",
        ["base_price_version_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_check_constraint(
        "ck_model_usage_price_version_purpose_owner",
        "model_usage_price_versions",
        "(purpose = 'legacy_global' AND family_id IS NULL AND config_revision_id IS NULL AND search_profile_id IS NULL) "
        "OR (purpose = 'active' AND family_id IS NOT NULL AND config_revision_id IS NOT NULL AND search_profile_id IS NULL) "
        "OR (purpose = 'search_rebuild_candidate' AND family_id IS NOT NULL AND config_revision_id IS NULL AND search_profile_id IS NOT NULL)",
    )

    for table_name, columns in {
        "model_usage_reservations": (
            "config_revision_id",
            "provider_profile_id",
            "provider_profile_version_id",
            "credential_secret_version_id",
            "search_profile_id",
        ),
        "model_usage_events": (
            "config_revision_id",
            "provider_profile_id",
            "provider_profile_version_id",
            "search_profile_id",
        ),
    }.items():
        for column_name in columns:
            op.add_column(table_name, sa.Column(column_name, sa.String(length=64), nullable=True))

    for table_name in ("model_usage_reservations", "model_usage_events"):
        op.create_foreign_key(
            f"fk_{table_name}_config_revision",
            table_name,
            "family_model_config_revisions",
            ["config_revision_id"],
            ["id"],
            ondelete="RESTRICT",
        )
        op.create_foreign_key(
            f"fk_{table_name}_provider_profile",
            table_name,
            "family_model_provider_profiles",
            ["provider_profile_id"],
            ["id"],
            ondelete="RESTRICT",
        )
        op.create_foreign_key(
            f"fk_{table_name}_provider_profile_version",
            table_name,
            "family_model_provider_profile_versions",
            ["provider_profile_version_id"],
            ["id"],
            ondelete="RESTRICT",
        )
        op.create_foreign_key(
            f"fk_{table_name}_search_profile",
            table_name,
            "family_search_profiles",
            ["search_profile_id"],
            ["id"],
            ondelete="RESTRICT",
        )
    op.create_foreign_key(
        "fk_model_usage_reservations_credential_secret",
        "model_usage_reservations",
        "family_model_secret_versions",
        ["credential_secret_version_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    for table_name, columns in {
        "ai_agent_runs": ("config_revision_id",),
        "ai_image_generation_jobs": ("config_revision_id",),
        "search_index_jobs": ("search_profile_id", "config_revision_id", "price_version_id"),
        "ai_run_llm_exchanges": (
            "config_revision_id",
            "provider_profile_id",
            "provider_profile_version_id",
        ),
    }.items():
        for column_name in columns:
            op.add_column(table_name, sa.Column(column_name, sa.String(length=64), nullable=True))

    for table_name in ("ai_agent_runs", "ai_image_generation_jobs", "search_index_jobs", "ai_run_llm_exchanges"):
        if table_name in {"ai_agent_runs", "ai_image_generation_jobs", "search_index_jobs", "ai_run_llm_exchanges"}:
            op.create_foreign_key(
                f"fk_{table_name}_config_revision",
                table_name,
                "family_model_config_revisions",
                ["config_revision_id"],
                ["id"],
                ondelete="RESTRICT",
            )
    op.create_foreign_key(
        "fk_search_index_jobs_search_profile",
        "search_index_jobs",
        "family_search_profiles",
        ["search_profile_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_search_index_jobs_price_version",
        "search_index_jobs",
        "model_usage_price_versions",
        ["price_version_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_ai_run_llm_exchanges_provider_profile",
        "ai_run_llm_exchanges",
        "family_model_provider_profiles",
        ["provider_profile_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_ai_run_llm_exchanges_provider_profile_version",
        "ai_run_llm_exchanges",
        "family_model_provider_profile_versions",
        ["provider_profile_version_id"],
        ["id"],
        ondelete="RESTRICT",
    )


def _create_settings_rows_and_pointer_foreign_keys() -> None:
    op.create_table(
        "family_model_settings",
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("active_config_revision_id", sa.String(length=64), nullable=True),
        sa.Column("active_price_version_id", sa.String(length=64), nullable=True),
        sa.Column("active_search_profile_id", sa.String(length=64), nullable=True),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["active_config_revision_id"], ["family_model_config_revisions.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["active_price_version_id"], ["model_usage_price_versions.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["active_search_profile_id"], ["family_search_profiles.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("family_id"),
    )
    op.execute(
        """
        INSERT INTO family_model_settings (
            family_id, active_config_revision_id, active_price_version_id,
            active_search_profile_id, version_number, created_at, updated_at
        )
        SELECT f.id, NULL, NULL, NULL, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()
        FROM families AS f
        LEFT JOIN family_model_settings AS s ON s.family_id = f.id
        WHERE s.family_id IS NULL
        """
    )
    op.create_foreign_key(
        "fk_family_model_profile_current_version",
        "family_model_provider_profiles",
        "family_model_provider_profile_versions",
        ["current_profile_version_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_family_model_profile_current_secret",
        "family_model_provider_profiles",
        "family_model_secret_versions",
        ["current_secret_version_id"],
        ["id"],
        ondelete="RESTRICT",
    )


def upgrade() -> None:
    _create_family_model_identity_tables()
    _extend_model_usage_and_runtime_snapshot_tables()
    _create_settings_rows_and_pointer_foreign_keys()


def _drop_runtime_snapshot_extensions() -> None:
    foreign_keys = {
        "model_usage_reservations": (
            "fk_model_usage_reservations_credential_secret",
            "fk_model_usage_reservations_search_profile",
            "fk_model_usage_reservations_provider_profile_version",
            "fk_model_usage_reservations_provider_profile",
            "fk_model_usage_reservations_config_revision",
        ),
        "model_usage_events": (
            "fk_model_usage_events_search_profile",
            "fk_model_usage_events_provider_profile_version",
            "fk_model_usage_events_provider_profile",
            "fk_model_usage_events_config_revision",
        ),
        "ai_agent_runs": ("fk_ai_agent_runs_config_revision",),
        "ai_image_generation_jobs": ("fk_ai_image_generation_jobs_config_revision",),
        "search_index_jobs": (
            "fk_search_index_jobs_price_version",
            "fk_search_index_jobs_search_profile",
            "fk_search_index_jobs_config_revision",
        ),
        "ai_run_llm_exchanges": (
            "fk_ai_run_llm_exchanges_provider_profile_version",
            "fk_ai_run_llm_exchanges_provider_profile",
            "fk_ai_run_llm_exchanges_config_revision",
        ),
    }
    columns = {
        "model_usage_reservations": (
            "search_profile_id",
            "credential_secret_version_id",
            "provider_profile_version_id",
            "provider_profile_id",
            "config_revision_id",
        ),
        "model_usage_events": (
            "search_profile_id",
            "provider_profile_version_id",
            "provider_profile_id",
            "config_revision_id",
        ),
        "ai_agent_runs": ("config_revision_id",),
        "ai_image_generation_jobs": ("config_revision_id",),
        "search_index_jobs": ("price_version_id", "config_revision_id", "search_profile_id"),
        "ai_run_llm_exchanges": (
            "provider_profile_version_id",
            "provider_profile_id",
            "config_revision_id",
        ),
    }
    for table_name, constraint_names in foreign_keys.items():
        for constraint_name in constraint_names:
            op.drop_constraint(constraint_name, table_name, type_="foreignkey")
    for table_name, column_names in columns.items():
        for column_name in column_names:
            op.drop_column(table_name, column_name)


def _drop_price_version_extensions() -> None:
    # MySQL requires supporting indexes for foreign-key columns, including
    # indexes it creates implicitly.  Release all foreign keys before dropping
    # the columns so a downgrade can remove those supporting indexes safely.
    # The candidate price pointer forms a deliberate cycle with the price
    # ownership FK, so remove it first.
    op.drop_constraint(
        "fk_family_search_profile_candidate_price",
        "family_search_profiles",
        type_="foreignkey",
    )
    op.drop_column("family_search_profiles", "candidate_price_version_id")
    for constraint_name in (
        "fk_model_usage_price_version_base",
        "fk_model_usage_price_version_search_profile",
        "fk_model_usage_price_version_config_revision",
        "fk_model_usage_price_version_family",
    ):
        op.drop_constraint(constraint_name, "model_usage_price_versions", type_="foreignkey")
    op.drop_constraint(
        "ck_model_usage_price_version_purpose_owner", "model_usage_price_versions", type_="check"
    )
    for column_name in (
        "published_by",
        "purpose",
        "base_price_version_id",
        "search_profile_id",
        "config_revision_id",
        "family_id",
    ):
        op.drop_column("model_usage_price_versions", column_name)
    op.create_unique_constraint(
        "uq_model_usage_price_manifest_checksum",
        "model_usage_price_versions",
        ["manifest_checksum"],
    )


def downgrade() -> None:
    op.drop_table("family_model_settings")
    _drop_runtime_snapshot_extensions()
    _drop_price_version_extensions()

    op.drop_table("family_model_resource_operations")
    op.drop_table("family_model_operation_receipts")
    op.drop_table("family_search_profile_documents")
    op.drop_table("family_model_capability_bindings")
    op.drop_table("family_model_config_drafts")
    op.drop_table("family_model_config_revisions")
    op.drop_table("family_search_profiles")
    op.drop_constraint(
        "fk_family_model_profile_current_secret",
        "family_model_provider_profiles",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_family_model_profile_current_version",
        "family_model_provider_profiles",
        type_="foreignkey",
    )
    op.drop_table("family_model_secret_versions")
    op.drop_table("family_model_provider_profile_versions")
    op.drop_table("family_model_provider_profiles")
