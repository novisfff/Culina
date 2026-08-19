from __future__ import annotations

"""Real-family smoke driver using the published capability-test protocol.

The former implementation reconstructed the removed process-wide Provider
configuration directly. This driver deliberately goes through the same family
revision resolver, reservation, dispatch, and settlement path as the
Owner-initiated billable capability tests. It therefore cannot turn legacy
environment variables into a provider send.
"""

from dataclasses import dataclass
from typing import cast

from sqlalchemy import select

from app.core.config import get_settings
from app.core.enums import MembershipStatus, ModelUsageCapability
from app.core.utils import create_id
from app.db.session import SessionLocal
from app.models.domain import Family, Membership, User
from app.repos.family_model_settings.idempotency import get_operation_receipt
from app.services.family_model_settings.capability_tests import (
    CapabilityTestCommand,
    CapabilityTestDependencies,
    run_family_capability_test,
)
from app.services.family_model_settings.credentials import FamilyModelCredentialCipher
from app.services.family_model_settings.errors import FamilyModelSettingsError
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy
from app.services.family_model_settings.resolver import FamilyModelConfigurationResolver
from app.services.family_model_settings.transport import ProviderTransport
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.preflight import decode_receipt_integrity_keyring


_EXPECTED_CAPABILITIES = frozenset(ModelUsageCapability)
_SMOKE_VARIANTS: dict[ModelUsageCapability, str] = {
    ModelUsageCapability.LLM: "primary",
    ModelUsageCapability.EMBEDDING: "search",
    ModelUsageCapability.RERANK: "search",
    ModelUsageCapability.STT: "default",
    ModelUsageCapability.TTS: "default",
    ModelUsageCapability.REALTIME_AUDIO: "default",
    ModelUsageCapability.IMAGE_GENERATION: "text",
}


class ProviderSmokeDriverError(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class ProviderSmokeResult:
    capability: ModelUsageCapability
    event_id: str


class CulinaProviderSmokeDriver:
    """Send one minimal metered probe for every published family capability.

    No prompt, transcript, audio, image, URL, provider response, family ID, or
    user ID is returned to the CLI artifact. The only result is the settled
    model-usage event ID for each capability.
    """

    def __init__(self, *, family_id: str, user_id: str) -> None:
        self.family_id = family_id
        self.user_id = user_id
        self.settings = get_settings()
        self.run_id = create_id("provider-smoke")
        self._dependencies: CapabilityTestDependencies | None = None
        self._validated = False

    def run(self, capability: ModelUsageCapability) -> ProviderSmokeResult:
        if capability not in _EXPECTED_CAPABILITIES:
            raise ProviderSmokeDriverError("provider_smoke_capability_invalid")
        if not self._validated:
            self._validate_before_provider_send()
            self._validated = True
        try:
            event_id = self._run_capability(capability)
        except ProviderSmokeDriverError:
            raise
        except Exception as exc:
            raise ProviderSmokeDriverError(
                f"provider_smoke_{capability.value}_failed"
            ) from exc
        if not event_id:
            raise ProviderSmokeDriverError(
                f"provider_smoke_{capability.value}_event_missing"
            )
        return ProviderSmokeResult(capability=capability, event_id=event_id)

    def _capability_test_dependencies(self) -> CapabilityTestDependencies:
        dependencies = self._dependencies
        if dependencies is None:
            settings = self.settings
            cipher = FamilyModelCredentialCipher.from_settings(settings)
            policy = ProviderNetworkPolicy.from_settings(settings)
            dependencies = CapabilityTestDependencies(
                cipher=cipher,
                network_policy=policy,
                transport=ProviderTransport.from_settings(settings, policy=policy),
                usage_facade=ModelUsageFacade(),
                signer=decode_receipt_integrity_keyring(settings).signer(),
            )
            self._dependencies = dependencies
        return dependencies

    def _validate_before_provider_send(self) -> None:
        if not bool(getattr(self.settings, "model_usage_required", False)):
            raise ProviderSmokeDriverError("provider_smoke_model_usage_required")

        with SessionLocal() as db:
            family_exists = db.get(Family, self.family_id) is not None
            user = db.get(User, self.user_id)
            membership = db.scalar(
                select(Membership).where(
                    Membership.family_id == self.family_id,
                    Membership.user_id == self.user_id,
                    Membership.status == MembershipStatus.ACTIVE,
                )
            )
            if not family_exists or user is None or not user.is_active or membership is None:
                raise ProviderSmokeDriverError("provider_smoke_membership_required")

            try:
                dependencies = self._capability_test_dependencies()
                resolver = FamilyModelConfigurationResolver(
                    db,
                    cipher=dependencies.cipher,
                    network_policy=dependencies.network_policy,
                )
                for capability, variant_key in _SMOKE_VARIANTS.items():
                    resolver.resolve_active(
                        self.family_id,
                        cast(str, capability.value),
                        variant_key,
                    )
            except FamilyModelSettingsError as exc:
                raise ProviderSmokeDriverError(
                    "provider_smoke_family_configuration_required"
                ) from exc
            except Exception as exc:
                raise ProviderSmokeDriverError(
                    "provider_smoke_family_configuration_invalid"
                ) from exc

    def _idempotency_key(self, capability: ModelUsageCapability) -> str:
        return f"provider-smoke-{self.run_id}-{capability.value}"

    def _run_capability(self, capability: ModelUsageCapability) -> str:
        variant_key = _SMOKE_VARIANTS[capability]
        idempotency_key = self._idempotency_key(capability)
        with SessionLocal() as db:
            result = run_family_capability_test(
                db,
                CapabilityTestCommand(
                    family_id=self.family_id,
                    actor_user_id=self.user_id,
                    capability=cast(str, capability.value),
                    variant_key=variant_key,
                    confirm_billable=True,
                    idempotency_key=idempotency_key,
                ),
                dependencies=self._capability_test_dependencies(),
            )
            if result.status != "succeeded":
                raise ProviderSmokeDriverError(
                    f"provider_smoke_{capability.value}_{result.status}"
                )
            receipt = get_operation_receipt(
                db,
                family_id=self.family_id,
                operation="family_model_capability_test",
                idempotency_key=idempotency_key,
            )
        event_id = receipt.result_id if receipt is not None else None
        if not isinstance(event_id, str) or not event_id:
            raise ProviderSmokeDriverError(
                f"provider_smoke_{capability.value}_event_missing"
            )
        return event_id
