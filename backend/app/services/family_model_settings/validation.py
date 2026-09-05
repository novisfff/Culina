from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from types import MappingProxyType

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    FamilyModelConfigRevisionStatus,
    FamilyModelProviderStatus,
    FamilyModelSecretStatus,
    ModelUsageCapability,
    ModelUsageMeter,
)
from app.core.utils import utcnow
from app.models.family_model_settings import (
    FamilyModelConfigDraft,
    FamilyModelProviderProfile,
    FamilyModelProviderProfileVersion,
    FamilyModelSecretVersion,
    FamilyModelSettings,
    FamilySearchProfile,
)
from app.repos.family_model_settings.configurations import (
    get_config_revision,
    get_search_profile,
    require_config_draft,
    require_draft_version,
)
from app.repos.family_model_settings.profiles import (
    get_current_provider_profile_version,
    get_current_provider_secret_version,
    get_provider_profile,
    lock_family_model_settings,
)
from app.schemas.family_model_settings import (
    FamilyModelBindingDraft,
    FamilyModelConfigDraftPayload,
    FamilyModelPriceRateRequest,
)
from app.services.family_model_settings.adapter_registry import (
    adapter_definition,
    require_adapter_endpoint_contract,
    require_adapter_support,
)
from app.services.family_model_settings.errors import (
    FamilyModelDraftInvalid,
    FamilyModelEndpointBlocked,
    FamilyModelProviderProtocolUnsupported,
)
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy


_CNY_QUANTUM = Decimal("0.000000000001")
_BINDING_OPTION_FIELDS = frozenset(
    {
        "capability",
        "variant_key",
        "enabled",
        "provider_profile_id",
        "requested_model",
        "billing_scheme_key",
    }
)
_REQUIRED_METERS: Mapping[ModelUsageCapability, frozenset[ModelUsageMeter]] = MappingProxyType(
    {
        ModelUsageCapability.LLM: frozenset(
            {
                ModelUsageMeter.UNCACHED_INPUT_TOKENS,
                ModelUsageMeter.CACHED_INPUT_TOKENS,
                ModelUsageMeter.OUTPUT_TOKENS,
            }
        ),
        ModelUsageCapability.IMAGE_GENERATION: frozenset(
            {ModelUsageMeter.GENERATED_IMAGES}
        ),
        ModelUsageCapability.STT: frozenset({ModelUsageMeter.AUDIO_INPUT_SECONDS}),
        ModelUsageCapability.TTS: frozenset({ModelUsageMeter.TTS_CHARACTERS}),
        ModelUsageCapability.REALTIME_AUDIO: frozenset(
            {ModelUsageMeter.AUDIO_INPUT_SECONDS, ModelUsageMeter.TTS_CHARACTERS}
        ),
        ModelUsageCapability.EMBEDDING: frozenset({ModelUsageMeter.EMBEDDING_TOKENS}),
        ModelUsageCapability.RERANK: frozenset({ModelUsageMeter.INPUT_TOKENS}),
    }
)
_DEFAULT_UNIT_QUANTITIES: Mapping[ModelUsageMeter, Decimal] = MappingProxyType(
    {
        ModelUsageMeter.GENERATED_IMAGES: Decimal("1"),
        ModelUsageMeter.AUDIO_INPUT_SECONDS: Decimal("60"),
        ModelUsageMeter.TTS_CHARACTERS: Decimal("1000"),
    }
)


@dataclass(frozen=True, slots=True)
class DraftValidationIssue:
    code: str
    field: str | None = None

    def record(self) -> dict[str, str]:
        record = {"code": self.code}
        if self.field:
            record["field"] = self.field
        return record


@dataclass(frozen=True, slots=True)
class ValidatedCapabilityBinding:
    capability: ModelUsageCapability
    variant_key: str
    enabled: bool
    provider_profile_id: str | None
    provider_profile_version_id: str | None
    requested_model: str
    billing_scheme_key: str
    options: Mapping[str, object]
    identity_checksum: str
    billable_meters: frozenset[ModelUsageMeter]
    profile: FamilyModelProviderProfile | None = None
    profile_version: FamilyModelProviderProfileVersion | None = None

    def checksum_record(self) -> dict[str, object]:
        return {
            "capability": self.capability.value,
            "variant_key": self.variant_key,
            "enabled": self.enabled,
            "provider_profile_id": self.provider_profile_id,
            "provider_profile_version_id": self.provider_profile_version_id,
            "requested_model": self.requested_model,
            "billing_scheme_key": self.billing_scheme_key,
            "options": dict(self.options),
            "identity_checksum": self.identity_checksum,
        }


@dataclass(frozen=True, slots=True)
class ValidatedFamilyPriceRate:
    capability: ModelUsageCapability
    variant_key: str
    meter: ModelUsageMeter
    provider: str
    billing_model: str
    billing_scheme_key: str
    unit_quantity: Decimal
    unit_price: Decimal
    source_currency: str
    fx_to_cny: Decimal
    unit_price_cny: Decimal
    reported_model_aliases: tuple[str, ...]

    def checksum_record(self) -> dict[str, object]:
        return {
            "capability": self.capability.value,
            "variant_key": self.variant_key,
            "meter": self.meter.value,
            "provider": self.provider,
            "billing_model": self.billing_model,
            "billing_scheme_key": self.billing_scheme_key,
            "unit_quantity": str(self.unit_quantity),
            "unit_price": str(self.unit_price),
            "source_currency": self.source_currency,
            "fx_to_cny": str(self.fx_to_cny),
            "unit_price_cny": str(self.unit_price_cny),
            "reported_model_aliases": list(self.reported_model_aliases),
        }


@dataclass(frozen=True, slots=True)
class ValidateDraftCommand:
    family_id: str
    actor_user_id: str
    network_policy: ProviderNetworkPolicy
    base_draft_version_number: int | None = None


@dataclass(frozen=True, slots=True)
class DraftValidationResult:
    draft_version_number: int
    payload: FamilyModelConfigDraftPayload
    search_profile_id: str | None
    bindings: tuple[ValidatedCapabilityBinding, ...]
    price_rates: tuple[ValidatedFamilyPriceRate, ...]
    errors: tuple[DraftValidationIssue, ...]
    config_checksum: str | None
    price_checksum: str | None

    @property
    def valid(self) -> bool:
        return not self.errors

    @property
    def profile_version_ids(self) -> frozenset[str]:
        return frozenset(
            binding.provider_profile_version_id
            for binding in self.bindings
            if binding.enabled and binding.provider_profile_version_id is not None
        )

    def require_confirmed_checksums(
        self,
        config_checksum: str,
        price_checksum: str,
    ) -> None:
        if not self.valid:
            raise FamilyModelDraftInvalid()
        if (
            self.config_checksum is None
            or self.price_checksum is None
            or not _constant_time_equal(self.config_checksum, config_checksum)
            or not _constant_time_equal(self.price_checksum, price_checksum)
        ):
            raise FamilyModelDraftInvalid("family_model_publish_checksum_mismatch")


def _canonical_json_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _constant_time_equal(left: str, right: str) -> bool:
    # Hash values are not secret, but a constant-time comparison keeps this
    # helper safe if confirmation semantics later include a protected value.
    return hmac.compare_digest(left, right)


def config_checksum(
    *,
    bindings: Sequence[ValidatedCapabilityBinding],
    profile_version_ids: Sequence[str],
    search_profile_id: str | None,
) -> str:
    canonical = {
        "bindings": [
            binding.checksum_record()
            for binding in sorted(
                bindings,
                key=lambda item: (item.capability.value, item.variant_key),
            )
        ],
        "profile_versions": sorted(profile_version_ids),
        "search_profile_id": search_profile_id,
    }
    return hashlib.sha256(_canonical_json_bytes(canonical)).hexdigest()


def price_checksum(rates: Sequence[ValidatedFamilyPriceRate]) -> str:
    canonical = [
        rate.checksum_record()
        for rate in sorted(
            rates,
            key=lambda item: (
                item.capability.value,
                item.variant_key,
                item.meter.value,
                item.provider,
                item.billing_model,
            ),
        )
    ]
    return hashlib.sha256(_canonical_json_bytes(canonical)).hexdigest()


def _binding_options(binding: FamilyModelBindingDraft) -> Mapping[str, object]:
    record = binding.model_dump(mode="json", exclude_none=True)
    return MappingProxyType(
        {key: value for key, value in record.items() if key not in _BINDING_OPTION_FIELDS}
    )


def _binding_identity_checksum(
    *,
    capability: ModelUsageCapability,
    variant_key: str,
    provider_profile_id: str | None,
    provider_profile_version_id: str | None,
    requested_model: str,
    billing_scheme_key: str,
    options: Mapping[str, object],
) -> str:
    return hashlib.sha256(
        _canonical_json_bytes(
            {
                "capability": capability.value,
                "variant_key": variant_key,
                "provider_profile_id": provider_profile_id,
                "provider_profile_version_id": provider_profile_version_id,
                "requested_model": requested_model,
                "billing_scheme_key": billing_scheme_key,
                "options": dict(options),
            }
        )
    ).hexdigest()


def _payload_validation_issues(error: ValidationError) -> tuple[DraftValidationIssue, ...]:
    """Translate stale/raw stored draft failures into stable, safe error facts.

    The HTTP schema prevents these shapes for new writes.  This branch still
    matters for a draft saved by an older deployment or inserted during an
    interrupted migration: Pydantic's default details can carry the rejected
    input, which must never become an Owner-facing error payload.
    """

    issues: list[DraftValidationIssue] = []
    for item in error.errors(include_url=False):
        location = item.get("loc", ())
        path = ".".join(str(segment) for segment in location)
        terminal = location[-1] if location else None
        if terminal == "billing_scheme_key":
            code = "family_model_billing_scheme_unsupported"
        elif terminal == "dimensions":
            code = "family_model_embedding_dimensions_required"
        else:
            code = "family_model_draft_invalid"
        issue = DraftValidationIssue(code, path or None)
        if issue not in issues:
            issues.append(issue)
    return tuple(issues) or (DraftValidationIssue("family_model_draft_invalid"),)


def _validate_enabled_binding(
    db: Session,
    *,
    family_id: str,
    binding: FamilyModelBindingDraft,
    binding_index: int,
    network_policy: ProviderNetworkPolicy,
) -> tuple[ValidatedCapabilityBinding | None, tuple[DraftValidationIssue, ...]]:
    capability = ModelUsageCapability(binding.capability)
    options = _binding_options(binding)
    field_prefix = f"bindings.{binding_index}"
    requested_model = binding.requested_model.strip()
    billing_scheme_key = binding.billing_scheme_key
    if not binding.enabled:
        return (
            ValidatedCapabilityBinding(
                capability=capability,
                variant_key=binding.variant_key,
                enabled=False,
                provider_profile_id=None,
                provider_profile_version_id=None,
                requested_model=requested_model,
                billing_scheme_key=billing_scheme_key,
                options=options,
                identity_checksum=_binding_identity_checksum(
                    capability=capability,
                    variant_key=binding.variant_key,
                    provider_profile_id=None,
                    provider_profile_version_id=None,
                    requested_model=requested_model,
                    billing_scheme_key=billing_scheme_key,
                    options=options,
                ),
                billable_meters=frozenset(),
            ),
            (),
        )
    if not requested_model:
        return None, (
            DraftValidationIssue("family_model_requested_model_required", field_prefix),
        )
    if binding.provider_profile_id is None:
        return None, (
            DraftValidationIssue("family_model_provider_required", field_prefix),
        )
    profile = get_provider_profile(
        db,
        family_id=family_id,
        profile_id=binding.provider_profile_id,
    )
    if profile is None:
        return None, (
            DraftValidationIssue("family_model_provider_not_found", field_prefix),
        )
    if profile.status is not FamilyModelProviderStatus.ACTIVE:
        return None, (
            DraftValidationIssue("family_model_provider_disabled", field_prefix),
        )
    version = get_current_provider_profile_version(
        db,
        family_id=family_id,
        profile=profile,
    )
    if version is None or version.credential_scope_checksum != profile.credential_scope_checksum:
        return None, (
            DraftValidationIssue(
                "family_model_provider_scope_change_requires_new_profile", field_prefix
            ),
        )
    try:
        definition = adapter_definition(version.adapter_kind)
        protocol = (
            "http"
            if any(item in {"http", "https"} for item in definition.http_protocols)
            else "websocket"
        )
        endpoint = network_policy.authorize(version.api_base_url, protocol=protocol)  # type: ignore[arg-type]
        require_adapter_endpoint_contract(
            kind=version.adapter_kind,
            auth_mode=version.auth_mode,
            endpoint=endpoint,
        )
        if version.websocket_base_url:
            network_policy.authorize(version.websocket_base_url, protocol="websocket")
        require_adapter_support(
            kind=version.adapter_kind,
            capability=capability.value,
            auth_mode=version.auth_mode,
            billing_scheme_key=billing_scheme_key,
        )
    except FamilyModelEndpointBlocked as exc:
        return None, (DraftValidationIssue(exc.code, field_prefix),)
    except FamilyModelProviderProtocolUnsupported:
        return None, (
            DraftValidationIssue("family_model_provider_protocol_unsupported", field_prefix),
        )
    if version.auth_mode == "api_key":
        secret = get_current_provider_secret_version(
            db,
            family_id=family_id,
            profile=profile,
        )
        if (
            secret is None
            or secret.status is not FamilyModelSecretStatus.ACTIVE
            or secret.nonce is None
            or secret.ciphertext is None
            or secret.auth_tag is None
        ):
            if profile.current_secret_version_id is not None:
                pointed_secret = db.scalar(
                    select(FamilyModelSecretVersion).where(
                        FamilyModelSecretVersion.id == profile.current_secret_version_id,
                        FamilyModelSecretVersion.family_id == family_id,
                    )
                )
                if pointed_secret is not None and pointed_secret.profile_id != profile.id:
                    return None, (
                        DraftValidationIssue(
                            "family_model_provider_scope_change_requires_new_profile",
                            field_prefix,
                        ),
                    )
            return None, (
                DraftValidationIssue("family_model_credentials_missing", field_prefix),
            )
    elif version.auth_mode != "no_auth":
        return None, (
            DraftValidationIssue("family_model_provider_protocol_unsupported", field_prefix),
        )
    return (
        ValidatedCapabilityBinding(
            capability=capability,
            variant_key=binding.variant_key,
            enabled=True,
            provider_profile_id=profile.id,
            provider_profile_version_id=version.id,
            requested_model=requested_model,
            billing_scheme_key=billing_scheme_key,
            options=options,
            identity_checksum=_binding_identity_checksum(
                capability=capability,
                variant_key=binding.variant_key,
                provider_profile_id=profile.id,
                provider_profile_version_id=version.id,
                requested_model=requested_model,
                billing_scheme_key=billing_scheme_key,
                options=options,
            ),
            billable_meters=_REQUIRED_METERS[capability],
            profile=profile,
            profile_version=version,
        ),
        (),
    )


def _validate_fallback_graph(
    bindings: Sequence[ValidatedCapabilityBinding],
) -> tuple[DraftValidationIssue, ...]:
    enabled = {
        (binding.capability, binding.variant_key)
        for binding in bindings
        if binding.enabled
    }
    if (ModelUsageCapability.LLM, "fallback") in enabled and (
        ModelUsageCapability.LLM,
        "primary",
    ) not in enabled:
        return (DraftValidationIssue("family_model_llm_fallback_requires_primary", "bindings"),)
    return ()


def _active_search_profile(
    db: Session,
    *,
    settings: FamilyModelSettings,
) -> FamilySearchProfile | None:
    """Resolve the family search identity from the two historical pointers.

    ``FamilyModelConfigRevision.search_profile_id`` is the immutable owner of
    the identity. ``FamilyModelSettings.active_search_profile_id`` is a
    denormalized pointer that older deployments could leave stale. Prefer the
    revision when it is a currently published snapshot, then use the
    denormalized pointer as a recovery path. Every candidate is re-scoped to
    the family before it is returned.
    """

    revision_profile_ids: list[str] = []
    revision = None
    if isinstance(settings.active_config_revision_id, str):
        revision = get_config_revision(
            db,
            family_id=settings.family_id,
            config_revision_id=settings.active_config_revision_id,
        )
        if (
            revision is not None
            and revision.status == FamilyModelConfigRevisionStatus.PUBLISHED
            and isinstance(revision.search_profile_id, str)
        ):
            revision_profile_ids.append(revision.search_profile_id)

    candidates = [*revision_profile_ids]
    if isinstance(settings.active_search_profile_id, str):
        candidates.append(settings.active_search_profile_id)
    # If the pointed revision is a superseded historical row and the
    # denormalized pointer is empty, retaining its identity is safer than
    # silently treating an already provisioned search model as a first setup.
    if (
        not candidates
        and revision is not None
        and isinstance(revision.search_profile_id, str)
    ):
        candidates.append(revision.search_profile_id)

    seen: set[str] = set()
    for profile_id in candidates:
        if profile_id in seen:
            continue
        seen.add(profile_id)
        profile = get_search_profile(
            db,
            family_id=settings.family_id,
            search_profile_id=profile_id,
        )
        if profile is not None:
            return profile
    return None


def _validate_search_transition(
    db: Session,
    *,
    settings: FamilyModelSettings,
    bindings: Sequence[ValidatedCapabilityBinding],
) -> tuple[DraftValidationIssue, ...]:
    # During first provisioning the active pointer deliberately remains null
    # until the collection is complete. The active config revision still owns
    # that immutable profile identity, so ordinary config publication must not
    # silently replace its Embedding binding before activation.
    active = _active_search_profile(db, settings=settings)
    if active is None:
        return ()
    candidate = next(
        (
            binding
            for binding in bindings
            if binding.enabled and binding.capability is ModelUsageCapability.EMBEDDING
        ),
        None,
    )
    if candidate is None or candidate.profile is None or candidate.profile_version is None:
        return (DraftValidationIssue("family_search_profile_locked", "bindings"),)
    dimensions = candidate.options.get("dimensions")
    if not isinstance(dimensions, int):
        return (DraftValidationIssue("family_search_profile_locked", "bindings"),)
    if (
        active.provider_profile_id != candidate.profile.id
        or active.provider_profile_version_id != candidate.profile_version.id
        or active.adapter_kind != candidate.profile_version.adapter_kind
        or active.embedding_model != candidate.requested_model
        or active.dimensions != dimensions
    ):
        return (DraftValidationIssue("family_search_profile_locked", "bindings"),)
    return ()


def _resolve_draft_search_profile_id(
    db: Session,
    *,
    settings: FamilyModelSettings,
    payload: FamilyModelConfigDraftPayload,
) -> tuple[str | None, tuple[DraftValidationIssue, ...]]:
    """Resolve the search profile a normal config revision should retain.

    A provisioning profile is not active yet, so subsequent non-search config
    publishes must inherit the profile attached to their base revision instead
    of creating a duplicate collection.  Explicit IDs stay family-scoped.
    """

    if payload.search_profile_id is not None:
        profile = get_search_profile(
            db,
            family_id=settings.family_id,
            search_profile_id=payload.search_profile_id,
        )
        if profile is None:
            return None, (DraftValidationIssue("family_search_profile_not_found", "search_profile_id"),)
        return profile.id, ()
    profile = _active_search_profile(db, settings=settings)
    return (profile.id if profile is not None else None), ()


def _validated_rate(
    rate: FamilyModelPriceRateRequest,
    *,
    binding: ValidatedCapabilityBinding,
) -> ValidatedFamilyPriceRate:
    assert binding.provider_profile_id is not None
    return ValidatedFamilyPriceRate(
        capability=binding.capability,
        variant_key=binding.variant_key,
        meter=rate.meter,
        provider=binding.provider_profile_id,
        billing_model=binding.requested_model,
        billing_scheme_key=binding.billing_scheme_key,
        unit_quantity=rate.unit_quantity,
        unit_price=rate.unit_price,
        source_currency=rate.source_currency,
        fx_to_cny=rate.fx_to_cny,
        unit_price_cny=(rate.unit_price * rate.fx_to_cny).quantize(
            _CNY_QUANTUM,
            rounding=ROUND_HALF_UP,
        ),
        reported_model_aliases=tuple(rate.reported_model_aliases),
    )


def _zero_rate(
    *,
    binding: ValidatedCapabilityBinding,
    meter: ModelUsageMeter,
) -> ValidatedFamilyPriceRate:
    assert binding.provider_profile_id is not None
    return ValidatedFamilyPriceRate(
        capability=binding.capability,
        variant_key=binding.variant_key,
        meter=meter,
        provider=binding.provider_profile_id,
        billing_model=binding.requested_model,
        billing_scheme_key=binding.billing_scheme_key,
        unit_quantity=_DEFAULT_UNIT_QUANTITIES.get(meter, Decimal("1000000")),
        unit_price=Decimal("0"),
        source_currency="CNY",
        fx_to_cny=Decimal("1"),
        unit_price_cny=Decimal("0"),
        reported_model_aliases=(binding.requested_model,),
    )


def _validate_price_coverage(
    payload: FamilyModelConfigDraftPayload,
    bindings: Sequence[ValidatedCapabilityBinding],
    *,
    ignore_disabled_rates: bool = False,
) -> tuple[tuple[ValidatedFamilyPriceRate, ...], tuple[DraftValidationIssue, ...]]:
    all_bindings = {
        (binding.capability.value, binding.variant_key): binding
        for binding in bindings
    }
    enabled = {
        identity: binding
        for identity, binding in all_bindings.items()
        if binding.enabled and binding.provider_profile_id is not None
    }
    rates_by_binding: dict[tuple[str, str], list[tuple[int, FamilyModelPriceRateRequest]]] = {}
    for index, rate in enumerate(payload.price_rates):
        rates_by_binding.setdefault((rate.capability, rate.variant_key), []).append((index, rate))
    issues: list[DraftValidationIssue] = []
    validated: list[ValidatedFamilyPriceRate] = []
    for identity, supplied_rates in rates_by_binding.items():
        binding = enabled.get(identity)
        if binding is None:
            if ignore_disabled_rates and identity in all_bindings and not all_bindings[identity].enabled:
                # Old clients occasionally kept price rows after a card was
                # disabled.  They are inert and must not make an unrelated
                # capability edit fail; the storage merge drops them.
                continue
            issues.extend(
                DraftValidationIssue("family_model_price_incomplete", f"price_rates.{index}")
                for index, _ in supplied_rates
            )
            continue
        allowed = binding.billable_meters
        supplied_meters = {rate.meter for _, rate in supplied_rates}
        if not supplied_meters <= allowed:
            issues.extend(
                DraftValidationIssue("family_model_price_incomplete", f"price_rates.{index}")
                for index, rate in supplied_rates
                if rate.meter not in allowed
            )
        for _, rate in supplied_rates:
            if rate.meter in allowed:
                validated.append(_validated_rate(rate, binding=binding))
    for identity, binding in enabled.items():
        supplied = {
            rate.meter
            for _, rate in rates_by_binding.get(identity, [])
            if rate.meter in binding.billable_meters
        }
        for meter in sorted(binding.billable_meters - supplied, key=lambda item: item.value):
            validated.append(_zero_rate(binding=binding, meter=meter))
    return tuple(validated), tuple(issues)


def required_meters_for_capability(
    capability: ModelUsageCapability | str,
) -> frozenset[ModelUsageMeter]:
    """Return the billable meters owned by one capability contract.

    Immutable active rows are trusted when an unrelated card is edited.  The
    independent save path still needs the same meter set to validate a
    price-only edit, so expose the registry rather than duplicating it in the
    draft merge service.
    """

    value = capability if isinstance(capability, ModelUsageCapability) else ModelUsageCapability(capability)
    return _REQUIRED_METERS[value]


def validate_family_model_capability_rates(
    payload: FamilyModelConfigDraftPayload,
    binding: ValidatedCapabilityBinding,
) -> tuple[tuple[ValidatedFamilyPriceRate, ...], tuple[DraftValidationIssue, ...]]:
    """Validate rates against an already validated/trusted binding.

    This is intentionally separate from provider validation.  An active
    binding is an immutable runtime fact; a temporary Provider outage must not
    prevent its Owner from correcting that card's prices or editing a sibling.
    """

    return _validate_price_coverage(
        payload,
        (binding,),
        ignore_disabled_rates=True,
    )


def _store_validation_result(
    draft: FamilyModelConfigDraft,
    *,
    actor_user_id: str,
    result: DraftValidationResult,
) -> None:
    draft.validation_status = "valid" if result.valid else "invalid"
    draft.validation_errors_json = [issue.record() for issue in result.errors]
    draft.updated_at = utcnow()
    draft.updated_by = actor_user_id


def _validate_payload(
    db: Session,
    *,
    family_id: str,
    settings: FamilyModelSettings,
    payload: FamilyModelConfigDraftPayload,
    network_policy: ProviderNetworkPolicy,
    draft_version_number: int,
    validate_search_transition: bool = True,
    validate_fallback_graph: bool = True,
    resolve_search_profile: bool = True,
    ignore_disabled_rates: bool = False,
) -> DraftValidationResult:
    """Validate an already parsed payload without acquiring any locks.

    The public draft-validation endpoint still validates the complete payload,
    but saves and capability probes also need a capability-scoped variant.  A
    single implementation keeps the adapter, credential and price rules
    identical in both paths while letting callers decide which cross-capability
    invariants are relevant to the operation.
    """

    bindings: list[ValidatedCapabilityBinding] = []
    issues: list[DraftValidationIssue] = []
    for index, binding in enumerate(payload.bindings):
        validated, binding_issues = _validate_enabled_binding(
            db,
            family_id=family_id,
            binding=binding,
            binding_index=index,
            network_policy=network_policy,
        )
        if validated is not None:
            bindings.append(validated)
        issues.extend(binding_issues)
    if validate_fallback_graph:
        issues.extend(_validate_fallback_graph(bindings))
    if resolve_search_profile:
        search_profile_id, search_profile_issues = _resolve_draft_search_profile_id(
            db,
            settings=settings,
            payload=payload,
        )
        issues.extend(search_profile_issues)
    else:
        # A capability-scoped edit has no authority over the search profile.
        # Do not resolve (or reject) an unrelated historical pointer here.
        search_profile_id = None
    if validate_search_transition:
        issues.extend(_validate_search_transition(db, settings=settings, bindings=bindings))
    rates, price_issues = _validate_price_coverage(
        payload,
        bindings,
        ignore_disabled_rates=ignore_disabled_rates,
    )
    issues.extend(price_issues)
    errors = tuple(issues)
    return DraftValidationResult(
        draft_version_number=draft_version_number,
        payload=payload,
        search_profile_id=search_profile_id,
        bindings=tuple(bindings),
        price_rates=rates,
        errors=errors,
        config_checksum=(
            None
            if errors
            else config_checksum(
                bindings=bindings,
                profile_version_ids=tuple(
                    binding.provider_profile_version_id
                    for binding in bindings
                    if binding.enabled and binding.provider_profile_version_id is not None
                ),
                search_profile_id=search_profile_id,
            )
        ),
        price_checksum=None if errors else price_checksum(rates),
    )


def validate_family_model_capability(
    db: Session,
    *,
    family_id: str,
    settings: FamilyModelSettings,
    payload: FamilyModelConfigDraftPayload,
    capability: ModelUsageCapability | str,
    network_policy: ProviderNetworkPolicy,
    draft_version_number: int = 0,
    validate_fallback_graph: bool = False,
    ignore_disabled_rates: bool = False,
    enforce_search_identity: bool = True,
) -> DraftValidationResult:
    """Validate one capability group independently from its siblings.

    LLM primary/fallback variants intentionally remain in the same group so
    their fallback graph is checked together.  Search identity transition is
    only evaluated for Embedding; an invalid candidate therefore cannot block
    an unrelated LLM, image or audio save.
    """

    capability_value = capability.value if isinstance(capability, ModelUsageCapability) else str(capability)
    scoped_bindings = tuple(
        binding for binding in payload.bindings if binding.capability == capability_value
    )
    scoped_rates = tuple(
        rate for rate in payload.price_rates if rate.capability == capability_value
    )
    scoped_payload = payload.model_copy(
        update={
            "bindings": list(scoped_bindings),
            "price_rates": list(scoped_rates),
        }
    )
    return _validate_payload(
        db,
        family_id=family_id,
        settings=settings,
        payload=scoped_payload,
        network_policy=network_policy,
        draft_version_number=draft_version_number,
        validate_search_transition=(
            capability_value == ModelUsageCapability.EMBEDDING.value
            and enforce_search_identity
        ),
        validate_fallback_graph=validate_fallback_graph,
        resolve_search_profile=(
            capability_value == ModelUsageCapability.EMBEDDING.value
            and enforce_search_identity
        ),
        ignore_disabled_rates=ignore_disabled_rates,
    )


def validate_family_model_draft(
    db: Session,
    command: ValidateDraftCommand,
) -> DraftValidationResult:
    """Validate a draft deterministically without creating runtime state.

    All errors are stable codes/field paths.  The route may safely persist
    them for Owner recovery, but no provider, Qdrant, price version or config
    revision is created here.
    """

    # Validation persists safe error state, so it follows the same stable
    # settings -> draft lock order as draft saves and publishing.
    settings = lock_family_model_settings(db, family_id=command.family_id)
    draft = require_config_draft(db, family_id=command.family_id, for_update=True)
    if command.base_draft_version_number is not None:
        require_draft_version(draft, command.base_draft_version_number)
    try:
        payload = FamilyModelConfigDraftPayload.model_validate(draft.payload_json)
    except ValidationError as exc:
        result = DraftValidationResult(
            draft_version_number=draft.draft_version_number,
            payload=FamilyModelConfigDraftPayload(),
            search_profile_id=None,
            bindings=(),
            price_rates=(),
            errors=_payload_validation_issues(exc),
            config_checksum=None,
            price_checksum=None,
        )
        _store_validation_result(draft, actor_user_id=command.actor_user_id, result=result)
        db.flush()
        return result

    result = _validate_payload(
        db,
        family_id=command.family_id,
        settings=settings,
        payload=payload,
        network_policy=command.network_policy,
        draft_version_number=draft.draft_version_number,
    )
    _store_validation_result(draft, actor_user_id=command.actor_user_id, result=result)
    db.flush()
    return result
