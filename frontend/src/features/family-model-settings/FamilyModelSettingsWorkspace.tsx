import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { StateBlock } from '../../components/ui-kit';
import type {
  FamilyModelConfigDraft,
  FamilyModelDraftValidation,
  UserRole,
} from '../../api/types';
import {
  createEmptyFamilyModelDraft,
  createFamilyModelSettingsDraft,
  normalizeFamilyModelPriceRates,
  rebindDraftProviderProfile,
  type FamilyModelSettingsDraft,
} from './familyModelSettingsModel';
import { deriveFamilyModelSettingsOverview } from './familyModelSettingsOverviewModel';
import { FamilyModelSettingsDesktopView } from './FamilyModelSettingsDesktopView';
import { FamilyModelSettingsMobilePage } from './FamilyModelSettingsMobilePage';
import type { FamilyModelProfileRebindOptions } from './familyModelSettingsViewTypes';
import { useFamilyModelSettingsActions } from './useFamilyModelSettingsActions';
import { useFamilyModelSettingsQueries } from './useFamilyModelSettingsQueries';
import { useFamilyModelSettingsState } from './useFamilyModelSettingsState';

export type FamilyModelSettingsWorkspaceProps = {
  familyId: string;
  role: UserRole;
  isPhoneViewport: boolean;
  onBack: () => void;
};

function localDraftFromServerDraft(source: FamilyModelConfigDraft | null): FamilyModelSettingsDraft {
  if (!source) return createEmptyFamilyModelDraft();
  if (source.payload.bindings.length > 0) {
    return createFamilyModelSettingsDraft(source.payload, source.draft_version_number);
  }

  // A newly bootstrapped family has a persisted empty server draft. The local
  // form still needs all controlled capability rows before its first save.
  const empty = createEmptyFamilyModelDraft();
  return {
    ...empty,
    base_config_revision_id: source.payload.base_config_revision_id,
    search_profile_id: source.payload.search_profile_id,
    price_rates: source.payload.price_rates.map((rate) => ({
      ...rate,
      reported_model_aliases: [...rate.reported_model_aliases],
    })),
    price_draft: source.payload.price_draft
      ? {
        ...source.payload.price_draft,
        rates: source.payload.price_draft.rates.map((rate) => ({
          ...rate,
          reported_model_aliases: [...rate.reported_model_aliases],
        })),
      }
      : null,
    change_note: source.payload.change_note,
    base_draft_version_number: source.draft_version_number,
  };
}

function isAtLeastAsRecent(
  candidate: FamilyModelConfigDraft,
  current: FamilyModelConfigDraft | null,
): boolean {
  return !current || candidate.draft_version_number >= current.draft_version_number;
}

/**
 * Connects family-scoped Owner queries and mutations to an independent
 * desktop/phone surface. It deliberately owns no editor JSX or API payload
 * construction; those responsibilities stay in view and model modules.
 */
function FamilyModelSettingsWorkspaceContent(props: FamilyModelSettingsWorkspaceProps) {
  const historyMarker = `family-model-settings:${props.familyId}`;
  const pendingHistoryExitRef = useRef(false);
  const [replacementProfileId, setReplacementProfileId] = useState<string | null>(null);
  const queries = useFamilyModelSettingsQueries({
    familyId: props.familyId,
    role: props.role,
    replacementProfileId,
  });
  const state = useFamilyModelSettingsState();
  const [serverDraft, setServerDraft] = useState<FamilyModelConfigDraft | null>(null);
  const [draft, setDraft] = useState<FamilyModelSettingsDraft>(() => createEmptyFamilyModelDraft());
  const [validation, setValidation] = useState<FamilyModelDraftValidation | null>(null);
  const failedAutoSaveDraftRef = useRef<FamilyModelSettingsDraft | null>(null);

  useLayoutEffect(() => {
    const previousState = window.history.state;
    window.history.pushState(
      { ...(previousState && typeof previousState === 'object' ? previousState : {}), culinaWorkspaceGuard: historyMarker },
      '',
      window.location.href,
    );
    return () => {
      if (window.history.state?.culinaWorkspaceGuard === historyMarker) {
        window.history.replaceState(previousState, '', window.location.href);
      }
    };
  }, [historyMarker]);

  useEffect(() => {
    if (!queries.draft) return;
    setServerDraft((current) => isAtLeastAsRecent(queries.draft as FamilyModelConfigDraft, current)
      ? queries.draft
      : current);
  }, [queries.draft]);

  useEffect(() => {
    if (!serverDraft || state.state.dirty) return;
    setDraft(localDraftFromServerDraft(serverDraft));
  }, [serverDraft, state.state.dirty]);

  const mutationState = useFamilyModelSettingsActions({
    familyId: props.familyId,
    settings: queries.settings,
    draft: serverDraft,
    onBusy: state.actions.begin,
    onSettled: state.actions.settle,
  });
  const busyAction = mutationState.busyAction ?? state.state.busyAction;
  const busy = busyAction !== null;

  const setLocalDraft = useCallback((next: FamilyModelSettingsDraft) => {
    setDraft({
      ...next,
      price_rates: normalizeFamilyModelPriceRates(next.bindings, next.price_rates),
    });
    setValidation(null);
    state.actions.markDirty(true);
  }, [state.actions]);

  const persistDraftValue = useCallback(async (nextDraft: FamilyModelSettingsDraft): Promise<FamilyModelConfigDraft> => {
    const saved = await mutationState.actions.saveDraft(nextDraft);
    setServerDraft(saved);
    setDraft(localDraftFromServerDraft(saved));
    setValidation(null);
    failedAutoSaveDraftRef.current = null;
    state.actions.markDirty(false);
    return saved;
  }, [mutationState.actions, state.actions]);

  const persistDraft = useCallback(
    () => persistDraftValue(draft),
    [draft, persistDraftValue],
  );

  useEffect(() => {
    if (!state.state.dirty || busy || failedAutoSaveDraftRef.current === draft) return;
    const timer = window.setTimeout(() => {
      failedAutoSaveDraftRef.current = draft;
      void persistDraftValue(draft).catch(() => {
        // Keep the local value and wait for another edit or an explicit retry.
      });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [busy, draft, persistDraftValue, state.state.dirty]);

  const rebindCreatedProfile = useCallback(async (
    fromProfileId: string,
    toProfileId: string,
    options?: FamilyModelProfileRebindOptions,
  ) => {
    let sourceDraft = draft;
    if (options?.refreshServerDraft) {
      const refreshed = await queries.draftQuery.refetch();
      if (refreshed.isError) throw refreshed.error;
      if (!refreshed.data) throw new Error('家庭模型草稿刷新后仍不可用。');
      setServerDraft((current) => isAtLeastAsRecent(refreshed.data, current) ? refreshed.data : current);
      sourceDraft = localDraftFromServerDraft(refreshed.data);
    }
    const nextDraft = rebindDraftProviderProfile(sourceDraft, fromProfileId, toProfileId);
    setDraft(nextDraft);
    await persistDraftValue(nextDraft);
  }, [draft, persistDraftValue, queries.draftQuery]);

  const validate = useCallback(async () => {
    const currentDraft = state.state.dirty ? await persistDraft() : serverDraft;
    if (!currentDraft) return;
    const result = await mutationState.actions.validateDraft(currentDraft.draft_version_number);
    setValidation(result);
  }, [mutationState.actions, persistDraft, serverDraft, state.state.dirty]);

  const testCapability = useCallback(async (
    capability: Parameters<typeof mutationState.actions.testCapability>[0],
    variantKey: string,
    confirmBillable: boolean,
  ) => {
    const currentDraft = state.state.dirty ? await persistDraft() : serverDraft;
    if (!currentDraft) throw new Error('家庭模型草稿尚未加载完成。');
    return mutationState.actions.testCapability(
      capability,
      variantKey,
      confirmBillable,
      currentDraft.draft_version_number,
    );
  }, [mutationState.actions, persistDraft, serverDraft, state.state.dirty]);

  const exitWorkspace = useCallback(() => {
    if (pendingHistoryExitRef.current) return;
    if (window.history.state?.culinaWorkspaceGuard === historyMarker) {
      pendingHistoryExitRef.current = true;
      window.history.back();
      return;
    }
    props.onBack();
  }, [historyMarker, props.onBack]);

  const requestBack = useCallback(() => {
    if (busy) return;
    if (state.state.dirty) {
      void persistDraft().then(exitWorkspace).catch(() => {
        // Stay on the page so the visible error can guide recovery.
      });
      return;
    }
    exitWorkspace();
  }, [busy, exitWorkspace, persistDraft, state.state.dirty]);

  useEffect(() => {
    const preserveWorkspaceHistory = () => {
      const currentState = window.history.state;
      window.history.pushState(
        { ...(currentState && typeof currentState === 'object' ? currentState : {}), culinaWorkspaceGuard: historyMarker },
        '',
        window.location.href,
      );
    };
    const handlePopState = () => {
      if (pendingHistoryExitRef.current) {
        pendingHistoryExitRef.current = false;
        props.onBack();
        return;
      }
      if (busy || state.state.dirty) preserveWorkspaceHistory();
      requestBack();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      requestBack();
    };

    window.addEventListener('popstate', handlePopState);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [busy, historyMarker, props.onBack, requestBack, state.state.dirty]);

  if (!queries.isOwner) {
    return (
      <main className="family-model-settings-fallback" aria-labelledby="family-model-settings-fallback-title">
        <h1 id="family-model-settings-fallback-title">家庭 AI 服务</h1>
        <StateBlock
          status="empty"
          title="仅家庭主理人可以管理 AI 服务"
          description="如需调整服务、凭据、模型或价格，请联系家庭主理人。"
          actionLabel="返回家庭"
          onAction={requestBack}
        />
      </main>
    );
  }

  if (queries.error && (!queries.settings || !serverDraft)) {
    return (
      <main className="family-model-settings-fallback" aria-labelledby="family-model-settings-error-title">
        <h1 id="family-model-settings-error-title">家庭 AI 服务</h1>
        <StateBlock
          status="error"
          title="暂时无法加载家庭 AI 服务"
          description="请稍后重试，已有草稿不会因此丢失。"
          actionLabel="重新加载"
          onAction={() => {
            void Promise.all([
              queries.settingsQuery.refetch(),
              queries.draftQuery.refetch(),
              queries.pricesQuery.refetch(),
            ]);
          }}
        />
      </main>
    );
  }

  if (queries.isInitialLoading || !queries.settings || !serverDraft) {
    return (
      <main className="family-model-settings-fallback" aria-labelledby="family-model-settings-loading-title">
        <h1 id="family-model-settings-loading-title">家庭 AI 服务</h1>
        <StateBlock status="loading" title="正在加载家庭 AI 服务" description="正在读取当前家庭的非敏感配置。" />
      </main>
    );
  }

  const surfaceProps = {
    overview: deriveFamilyModelSettingsOverview({ settings: queries.settings, draft, dirty: state.state.dirty }),
    settings: queries.settings,
    serverDraft,
    draft,
    prices: queries.prices,
    validation,
    searchReplacement: queries.searchReplacement,
    state: state.state,
    actions: mutationState.actions,
    busyAction,
    errorMessage: mutationState.errorMessage,
    stale: queries.stale,
    replacementProfileId,
    onBack: requestBack,
    onSelectSection: state.actions.selectSection,
    onSelectProfile: state.actions.selectProfile,
    onRebindCreatedProfile: rebindCreatedProfile,
    onPushMobileTask: state.actions.pushMobileTask,
    onPopMobileTask: state.actions.popMobileTask,
    onDraftChange: setLocalDraft,
    onDiscoverModels: queries.discoverProviderModels,
    onTestCapability: testCapability,
    onValidate: validate,
    onReplacementProfileIdChange: setReplacementProfileId,
  };

  return props.isPhoneViewport
    ? <FamilyModelSettingsMobilePage {...surfaceProps} />
    : <FamilyModelSettingsDesktopView {...surfaceProps} />;
}

/**
 * A family change is a hard local-state boundary. Remounting the scoped
 * content prevents a previous family's draft, validation or retry secrets
 * from surviving long enough to combine with the next family's query data.
 */
export function FamilyModelSettingsWorkspace(props: FamilyModelSettingsWorkspaceProps) {
  return <FamilyModelSettingsWorkspaceContent key={props.familyId} {...props} />;
}
