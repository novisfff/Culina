from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal
from threading import Barrier

from sqlalchemy import func, select

from app.core.enums import (
    ModelUsageCapability,
    ModelUsageMeter,
    ModelUsageMeterRole,
)
from app.models.model_usage import (
    ModelUsageEvent,
    ModelUsagePeriodCounter,
    ModelUsagePriceRate,
    ModelUsagePriceVersion,
    ModelUsageRealtimeWatermark,
)
from app.services.model_usage.adapters.realtime_audio import RealtimeAudioUsageAdapter
from app.services.model_usage.configured_variants import (
    ConfiguredUsageVariant,
    ProviderUsageContract,
)
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.settlement import settle_usage
from tests.model_usage.test_reservation_mysql_concurrency import (
    NOW,
    MysqlReservationContext,
)


pytest_plugins = ("tests.model_usage.test_reservation_mysql_concurrency",)


def _adapter(context: MysqlReservationContext) -> RealtimeAudioUsageAdapter:
    with context.SessionLocal() as db:
        version = db.get(ModelUsagePriceVersion, "price-mysql-reserve")
        assert version is not None
        db.add_all(
            (
                ModelUsagePriceRate(
                    id="rate-mysql-realtime-input",
                    price_version_id=version.id,
                    provider="test",
                    billing_model="realtime-test",
                    capability=ModelUsageCapability.REALTIME_AUDIO,
                    variant_key="voice=default",
                    billing_scheme_key="realtime-token-test-v1",
                    meter=ModelUsageMeter.AUDIO_INPUT_TOKENS,
                    meter_role=ModelUsageMeterRole.BILLABLE,
                    unit_quantity=Decimal("1"),
                    unit_price=Decimal("0.001"),
                    source_currency="CNY",
                    fx_to_cny=Decimal("1"),
                    unit_price_cny=Decimal("0.001"),
                    reported_model_aliases=[],
                ),
                ModelUsagePriceRate(
                    id="rate-mysql-realtime-output",
                    price_version_id=version.id,
                    provider="test",
                    billing_model="realtime-test",
                    capability=ModelUsageCapability.REALTIME_AUDIO,
                    variant_key="voice=default",
                    billing_scheme_key="realtime-token-test-v1",
                    meter=ModelUsageMeter.AUDIO_OUTPUT_TOKENS,
                    meter_role=ModelUsageMeterRole.BILLABLE,
                    unit_quantity=Decimal("1"),
                    unit_price=Decimal("0.001"),
                    source_currency="CNY",
                    fx_to_cny=Decimal("1"),
                    unit_price_cny=Decimal("0.001"),
                    reported_model_aliases=[],
                ),
            )
        )
        db.commit()
    signer = ProviderUsageReceiptSigner(
        active_key_id="mysql-realtime-key",
        keys={"mysql-realtime-key": b"mysql-realtime-secret"},
    )
    return RealtimeAudioUsageAdapter(
        billing_variant=ConfiguredUsageVariant(
            provider="test",
            billing_model="realtime-test",
            capability=ModelUsageCapability.REALTIME_AUDIO,
            variant_key="voice=default",
            billing_scheme_key="realtime-token-test-v1",
            billable_meters=frozenset(
                {
                    ModelUsageMeter.AUDIO_INPUT_TOKENS,
                    ModelUsageMeter.AUDIO_OUTPUT_TOKENS,
                }
            ),
            produced_meters=frozenset(
                {
                    ModelUsageMeter.AUDIO_INPUT_SECONDS,
                    ModelUsageMeter.AUDIO_OUTPUT_SECONDS,
                    ModelUsageMeter.AUDIO_INPUT_TOKENS,
                    ModelUsageMeter.AUDIO_OUTPUT_TOKENS,
                }
            ),
            input_tokens_per_second_cap=Decimal("100"),
            output_tokens_per_second_cap=Decimal("200"),
            lease_boundary_cumulative_meters=frozenset(
                {
                    ModelUsageMeter.AUDIO_INPUT_TOKENS,
                    ModelUsageMeter.AUDIO_OUTPUT_TOKENS,
                }
            ),
            provider_contract=ProviderUsageContract(
                supports_lease_boundary_cumulative_usage=True,
            ),
        ),
        usage_facade=ModelUsageFacade(session_factory=context.SessionLocal, clock=lambda: NOW),
        session_factory=context.SessionLocal,
        signer=signer,
        clock=lambda: NOW,
    )


def _signed_receipt(
    context: MysqlReservationContext,
) -> tuple[RealtimeAudioUsageAdapter, object]:
    adapter = _adapter(context)
    lease = adapter.begin_lease(
        family_id="family-mysql-reserve",
        user_id="owner-mysql-reserve",
        session_id="mysql-realtime-session",
        turn_id="mysql-realtime-turn",
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
    return (
        adapter,
        adapter._receipt_for_terminal_lease(  # noqa: SLF001 - exact signed recovery payload
            lease,
            server_input_total=Decimal("30"),
            server_output_total=Decimal("18"),
            provider_cumulative={
                ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100"),
                ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80"),
            },
            completed_at=NOW + timedelta(seconds=30),
        ),
    )


def test_mysql_concurrent_terminal_callbacks_claim_one_event_and_watermark_advance(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    adapter, receipt = _signed_receipt(mysql_reservation_context)
    barrier = Barrier(50)

    def settle_once(_: int):
        barrier.wait()
        return settle_usage(
            receipt,
            signer=adapter.signer,
            session_factory=mysql_reservation_context.SessionLocal,
        )

    with ThreadPoolExecutor(max_workers=50) as pool:
        results = list(pool.map(settle_once, range(50)))

    assert len({result.event_id for result in results}) == 1
    with mysql_reservation_context.SessionLocal() as db:
        assert db.scalar(
            select(func.count())
            .select_from(ModelUsageEvent)
            .where(ModelUsageEvent.attempt_key == receipt.attempt_key)
        ) == 1
        rows = tuple(
            db.scalars(
                select(ModelUsageRealtimeWatermark)
                .where(ModelUsageRealtimeWatermark.session_key == "mysql-realtime-session")
                .order_by(ModelUsageRealtimeWatermark.meter)
            )
        )
        assert {row.meter: row.cumulative_quantity for row in rows} == {
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("100.000000"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("80.000000"),
        }
        settled = db.scalar(
            select(ModelUsagePeriodCounter.settled_value).where(
                ModelUsagePeriodCounter.family_id == "family-mysql-reserve",
                ModelUsagePeriodCounter.dimension_key == "family_cost",
            )
        )
        assert settled == Decimal("0.180000000000")
