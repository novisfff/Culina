"""add model usage governance

Revision ID: 2d3e4f5a6b7c
Revises: 1c2d3e4f5a6b
Create Date: 2026-07-30 03:41:56.971652

"""
from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timezone

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "2d3e4f5a6b7c"
down_revision = "1c2d3e4f5a6b"
branch_labels = None
depends_on = None


def _migration_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(16)}"


def _subject_key() -> str:
    return f"mus_{secrets.token_urlsafe(24)}"


def _default_policy_checksum() -> str:
    payload = json.dumps(
        {
            "alerts_enabled": True,
            "budget_alert_revision": 1,
            "capability_limits": [],
            "hard_limit_enabled": False,
            "monthly_budget_cny": None,
            "version_number": 1,
        },
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _backfill_existing_families() -> None:
    connection = op.get_bind()
    now = datetime.now(timezone.utc)
    families = connection.execute(sa.text("SELECT id FROM families ORDER BY id")).scalars()

    for family_id in families:
        system_subject_id = _migration_id("mus")
        connection.execute(
            sa.text(
                """
                INSERT INTO model_usage_subjects (
                    id, subject_key, family_id, user_id, subject_kind,
                    dimension_key, anonymized_label, created_at, unlinked_at
                ) VALUES (
                    :id, :subject_key, :family_id, NULL, 'system',
                    'system', NULL, :created_at, NULL
                )
                """
            ),
            {
                "id": system_subject_id,
                "subject_key": _subject_key(),
                "family_id": family_id,
                "created_at": now,
            },
        )

        member_user_ids = connection.execute(
            sa.text(
                """
                SELECT DISTINCT user_id
                FROM memberships
                WHERE family_id = :family_id
                  AND status IN ('ACTIVE', 'active')
                ORDER BY user_id
                """
            ),
            {"family_id": family_id},
        ).scalars()
        for user_id in member_user_ids:
            connection.execute(
                sa.text(
                    """
                    INSERT INTO model_usage_subjects (
                        id, subject_key, family_id, user_id, subject_kind,
                        dimension_key, anonymized_label, created_at, unlinked_at
                    ) VALUES (
                        :id, :subject_key, :family_id, :user_id, 'user',
                        :dimension_key, NULL, :created_at, NULL
                    )
                    """
                ),
                {
                    "id": _migration_id("mus"),
                    "subject_key": _subject_key(),
                    "family_id": family_id,
                    "user_id": user_id,
                    "dimension_key": f"user_{secrets.token_urlsafe(24)}",
                    "created_at": now,
                },
            )

        policy_version_id = _migration_id("mup")
        connection.execute(
            sa.text(
                """
                INSERT INTO model_usage_policy_versions (
                    id, family_id, version_number, monthly_budget_cny,
                    alerts_enabled, hard_limit_enabled, budget_alert_revision,
                    policy_checksum, created_by_subject_id, created_at, effective_at
                ) VALUES (
                    :id, :family_id, 1, NULL,
                    TRUE, FALSE, 1,
                    :policy_checksum, :created_by_subject_id, :created_at, :effective_at
                )
                """
            ),
            {
                "id": policy_version_id,
                "family_id": family_id,
                "policy_checksum": _default_policy_checksum(),
                "created_by_subject_id": system_subject_id,
                "created_at": now,
                "effective_at": now,
            },
        )
        connection.execute(
            sa.text(
                """
                INSERT INTO model_usage_family_policies (
                    family_id, current_policy_version_id, tracking_started_at,
                    created_at, updated_at
                ) VALUES (
                    :family_id, :current_policy_version_id, :tracking_started_at,
                    :created_at, :updated_at
                )
                """
            ),
            {
                "family_id": family_id,
                "current_policy_version_id": policy_version_id,
                "tracking_started_at": now,
                "created_at": now,
                "updated_at": now,
            },
        )


def upgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    op.create_table('model_usage_price_versions',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('version_number', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('effective_from', sa.DateTime(timezone=True), nullable=False),
    sa.Column('reviewed_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('source_ref', sa.String(length=255), nullable=False),
    sa.Column('change_note', sa.Text(), nullable=False),
    sa.Column('operator', sa.String(length=120), nullable=False),
    sa.Column('change_ticket', sa.String(length=160), nullable=True),
    sa.Column('manifest_checksum', sa.String(length=64), nullable=False),
    sa.Column('model_aliases_json', sa.JSON(), nullable=False),
    sa.Column('fx_rates_json', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('manifest_checksum', name='uq_model_usage_price_manifest_checksum'),
    sa.UniqueConstraint('version_number', name='uq_model_usage_price_version_number')
    )
    op.create_index('ix_model_usage_price_version_status_effective', 'model_usage_price_versions', ['status', 'effective_from'], unique=False)
    op.create_table('model_usage_period_counters',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('family_id', sa.String(length=64), nullable=False),
    sa.Column('period_start', sa.DateTime(timezone=True), nullable=False),
    sa.Column('period_end', sa.DateTime(timezone=True), nullable=False),
    sa.Column('counter_kind', sa.Enum('family_cost', 'capability_cost', 'capability_meter', name='modelusagecounterkind', native_enum=False), nullable=False),
    sa.Column('capability', sa.Enum('llm', 'embedding', 'rerank', 'stt', 'tts', 'realtime_audio', 'image_generation', name='modelusagecapability', native_enum=False), nullable=True),
    sa.Column('meter', sa.Enum('input_tokens', 'uncached_input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens', 'embedding_tokens', 'rerank_requests', 'rerank_documents', 'audio_input_seconds', 'audio_output_seconds', 'audio_input_tokens', 'audio_output_tokens', 'tts_characters', 'tts_tokens', 'generated_images', 'request_units', name='modelusagemeter', native_enum=False), nullable=True),
    sa.Column('dimension_key', sa.String(length=255), nullable=False),
    sa.Column('settled_value', sa.Numeric(precision=30, scale=12), nullable=False),
    sa.Column('reserved_value', sa.Numeric(precision=30, scale=12), nullable=False),
    sa.Column('adjustment_value', sa.Numeric(precision=30, scale=12), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('health_status', sa.String(length=32), nullable=False),
    sa.Column('last_verified_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['family_id'], ['families.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('family_id', 'period_start', 'dimension_key', name='uq_model_usage_counter_dimension')
    )
    op.create_index('ix_model_usage_counter_family_period', 'model_usage_period_counters', ['family_id', 'period_start'], unique=False)
    op.create_table('model_usage_price_rates',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('price_version_id', sa.String(length=64), nullable=False),
    sa.Column('provider', sa.String(length=64), nullable=False),
    sa.Column('billing_model', sa.String(length=160), nullable=False),
    sa.Column('capability', sa.Enum('llm', 'embedding', 'rerank', 'stt', 'tts', 'realtime_audio', 'image_generation', name='modelusagecapability', native_enum=False), nullable=False),
    sa.Column('variant_key', sa.String(length=255), nullable=False),
    sa.Column('billing_scheme_key', sa.String(length=160), nullable=False),
    sa.Column('meter', sa.Enum('input_tokens', 'uncached_input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens', 'embedding_tokens', 'rerank_requests', 'rerank_documents', 'audio_input_seconds', 'audio_output_seconds', 'audio_input_tokens', 'audio_output_tokens', 'tts_characters', 'tts_tokens', 'generated_images', 'request_units', name='modelusagemeter', native_enum=False), nullable=False),
    sa.Column('meter_role', sa.Enum('billable', 'informational', name='modelusagemeterrole', native_enum=False), nullable=False),
    sa.Column('unit_quantity', sa.Numeric(precision=30, scale=6), nullable=False),
    sa.Column('unit_price', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('source_currency', sa.String(length=8), nullable=True),
    sa.Column('fx_to_cny', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('unit_price_cny', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('reported_model_aliases', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint('unit_quantity > 0', name='ck_model_usage_price_rate_unit_quantity'),
    sa.ForeignKeyConstraint(['price_version_id'], ['model_usage_price_versions.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('price_version_id', 'provider', 'billing_model', 'capability', 'variant_key', 'billing_scheme_key', 'meter', name='uq_model_usage_price_rate_identity')
    )
    op.create_index('ix_model_usage_price_rate_lookup', 'model_usage_price_rates', ['price_version_id', 'provider', 'billing_model', 'capability', 'variant_key'], unique=False)
    op.create_table('model_usage_subjects',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('subject_key', sa.String(length=64), nullable=False),
    sa.Column('family_id', sa.String(length=64), nullable=False),
    sa.Column('user_id', sa.String(length=64), nullable=True),
    sa.Column('subject_kind', sa.Enum('user', 'system', name='modelusagesubjectkind', native_enum=False), nullable=False),
    sa.Column('dimension_key', sa.String(length=160), nullable=False),
    sa.Column('anonymized_label', sa.String(length=120), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('unlinked_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['family_id'], ['families.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('family_id', 'anonymized_label', name='uq_model_usage_subject_anonymized_label'),
    sa.UniqueConstraint('family_id', 'dimension_key', name='uq_model_usage_subject_dimension'),
    sa.UniqueConstraint('family_id', 'user_id', name='uq_model_usage_subject_user'),
    sa.UniqueConstraint('subject_key', name='uq_model_usage_subject_key')
    )
    op.create_index('ix_model_usage_subject_family_kind', 'model_usage_subjects', ['family_id', 'subject_kind'], unique=False)
    op.create_table('model_usage_measurement_incidents',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('incident_key', sa.String(length=160), nullable=False),
    sa.Column('family_id', sa.String(length=64), nullable=True),
    sa.Column('subject_id', sa.String(length=64), nullable=True),
    sa.Column('subject_key', sa.String(length=64), nullable=True),
    sa.Column('capability', sa.Enum('llm', 'embedding', 'rerank', 'stt', 'tts', 'realtime_audio', 'image_generation', name='modelusagecapability', native_enum=False), nullable=True),
    sa.Column('period_start', sa.DateTime(timezone=True), nullable=False),
    sa.Column('period_end', sa.DateTime(timezone=True), nullable=False),
    sa.Column('mode', sa.String(length=32), nullable=False),
    sa.Column('cause_code', sa.String(length=120), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('recovered_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('coverage', sa.Enum('exact_scope', 'partial_scope', 'unknown_scope', name='modelusageincidentcoverage', native_enum=False), nullable=False),
    sa.Column('source_instance', sa.String(length=160), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['family_id'], ['families.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['subject_id'], ['model_usage_subjects.id'], ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('incident_key', name='uq_model_usage_incident_key')
    )
    op.create_index('ix_model_usage_incident_family_period', 'model_usage_measurement_incidents', ['family_id', 'period_start'], unique=False)
    op.create_index('ix_model_usage_incident_period', 'model_usage_measurement_incidents', ['period_start', 'period_end'], unique=False)
    op.create_table('model_usage_monthly_rollups',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('family_id', sa.String(length=64), nullable=False),
    sa.Column('period_start', sa.DateTime(timezone=True), nullable=False),
    sa.Column('period_end', sa.DateTime(timezone=True), nullable=False),
    sa.Column('rollup_kind', sa.Enum('family_total', 'subject_total', 'capability_total', 'provider_model_total', 'meter_total', 'daily_capability_cost', name='modelusagerollupkind', native_enum=False), nullable=False),
    sa.Column('dimension_key', sa.String(length=255), nullable=False),
    sa.Column('subject_id', sa.String(length=64), nullable=True),
    sa.Column('subject_key', sa.String(length=64), nullable=True),
    sa.Column('capability', sa.Enum('llm', 'embedding', 'rerank', 'stt', 'tts', 'realtime_audio', 'image_generation', name='modelusagecapability', native_enum=False), nullable=True),
    sa.Column('provider', sa.String(length=64), nullable=True),
    sa.Column('billing_model', sa.String(length=160), nullable=True),
    sa.Column('meter', sa.Enum('input_tokens', 'uncached_input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens', 'embedding_tokens', 'rerank_requests', 'rerank_documents', 'audio_input_seconds', 'audio_output_seconds', 'audio_input_tokens', 'audio_output_tokens', 'tts_characters', 'tts_tokens', 'generated_images', 'request_units', name='modelusagemeter', native_enum=False), nullable=True),
    sa.Column('local_day', sa.Date(), nullable=True),
    sa.Column('exact_event_count', sa.Integer(), nullable=False),
    sa.Column('estimated_event_count', sa.Integer(), nullable=False),
    sa.Column('unpriced_event_count', sa.Integer(), nullable=False),
    sa.Column('uncertain_attempt_count', sa.Integer(), nullable=False),
    sa.Column('unresolved_unknown_execution_count', sa.Integer(), nullable=False),
    sa.Column('unresolved_known_unmeasured_count', sa.Integer(), nullable=False),
    sa.Column('has_unknown_measurement_gap', sa.Boolean(), nullable=False),
    sa.Column('meter_total', sa.Numeric(precision=30, scale=6), nullable=True),
    sa.Column('cost_total_cny', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('source_event_count', sa.Integer(), nullable=False),
    sa.Column('source_adjustment_count', sa.Integer(), nullable=False),
    sa.Column('source_incident_count', sa.Integer(), nullable=False),
    sa.Column('revision', sa.Integer(), nullable=False),
    sa.Column('source_watermark', sa.String(length=255), nullable=False),
    sa.Column('checksum', sa.String(length=64), nullable=False),
    sa.Column('correction_status', sa.Enum('open', 'pruning', 'closed', name='modelusagecorrectionstatus', native_enum=False), nullable=False),
    sa.Column('adjustment_closed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('raw_data_pruned_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('computed_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['family_id'], ['families.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['subject_id'], ['model_usage_subjects.id'], ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('family_id', 'period_start', 'dimension_key', name='uq_model_usage_rollup_dimension')
    )
    op.create_index('ix_model_usage_rollup_family_period', 'model_usage_monthly_rollups', ['family_id', 'period_start'], unique=False)
    op.create_table('model_usage_policy_versions',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('family_id', sa.String(length=64), nullable=False),
    sa.Column('version_number', sa.Integer(), nullable=False),
    sa.Column('monthly_budget_cny', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('alerts_enabled', sa.Boolean(), nullable=False),
    sa.Column('hard_limit_enabled', sa.Boolean(), nullable=False),
    sa.Column('budget_alert_revision', sa.Integer(), nullable=False),
    sa.Column('policy_checksum', sa.String(length=64), nullable=False),
    sa.Column('created_by_subject_id', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('effective_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['created_by_subject_id'], ['model_usage_subjects.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['family_id'], ['families.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('family_id', 'version_number', name='uq_model_usage_policy_family_version')
    )
    op.create_table('model_usage_alerts',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('family_id', sa.String(length=64), nullable=False),
    sa.Column('period_start', sa.DateTime(timezone=True), nullable=False),
    sa.Column('period_end', sa.DateTime(timezone=True), nullable=False),
    sa.Column('policy_version_id', sa.String(length=64), nullable=False),
    sa.Column('budget_alert_revision', sa.Integer(), nullable=False),
    sa.Column('threshold', sa.Numeric(precision=6, scale=3), nullable=False),
    sa.Column('budget_cny', sa.Numeric(precision=30, scale=12), nullable=False),
    sa.Column('settled_value', sa.Numeric(precision=30, scale=12), nullable=False),
    sa.Column('adjustment_value', sa.Numeric(precision=30, scale=12), nullable=False),
    sa.Column('effective_spend_cny', sa.Numeric(precision=30, scale=12), nullable=False),
    sa.Column('severity', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['family_id'], ['families.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['policy_version_id'], ['model_usage_policy_versions.id'], ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('family_id', 'period_start', 'budget_alert_revision', 'threshold', name='uq_model_usage_alert_threshold')
    )
    op.create_index('ix_model_usage_alert_family_period', 'model_usage_alerts', ['family_id', 'period_start'], unique=False)
    op.create_table('model_usage_capability_limits',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('family_id', sa.String(length=64), nullable=False),
    sa.Column('policy_version_id', sa.String(length=64), nullable=False),
    sa.Column('capability', sa.Enum('llm', 'embedding', 'rerank', 'stt', 'tts', 'realtime_audio', 'image_generation', name='modelusagecapability', native_enum=False), nullable=False),
    sa.Column('limit_kind', sa.Enum('cost', 'meter', name='modelusagelimitkind', native_enum=False), nullable=False),
    sa.Column('meter', sa.Enum('input_tokens', 'uncached_input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens', 'embedding_tokens', 'rerank_requests', 'rerank_documents', 'audio_input_seconds', 'audio_output_seconds', 'audio_input_tokens', 'audio_output_tokens', 'tts_characters', 'tts_tokens', 'generated_images', 'request_units', name='modelusagemeter', native_enum=False), nullable=True),
    sa.Column('limit_value', sa.Numeric(precision=30, scale=12), nullable=False),
    sa.Column('enabled', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("(limit_kind = 'cost' AND meter IS NULL) OR (limit_kind = 'meter' AND meter IS NOT NULL)", name='ck_model_usage_capability_limit_meter'),
    sa.CheckConstraint('limit_value >= 0', name='ck_model_usage_capability_limit_value'),
    sa.ForeignKeyConstraint(['family_id'], ['families.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['policy_version_id'], ['model_usage_policy_versions.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('policy_version_id', 'capability', name='uq_model_usage_capability_limit_version_capability')
    )
    op.create_table('model_usage_family_policies',
    sa.Column('family_id', sa.String(length=64), nullable=False),
    sa.Column('current_policy_version_id', sa.String(length=64), nullable=True),
    sa.Column('tracking_started_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['current_policy_version_id'], ['model_usage_policy_versions.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['family_id'], ['families.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('family_id')
    )
    op.create_table('model_usage_reservations',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('attempt_key', sa.String(length=255), nullable=False),
    sa.Column('client_attempt_id', sa.String(length=160), nullable=False),
    sa.Column('fingerprint', sa.String(length=64), nullable=False),
    sa.Column('family_id', sa.String(length=64), nullable=False),
    sa.Column('subject_id', sa.String(length=64), nullable=False),
    sa.Column('subject_key', sa.String(length=64), nullable=False),
    sa.Column('attribution_kind', sa.Enum('user', 'system', name='modelusageattributionkind', native_enum=False), nullable=False),
    sa.Column('operation_source', sa.Enum('interactive', 'background_index', 'image_job', name='modelusageoperationsource', native_enum=False), nullable=False),
    sa.Column('logical_operation_id', sa.String(length=160), nullable=False),
    sa.Column('operation_kind', sa.String(length=120), nullable=False),
    sa.Column('capability', sa.Enum('llm', 'embedding', 'rerank', 'stt', 'tts', 'realtime_audio', 'image_generation', name='modelusagecapability', native_enum=False), nullable=False),
    sa.Column('provider', sa.String(length=64), nullable=False),
    sa.Column('requested_model', sa.String(length=160), nullable=False),
    sa.Column('billing_model', sa.String(length=160), nullable=False),
    sa.Column('variant_key', sa.String(length=255), nullable=False),
    sa.Column('billing_scheme_key', sa.String(length=160), nullable=False),
    sa.Column('recovery_mode', sa.Enum('idempotency_key', 'queryable_request', 'idempotency_and_queryable', 'none', name='modelusagerecoverymode', native_enum=False), nullable=False),
    sa.Column('idempotency_window_seconds', sa.Integer(), nullable=True),
    sa.Column('query_window_seconds', sa.Integer(), nullable=True),
    sa.Column('automatic_resend_deadline_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('provider_idempotency_key', sa.String(length=255), nullable=True),
    sa.Column('policy_version_id', sa.String(length=64), nullable=False),
    sa.Column('dispatch_policy_version_id', sa.String(length=64), nullable=True),
    sa.Column('pre_dispatch_denial_policy_version_id', sa.String(length=64), nullable=True),
    sa.Column('pricing_status', sa.Enum('priced', 'unpriced', name='modelusagepricingstatus', native_enum=False), nullable=False),
    sa.Column('price_version_id', sa.String(length=64), nullable=True),
    sa.Column('price_snapshot_checksum', sa.String(length=64), nullable=True),
    sa.Column('period_start', sa.DateTime(timezone=True), nullable=False),
    sa.Column('period_end', sa.DateTime(timezone=True), nullable=False),
    sa.Column('reserved_cost_cny', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('status', sa.Enum('reserved', 'dispatching', 'settled', 'released', 'uncertain', name='modelusagereservationstatus', native_enum=False), nullable=False),
    sa.Column('provider_request_id', sa.String(length=255), nullable=True),
    sa.Column('reserved_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('dispatching_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('provider_acknowledged_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('error_code', sa.String(length=120), nullable=True),
    sa.ForeignKeyConstraint(['dispatch_policy_version_id'], ['model_usage_policy_versions.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['family_id'], ['families.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['policy_version_id'], ['model_usage_policy_versions.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['pre_dispatch_denial_policy_version_id'], ['model_usage_policy_versions.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['price_version_id'], ['model_usage_price_versions.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['subject_id'], ['model_usage_subjects.id'], ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('client_attempt_id'),
    sa.UniqueConstraint('family_id', 'attempt_key', name='uq_model_usage_reservation_attempt')
    )
    op.create_index('ix_model_usage_reservation_family_period', 'model_usage_reservations', ['family_id', 'period_start'], unique=False)
    op.create_index('ix_model_usage_reservation_status_expiry', 'model_usage_reservations', ['status', 'expires_at'], unique=False)
    op.create_table('model_usage_alert_receipts',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('alert_id', sa.String(length=64), nullable=False),
    sa.Column('user_id', sa.String(length=64), nullable=False),
    sa.Column('seen_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('dismissed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['alert_id'], ['model_usage_alerts.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('alert_id', 'user_id', name='uq_model_usage_alert_receipt_owner')
    )
    op.create_table('model_usage_events',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('reservation_id', sa.String(length=64), nullable=True),
    sa.Column('recovery_source', sa.String(length=32), nullable=False),
    sa.Column('attempt_key', sa.String(length=255), nullable=False),
    sa.Column('fingerprint', sa.String(length=64), nullable=False),
    sa.Column('client_attempt_id', sa.String(length=160), nullable=False),
    sa.Column('family_id', sa.String(length=64), nullable=False),
    sa.Column('subject_id', sa.String(length=64), nullable=False),
    sa.Column('subject_key', sa.String(length=64), nullable=False),
    sa.Column('capability', sa.Enum('llm', 'embedding', 'rerank', 'stt', 'tts', 'realtime_audio', 'image_generation', name='modelusagecapability', native_enum=False), nullable=False),
    sa.Column('provider', sa.String(length=64), nullable=False),
    sa.Column('requested_model', sa.String(length=160), nullable=False),
    sa.Column('reported_model', sa.String(length=160), nullable=True),
    sa.Column('billing_model', sa.String(length=160), nullable=False),
    sa.Column('variant_key', sa.String(length=255), nullable=False),
    sa.Column('billing_scheme_key', sa.String(length=160), nullable=False),
    sa.Column('pricing_status', sa.Enum('priced', 'unpriced', name='modelusagepricingstatus', native_enum=False), nullable=False),
    sa.Column('price_version_id', sa.String(length=64), nullable=True),
    sa.Column('price_snapshot_checksum', sa.String(length=64), nullable=True),
    sa.Column('policy_version_id', sa.String(length=64), nullable=False),
    sa.Column('dispatch_policy_version_id', sa.String(length=64), nullable=False),
    sa.Column('period_start', sa.DateTime(timezone=True), nullable=False),
    sa.Column('period_end', sa.DateTime(timezone=True), nullable=False),
    sa.Column('provider_outcome', sa.Enum('succeeded', 'failed_billed', 'not_billed', 'unknown', name='modelusageprovideroutcome', native_enum=False), nullable=False),
    sa.Column('execution_certainty', sa.Enum('confirmed_executed', 'confirmed_not_executed', 'unknown', name='modelusageexecutioncertainty', native_enum=False), nullable=False),
    sa.Column('measurement_status', sa.Enum('exact', 'estimated', name='modelusagemeasurementstatus', native_enum=False), nullable=False),
    sa.Column('provider_reported_source_cost', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('provider_reported_source_currency', sa.String(length=8), nullable=True),
    sa.Column('cost_cny', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('provider_request_id', sa.String(length=255), nullable=True),
    sa.Column('dispatched_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('estimation_reason', sa.String(length=160), nullable=True),
    sa.Column('stable_error_code', sa.String(length=120), nullable=True),
    sa.Column('fail_open_proof_id', sa.String(length=160), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['dispatch_policy_version_id'], ['model_usage_policy_versions.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['family_id'], ['families.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['policy_version_id'], ['model_usage_policy_versions.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['price_version_id'], ['model_usage_price_versions.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['reservation_id'], ['model_usage_reservations.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['subject_id'], ['model_usage_subjects.id'], ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('family_id', 'attempt_key', name='uq_model_usage_event_attempt'),
    sa.UniqueConstraint('reservation_id')
    )
    op.create_index('ix_model_usage_event_completed', 'model_usage_events', ['completed_at'], unique=False)
    op.create_index('ix_model_usage_event_family_period', 'model_usage_events', ['family_id', 'period_start'], unique=False)
    op.create_table('model_usage_reservation_meters',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('reservation_id', sa.String(length=64), nullable=False),
    sa.Column('meter_key', sa.String(length=160), nullable=False),
    sa.Column('meter', sa.Enum('input_tokens', 'uncached_input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens', 'embedding_tokens', 'rerank_requests', 'rerank_documents', 'audio_input_seconds', 'audio_output_seconds', 'audio_input_tokens', 'audio_output_tokens', 'tts_characters', 'tts_tokens', 'generated_images', 'request_units', name='modelusagemeter', native_enum=False), nullable=False),
    sa.Column('meter_role', sa.Enum('billable', 'informational', name='modelusagemeterrole', native_enum=False), nullable=False),
    sa.Column('reserved_quantity', sa.Numeric(precision=30, scale=6), nullable=False),
    sa.Column('unit_quantity', sa.Numeric(precision=30, scale=6), nullable=True),
    sa.Column('source_unit_price', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('source_currency', sa.String(length=8), nullable=True),
    sa.Column('fx_to_cny', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('unit_price_cny', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('reserved_cost_cny', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.ForeignKeyConstraint(['reservation_id'], ['model_usage_reservations.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('reservation_id', 'meter_key', name='uq_model_usage_reservation_meter_key')
    )
    op.create_table('model_usage_adjustment_groups',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('family_id', sa.String(length=64), nullable=False),
    sa.Column('idempotency_key', sa.String(length=160), nullable=False),
    sa.Column('fingerprint', sa.String(length=64), nullable=False),
    sa.Column('subject_id', sa.String(length=64), nullable=False),
    sa.Column('subject_key', sa.String(length=64), nullable=False),
    sa.Column('period_start', sa.DateTime(timezone=True), nullable=False),
    sa.Column('period_end', sa.DateTime(timezone=True), nullable=False),
    sa.Column('source_event_id', sa.String(length=64), nullable=False),
    sa.Column('source_reservation_id', sa.String(length=64), nullable=True),
    sa.Column('reason_code', sa.String(length=120), nullable=False),
    sa.Column('operator', sa.String(length=120), nullable=False),
    sa.Column('change_ticket', sa.String(length=160), nullable=False),
    sa.Column('evidence_ref', sa.String(length=255), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['family_id'], ['families.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['source_event_id'], ['model_usage_events.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['source_reservation_id'], ['model_usage_reservations.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['subject_id'], ['model_usage_subjects.id'], ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('family_id', 'idempotency_key', name='uq_model_usage_adjustment_group_key')
    )
    op.create_index('ix_model_usage_adjustment_group_period', 'model_usage_adjustment_groups', ['family_id', 'period_start'], unique=False)
    op.create_table('model_usage_event_meters',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('event_id', sa.String(length=64), nullable=False),
    sa.Column('meter_key', sa.String(length=160), nullable=False),
    sa.Column('meter', sa.Enum('input_tokens', 'uncached_input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens', 'embedding_tokens', 'rerank_requests', 'rerank_documents', 'audio_input_seconds', 'audio_output_seconds', 'audio_input_tokens', 'audio_output_tokens', 'tts_characters', 'tts_tokens', 'generated_images', 'request_units', name='modelusagemeter', native_enum=False), nullable=False),
    sa.Column('meter_role', sa.Enum('billable', 'informational', name='modelusagemeterrole', native_enum=False), nullable=False),
    sa.Column('quantity', sa.Numeric(precision=30, scale=6), nullable=False),
    sa.Column('quantity_source', sa.Enum('provider', 'server_measured', 'estimated', name='modelusagequantitysource', native_enum=False), nullable=False),
    sa.Column('unit_quantity', sa.Numeric(precision=30, scale=6), nullable=True),
    sa.Column('source_unit_price', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('source_currency', sa.String(length=8), nullable=True),
    sa.Column('fx_to_cny', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('unit_price_cny', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('cost_cny', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.ForeignKeyConstraint(['event_id'], ['model_usage_events.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('event_id', 'meter_key', name='uq_model_usage_event_meter_key')
    )
    op.create_table('model_usage_measurement_incident_attempts',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('incident_id', sa.String(length=64), nullable=False),
    sa.Column('family_id', sa.String(length=64), nullable=False),
    sa.Column('subject_id', sa.String(length=64), nullable=True),
    sa.Column('capability', sa.Enum('llm', 'embedding', 'rerank', 'stt', 'tts', 'realtime_audio', 'image_generation', name='modelusagecapability', native_enum=False), nullable=True),
    sa.Column('client_attempt_id', sa.String(length=160), nullable=False),
    sa.Column('recovery_status', sa.Enum('unresolved', 'recovered', name='modelusageincidentrecoverystatus', native_enum=False), nullable=False),
    sa.Column('recovered_event_id', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['family_id'], ['families.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['incident_id'], ['model_usage_measurement_incidents.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['recovered_event_id'], ['model_usage_events.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['subject_id'], ['model_usage_subjects.id'], ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('family_id', 'client_attempt_id', name='uq_model_usage_incident_attempt_family_client')
    )
    op.create_index('ix_model_usage_incident_attempt_recovery', 'model_usage_measurement_incident_attempts', ['incident_id', 'recovery_status'], unique=False)
    op.create_table('model_usage_adjustments',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('adjustment_group_id', sa.String(length=64), nullable=False),
    sa.Column('line_sequence', sa.Integer(), nullable=False),
    sa.Column('capability', sa.Enum('llm', 'embedding', 'rerank', 'stt', 'tts', 'realtime_audio', 'image_generation', name='modelusagecapability', native_enum=False), nullable=False),
    sa.Column('meter', sa.Enum('input_tokens', 'uncached_input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens', 'embedding_tokens', 'rerank_requests', 'rerank_documents', 'audio_input_seconds', 'audio_output_seconds', 'audio_input_tokens', 'audio_output_tokens', 'tts_characters', 'tts_tokens', 'generated_images', 'request_units', name='modelusagemeter', native_enum=False), nullable=True),
    sa.Column('meter_delta', sa.Numeric(precision=30, scale=6), nullable=True),
    sa.Column('cost_delta_cny', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('resolution_kind', sa.Enum('meter_correction', 'pricing_correction', 'execution_resolution', name='modelusageresolutionkind', native_enum=False), nullable=False),
    sa.Column('resulting_provider_outcome', sa.Enum('succeeded', 'failed_billed', 'not_billed', 'unknown', name='modelusageprovideroutcome', native_enum=False), nullable=True),
    sa.Column('resulting_execution_certainty', sa.Enum('confirmed_executed', 'confirmed_not_executed', 'unknown', name='modelusageexecutioncertainty', native_enum=False), nullable=True),
    sa.Column('resulting_measurement_status', sa.Enum('exact', 'estimated', name='modelusagemeasurementstatus', native_enum=False), nullable=True),
    sa.Column('resulting_pricing_status', sa.Enum('priced', 'unpriced', name='modelusagepricingstatus', native_enum=False), nullable=True),
    sa.Column('price_snapshot_json', sa.JSON(), nullable=True),
    sa.Column('price_snapshot_checksum', sa.String(length=64), nullable=True),
    sa.Column('resolved_cost_cny', sa.Numeric(precision=30, scale=12), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['adjustment_group_id'], ['model_usage_adjustment_groups.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('adjustment_group_id', 'line_sequence', name='uq_model_usage_adjustment_line_sequence')
    )
    _backfill_existing_families()
    op.alter_column(
        "model_usage_family_policies",
        "current_policy_version_id",
        existing_type=sa.String(length=64),
        nullable=False,
    )
    # ### end Alembic commands ###


def downgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_table('model_usage_adjustments')
    op.drop_table('model_usage_measurement_incident_attempts')
    op.drop_table('model_usage_event_meters')
    op.drop_table('model_usage_adjustment_groups')
    op.drop_table('model_usage_reservation_meters')
    op.drop_table('model_usage_events')
    op.drop_table('model_usage_alert_receipts')
    op.drop_table('model_usage_reservations')
    op.drop_table('model_usage_family_policies')
    op.drop_table('model_usage_capability_limits')
    op.drop_table('model_usage_alerts')
    op.drop_table('model_usage_policy_versions')
    op.drop_table('model_usage_monthly_rollups')
    op.drop_table('model_usage_measurement_incidents')
    op.drop_table('model_usage_subjects')
    op.drop_table('model_usage_price_rates')
    op.drop_table('model_usage_period_counters')
    op.drop_table('model_usage_price_versions')
    # ### end Alembic commands ###
