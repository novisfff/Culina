from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Enum as SqlEnum,
    ForeignKey,
    Index,
    Integer,
    JSON,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.enums import (
    FamilyModelConfigRevisionStatus,
    FamilyModelOperationStatus,
    FamilyModelProviderStatus,
    FamilyModelResourceOperationStatus,
    FamilyModelResourceOperationType,
    FamilyModelSearchProfileStatus,
    FamilyModelSecretStatus,
    ModelUsageCapability,
)
from app.core.utils import create_id, utcnow
from app.models.domain import Base


def _enum_type(enum_class: type) -> SqlEnum:
    return SqlEnum(
        enum_class,
        native_enum=False,
        values_callable=lambda items: [item.value for item in items],
    )


class FamilyModelSettings(Base):
    __tablename__ = "family_model_settings"

    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), primary_key=True
    )
    active_config_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("family_model_config_revisions.id", ondelete="SET NULL"), nullable=True
    )
    active_price_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_usage_price_versions.id", ondelete="SET NULL"), nullable=True
    )
    active_search_profile_id: Mapped[str | None] = mapped_column(
        ForeignKey("family_search_profiles.id", ondelete="SET NULL"), nullable=True
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )


class FamilyModelProviderProfile(Base):
    __tablename__ = "family_model_provider_profiles"
    __table_args__ = (
        UniqueConstraint(
            "family_id", "display_name", name="uq_family_model_provider_profile_display_name"
        ),
        Index("ix_family_model_provider_profile_family_status", "family_id", "status"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("family-model-profile")
    )
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    display_name: Mapped[str] = mapped_column(String(160), nullable=False)
    credential_scope_checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    current_profile_version_id: Mapped[str | None] = mapped_column(
        ForeignKey(
            "family_model_provider_profile_versions.id",
            ondelete="RESTRICT",
            use_alter=True,
            name="fk_family_model_profile_current_version",
        ),
        nullable=True,
    )
    current_secret_version_id: Mapped[str | None] = mapped_column(
        ForeignKey(
            "family_model_secret_versions.id",
            ondelete="RESTRICT",
            use_alter=True,
            name="fk_family_model_profile_current_secret",
        ),
        nullable=True,
    )
    status: Mapped[FamilyModelProviderStatus] = mapped_column(
        _enum_type(FamilyModelProviderStatus),
        nullable=False,
        default=FamilyModelProviderStatus.ACTIVE,
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )


class FamilyModelProviderProfileVersion(Base):
    __tablename__ = "family_model_provider_profile_versions"
    __table_args__ = (
        UniqueConstraint(
            "profile_id", "version_number", name="uq_family_model_profile_version_number"
        ),
        Index("ix_family_model_profile_version_family_profile", "family_id", "profile_id"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("family-model-profile-version")
    )
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    profile_id: Mapped[str] = mapped_column(
        ForeignKey("family_model_provider_profiles.id", ondelete="CASCADE"), nullable=False
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    adapter_kind: Mapped[str] = mapped_column(String(64), nullable=False)
    auth_mode: Mapped[str] = mapped_column(String(32), nullable=False)
    api_base_url: Mapped[str] = mapped_column(String(2048), nullable=False)
    websocket_base_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    options_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    credential_scope_checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    endpoint_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class FamilyModelSecretVersion(Base):
    __tablename__ = "family_model_secret_versions"
    __table_args__ = (
        UniqueConstraint(
            "profile_id", "version_number", name="uq_family_model_secret_version_number"
        ),
        Index("ix_family_model_secret_version_family_profile", "family_id", "profile_id"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("family-model-secret")
    )
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    profile_id: Mapped[str] = mapped_column(
        ForeignKey("family_model_provider_profiles.id", ondelete="CASCADE"), nullable=False
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    encryption_key_id: Mapped[str] = mapped_column(String(120), nullable=False)
    nonce: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    auth_tag: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    secret_fingerprint: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[FamilyModelSecretStatus] = mapped_column(
        _enum_type(FamilyModelSecretStatus),
        nullable=False,
        default=FamilyModelSecretStatus.ACTIVE,
    )
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    destroyed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class FamilyModelConfigDraft(Base):
    __tablename__ = "family_model_config_drafts"

    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), primary_key=True
    )
    base_config_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("family_model_config_revisions.id", ondelete="SET NULL"), nullable=True
    )
    draft_version_number: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    payload_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    validation_status: Mapped[str] = mapped_column(String(32), default="unknown", nullable=False)
    validation_errors_json: Mapped[list[dict[str, Any]]] = mapped_column(
        JSON, default=list, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)


class FamilyModelConfigRevision(Base):
    __tablename__ = "family_model_config_revisions"
    __table_args__ = (
        UniqueConstraint(
            "family_id", "version_number", name="uq_family_model_config_revision_number"
        ),
        UniqueConstraint(
            "family_id",
            "config_checksum",
            name="uq_family_model_config_revision_family_checksum",
        ),
        Index("ix_family_model_config_revision_family_status", "family_id", "status"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("family-model-revision")
    )
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    base_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("family_model_config_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    config_checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[FamilyModelConfigRevisionStatus] = mapped_column(
        _enum_type(FamilyModelConfigRevisionStatus),
        nullable=False,
        default=FamilyModelConfigRevisionStatus.PUBLISHED,
    )
    search_profile_id: Mapped[str | None] = mapped_column(
        ForeignKey("family_search_profiles.id", ondelete="SET NULL"), nullable=True
    )
    change_note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    published_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    published_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class FamilyModelCapabilityBinding(Base):
    __tablename__ = "family_model_capability_bindings"
    __table_args__ = (
        UniqueConstraint(
            "config_revision_id",
            "capability",
            "variant_key",
            name="uq_family_model_binding_revision_capability_variant",
        ),
        Index(
            "ix_family_model_binding_family_revision",
            "family_id",
            "config_revision_id",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("family-model-binding")
    )
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    config_revision_id: Mapped[str] = mapped_column(
        ForeignKey("family_model_config_revisions.id", ondelete="CASCADE"), nullable=False
    )
    capability: Mapped[ModelUsageCapability] = mapped_column(
        _enum_type(ModelUsageCapability), nullable=False
    )
    variant_key: Mapped[str] = mapped_column(String(120), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    provider_profile_id: Mapped[str | None] = mapped_column(
        ForeignKey("family_model_provider_profiles.id", ondelete="RESTRICT"), nullable=True
    )
    provider_profile_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("family_model_provider_profile_versions.id", ondelete="RESTRICT"), nullable=True
    )
    requested_model: Mapped[str] = mapped_column(String(160), default="", nullable=False)
    options_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    billing_scheme_key: Mapped[str] = mapped_column(String(160), default="", nullable=False)
    identity_checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class FamilySearchProfile(Base):
    __tablename__ = "family_search_profiles"
    __table_args__ = (
        UniqueConstraint("qdrant_collection", name="uq_family_search_profile_collection"),
        UniqueConstraint(
            "family_id", "index_identity_checksum", name="uq_family_search_profile_identity"
        ),
        Index("ix_family_search_profile_family_status", "family_id", "status"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("family-search-profile")
    )
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    # A replacement is immutable work against one specific active profile.
    # Persisting that relationship avoids activating a candidate after another
    # replacement has already switched the family.
    base_search_profile_id: Mapped[str | None] = mapped_column(
        ForeignKey(
            "family_search_profiles.id",
            ondelete="RESTRICT",
            use_alter=True,
            name="fk_family_search_profile_base",
        ),
        nullable=True,
    )
    provider_profile_id: Mapped[str] = mapped_column(
        ForeignKey("family_model_provider_profiles.id", ondelete="RESTRICT"), nullable=False
    )
    provider_profile_version_id: Mapped[str] = mapped_column(
        ForeignKey("family_model_provider_profile_versions.id", ondelete="RESTRICT"), nullable=False
    )
    adapter_kind: Mapped[str] = mapped_column(String(64), nullable=False)
    embedding_model: Mapped[str] = mapped_column(String(160), nullable=False)
    dimensions: Mapped[int] = mapped_column(Integer, nullable=False)
    distance: Mapped[str] = mapped_column(String(32), nullable=False, default="Cosine")
    document_builder_version: Mapped[str] = mapped_column(String(64), nullable=False)
    index_identity_checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    qdrant_collection: Mapped[str] = mapped_column(String(255), nullable=False)
    # Candidate rebuild jobs retain a dedicated price snapshot. Keeping the
    # pointer explicit prevents retry/activation from selecting another
    # candidate price version.
    candidate_price_version_id: Mapped[str | None] = mapped_column(
        ForeignKey(
            "model_usage_price_versions.id",
            ondelete="RESTRICT",
            use_alter=True,
            name="fk_family_search_profile_candidate_price",
        ),
        nullable=True,
    )
    status: Mapped[FamilyModelSearchProfileStatus] = mapped_column(
        _enum_type(FamilyModelSearchProfileStatus),
        nullable=False,
        default=FamilyModelSearchProfileStatus.PROVISIONING,
    )
    total_documents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    indexed_documents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_documents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class FamilySearchProfileDocument(Base):
    __tablename__ = "family_search_profile_documents"
    __table_args__ = (
        UniqueConstraint(
            "family_id",
            "search_profile_id",
            "search_document_id",
            name="uq_family_search_profile_document",
        ),
        Index(
            "ix_family_search_profile_document_status",
            "family_id",
            "search_profile_id",
            "status",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("family-search-document")
    )
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    search_profile_id: Mapped[str] = mapped_column(
        ForeignKey("family_search_profiles.id", ondelete="CASCADE"), nullable=False
    )
    search_document_id: Mapped[str] = mapped_column(
        ForeignKey("search_documents.id", ondelete="CASCADE"), nullable=False
    )
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    vector_json: Mapped[list[float] | None] = mapped_column(JSON, nullable=True)
    vector_dimensions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    indexed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )


class FamilyModelOperationReceipt(Base):
    __tablename__ = "family_model_operation_receipts"
    __table_args__ = (
        UniqueConstraint(
            "family_id", "operation", "idempotency_key", name="uq_family_model_operation_key"
        ),
        Index("ix_family_model_operation_receipt_family_status", "family_id", "status"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("family-model-receipt")
    )
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    operation: Mapped[str] = mapped_column(String(120), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(255), nullable=False)
    request_fingerprint: Mapped[str] = mapped_column(String(128), nullable=False)
    request_fingerprint_key_id: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[FamilyModelOperationStatus] = mapped_column(
        _enum_type(FamilyModelOperationStatus),
        nullable=False,
        default=FamilyModelOperationStatus.PENDING,
    )
    result_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    response_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class FamilyModelResourceOperation(Base):
    __tablename__ = "family_model_resource_operations"
    __table_args__ = (
        UniqueConstraint(
            "operation_type", "resource_key", name="uq_family_model_resource_operation"
        ),
        Index("ix_family_model_resource_operation_status_available", "status", "available_at"),
        CheckConstraint("attempt_count >= 0", name="ck_family_model_resource_operation_attempt_count"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("family-model-resource-operation")
    )
    operation_type: Mapped[FamilyModelResourceOperationType] = mapped_column(
        _enum_type(FamilyModelResourceOperationType), nullable=False
    )
    resource_key: Mapped[str] = mapped_column(String(255), nullable=False)
    # These deliberately have no foreign keys: deletion cleanup must remain
    # durable after the family or profile rows have cascaded away.
    family_id_snapshot: Mapped[str] = mapped_column(String(64), nullable=False)
    search_profile_id_snapshot: Mapped[str | None] = mapped_column(String(64), nullable=True)
    qdrant_collection_snapshot: Mapped[str] = mapped_column(String(255), nullable=False)
    payload_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    status: Mapped[FamilyModelResourceOperationStatus] = mapped_column(
        _enum_type(FamilyModelResourceOperationStatus),
        nullable=False,
        default=FamilyModelResourceOperationStatus.PENDING,
    )
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    lease_owner: Mapped[str | None] = mapped_column(String(160), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
