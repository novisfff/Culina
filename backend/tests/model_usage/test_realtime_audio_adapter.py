from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import (
    ModelUsageCapability,
    ModelUsageLimitKind,
    ModelUsageMeter,
    ModelUsageProviderOutcome,
    ModelUsageReservationStatus,
)
from app.core.utils import utcnow
from app.db.base import Base
from app.models.model_usage import (
    ModelUsageEvent,
    ModelUsagePeriodCounter,
    ModelUsageRealtimeWatermark,
    ModelUsageReservation,
)
from app.services.ai_audio.realtime import RealtimeProviderScope, RealtimeVoiceSessionState
from app.services.model_usage.adapters.realtime_audio import RealtimeAudioUsageAdapter
from app.services.model_usage.configured_variants import realtime_duplex_billing_model
from app.services.model_usage.errors import (
    ModelUsageContractError,
    ModelUsageSettlementPending,
)
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.periods import shanghai_billing_period
from app.services.model_usage.policies import CapabilityLimitCommand
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.settlement import settle_usage
from tests.model_usage.test_price_manifest import configured_test_variants
from tests.model_usage.test_pricing_service import publish, raw_manifest
from tests.model_usage.test_reservations import NOW, set_policy


pytest_plugins = ("tests.model_usage.test_reservations",)


def test_realtime_watermark_table_is_period_scoped_and_non_nullable() -> None:
    table = Base.metadata.tables.get("model_usage_realtime_watermarks")

    assert table is not None
    unique = next(
        constraint
        for constraint in table.constraints
        if constraint.name == "uq_model_usage_realtime_watermark"
    )
    assert set(unique.columns.keys()) == {
        "family_id",
        "period_start",
        "session_key",
        "provider",
        "meter",
    }
    assert table.c.period_start.nullable is False
    assert table.c.period_end.nullable is False
    assert table.c.session_key.nullable is False
    assert table.c.cumulative_quantity.nullable is False
    assert table.c.sequence.nullable is False
    assert {index.name for index in table.indexes} == {
        "ix_model_usage_realtime_watermark_family_period",
    }


@pytest.fixture()
def realtime_signer() -> ProviderUsageReceiptSigner:
    return ProviderUsageReceiptSigner(
        active_key_id="realtime-test-key",
        keys={"realtime-test-key": b"realtime-test-secret"},
    )


def _adapter(
    db: Session,
    signer: ProviderUsageReceiptSigner,
    *,
    clock: Callable[[], datetime] | None = None,
) -> RealtimeAudioUsageAdapter:
    factory = sessionmaker(bind=db.get_bind(), expire_on_commit=False)
    active_clock = clock or (lambda: NOW)
    return RealtimeAudioUsageAdapter(
        billing_variant=configured_test_variants()[5],
        usage_facade=ModelUsageFacade(session_factory=factory, clock=active_clock),
        session_factory=factory,
        signer=signer,
        clock=active_clock,
    )


def _dashscope_variant():
    return replace(
        configured_test_variants()[5],
        billing_model=realtime_duplex_billing_model(
            input_model="qwen3-asr-flash-realtime",
            output_model="qwen3-tts-flash-realtime",
        ),
        billing_scheme_key="realtime-asr-seconds-tts-characters-v1",
        billable_meters=frozenset(
            {
                ModelUsageMeter.AUDIO_INPUT_SECONDS,
                ModelUsageMeter.TTS_CHARACTERS,
            }
        ),
        produced_meters=frozenset(
            {
                ModelUsageMeter.AUDIO_INPUT_SECONDS,
                ModelUsageMeter.TTS_CHARACTERS,
            }
        ),
        lease_boundary_cumulative_meters=frozenset(),
        input_tokens_per_second_cap=None,
        output_tokens_per_second_cap=None,
        realtime_input_model="qwen3-asr-flash-realtime",
        realtime_output_model="qwen3-tts-flash-realtime",
        tts_characters_per_lease_cap=4096,
    )


def test_realtime_adapter_rejects_a_provider_model_outside_the_duplex_mapping(
    model_usage_db: Session,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    adapter = _adapter(model_usage_db, realtime_signer)
    adapter.billing_variant = _dashscope_variant()

    adapter.validate_provider_model(
        direction="input",
        provider_model="qwen3-asr-flash-realtime",
    )
    adapter.validate_provider_model(
        direction="output",
        provider_model="qwen3-tts-flash-realtime",
    )
    with pytest.raises(
        ModelUsageContractError,
        match="realtime_provider_model_identity_mismatch",
    ):
        adapter.validate_provider_model(
            direction="output",
            provider_model="qwen3-asr-flash-realtime",
        )


def test_dashscope_scope_settles_asr_seconds_and_tts_characters(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    adapter = _adapter(model_usage_db, realtime_signer)
    adapter.billing_variant = _dashscope_variant()
    session = RealtimeVoiceSessionState(
        session_id="voice-session-provider-units",
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        config_revision_id="revision-test",
        provider_profile_id="profile-test",
        provider_profile_version_id="profile-version-test",
        requested_model="realtime-test",
        binding_identity_checksum="checksum-test",
        adapter_kind="dashscope",
        recipe_id="recipe-provider-units",
        cook_session_id="cook-provider-units",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=NOW,
        expires_at=NOW + timedelta(minutes=5),
    )

    async def run() -> object:
        scope = RealtimeProviderScope(session=session, usage_adapter=adapter)
        async with scope.provider_audio_operation(
            turn_id="turn-provider-units",
            segment="duplex",
            direction="output",
            provider_model="qwen3-tts-flash-realtime",
            at=NOW,
        ) as operation:
            operation.add_input_seconds(Decimal("2"))
            operation.add_tts_characters(7)
        terminal = await scope.finish_current_lease_once(
            at=NOW + timedelta(seconds=2),
            completion_reason="test",
        )
        assert terminal.settlement is not None
        return terminal.settlement

    settlement = asyncio.run(run())
    assert settlement.quantity(ModelUsageMeter.AUDIO_INPUT_SECONDS) == Decimal("2")
    assert settlement.quantity(ModelUsageMeter.TTS_CHARACTERS) == Decimal("7")


def test_realtime_cumulative_usage_settles_monotonic_lease_deltas(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    family_id = reservation_context.attribution.family_id
    user_id = reservation_context.attribution.actor_user_id or "user-test"
    first_baseline = {
        ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
        ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
    }
    first = adapter.begin_lease(
        family_id=family_id,
        user_id=user_id,
        session_id="voice-session-1",
        turn_id="voice-turn-1",
        segment="duplex",
        lease_sequence=1,
        at=NOW,
        server_input_total=Decimal("0"),
        server_output_total=Decimal("0"),
        provider_cumulative=first_baseline,
        previous_provider_watermarks={},
    )
    first_outcome = adapter.finish_lease(
        first,
        server_input_total=Decimal("30"),
        server_output_total=Decimal("18"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
        },
        completed_at=NOW + timedelta(seconds=30),
    )
    second = adapter.begin_lease(
        family_id=family_id,
        user_id=user_id,
        session_id="voice-session-1",
        turn_id="voice-turn-1",
        segment="duplex",
        lease_sequence=2,
        at=NOW + timedelta(seconds=30),
        server_input_total=Decimal("30"),
        server_output_total=Decimal("18"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
        },
        previous_provider_watermarks={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
        },
    )
    second_outcome = adapter.finish_lease(
        second,
        server_input_total=Decimal("60"),
        server_output_total=Decimal("37"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("145"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("115"),
        },
        completed_at=NOW + timedelta(seconds=60),
    )

    assert first_outcome.quantity(ModelUsageMeter.AUDIO_INPUT_TOKENS) == Decimal("100")
    assert second_outcome.quantity(ModelUsageMeter.AUDIO_INPUT_TOKENS) == Decimal("45")
    rows = tuple(
        model_usage_db.scalars(
            select(ModelUsageRealtimeWatermark)
            .where(ModelUsageRealtimeWatermark.session_key == "voice-session-1")
            .order_by(ModelUsageRealtimeWatermark.meter)
        )
    )
    assert {row.meter: row.cumulative_quantity for row in rows} == {
        ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("145"),
        ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("115"),
    }


def test_realtime_lease_aborts_without_charge_when_provider_send_never_started(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    """A permit that expires before its first provider byte is not uncertain."""

    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    lease = adapter.begin_lease(
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        session_id="voice-session-no-provider-send",
        turn_id="voice-turn-no-provider-send",
        segment="duplex",
        lease_sequence=1,
        at=NOW,
        server_input_total=Decimal("0"),
        server_output_total=Decimal("0"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
        },
        previous_provider_watermarks={},
    )

    settlement = adapter.abort_lease_before_provider_send(
        lease,
        completed_at=NOW + timedelta(seconds=31),
    )

    assert lease.terminal_state == "terminal"
    assert settlement.quantity(ModelUsageMeter.AUDIO_INPUT_TOKENS) == Decimal("0")
    assert settlement.quantity(ModelUsageMeter.AUDIO_OUTPUT_TOKENS) == Decimal("0")
    event = model_usage_db.scalar(
        select(ModelUsageEvent).where(ModelUsageEvent.attempt_key == lease.attempt_key)
    )
    assert event is not None
    assert event.provider_outcome is ModelUsageProviderOutcome.NOT_BILLED
    reservation = model_usage_db.get(ModelUsageReservation, lease.dispatch_permit.reservation_id)
    assert reservation is not None
    assert reservation.status is ModelUsageReservationStatus.SETTLED
    assert model_usage_db.scalars(
        select(ModelUsageRealtimeWatermark).where(
            ModelUsageRealtimeWatermark.session_key == "voice-session-no-provider-send"
        )
    ).all() == []


def test_cross_month_lease_keeps_absolute_provider_baseline(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    publish(model_usage_db, raw_manifest())
    current_time = [datetime(2026, 7, 31, 15, 59, 40, tzinfo=timezone.utc)]
    adapter = _adapter(model_usage_db, realtime_signer, clock=lambda: current_time[0])
    family_id = reservation_context.attribution.family_id
    user_id = reservation_context.attribution.actor_user_id or "user-test"
    first = adapter.begin_lease(
        family_id=family_id,
        user_id=user_id,
        session_id="voice-session-boundary",
        turn_id="voice-turn-boundary",
        segment="duplex",
        lease_sequence=1,
        at=current_time[0],
        server_input_total=Decimal("0"),
        server_output_total=Decimal("0"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
        },
        previous_provider_watermarks={},
    )
    first_outcome = adapter.finish_lease(
        first,
        server_input_total=Decimal("20"),
        server_output_total=Decimal("10"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
        },
        completed_at=current_time[0] + timedelta(seconds=20),
    )
    current_time[0] = datetime(2026, 7, 31, 16, 0, 10, tzinfo=timezone.utc)
    second = adapter.begin_lease(
        family_id=family_id,
        user_id=user_id,
        session_id="voice-session-boundary",
        turn_id="voice-turn-boundary",
        segment="duplex",
        lease_sequence=2,
        at=current_time[0],
        server_input_total=Decimal("20"),
        server_output_total=Decimal("10"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
        },
        previous_provider_watermarks={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
        },
    )
    second_outcome = adapter.finish_lease(
        second,
        server_input_total=Decimal("30"),
        server_output_total=Decimal("18"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("145"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("115"),
        },
        completed_at=current_time[0] + timedelta(seconds=10),
    )

    assert first.dispatch_permit.period.start_at != second.dispatch_permit.period.start_at
    assert first_outcome.quantity(ModelUsageMeter.AUDIO_INPUT_TOKENS) == Decimal("100")
    assert second_outcome.quantity(ModelUsageMeter.AUDIO_INPUT_TOKENS) == Decimal("45")
    rows = tuple(
        model_usage_db.scalars(
            select(ModelUsageRealtimeWatermark)
            .where(ModelUsageRealtimeWatermark.session_key == "voice-session-boundary")
            .order_by(ModelUsageRealtimeWatermark.period_start, ModelUsageRealtimeWatermark.meter)
        )
    )
    assert len(rows) == 4
    assert rows[-2].cumulative_quantity == Decimal("145")
    assert rows[-1].cumulative_quantity == Decimal("115")


def test_realtime_lease_uses_its_explicit_server_time_for_reservation_and_dispatch(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    """A lease cannot straddle an implicit-clock billing period mismatch."""

    publish(model_usage_db, raw_manifest())
    before_beijing_month = datetime(2026, 7, 31, 15, 59, 59, tzinfo=timezone.utc)
    lease_started_at = datetime(2026, 7, 31, 16, 0, 1, tzinfo=timezone.utc)
    adapter = _adapter(
        model_usage_db,
        realtime_signer,
        clock=lambda: before_beijing_month,
    )

    lease = adapter.begin_lease(
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        session_id="voice-session-explicit-time",
        turn_id="voice-turn-explicit-time",
        segment="duplex",
        lease_sequence=1,
        at=lease_started_at,
        server_input_total=Decimal("0"),
        server_output_total=Decimal("0"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
        },
        previous_provider_watermarks={},
    )

    assert lease.dispatch_permit.period == shanghai_billing_period(lease_started_at)
    assert lease.started_at == lease.dispatch_permit.dispatched_at
    assert lease.expires_at == lease.dispatch_permit.dispatched_at + timedelta(seconds=30)


def test_realtime_signed_receipt_replay_advances_watermarks_only_once(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    lease = adapter.begin_lease(
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        session_id="voice-session-replay",
        turn_id="voice-turn-replay",
        segment="duplex",
        lease_sequence=1,
        at=NOW,
        server_input_total=Decimal("0"),
        server_output_total=Decimal("0"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
        },
        previous_provider_watermarks={},
    )
    receipt = adapter._receipt_for_terminal_lease(  # noqa: SLF001 - signed recovery fixture
        lease,
        server_input_total=Decimal("30"),
        server_output_total=Decimal("18"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
        },
        completed_at=NOW + timedelta(seconds=30),
    )

    first = lease.attempt.settle(receipt)
    replay = settle_usage(
        receipt,
        signer=realtime_signer,
        session_factory=adapter.session_factory,
    )

    assert replay.event_id == first.event_id
    assert model_usage_db.scalar(
        select(ModelUsageEvent.id).where(ModelUsageEvent.attempt_key == receipt.attempt_key)
    ) == first.event_id
    rows = tuple(
        model_usage_db.scalars(
            select(ModelUsageRealtimeWatermark)
            .where(ModelUsageRealtimeWatermark.session_key == "voice-session-replay")
            .order_by(ModelUsageRealtimeWatermark.meter)
        )
    )
    assert {row.meter: row.sequence for row in rows} == {
        ModelUsageMeter.AUDIO_INPUT_TOKENS: 1,
        ModelUsageMeter.AUDIO_OUTPUT_TOKENS: 1,
    }


def test_realtime_frozen_receipt_recovers_after_process_state_loss_exactly_once(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    """Recovery needs only the signed receipt, not the in-memory lease state."""

    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    lease = adapter.begin_lease(
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        session_id="voice-session-recovery-after-loss",
        turn_id="voice-turn-recovery-after-loss",
        segment="duplex",
        lease_sequence=1,
        at=NOW,
        server_input_total=Decimal("0"),
        server_output_total=Decimal("0"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
        },
        previous_provider_watermarks={},
    )
    receipt = adapter._receipt_for_terminal_lease(  # noqa: SLF001 - frozen durable recovery payload
        lease,
        server_input_total=Decimal("5"),
        server_output_total=Decimal("3"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("145"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("115"),
        },
        completed_at=NOW + timedelta(seconds=5),
    )

    # Do not call `finish_lease`: this models losing all process-local session
    # and lease state after the signed terminal receipt was frozen.
    recovered = settle_usage(
        receipt,
        signer=realtime_signer,
        session_factory=adapter.session_factory,
    )
    replay = settle_usage(
        receipt,
        signer=realtime_signer,
        session_factory=adapter.session_factory,
    )

    assert replay.event_id == recovered.event_id
    assert model_usage_db.scalar(
        select(ModelUsageEvent.id).where(ModelUsageEvent.attempt_key == receipt.attempt_key)
    ) == recovered.event_id
    assert model_usage_db.scalar(
        select(ModelUsageEvent).where(ModelUsageEvent.attempt_key == receipt.attempt_key)
    ) is not None
    rows = tuple(
        model_usage_db.scalars(
            select(ModelUsageRealtimeWatermark)
            .where(ModelUsageRealtimeWatermark.session_key == "voice-session-recovery-after-loss")
            .order_by(ModelUsageRealtimeWatermark.meter)
        )
    )
    assert {row.meter: row.cumulative_quantity for row in rows} == {
        ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("145"),
        ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("115"),
    }
    assert {row.sequence for row in rows} == {1}
    counters = tuple(
        model_usage_db.scalars(
            select(ModelUsagePeriodCounter).where(
                ModelUsagePeriodCounter.family_id == receipt.family_id,
                ModelUsagePeriodCounter.meter.in_(
                    (
                        ModelUsageMeter.AUDIO_INPUT_TOKENS,
                        ModelUsageMeter.AUDIO_OUTPUT_TOKENS,
                    )
                ),
            )
        )
    )
    assert {row.meter: row.settled_value for row in counters} == {
        ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("145"),
        ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("115"),
    }


def test_realtime_scope_connection_without_provider_audio_creates_no_usage_rows(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    """Creating a connected session/scope alone is not a metered attempt."""

    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    session = RealtimeVoiceSessionState(
        session_id="voice-session-no-provider-audio",
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        config_revision_id="revision-test",
        provider_profile_id="profile-test",
        provider_profile_version_id="profile-version-test",
        requested_model="realtime-test",
        binding_identity_checksum="checksum-test",
        adapter_kind="dashscope",
        recipe_id="recipe-no-provider-audio",
        cook_session_id="cook-no-provider-audio",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=NOW,
        expires_at=NOW + timedelta(minutes=5),
    )
    session.realtime_usage_scope = RealtimeProviderScope(session=session, usage_adapter=adapter)

    assert session.realtime_usage_scope is not None
    assert session.active_usage_lease is None
    assert session.next_lease_sequence == 1
    assert model_usage_db.scalar(
        select(ModelUsageReservation.id).where(
            ModelUsageReservation.attempt_key.like("realtime:voice-session-no-provider-audio:%")
        )
    ) is None
    assert model_usage_db.scalar(
        select(ModelUsageEvent.id).where(
            ModelUsageEvent.attempt_key.like("realtime:voice-session-no-provider-audio:%")
        )
    ) is None


def test_realtime_scope_terminalizes_a_lease_before_renewing(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    session = RealtimeVoiceSessionState(
        session_id="voice-session-scope",
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        config_revision_id="revision-test",
        provider_profile_id="profile-test",
        provider_profile_version_id="profile-version-test",
        requested_model="realtime-test",
        binding_identity_checksum="checksum-test",
        adapter_kind="dashscope",
        recipe_id="recipe-scope",
        cook_session_id="cook-scope",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=NOW,
        expires_at=NOW + timedelta(minutes=5),
    )

    async def run() -> None:
        scope = RealtimeProviderScope(session=session, usage_adapter=adapter)
        initial = {
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
        }
        async with scope.provider_audio_operation(
            turn_id="turn-scope",
            segment="duplex",
            direction="input",
            provider_model="realtime-test",
            at=NOW,
            provider_cumulative=initial,
        ) as first:
            assert first.decision == "active"
            first.add_input_seconds(Decimal("30"))
            first.add_output_seconds(Decimal("18"))

        async with scope.provider_audio_operation(
            turn_id="turn-scope",
            segment="duplex",
            direction="input",
            provider_model="realtime-test",
            at=NOW + timedelta(seconds=30),
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
            },
        ) as second:
            assert second.decision == "renewed"
            assert second.lease is not None
            first_settlement = second.previous_settlement
            assert first_settlement is not None
            assert first_settlement.quantity(ModelUsageMeter.AUDIO_INPUT_TOKENS) == Decimal("100")
            second.add_input_seconds(Decimal("5"))
            second.add_output_seconds(Decimal("3"))

        terminal = await scope.finish_current_lease_once(
            at=NOW + timedelta(seconds=35),
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("145"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("115"),
            },
            completion_reason="disconnect",
        )

        assert terminal.decision == "ended"
        assert terminal.settlement is not None
        assert terminal.settlement.quantity(ModelUsageMeter.AUDIO_INPUT_TOKENS) == Decimal("45")
        assert session.active_usage_lease is None
        assert session.next_lease_sequence == 3
        assert session.provider_meter_watermarks == {
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("145"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("115"),
        }

    asyncio.run(run())


def test_realtime_scope_terminalizes_three_non_overlapping_leases_for_sixty_five_seconds(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    session = RealtimeVoiceSessionState(
        session_id="voice-session-sixty-five-seconds",
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        config_revision_id="revision-test",
        provider_profile_id="profile-test",
        provider_profile_version_id="profile-version-test",
        requested_model="realtime-test",
        binding_identity_checksum="checksum-test",
        adapter_kind="dashscope",
        recipe_id="recipe-sixty-five-seconds",
        cook_session_id="cook-sixty-five-seconds",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=NOW,
        expires_at=NOW + timedelta(minutes=5),
    )

    async def run() -> tuple[object, object, object]:
        scope = RealtimeProviderScope(session=session, usage_adapter=adapter)
        initial = {
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
        }
        async with scope.provider_audio_operation(
            turn_id="turn-sixty-five-seconds",
            segment="duplex",
            direction="input",
            provider_model="realtime-test",
            at=NOW,
            provider_cumulative=initial,
        ) as first:
            first.add_input_seconds(Decimal("30"))
            first.add_output_seconds(Decimal("18"))

        async with scope.provider_audio_operation(
            turn_id="turn-sixty-five-seconds",
            segment="duplex",
            direction="input",
            provider_model="realtime-test",
            at=NOW + timedelta(seconds=30),
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
            },
        ) as second:
            assert second.previous_settlement is not None
            second.add_input_seconds(Decimal("30"))
            second.add_output_seconds(Decimal("19"))
            first_settlement = second.previous_settlement

        async with scope.provider_audio_operation(
            turn_id="turn-sixty-five-seconds",
            segment="duplex",
            direction="input",
            provider_model="realtime-test",
            at=NOW + timedelta(seconds=60),
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("145"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("115"),
            },
        ) as third:
            assert third.previous_settlement is not None
            third.add_input_seconds(Decimal("5"))
            third.add_output_seconds(Decimal("3"))
            second_settlement = third.previous_settlement

        terminal = await scope.finish_current_lease_once(
            at=NOW + timedelta(seconds=65),
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("180"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("145"),
            },
            completion_reason="disconnect",
        )
        assert terminal.settlement is not None
        assert session.active_usage_lease is None
        return first_settlement, second_settlement, terminal.settlement

    first, second, third = asyncio.run(run())

    assert first.quantity(ModelUsageMeter.AUDIO_INPUT_SECONDS) == Decimal("30")
    assert second.quantity(ModelUsageMeter.AUDIO_INPUT_SECONDS) == Decimal("30")
    assert third.quantity(ModelUsageMeter.AUDIO_INPUT_SECONDS) == Decimal("5")
    assert first.quantity(ModelUsageMeter.AUDIO_OUTPUT_SECONDS) == Decimal("18")
    assert second.quantity(ModelUsageMeter.AUDIO_OUTPUT_SECONDS) == Decimal("19")
    assert third.quantity(ModelUsageMeter.AUDIO_OUTPUT_SECONDS) == Decimal("3")
    assert first.quantity(ModelUsageMeter.AUDIO_INPUT_TOKENS) == Decimal("100")
    assert second.quantity(ModelUsageMeter.AUDIO_INPUT_TOKENS) == Decimal("45")
    assert third.quantity(ModelUsageMeter.AUDIO_INPUT_TOKENS) == Decimal("35")
    reservations = tuple(
        model_usage_db.scalars(
            select(ModelUsageReservation).where(
                ModelUsageReservation.attempt_key.like(
                    "realtime:voice-session-sixty-five-seconds:%"
                )
            )
        )
    )
    assert len(reservations) == 3
    assert {row.status for row in reservations} == {ModelUsageReservationStatus.SETTLED}


def test_realtime_scope_concurrent_terminal_callbacks_settle_one_lease_once(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    session = RealtimeVoiceSessionState(
        session_id="voice-session-concurrent-terminal",
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        config_revision_id="revision-test",
        provider_profile_id="profile-test",
        provider_profile_version_id="profile-version-test",
        requested_model="realtime-test",
        binding_identity_checksum="checksum-test",
        adapter_kind="dashscope",
        recipe_id="recipe-concurrent-terminal",
        cook_session_id="cook-concurrent-terminal",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=NOW,
        expires_at=NOW + timedelta(minutes=5),
    )

    async def run() -> tuple[object, object]:
        scope = RealtimeProviderScope(session=session, usage_adapter=adapter)
        async with scope.provider_audio_operation(
            turn_id="turn-concurrent-terminal",
            segment="duplex",
            direction="input",
            provider_model="realtime-test",
            at=NOW,
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
            },
        ) as operation:
            operation.add_input_seconds(Decimal("5"))
            operation.add_output_seconds(Decimal("3"))

        return await asyncio.gather(
            scope.finish_current_lease_once(
                at=NOW + timedelta(seconds=5),
                provider_cumulative={
                    ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("10"),
                    ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("8"),
                },
                completion_reason="disconnect",
            ),
            scope.finish_current_lease_once(
                at=NOW + timedelta(seconds=5),
                provider_cumulative={
                    ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("10"),
                    ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("8"),
                },
                completion_reason="deadline",
            ),
        )

    first, replay = asyncio.run(run())

    assert first.decision == "ended"
    assert replay.decision == "ended"
    assert first.settlement is not None
    assert replay.settlement is None
    assert model_usage_db.scalar(
        select(ModelUsageEvent.id).where(
            ModelUsageEvent.attempt_key == "realtime:voice-session-concurrent-terminal:turn-concurrent-terminal:duplex:lease:1"
        )
    ) == first.settlement.event_id
    rows = tuple(
        model_usage_db.scalars(
            select(ModelUsageRealtimeWatermark).where(
                ModelUsageRealtimeWatermark.session_key == "voice-session-concurrent-terminal"
            )
        )
    )
    assert len(rows) == 2
    assert {row.sequence for row in rows} == {1}


def test_realtime_scope_budget_blocked_renewal_never_authorizes_a_second_provider_send(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    publish(model_usage_db, raw_manifest())
    set_policy(
        model_usage_db,
        reservation_context,
        budget=Decimal("100"),
        hard=True,
        limits=(
            CapabilityLimitCommand(
                capability=ModelUsageCapability.REALTIME_AUDIO,
                limit_kind=ModelUsageLimitKind.METER,
                meter=ModelUsageMeter.AUDIO_INPUT_TOKENS,
                limit_value=Decimal("3000"),
            ),
        ),
        active_variants=(configured_test_variants()[5],),
    )
    adapter = _adapter(model_usage_db, realtime_signer)
    session = RealtimeVoiceSessionState(
        session_id="voice-session-budget-blocked-renewal",
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        config_revision_id="revision-test",
        provider_profile_id="profile-test",
        provider_profile_version_id="profile-version-test",
        requested_model="realtime-test",
        binding_identity_checksum="checksum-test",
        adapter_kind="dashscope",
        recipe_id="recipe-budget-blocked-renewal",
        cook_session_id="cook-budget-blocked-renewal",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=NOW,
        expires_at=NOW + timedelta(minutes=5),
    )

    async def run() -> None:
        scope = RealtimeProviderScope(session=session, usage_adapter=adapter)
        async with scope.provider_audio_operation(
            turn_id="turn-budget-blocked-renewal",
            segment="duplex",
            direction="input",
            provider_model="realtime-test",
            at=NOW,
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
            },
        ) as first:
            assert first.decision == "active"
            first.add_input_seconds(Decimal("1"))

        async with scope.provider_audio_operation(
            turn_id="turn-budget-blocked-renewal",
            segment="duplex",
            direction="input",
            provider_model="realtime-test",
            at=NOW + timedelta(seconds=30),
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
            },
        ) as blocked:
            assert blocked.decision == "blocked"
            assert blocked.lease is None

    asyncio.run(run())

    assert session.remote_voice_ended is True
    assert session.active_usage_lease is None
    assert session.next_lease_sequence == 2
    reservations = tuple(
        model_usage_db.scalars(
            select(ModelUsageReservation).where(
                ModelUsageReservation.attempt_key.like(
                    "realtime:voice-session-budget-blocked-renewal:%"
                )
            )
        )
    )
    assert len(reservations) == 1
    assert reservations[0].status is ModelUsageReservationStatus.SETTLED
    assert model_usage_db.scalar(
        select(ModelUsageEvent.id).where(
            ModelUsageEvent.attempt_key == reservations[0].attempt_key
        )
    ) is not None


def test_realtime_scope_missing_terminal_boundary_data_never_opens_a_new_lease(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    session = RealtimeVoiceSessionState(
        session_id="voice-session-pending-renewal",
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        config_revision_id="revision-test",
        provider_profile_id="profile-test",
        provider_profile_version_id="profile-version-test",
        requested_model="realtime-test",
        binding_identity_checksum="checksum-test",
        adapter_kind="dashscope",
        recipe_id="recipe-pending-renewal",
        cook_session_id="cook-pending-renewal",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=NOW,
        expires_at=NOW + timedelta(minutes=5),
    )

    async def run() -> None:
        scope = RealtimeProviderScope(session=session, usage_adapter=adapter)
        async with scope.provider_audio_operation(
            turn_id="turn-pending-renewal",
            segment="duplex",
            direction="input",
            provider_model="realtime-test",
            at=NOW,
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
            },
        ) as first:
            first.add_input_seconds(Decimal("1"))

        async with scope.provider_audio_operation(
            turn_id="turn-pending-renewal",
            segment="duplex",
            direction="input",
            provider_model="realtime-test",
            at=NOW + timedelta(seconds=30),
            provider_cumulative={},
        ) as pending:
            assert pending.decision == "settlement_pending"
            assert pending.lease is session.active_usage_lease

    asyncio.run(run())

    assert session.remote_voice_ended is True
    assert session.active_usage_lease is not None
    assert session.active_usage_lease.terminal_state == "settlement_pending"
    assert session.next_lease_sequence == 2
    assert model_usage_db.scalar(
        select(ModelUsageEvent.id).where(
            ModelUsageEvent.attempt_key.like("realtime:voice-session-pending-renewal:%")
        )
    ) is None


def test_realtime_scope_late_pre_send_cumulative_growth_blocks_renewal(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    session = RealtimeVoiceSessionState(
        session_id="voice-session-late-cumulative",
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        config_revision_id="revision-test",
        provider_profile_id="profile-test",
        provider_profile_version_id="profile-version-test",
        requested_model="realtime-test",
        binding_identity_checksum="checksum-test",
        adapter_kind="dashscope",
        recipe_id="recipe-late-cumulative",
        cook_session_id="cook-late-cumulative",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=NOW,
        expires_at=NOW + timedelta(minutes=5),
    )

    async def run() -> None:
        scope = RealtimeProviderScope(session=session, usage_adapter=adapter)
        async with scope.provider_audio_operation(
            turn_id="turn-late-cumulative",
            segment="duplex",
            direction="input",
            provider_model="realtime-test",
            at=NOW,
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
            },
        ) as first:
            first.add_input_seconds(Decimal("1"))

        terminal = await scope.finish_current_lease_once(
            at=NOW + timedelta(seconds=1),
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
            },
            completion_reason="segment_end",
        )
        assert terminal.decision == "ended"

        async with scope.provider_audio_operation(
            turn_id="turn-late-cumulative",
            segment="duplex",
            direction="input",
            provider_model="realtime-test",
            at=NOW + timedelta(seconds=2),
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("105"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
            },
        ) as pending:
            assert pending.decision == "settlement_pending"
            assert pending.lease is None

    asyncio.run(run())

    assert session.remote_voice_ended is True
    assert session.active_usage_lease is None
    assert session.next_lease_sequence == 2
    assert model_usage_db.scalar(
        select(ModelUsageEvent.id).where(
            ModelUsageEvent.attempt_key.like("realtime:voice-session-late-cumulative:%")
        )
    ) is not None


def test_realtime_terminal_receipt_rejects_a_durable_watermark_baseline_conflict(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    family_id = reservation_context.attribution.family_id
    user_id = reservation_context.attribution.actor_user_id or "user-test"
    first = adapter.begin_lease(
        family_id=family_id,
        user_id=user_id,
        session_id="voice-session-baseline-conflict",
        turn_id="voice-turn-baseline-conflict",
        segment="duplex",
        lease_sequence=1,
        at=NOW,
        server_input_total=Decimal("0"),
        server_output_total=Decimal("0"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
        },
        previous_provider_watermarks={},
    )
    adapter.finish_lease(
        first,
        server_input_total=Decimal("30"),
        server_output_total=Decimal("18"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
        },
        completed_at=NOW + timedelta(seconds=30),
    )
    second = adapter.begin_lease(
        family_id=family_id,
        user_id=user_id,
        session_id="voice-session-baseline-conflict",
        turn_id="voice-turn-baseline-conflict",
        segment="duplex",
        lease_sequence=2,
        at=NOW + timedelta(seconds=30),
        server_input_total=Decimal("30"),
        server_output_total=Decimal("18"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
        },
        previous_provider_watermarks={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
        },
    )
    durable = model_usage_db.scalar(
        select(ModelUsageRealtimeWatermark)
        .where(
            ModelUsageRealtimeWatermark.session_key == "voice-session-baseline-conflict",
            ModelUsageRealtimeWatermark.meter == ModelUsageMeter.AUDIO_INPUT_TOKENS,
        )
        .with_for_update()
    )
    assert durable is not None
    durable.cumulative_quantity = Decimal("145")
    model_usage_db.flush()

    with pytest.raises(ModelUsageSettlementPending, match="realtime_watermark_baseline_conflict"):
        adapter.finish_lease(
            second,
            server_input_total=Decimal("35"),
            server_output_total=Decimal("21"),
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("180"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("115"),
            },
            completed_at=NOW + timedelta(seconds=35),
        )


def test_realtime_terminal_receipt_rejects_a_decreasing_provider_watermark(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    lease = adapter.begin_lease(
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        session_id="voice-session-decreasing-watermark",
        turn_id="voice-turn-decreasing-watermark",
        segment="duplex",
        lease_sequence=1,
        at=NOW,
        server_input_total=Decimal("0"),
        server_output_total=Decimal("0"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
        },
        previous_provider_watermarks={},
    )

    with pytest.raises(ModelUsageSettlementPending, match="realtime_watermark_decreased"):
        adapter.finish_lease(
            lease,
            server_input_total=Decimal("1"),
            server_output_total=Decimal("1"),
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("99"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
            },
            completed_at=NOW + timedelta(seconds=1),
        )

    assert lease.terminal_state == "settlement_pending"
    assert model_usage_db.scalar(
        select(ModelUsageEvent.id).where(
            ModelUsageEvent.attempt_key == lease.attempt_key
        )
    ) is None


def test_realtime_scope_deadline_ends_a_quiet_lease_when_boundary_usage_is_missing(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    now = utcnow()
    session = RealtimeVoiceSessionState(
        session_id="voice-session-deadline",
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        config_revision_id="revision-test",
        provider_profile_id="profile-test",
        provider_profile_version_id="profile-version-test",
        requested_model="realtime-test",
        binding_identity_checksum="checksum-test",
        adapter_kind="dashscope",
        recipe_id="recipe-deadline",
        cook_session_id="cook-deadline",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=now,
        expires_at=now + timedelta(minutes=5),
    )

    async def run() -> None:
        scope = RealtimeProviderScope(
            session=session,
            usage_adapter=adapter,
            schedule_deadlines=True,
        )
        async with scope.provider_audio_operation(
            turn_id="turn-deadline",
            segment="duplex",
            direction="input",
            provider_model="realtime-test",
            at=now - timedelta(seconds=31),
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
            },
        ) as operation:
            assert operation.decision == "active"
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        assert session.active_usage_lease is not None
        assert session.active_usage_lease.terminal_state == "settlement_pending"
        assert session.remote_voice_ended is True

    asyncio.run(run())


def test_realtime_scope_marks_an_ambiguous_provider_failure_uncertain(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    session = RealtimeVoiceSessionState(
        session_id="voice-session-uncertain",
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        config_revision_id="revision-test",
        provider_profile_id="profile-test",
        provider_profile_version_id="profile-version-test",
        requested_model="realtime-test",
        binding_identity_checksum="checksum-test",
        adapter_kind="dashscope",
        recipe_id="recipe-uncertain",
        cook_session_id="cook-uncertain",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=NOW,
        expires_at=NOW + timedelta(minutes=5),
    )
    reservation_id: str | None = None

    async def run() -> None:
        nonlocal reservation_id
        scope = RealtimeProviderScope(session=session, usage_adapter=adapter)
        with pytest.raises(RuntimeError, match="provider transport lost"):
            async with scope.provider_audio_operation(
                turn_id="turn-uncertain",
                segment="duplex",
                direction="input",
                provider_model="realtime-test",
                at=NOW,
                provider_cumulative={
                    ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
                    ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
                },
            ) as operation:
                assert operation.lease is not None
                reservation_id = operation.lease.dispatch_permit.reservation_id
                raise RuntimeError("provider transport lost")

    asyncio.run(run())

    assert reservation_id is not None
    assert session.remote_voice_ended is True
    assert session.active_usage_lease is not None
    assert session.active_usage_lease.terminal_state == "settlement_pending"
    reservation = model_usage_db.get(ModelUsageReservation, reservation_id)
    assert reservation is not None
    assert reservation.status is ModelUsageReservationStatus.UNCERTAIN


def test_realtime_scope_can_clear_a_completed_deadline_after_its_event_loop_closed() -> None:
    """Session-store cleanup may run outside the event loop that owned a lease."""

    session = RealtimeVoiceSessionState(
        session_id="voice-session-sync-deadline-cleanup",
        family_id="family-test",
        user_id="user-test",
        config_revision_id="revision-test",
        provider_profile_id="profile-test",
        provider_profile_version_id="profile-version-test",
        requested_model="realtime-test",
        binding_identity_checksum="checksum-test",
        adapter_kind="dashscope",
        recipe_id="recipe-test",
        cook_session_id="cook-test",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=NOW,
        expires_at=NOW + timedelta(minutes=5),
    )
    scope = RealtimeProviderScope(session=session, usage_adapter=object())  # type: ignore[arg-type]

    async def finish_deadline_task() -> None:
        task = asyncio.create_task(asyncio.sleep(0))
        await task
        scope._deadline_task = task  # noqa: SLF001 - exercise public cleanup across event-loop boundary

    asyncio.run(finish_deadline_task())

    scope.cancel_deadline()

    assert scope._deadline_task is None  # noqa: SLF001 - observable cleanup state


def test_realtime_session_expiry_terminalizes_a_quiet_lease_before_the_lease_deadline(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    """A short-lived voice session may not retain a 30-second dispatch permit."""

    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    now = utcnow()
    session = RealtimeVoiceSessionState(
        session_id="voice-session-expiry-deadline",
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        config_revision_id="revision-test",
        provider_profile_id="profile-test",
        provider_profile_version_id="profile-version-test",
        requested_model="realtime-test",
        binding_identity_checksum="checksum-test",
        adapter_kind="dashscope",
        recipe_id="recipe-expiry-deadline",
        cook_session_id="cook-expiry-deadline",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=now,
        expires_at=now + timedelta(milliseconds=30),
    )

    async def run() -> None:
        scope = RealtimeProviderScope(
            session=session,
            usage_adapter=adapter,
            schedule_deadlines=True,
        )
        async with scope.provider_audio_operation(
            turn_id="turn-expiry-deadline",
            segment="duplex",
            direction="input",
            provider_model="realtime-test",
            at=now,
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
            },
        ) as operation:
            assert operation.decision == "active"
            operation.add_input_seconds(Decimal("1"))

        await asyncio.sleep(0.1)

        assert session.remote_voice_ended is True
        assert session.active_usage_lease is not None
        assert session.active_usage_lease.terminal_state == "settlement_pending"
        async with scope.provider_audio_operation(
            turn_id="turn-expiry-deadline",
            segment="duplex",
            direction="input",
            provider_model="realtime-test",
            at=now + timedelta(seconds=1),
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
            },
        ) as expired:
            assert expired.decision == "ended"

    asyncio.run(run())


def test_realtime_scope_interrupts_an_inflight_provider_operation_at_the_deadline(
    model_usage_db: Session,
    reservation_context,
    realtime_signer: ProviderUsageReceiptSigner,
) -> None:
    """A long provider stream cannot retain a lease past the session deadline."""

    publish(model_usage_db, raw_manifest())
    adapter = _adapter(model_usage_db, realtime_signer)
    now = utcnow()
    session = RealtimeVoiceSessionState(
        session_id="voice-session-inflight-deadline",
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        config_revision_id="revision-test",
        provider_profile_id="profile-test",
        provider_profile_version_id="profile-version-test",
        requested_model="realtime-test",
        binding_identity_checksum="checksum-test",
        adapter_kind="dashscope",
        recipe_id="recipe-inflight-deadline",
        cook_session_id="cook-inflight-deadline",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=now,
        expires_at=now + timedelta(milliseconds=30),
    )

    async def run() -> None:
        from fastapi import HTTPException

        scope = RealtimeProviderScope(session=session, usage_adapter=adapter)
        with pytest.raises(HTTPException) as exc_info:
            async with scope.provider_audio_operation(
                turn_id="turn-inflight-deadline",
                segment="duplex",
                direction="input",
                provider_model="realtime-test",
                at=now,
                provider_cumulative={
                    ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
                    ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
                },
            ) as operation:
                operation.add_input_seconds(Decimal("1"))
                await asyncio.sleep(0.1)

        assert exc_info.value.status_code == 429
        assert exc_info.value.detail["code"] == "realtime_lease_expired"

    asyncio.run(run())

    assert session.remote_voice_ended is True
    assert session.active_usage_lease is not None
    assert session.active_usage_lease.terminal_state == "settlement_pending"
    reservation = model_usage_db.scalar(
        select(ModelUsageReservation).where(
            ModelUsageReservation.attempt_key.like("realtime:voice-session-inflight-deadline:%")
        )
    )
    assert reservation is not None
    assert reservation.status is ModelUsageReservationStatus.UNCERTAIN


def test_realtime_scope_uses_the_physical_send_clock_after_dispatch_setup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A slow reserve/dispatch setup cannot revive an already-expired permit."""

    from app.services.ai_audio import realtime as realtime_module

    started_at = datetime(2026, 7, 30, 3, 0, tzinfo=timezone.utc)
    now_values = iter((started_at, started_at + timedelta(seconds=31)))
    monkeypatch.setattr(realtime_module, "utcnow", lambda: next(now_values))

    class Attempt:
        def __init__(self) -> None:
            self.uncertain_codes: list[str] = []

        def mark_uncertain(self, code: str) -> None:
            self.uncertain_codes.append(code)

    attempt = Attempt()
    lease = SimpleNamespace(
        expires_at=started_at + timedelta(seconds=30),
        attempt=attempt,
        attempt_key="realtime:voice-session-physical-clock:turn:duplex:lease:1",
        terminal_state="active",
    )

    class Adapter:
        def __init__(self) -> None:
            self.aborted_leases: list[object] = []

        def validate_provider_model(self, **_kwargs: object) -> None:
            return None

        def begin_lease(self, **_kwargs: object):
            return lease

        def abort_lease_before_provider_send(self, aborted_lease, *, completed_at: datetime):
            self.aborted_leases.append((aborted_lease, completed_at))
            aborted_lease.terminal_state = "terminal"
            return SimpleNamespace(event_id="usage-event-no-provider-send")

    session = RealtimeVoiceSessionState(
        session_id="voice-session-physical-clock",
        family_id="family-test",
        user_id="user-test",
        config_revision_id="revision-test",
        provider_profile_id="profile-test",
        provider_profile_version_id="profile-version-test",
        requested_model="realtime-test",
        binding_identity_checksum="checksum-test",
        adapter_kind="dashscope",
        recipe_id="recipe-test",
        cook_session_id="cook-test",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=started_at,
        expires_at=started_at + timedelta(minutes=5),
    )

    async def run() -> None:
        from fastapi import HTTPException

        adapter = Adapter()
        scope = RealtimeProviderScope(session=session, usage_adapter=adapter)  # type: ignore[arg-type]
        with pytest.raises(HTTPException) as exc_info:
            async with scope.provider_audio_operation(
                turn_id="turn",
                segment="duplex",
                direction="input",
                provider_model="realtime-test",
                provider_cumulative={},
            ):
                raise AssertionError("expired permit must not authorize a provider send")
        assert exc_info.value.status_code == 429
        assert exc_info.value.detail["code"] == "realtime_lease_expired"
        assert adapter.aborted_leases == [(lease, started_at + timedelta(seconds=31))]

    asyncio.run(run())

    assert session.remote_voice_ended is True
    assert session.active_usage_lease is None
    assert lease.terminal_state == "terminal"
    assert attempt.uncertain_codes == []
