from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from app.ai.runtime.openai_chat import OpenAICompatibleChatProvider
from app.ai.runtime.openai_responses import OpenAIResponsesChatProvider
from app.ai.runtime.types import BaseChatProvider
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services.family_model_settings.resolver import FamilyModelConfigurationResolver
from app.services.family_model_settings.transport import ProviderTransport
from app.services.family_model_settings.types import ResolvedCapabilityBinding
from app.services.model_usage.adapters.llm import LLMUsageAdapter
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.preflight import decode_receipt_integrity_keyring


@dataclass(frozen=True, slots=True)
class FamilyChatProviderSelection:
    """Chat providers reconstructed from one immutable family revision."""

    config_revision_id: str | None
    primary: BaseChatProvider
    fallback: BaseChatProvider | None = None
    primary_binding: ResolvedCapabilityBinding | None = None
    fallback_binding: ResolvedCapabilityBinding | None = None


class FixedChatProviderFactory:
    """Explicit test-only provider factory.

    Production code never accepts a global provider at application-service
    construction. Existing focused tests may still inject a deterministic
    provider through this factory without pretending it is family config.
    """

    def __init__(self, provider: BaseChatProvider) -> None:
        self.provider = provider

    def for_active_family(self, db: Session, *, family_id: str) -> FamilyChatProviderSelection:
        del db, family_id
        return FamilyChatProviderSelection(config_revision_id=None, primary=self.provider)

    def for_run_revision(
        self,
        db: Session,
        *,
        family_id: str,
        config_revision_id: str,
    ) -> FamilyChatProviderSelection:
        del db, family_id, config_revision_id
        return FamilyChatProviderSelection(config_revision_id=None, primary=self.provider)

    def for_revision_variant(
        self,
        db: Session,
        *,
        family_id: str,
        config_revision_id: str,
        variant_key: str,
    ) -> BaseChatProvider:
        del db, family_id, config_revision_id, variant_key
        return self.provider


@dataclass(frozen=True, slots=True)
class RevisionBoundFamilyChatProviderFactory:
    """Expose one immutable configuration revision as a normal chat factory.

    Realtime cooking sessions can outlive a later Owner publication.  The
    workspace runner normally resolves an active family configuration when it
    starts a run, so this narrow wrapper redirects every resolution request to
    the session's captured revision instead.
    """

    delegate: "FamilyChatProviderFactory"
    config_revision_id: str

    def for_active_family(
        self,
        db: Session,
        *,
        family_id: str,
    ) -> FamilyChatProviderSelection:
        return self.delegate.for_run_revision(
            db,
            family_id=family_id,
            config_revision_id=self.config_revision_id,
        )

    def for_run_revision(
        self,
        db: Session,
        *,
        family_id: str,
        config_revision_id: str,
    ) -> FamilyChatProviderSelection:
        if config_revision_id != self.config_revision_id:
            raise ValueError("family_chat_revision_bound_factory_mismatch")
        return self.delegate.for_run_revision(
            db,
            family_id=family_id,
            config_revision_id=self.config_revision_id,
        )

    def for_revision_variant(
        self,
        db: Session,
        *,
        family_id: str,
        config_revision_id: str,
        variant_key: str,
    ) -> BaseChatProvider:
        if config_revision_id != self.config_revision_id:
            raise ValueError("family_chat_revision_bound_factory_mismatch")
        return self.delegate.for_revision_variant(
            db,
            family_id=family_id,
            config_revision_id=self.config_revision_id,
            variant_key=variant_key,
        )


class FamilyChatProviderFactory:
    """Build short-lived LLM providers from family-owned configuration only."""

    def __init__(
        self,
        *,
        session_factory: Callable[[], Session] = SessionLocal,
        resolver_factory: Callable[[Session], FamilyModelConfigurationResolver] | None = None,
        transport_factory: Callable[[FamilyModelConfigurationResolver], ProviderTransport] | None = None,
        settings_factory: Callable[[], object] = get_settings,
    ) -> None:
        self.session_factory = session_factory
        self._resolver_factory = resolver_factory or (lambda db: FamilyModelConfigurationResolver(db))
        self._transport_factory = transport_factory
        self._settings_factory = settings_factory

    def resolver(self, db: Session) -> FamilyModelConfigurationResolver:
        return self._resolver_factory(db)

    def for_active_family(self, db: Session, *, family_id: str) -> FamilyChatProviderSelection:
        resolver = self.resolver(db)
        primary = resolver.resolve_active(family_id, "llm", "primary")
        fallback = resolver.optional_revision_variant(
            family_id,
            primary.config_revision_id,
            "llm",
            "fallback",
        )
        return self._build(resolver, primary=primary, fallback=fallback)

    def for_run_revision(
        self,
        db: Session,
        *,
        family_id: str,
        config_revision_id: str,
    ) -> FamilyChatProviderSelection:
        resolver = self.resolver(db)
        primary = resolver.resolve_revision(
            family_id,
            config_revision_id,
            "llm",
            "primary",
        )
        fallback = resolver.optional_revision_variant(
            family_id,
            config_revision_id,
            "llm",
            "fallback",
        )
        return self._build(resolver, primary=primary, fallback=fallback)

    def for_revision_variant(
        self,
        db: Session,
        *,
        family_id: str,
        config_revision_id: str,
        variant_key: str,
    ) -> BaseChatProvider:
        resolver = self.resolver(db)
        binding = resolver.resolve_revision(
            family_id,
            config_revision_id,
            "llm",
            variant_key,
        )
        return self._provider_for_binding(resolver, binding)

    def _build(
        self,
        resolver: FamilyModelConfigurationResolver,
        *,
        primary: ResolvedCapabilityBinding,
        fallback: ResolvedCapabilityBinding | None,
    ) -> FamilyChatProviderSelection:
        primary_provider = self._provider_for_binding(resolver, primary)
        fallback_provider = (
            self._provider_for_binding(resolver, fallback) if fallback is not None else None
        )
        if fallback_provider is not None:
            if type(primary_provider) is not type(fallback_provider):
                # The configuration schema currently has one LLM request
                # protocol per revision. Failing closed is safer than sending
                # a Responses payload to a Chat-Completions endpoint.
                raise ValueError("family_model_llm_fallback_protocol_mismatch")
            setattr(primary_provider, "fallback_provider", fallback_provider)
        return FamilyChatProviderSelection(
            config_revision_id=primary.config_revision_id,
            primary=primary_provider,
            fallback=fallback_provider,
            primary_binding=primary,
            fallback_binding=fallback,
        )

    def _provider_for_binding(
        self,
        resolver: FamilyModelConfigurationResolver,
        binding: ResolvedCapabilityBinding,
    ) -> BaseChatProvider:
        settings = self._settings_factory()
        transport = (
            self._transport_factory(resolver)
            if self._transport_factory is not None
            else ProviderTransport.from_settings(settings, policy=resolver.network_policy)
        )
        usage_adapter = LLMUsageAdapter(
            usage_facade=ModelUsageFacade(session_factory=self.session_factory),
            session_factory=self.session_factory,
            signer=decode_receipt_integrity_keyring(settings).signer(),
            binding=binding,
        )
        constructor: type[OpenAICompatibleChatProvider] | type[OpenAIResponsesChatProvider]
        # Adapter-owned profile options are immutable. The public schema does
        # not expose this protocol knob yet, but keeping the choice bound to the
        # revision lets an already-published internal profile stay reproducible.
        if binding.options.get("runtime_protocol") == "responses":
            constructor = OpenAIResponsesChatProvider
        else:
            constructor = OpenAICompatibleChatProvider
        return constructor(
            binding=binding,
            transport=transport,
            resolve_dispatch_credential=resolver.resolve_dispatch_credential,
            usage_adapter=usage_adapter,
            model_usage_required=True,
        )


def build_chat_provider(*args: Any, **kwargs: Any) -> BaseChatProvider:
    """Removed global-provider entry point.

    Keeping a hard failure instead of a silent environment fallback makes stale
    callers visible during the staged cutover.
    """

    del args, kwargs
    raise RuntimeError("family_chat_provider_factory_required")
