from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCapability,
    ModelUsageLimitKind,
    ModelUsageMeter,
)
from app.models.domain import Family, User
from app.models.model_usage import ModelUsageCapabilityLimit, ModelUsagePolicyVersion
from app.services.model_usage.configured_variants import ConfiguredUsageVariant
from app.services.model_usage.errors import (
    ModelUsagePolicyConflict,
    ModelUsagePolicyValidationError,
)
from app.services.model_usage.policies import (
    CapabilityLimitCommand,
    PolicyUpdateCommand,
    current_policy,
    ensure_family_model_usage_defaults,
    policy_limits,
    update_family_policy,
)
from app.services.model_usage.subjects import ensure_user_subject, unlink_user_subjects


def _load_model_usage_governance_migration() -> ModuleType:
    migration_path = (
        Path(__file__).resolve().parents[2]
        / "alembic"
        / "versions"
        / "2d3e4f5a6b7c_add_model_usage_governance.py"
    )
    spec = spec_from_file_location("model_usage_governance_migration", migration_path)
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def family_defaults(model_usage_db: Session) -> tuple[str, str]:
    family = Family(id="family-policy", name="策略家庭", motto="", location="")
    owner = User(
        id="owner-policy",
        username="owner-policy",
        display_name="Owner",
        avatar_seed="Owner",
        is_active=True,
    )
    model_usage_db.add_all([family, owner])
    model_usage_db.flush()
    subject = ensure_user_subject(
        model_usage_db,
        family_id=family.id,
        user_id=owner.id,
    )
    ensure_family_model_usage_defaults(
        model_usage_db,
        family_id=family.id,
        creator_subject_id=subject.id,
    )
    return family.id, subject.id


def command_for(
    db: Session,
    family_id: str,
    actor_subject_id: str,
    **overrides: object,
) -> PolicyUpdateCommand:
    existing = current_policy(db, family_id=family_id)
    values: dict[str, object] = {
        "family_id": family_id,
        "base_version_number": existing.version_number,
        "monthly_budget_cny": existing.monthly_budget_cny,
        "alerts_enabled": existing.alerts_enabled,
        "hard_limit_enabled": existing.hard_limit_enabled,
        "capability_limits": tuple(policy_limits(db, policy_version_id=existing.id)),
        "actor_subject_id": actor_subject_id,
        "active_variants": (),
    }
    values.update(overrides)
    return PolicyUpdateCommand(**values)


def test_defaults_create_immutable_version_one(
    model_usage_db: Session,
    family_defaults: tuple[str, str],
) -> None:
    family_id, subject_id = family_defaults
    initial = current_policy(model_usage_db, family_id=family_id)

    assert initial.version_number == 1
    assert initial.monthly_budget_cny is None
    assert initial.alerts_enabled is True
    assert initial.hard_limit_enabled is False
    assert initial.budget_alert_revision == 1
    assert initial.created_by_subject_id == subject_id
    assert policy_limits(model_usage_db, policy_version_id=initial.id) == ()


def test_runtime_default_policy_checksum_matches_migration(
    model_usage_db: Session,
    family_defaults: tuple[str, str],
) -> None:
    family_id, _ = family_defaults
    migration = _load_model_usage_governance_migration()

    assert current_policy(
        model_usage_db,
        family_id=family_id,
    ).policy_checksum == migration._default_policy_checksum()


def test_update_inserts_history_and_swaps_pointer(
    model_usage_db: Session,
    family_defaults: tuple[str, str],
) -> None:
    family_id, subject_id = family_defaults
    initial = current_policy(model_usage_db, family_id=family_id)
    updated = update_family_policy(
        model_usage_db,
        command_for(
            model_usage_db,
            family_id,
            subject_id,
            monthly_budget_cny=Decimal("100.00"),
        ),
    )

    assert updated.id != initial.id
    assert updated.version_number == 2
    assert current_policy(model_usage_db, family_id=family_id).id == updated.id
    versions = tuple(
        model_usage_db.scalars(
            select(ModelUsagePolicyVersion)
            .where(ModelUsagePolicyVersion.family_id == family_id)
            .order_by(ModelUsagePolicyVersion.version_number)
        )
    )
    assert [item.id for item in versions] == [initial.id, updated.id]
    assert versions[0].monthly_budget_cny is None


def test_stale_base_version_returns_current_policy(
    model_usage_db: Session,
    family_defaults: tuple[str, str],
) -> None:
    family_id, subject_id = family_defaults
    stale = command_for(model_usage_db, family_id, subject_id)
    latest = update_family_policy(
        model_usage_db,
        replace(stale, monthly_budget_cny=Decimal("50")),
    )

    with pytest.raises(ModelUsagePolicyConflict) as caught:
        update_family_policy(model_usage_db, stale)

    assert caught.value.code == "model_usage_policy_conflict"
    assert caught.value.current_policy.id == latest.id


@pytest.mark.parametrize(
    "command_overrides",
    [
        {"hard_limit_enabled": True},
        {
            "capability_limits": (
                CapabilityLimitCommand(
                    capability=ModelUsageCapability.LLM,
                    limit_kind=ModelUsageLimitKind.COST,
                    meter=None,
                    limit_value=Decimal("10"),
                ),
            )
        },
        {"monthly_budget_cny": Decimal("0")},
    ],
)
def test_budget_dependent_rules_require_positive_budget(
    model_usage_db: Session,
    family_defaults: tuple[str, str],
    command_overrides: dict[str, object],
) -> None:
    family_id, subject_id = family_defaults
    with pytest.raises(ModelUsagePolicyValidationError, match="positive_monthly_budget_required"):
        update_family_policy(
            model_usage_db,
            command_for(
                model_usage_db,
                family_id,
                subject_id,
                **command_overrides,
            ),
        )


def test_policy_rejects_meter_without_cross_variant_guardrail_contract(
    model_usage_db: Session,
    family_defaults: tuple[str, str],
) -> None:
    family_id, subject_id = family_defaults
    variant = ConfiguredUsageVariant(
        provider="provider",
        billing_model="model",
        capability=ModelUsageCapability.REALTIME_AUDIO,
        variant_key="seconds",
        billing_scheme_key="seconds",
        billable_meters=frozenset({ModelUsageMeter.AUDIO_INPUT_SECONDS}),
        produced_meters=frozenset({ModelUsageMeter.AUDIO_INPUT_SECONDS}),
    )
    limit = CapabilityLimitCommand(
        capability=ModelUsageCapability.REALTIME_AUDIO,
        limit_kind=ModelUsageLimitKind.METER,
        meter=ModelUsageMeter.AUDIO_INPUT_TOKENS,
        limit_value=Decimal("1000"),
    )

    with pytest.raises(
        ModelUsagePolicyValidationError,
        match="guardrail_meter_not_supported",
    ):
        update_family_policy(
            model_usage_db,
            command_for(
                model_usage_db,
                family_id,
                subject_id,
                monthly_budget_cny=Decimal("100"),
                capability_limits=(limit,),
                active_variants=(variant,),
            ),
        )


def test_only_budget_or_alert_reenable_bumps_alert_revision(
    model_usage_db: Session,
    family_defaults: tuple[str, str],
) -> None:
    family_id, subject_id = family_defaults
    v1 = current_policy(model_usage_db, family_id=family_id)
    v2 = update_family_policy(
        model_usage_db,
        command_for(
            model_usage_db,
            family_id,
            subject_id,
            monthly_budget_cny=Decimal("100"),
        ),
    )
    v3 = update_family_policy(
        model_usage_db,
        command_for(
            model_usage_db,
            family_id,
            subject_id,
            hard_limit_enabled=True,
        ),
    )
    v4 = update_family_policy(
        model_usage_db,
        command_for(
            model_usage_db,
            family_id,
            subject_id,
            alerts_enabled=False,
        ),
    )
    v5 = update_family_policy(
        model_usage_db,
        command_for(
            model_usage_db,
            family_id,
            subject_id,
            alerts_enabled=True,
        ),
    )

    assert v2.budget_alert_revision == v1.budget_alert_revision + 1
    assert v3.budget_alert_revision == v2.budget_alert_revision
    assert v4.budget_alert_revision == v3.budget_alert_revision
    assert v5.budget_alert_revision == v4.budget_alert_revision + 1


def test_policy_history_uses_stable_subject_identity(
    model_usage_db: Session,
    family_defaults: tuple[str, str],
) -> None:
    family_id, subject_id = family_defaults
    initial = current_policy(model_usage_db, family_id=family_id)
    owner_subject = ensure_user_subject(
        model_usage_db,
        family_id=family_id,
        user_id="owner-policy",
    )
    updated = update_family_policy(
        model_usage_db,
        command_for(model_usage_db, family_id, subject_id),
    )

    unlink_user_subjects(model_usage_db, user_id="owner-policy")

    assert {initial.created_by_subject_id, updated.created_by_subject_id} == {subject_id}
    assert subject_id != "owner-policy"
    assert owner_subject.user_id is None


def test_capability_limits_are_copied_as_immutable_rows(
    model_usage_db: Session,
    family_defaults: tuple[str, str],
) -> None:
    family_id, subject_id = family_defaults
    limit = CapabilityLimitCommand(
        capability=ModelUsageCapability.LLM,
        limit_kind=ModelUsageLimitKind.COST,
        meter=None,
        limit_value=Decimal("25"),
    )
    v2 = update_family_policy(
        model_usage_db,
        command_for(
            model_usage_db,
            family_id,
            subject_id,
            monthly_budget_cny=Decimal("100"),
            capability_limits=(limit,),
        ),
    )
    v3 = update_family_policy(
        model_usage_db,
        command_for(model_usage_db, family_id, subject_id),
    )

    rows = tuple(
        model_usage_db.scalars(
            select(ModelUsageCapabilityLimit)
            .where(ModelUsageCapabilityLimit.family_id == family_id)
            .order_by(ModelUsageCapabilityLimit.created_at, ModelUsageCapabilityLimit.id)
        )
    )
    assert len(rows) == 2
    assert {row.policy_version_id for row in rows} == {v2.id, v3.id}
    assert all(row.limit_value == Decimal("25") for row in rows)
