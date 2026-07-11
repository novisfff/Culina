import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  InventoryOperationResult,
  InventoryReconciliationGroup,
  InventoryReconciliationResponse,
} from '../../api/types';
import { hoursBetweenInstants } from '../../lib/date';
import { readJsonStorage, reconciliationDraftKey, removeStorage, writeJsonStorage } from '../../lib/storage';
import {
  createEmptyDraft,
  intentTargetKey,
  progressCounts,
  RECONCILIATION_DRAFT_TTL_HOURS,
  removeIntent,
  replayReconciliationDraft,
  sortGroupsForDisplay,
  summarizeReconciliationDraft,
  upsertIntent,
  validateReconciliationDraft,
  type DraftReplayConflict,
  type InventoryReconciliationDraft,
  type InventoryReconciliationScope,
  type InventoryReconciliationStep,
  type ReconciliationConflictState,
  type ReconciliationFieldError,
  type ReconciliationIntent,
  type ReconciliationSubmitSummary,
} from './inventoryReconciliationModel';

export type UseInventoryReconciliationStateResult = {
  open: boolean;
  step: InventoryReconciliationStep;
  scope: InventoryReconciliationScope;
  storageLocation: string | null;
  draft: InventoryReconciliationDraft | null;
  groups: InventoryReconciliationGroup[];
  orderedGroups: InventoryReconciliationGroup[];
  focusedGroupKey: string | null;
  expandedBatchGroupKeys: string[];
  busy: boolean;
  loading: boolean;
  errorMessage: string | null;
  fieldErrors: ReconciliationFieldError[];
  focusFieldKey: string | null;
  conflictState: ReconciliationConflictState;
  replayConflicts: DraftReplayConflict[];
  newlyDiscoveredTargetKeys: string[];
  restoredDraftPrompt: InventoryReconciliationDraft | null;
  result: InventoryOperationResult | null;
  summary: ReconciliationSubmitSummary;
  checkedCount: number;
  totalCount: number;
  canSubmit: boolean;
  /** Prepare a fresh open without marking anything confirmed. */
  beginOpen: (args: {
    familyId: string;
    userId: string;
    scope: InventoryReconciliationScope;
    storageLocation?: string | null;
    now: string;
  }) => {
    restoredDraftPrompt: InventoryReconciliationDraft | null;
    draftKey: string;
  };
  /** Apply freshly loaded reconciliation groups; opening does not create intents. */
  applyLoadedGroups: (args: {
    response: InventoryReconciliationResponse;
    scope: InventoryReconciliationScope;
    storageLocation?: string | null;
  }) => void;
  /** Accept a restored local draft after latest data is available. */
  acceptRestoredDraft: (args: {
    draft: InventoryReconciliationDraft;
    latest: InventoryReconciliationResponse;
    familyId: string;
    userId: string;
    referenceDate: string;
    now: string;
  }) => void;
  discardRestoredDraft: (args: { familyId: string; userId: string }) => void;
  setScopeLocal: (scope: InventoryReconciliationScope, storageLocation?: string | null) => void;
  setFocusedGroupKey: (key: string | null) => void;
  toggleBatchDetails: (groupKey: string) => void;
  setIntent: (intent: ReconciliationIntent, now: string) => void;
  clearIntent: (targetKey: string, now: string) => void;
  goToSummary: () => boolean;
  /**
   * User cancel from summary → review.
   * Does not wipe fieldErrors/focusFieldKey so a prior failed submit recovery survives.
   */
  goToReview: () => void;
  /**
   * Error recovery path: force review, optionally set errors/focus, expand batch groups
   * when focused field is a batch/create control.
   */
  recoverToReview: (args?: {
    fieldErrors?: ReconciliationFieldError[];
    focusFieldKey?: string | null;
    errorMessage?: string | null;
  }) => void;
  setBusy: (busy: boolean) => void;
  setLoading: (loading: boolean) => void;
  setErrorMessage: (message: string | null) => void;
  setFieldErrors: (errors: ReconciliationFieldError[]) => void;
  setFocusFieldKey: (key: string | null) => void;
  setConflictState: (state: ReconciliationConflictState) => void;
  setReplayConflicts: (conflicts: DraftReplayConflict[]) => void;
  /** Store success result; clears draft storage only after result is set. */
  setResultAndClearDraft: (args: {
    result: InventoryOperationResult;
    familyId: string;
    userId: string;
  }) => void;
  replaceDraft: (draft: InventoryReconciliationDraft | null) => void;
  applyLocalValidation: () => ReconciliationFieldError[];
  /** Closing while not busy preserves the draft to local storage. */
  closeReconciliation: (args?: { familyId?: string; userId?: string; now?: string }) => boolean;
  persistDraft: (args: { familyId: string; userId: string; now?: string }) => void;
  clearPersistedDraft: (args: { familyId: string; userId: string }) => void;
  resetForNewReconciliation: () => void;
};

const EMPTY_ERRORS: ReconciliationFieldError[] = [];
const EMPTY_CONFLICTS: DraftReplayConflict[] = [];
const EMPTY_GROUPS: InventoryReconciliationGroup[] = [];

function isPersistedDraftExpired(draft: InventoryReconciliationDraft, now: string): boolean {
  return hoursBetweenInstants(now, draft.savedAt) > RECONCILIATION_DRAFT_TTL_HOURS;
}

function withReplayConflictErrors(
  fieldErrors: ReconciliationFieldError[],
  conflicts: DraftReplayConflict[],
): ReconciliationFieldError[] {
  if (conflicts.length === 0) {
    return fieldErrors;
  }
  const conflictErrors = conflicts.map((conflict) => ({
    targetKey: conflict.targetKey,
    field: 'target',
    code: conflict.code,
    message: conflict.message,
  }));
  return [...fieldErrors, ...conflictErrors];
}

function isDraftShape(value: unknown): value is InventoryReconciliationDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as InventoryReconciliationDraft;
  return (
    draft.schemaVersion === 1 &&
    typeof draft.familyId === 'string' &&
    typeof draft.userId === 'string' &&
    typeof draft.clientRequestId === 'string' &&
    typeof draft.scope === 'string' &&
    Array.isArray(draft.intents)
  );
}

/** Target keys whose batch editor must be expanded for the given focus/errors. */
export function batchGroupKeysNeedingExpansion(
  focusFieldKey: string | null | undefined,
  fieldErrors: ReconciliationFieldError[],
): string[] {
  const keys = new Set<string>();
  for (const error of fieldErrors) {
    if (!error.targetKey || !error.targetKey.startsWith('exact_ingredient:')) {
      continue;
    }
    if (
      error.field.startsWith('batch:') ||
      error.field.startsWith('create:') ||
      error.field === 'actualRemainingQuantity' ||
      error.field === 'updates' ||
      error.field === 'creates'
    ) {
      keys.add(error.targetKey);
    }
  }
  if (focusFieldKey && (focusFieldKey.includes(':batch:') || focusFieldKey.includes(':create:'))) {
    const match = focusFieldKey.match(/^(exact_ingredient:[^:]+)/);
    if (match) {
      keys.add(match[1]);
    }
  }
  return [...keys];
}

export function readPersistedReconciliationDraft(
  familyId: string,
  userId: string,
): InventoryReconciliationDraft | null {
  const key = reconciliationDraftKey(familyId, userId);
  const value = readJsonStorage<InventoryReconciliationDraft | null>(key, null);
  if (!isDraftShape(value)) {
    if (value !== null) {
      removeStorage(key);
    }
    return null;
  }
  return value;
}

export function writePersistedReconciliationDraft(
  familyId: string,
  userId: string,
  draft: InventoryReconciliationDraft,
): void {
  writeJsonStorage(reconciliationDraftKey(familyId, userId), draft);
}

export function clearPersistedReconciliationDraft(familyId: string, userId: string): void {
  removeStorage(reconciliationDraftKey(familyId, userId));
}

export function useInventoryReconciliationState(): UseInventoryReconciliationStateResult {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<InventoryReconciliationStep>('review');
  const [scope, setScope] = useState<InventoryReconciliationScope>('suggested');
  const [storageLocation, setStorageLocation] = useState<string | null>(null);
  const [draft, setDraft] = useState<InventoryReconciliationDraft | null>(null);
  const [groups, setGroups] = useState<InventoryReconciliationGroup[]>(EMPTY_GROUPS);
  const [focusedGroupKey, setFocusedGroupKey] = useState<string | null>(null);
  const [expandedBatchGroupKeys, setExpandedBatchGroupKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ReconciliationFieldError[]>(EMPTY_ERRORS);
  const [focusFieldKey, setFocusFieldKey] = useState<string | null>(null);
  const [conflictState, setConflictState] = useState<ReconciliationConflictState>('none');
  const [replayConflicts, setReplayConflicts] = useState<DraftReplayConflict[]>(EMPTY_CONFLICTS);
  const [newlyDiscoveredTargetKeys, setNewlyDiscoveredTargetKeys] = useState<string[]>([]);
  const [restoredDraftPrompt, setRestoredDraftPrompt] = useState<InventoryReconciliationDraft | null>(null);
  const [result, setResult] = useState<InventoryOperationResult | null>(null);

  const busyRef = useRef(false);
  busyRef.current = busy;
  const draftRef = useRef<InventoryReconciliationDraft | null>(null);
  draftRef.current = draft;
  const groupsRef = useRef<InventoryReconciliationGroup[]>(EMPTY_GROUPS);
  groupsRef.current = groups;
  const replayConflictsRef = useRef<DraftReplayConflict[]>(EMPTY_CONFLICTS);
  replayConflictsRef.current = replayConflicts;
  const fieldErrorsRef = useRef<ReconciliationFieldError[]>(EMPTY_ERRORS);
  fieldErrorsRef.current = fieldErrors;
  const focusFieldKeyRef = useRef<string | null>(null);
  focusFieldKeyRef.current = focusFieldKey;

  const summary = useMemo(
    () =>
      draft
        ? summarizeReconciliationDraft(draft)
        : {
            confirmCount: 0,
            adjustedCount: 0,
            lowCount: 0,
            absentCount: 0,
            createdBatchCount: 0,
            totalTouched: 0,
          },
    [draft],
  );

  const orderedGroups = useMemo(
    () =>
      draft
        ? sortGroupsForDisplay({
            groups,
            draft,
            conflictTargetKeys: replayConflicts.map((conflict) => conflict.targetKey),
          })
        : groups,
    [draft, groups, replayConflicts],
  );

  const { checked: checkedCount, total: totalCount } = useMemo(
    () =>
      draft
        ? progressCounts({ groups, draft })
        : { checked: 0, total: groups.length },
    [draft, groups],
  );

  const canSubmit = useMemo(() => {
    if (!draft) return false;
    if (replayConflicts.length > 0) return false;
    return validateReconciliationDraft(draft, groups).length === 0;
  }, [draft, groups, replayConflicts]);

  const expandBatchGroupsForFocus = useCallback(
    (nextFocus: string | null | undefined, nextErrors: ReconciliationFieldError[]) => {
      const keys = batchGroupKeysNeedingExpansion(nextFocus, nextErrors);
      if (keys.length === 0) return;
      setExpandedBatchGroupKeys((current) => {
        const next = new Set(current);
        let changed = false;
        for (const key of keys) {
          if (!next.has(key)) {
            next.add(key);
            changed = true;
          }
        }
        return changed ? [...next] : current;
      });
    },
    [],
  );

  const beginOpen: UseInventoryReconciliationStateResult['beginOpen'] = useCallback((args) => {
    const draftKey = reconciliationDraftKey(args.familyId, args.userId);
    let existing = readPersistedReconciliationDraft(args.familyId, args.userId);
    // Discard expired drafts before offering a restore prompt.
    if (existing && isPersistedDraftExpired(existing, args.now)) {
      clearPersistedReconciliationDraft(args.familyId, args.userId);
      existing = null;
    }
    const fresh = createEmptyDraft({
      familyId: args.familyId,
      userId: args.userId,
      scope: args.scope,
      now: args.now,
    });
    setScope(args.scope);
    setStorageLocation(args.storageLocation ?? null);
    setDraft(fresh);
    setGroups(EMPTY_GROUPS);
    setFocusedGroupKey(null);
    setExpandedBatchGroupKeys([]);
    setBusy(false);
    setLoading(true);
    setErrorMessage(null);
    setFieldErrors(EMPTY_ERRORS);
    setFocusFieldKey(null);
    setConflictState('none');
    setReplayConflicts(EMPTY_CONFLICTS);
    setNewlyDiscoveredTargetKeys([]);
    setResult(null);
    setStep('review');
    setOpen(true);
    // Opening never marks groups confirmed; restored prompt is optional.
    const prompt =
      existing && existing.intents.length > 0 && existing.scope === args.scope ? existing : null;
    setRestoredDraftPrompt(prompt);
    return { restoredDraftPrompt: prompt, draftKey };
  }, []);

  const applyLoadedGroups: UseInventoryReconciliationStateResult['applyLoadedGroups'] = useCallback(
    (args) => {
      setGroups(args.response.groups);
      setScope(args.scope);
      setStorageLocation(args.storageLocation ?? null);
      setLoading(false);
      // Explicitly leave draft intents untouched — open does not confirm.
    },
    [],
  );

  const acceptRestoredDraft: UseInventoryReconciliationStateResult['acceptRestoredDraft'] = useCallback(
    (args) => {
      const replay = replayReconciliationDraft({
        draft: args.draft,
        latest: args.latest,
        familyId: args.familyId,
        userId: args.userId,
        referenceDate: args.referenceDate,
        now: args.now,
      });
      if (replay.discardedReason || !replay.restoredDraft) {
        clearPersistedReconciliationDraft(args.familyId, args.userId);
        setRestoredDraftPrompt(null);
        setReplayConflicts(EMPTY_CONFLICTS);
        setNewlyDiscoveredTargetKeys([]);
        return;
      }
      setDraft(replay.restoredDraft);
      setGroups(args.latest.groups);
      setScope(replay.restoredDraft.scope);
      setReplayConflicts(replay.conflicts);
      setNewlyDiscoveredTargetKeys(replay.newlyDiscoveredTargetKeys);
      setRestoredDraftPrompt(null);
      setStep('review');
      writePersistedReconciliationDraft(args.familyId, args.userId, replay.restoredDraft);
    },
    [],
  );

  const discardRestoredDraft: UseInventoryReconciliationStateResult['discardRestoredDraft'] = useCallback(
    (args) => {
      clearPersistedReconciliationDraft(args.familyId, args.userId);
      setRestoredDraftPrompt(null);
    },
    [],
  );

  const setScopeLocal = useCallback((nextScope: InventoryReconciliationScope, nextStorage: string | null = null) => {
    setScope(nextScope);
    setStorageLocation(nextStorage);
  }, []);

  const toggleBatchDetails = useCallback((groupKey: string) => {
    setExpandedBatchGroupKeys((current) =>
      current.includes(groupKey) ? current.filter((key) => key !== groupKey) : [...current, groupKey],
    );
  }, []);

  const persistIfPossible = useCallback(
    (nextDraft: InventoryReconciliationDraft | null) => {
      if (!nextDraft) return;
      writePersistedReconciliationDraft(nextDraft.familyId, nextDraft.userId, nextDraft);
    },
    [],
  );

  const clearReplayConflictForTarget = useCallback((targetKey: string) => {
    setReplayConflicts((current) => {
      if (current.length === 0) return current;
      const next = current.filter((conflict) => conflict.targetKey !== targetKey);
      return next.length === current.length ? current : next.length === 0 ? EMPTY_CONFLICTS : next;
    });
  }, []);

  const setIntent = useCallback(
    (intent: ReconciliationIntent, now: string) => {
      const targetKey = intentTargetKey(intent);
      setDraft((current) => {
        if (!current) return current;
        const next = upsertIntent(current, intent, now);
        persistIfPossible(next);
        return next;
      });
      setErrorMessage(null);
      setFieldErrors((current) => current.filter((error) => error.targetKey !== targetKey));
      clearReplayConflictForTarget(targetKey);
    },
    [clearReplayConflictForTarget, persistIfPossible],
  );

  const clearIntent = useCallback(
    (targetKey: string, now: string) => {
      setDraft((current) => {
        if (!current) return current;
        const next = removeIntent(current, targetKey, now);
        persistIfPossible(next);
        return next;
      });
      setErrorMessage(null);
      setFieldErrors((current) => current.filter((error) => error.targetKey !== targetKey));
      clearReplayConflictForTarget(targetKey);
    },
    [clearReplayConflictForTarget, persistIfPossible],
  );

  const goToSummary = useCallback(() => {
    const current = draftRef.current;
    if (!current) {
      setErrorMessage('请先确认至少一项库存。');
      return false;
    }
    const replay = replayConflictsRef.current;
    const errors = withReplayConflictErrors(
      validateReconciliationDraft(current, groupsRef.current),
      replay,
    );
    setFieldErrors(errors);
    if (errors.length > 0) {
      const first = errors[0];
      const nextFocus = first.targetKey ? `${first.targetKey}:${first.field}` : first.field;
      setFocusFieldKey(nextFocus);
      expandBatchGroupsForFocus(nextFocus, errors);
      if (replay.length > 0) {
        setErrorMessage(
          replay.length === 1
            ? first.message
            : `还有 ${replay.length} 项版本已变化，请重新确认后再提交。`,
        );
      } else {
        setErrorMessage(errors.length === 1 ? first.message : `还有 ${errors.length} 处需要确认后才能提交。`);
      }
      return false;
    }
    setErrorMessage(null);
    setStep('summary');
    return true;
  }, [expandBatchGroupsForFocus]);

  const goToReview = useCallback(() => {
    if (busyRef.current) return;
    // User cancel from summary: return to review without wiping fieldErrors/focusFieldKey.
    // Failed-submit recovery (422/local validation) relies on those surviving.
    setStep('review');
  }, []);

  const recoverToReview = useCallback(
    (args?: {
      fieldErrors?: ReconciliationFieldError[];
      focusFieldKey?: string | null;
      errorMessage?: string | null;
    }) => {
      const nextErrors = args?.fieldErrors ?? fieldErrorsRef.current;
      const nextFocus =
        args?.focusFieldKey !== undefined ? args.focusFieldKey : focusFieldKeyRef.current;
      if (args?.fieldErrors) {
        setFieldErrors(args.fieldErrors);
      }
      if (args?.focusFieldKey !== undefined) {
        setFocusFieldKey(args.focusFieldKey);
      }
      if (args?.errorMessage !== undefined) {
        setErrorMessage(args.errorMessage);
      }
      setStep('review');
      expandBatchGroupsForFocus(nextFocus, nextErrors);
    },
    [expandBatchGroupsForFocus],
  );

  const setResultAndClearDraft: UseInventoryReconciliationStateResult['setResultAndClearDraft'] =
    useCallback((args) => {
      setResult(args.result);
      setStep('result');
      setBusy(false);
      clearPersistedReconciliationDraft(args.familyId, args.userId);
      setDraft((current) =>
        current
          ? {
              ...current,
              intents: [],
              savedAt: args.result.applied_at,
            }
          : current,
      );
      setReplayConflicts(EMPTY_CONFLICTS);
    }, []);

  const applyLocalValidation = useCallback(() => {
    const current = draftRef.current;
    if (!current) {
      const empty: ReconciliationFieldError[] = [
        {
          targetKey: '',
          field: 'intents',
          code: 'empty_operation',
          message: '请先确认至少一项库存。',
        },
      ];
      setFieldErrors(empty);
      return empty;
    }
    const replay = replayConflictsRef.current;
    const errors = withReplayConflictErrors(
      validateReconciliationDraft(current, groupsRef.current),
      replay,
    );
    setFieldErrors(errors);
    if (errors.length > 0) {
      const first = errors[0];
      setFocusFieldKey(first.targetKey ? `${first.targetKey}:${first.field}` : first.field);
      if (replay.length > 0) {
        setErrorMessage(
          replay.length === 1
            ? first.message
            : `还有 ${replay.length} 项版本已变化，请重新确认后再提交。`,
        );
      } else {
        setErrorMessage(errors.length === 1 ? first.message : `还有 ${errors.length} 处需要确认后才能提交。`);
      }
    } else {
      setFocusFieldKey(null);
      setErrorMessage(null);
    }
    return errors;
  }, []);

  const persistDraft: UseInventoryReconciliationStateResult['persistDraft'] = useCallback((args) => {
    const current = draftRef.current;
    if (!current) return;
    const next = {
      ...current,
      familyId: args.familyId,
      userId: args.userId,
      savedAt: args.now ?? current.savedAt,
    };
    writePersistedReconciliationDraft(args.familyId, args.userId, next);
    setDraft(next);
  }, []);

  const clearPersistedDraft = useCallback((args: { familyId: string; userId: string }) => {
    clearPersistedReconciliationDraft(args.familyId, args.userId);
  }, []);

  const closeReconciliation: UseInventoryReconciliationStateResult['closeReconciliation'] = useCallback(
    (args) => {
      if (busyRef.current) {
        return false;
      }
      const current = draftRef.current;
      if (current && args?.familyId && args.userId) {
        const next = {
          ...current,
          familyId: args.familyId,
          userId: args.userId,
          savedAt: args.now ?? current.savedAt,
        };
        // Preserve draft on close while not busy; only clear after successful result.
        if (next.intents.length > 0) {
          writePersistedReconciliationDraft(args.familyId, args.userId, next);
        }
      }
      setOpen(false);
      setStep('review');
      setDraft(null);
      setGroups(EMPTY_GROUPS);
      setFocusedGroupKey(null);
      setExpandedBatchGroupKeys([]);
      setErrorMessage(null);
      setFieldErrors(EMPTY_ERRORS);
      setFocusFieldKey(null);
      setConflictState('none');
      setReplayConflicts(EMPTY_CONFLICTS);
      setNewlyDiscoveredTargetKeys([]);
      setRestoredDraftPrompt(null);
      setResult(null);
      setLoading(false);
      return true;
    },
    [],
  );

  const resetForNewReconciliation = useCallback(() => {
    setOpen(false);
    setStep('review');
    setDraft(null);
    setGroups(EMPTY_GROUPS);
    setFocusedGroupKey(null);
    setExpandedBatchGroupKeys([]);
    setBusy(false);
    setLoading(false);
    setErrorMessage(null);
    setFieldErrors(EMPTY_ERRORS);
    setFocusFieldKey(null);
    setConflictState('none');
    setReplayConflicts(EMPTY_CONFLICTS);
    setNewlyDiscoveredTargetKeys([]);
    setRestoredDraftPrompt(null);
    setResult(null);
  }, []);

  return {
    open,
    step,
    scope,
    storageLocation,
    draft,
    groups,
    orderedGroups,
    focusedGroupKey,
    expandedBatchGroupKeys,
    busy,
    loading,
    errorMessage,
    fieldErrors,
    focusFieldKey,
    conflictState,
    replayConflicts,
    newlyDiscoveredTargetKeys,
    restoredDraftPrompt,
    result,
    summary,
    checkedCount,
    totalCount,
    canSubmit,
    beginOpen,
    applyLoadedGroups,
    acceptRestoredDraft,
    discardRestoredDraft,
    setScopeLocal,
    setFocusedGroupKey,
    toggleBatchDetails,
    setIntent,
    clearIntent,
    goToSummary,
    goToReview,
    recoverToReview,
    setBusy,
    setLoading,
    setErrorMessage,
    setFieldErrors,
    setFocusFieldKey,
    setConflictState,
    setReplayConflicts,
    setResultAndClearDraft,
    replaceDraft: setDraft,
    applyLocalValidation,
    closeReconciliation,
    persistDraft,
    clearPersistedDraft,
    resetForNewReconciliation,
  };
}
