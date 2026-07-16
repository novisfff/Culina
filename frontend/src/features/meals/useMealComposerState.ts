import { useCallback, useMemo, useState } from 'react';
import type { MealLogCandidate, MealType, MediaAsset, RecordMealTarget } from '../../api/types';
import {
  createMealBusinessDate,
  deriveCandidatePresentation,
  mealTypeFromBusinessInstant,
  type MealComposerFood,
} from './MealComposerModel';

export type MealComposerMode = 'full' | 'compact';

export type PrefilledComposerFood = {
  food_id: string;
  name: string;
  cover?: MediaAsset | null;
  servings?: number;
};

export type UseMealComposerStateArgs = {
  mode: MealComposerMode;
  prefilledFood?: PrefilledComposerFood | null;
  now?: Date;
  /** Injectable for tests; defaults to crypto.randomUUID. */
  createRequestId?: () => string;
  initialMealType?: MealType;
};

function defaultCreateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `meal-record-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function seedFoods(
  mode: MealComposerMode,
  prefilledFood?: PrefilledComposerFood | null,
): MealComposerFood[] {
  if (mode !== 'compact' || !prefilledFood) {
    return [];
  }
  return [
    {
      kind: 'existing',
      food_id: prefilledFood.food_id,
      name: prefilledFood.name,
      servings: prefilledFood.servings ?? 1,
      cover: prefilledFood.cover ?? null,
    },
  ];
}

export type MealComposerState = {
  open: boolean;
  mode: MealComposerMode;
  date: string;
  mealType: MealType;
  foods: MealComposerFood[];
  target: RecordMealTarget;
  selectedCandidateId: string | null;
  candidateMode: ReturnType<typeof deriveCandidatePresentation>['mode'];
  recordClientRequestId: string;
  busy: boolean;
  error: string | null;
  requiresTargetReconfirm: boolean;
  openComposer: (options?: { mealType?: MealType; date?: string }) => void;
  close: () => void;
  discard: () => void;
  setDate: (date: string) => void;
  setMealType: (mealType: MealType) => void;
  setFoods: (foods: MealComposerFood[] | ((current: MealComposerFood[]) => MealComposerFood[])) => void;
  setTarget: (target: RecordMealTarget, selectedCandidateId?: string | null) => void;
  /**
   * Apply authoritative candidate defaults.
   * Does not overwrite a target the user already chose for the current date/meal slot,
   * unless `force` is true (stale reconfirm / date-meal reset path).
   */
  applyCandidates: (candidates: MealLogCandidate[], options?: { force?: boolean }) => void;
  markTargetStaleAndRefresh: (candidates: MealLogCandidate[]) => void;
  clearTargetReconfirm: () => void;
  /** Rotate client request id after idempotency_key_reused / record_operation_reverted. */
  rotateClientRequestId: () => void;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
};

export function useMealComposerState(args: UseMealComposerStateArgs): MealComposerState {
  const createRequestId = args.createRequestId ?? defaultCreateRequestId;
  const now = args.now ?? new Date();
  const initialDate = createMealBusinessDate(now);
  const initialMealType = args.initialMealType ?? mealTypeFromBusinessInstant(now);
  const initialFoods = seedFoods(args.mode, args.prefilledFood);

  const [open, setOpen] = useState(false);
  const [date, setDateState] = useState(initialDate);
  const [mealType, setMealTypeState] = useState<MealType>(initialMealType);
  const [foods, setFoodsState] = useState<MealComposerFood[]>(initialFoods);
  const [target, setTargetState] = useState<RecordMealTarget>({ kind: 'new' });
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [candidateMode, setCandidateMode] = useState<ReturnType<typeof deriveCandidatePresentation>['mode']>('none');
  const [recordClientRequestId, setRecordClientRequestId] = useState(createRequestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requiresTargetReconfirm, setRequiresTargetReconfirm] = useState(false);
  /** User explicitly chose a target for the current date/mealType slot. */
  const [targetTouchedByUser, setTargetTouchedByUser] = useState(false);

  const resetDraftIdentity = useCallback(() => {
    setDateState(createMealBusinessDate(args.now ?? new Date()));
    setMealTypeState(args.initialMealType ?? mealTypeFromBusinessInstant(args.now ?? new Date()));
    setFoodsState(seedFoods(args.mode, args.prefilledFood));
    setTargetState({ kind: 'new' });
    setSelectedCandidateId(null);
    setCandidateMode('none');
    setRecordClientRequestId(createRequestId());
    setBusy(false);
    setError(null);
    setRequiresTargetReconfirm(false);
    setTargetTouchedByUser(false);
  }, [args.initialMealType, args.mode, args.now, args.prefilledFood, createRequestId]);

  const openComposer = useCallback(
    (options?: { mealType?: MealType; date?: string }) => {
      if (options?.date) setDateState(options.date);
      if (options?.mealType) setMealTypeState(options.mealType);
      setOpen(true);
      setError(null);
    },
    [],
  );

  const close = useCallback(() => {
    // Accidental dismissal keeps draft + request identity for reopen.
    setOpen(false);
    setBusy(false);
  }, []);

  const discard = useCallback(() => {
    setOpen(false);
    resetDraftIdentity();
  }, [resetDraftIdentity]);

  const setDate = useCallback((nextDate: string) => {
    setDateState(nextDate);
    setTargetState({ kind: 'new' });
    setSelectedCandidateId(null);
    setCandidateMode('none');
    setRequiresTargetReconfirm(false);
    setTargetTouchedByUser(false);
    setError(null);
  }, []);

  const setMealType = useCallback((nextMealType: MealType) => {
    setMealTypeState(nextMealType);
    setTargetState({ kind: 'new' });
    setSelectedCandidateId(null);
    setCandidateMode('none');
    setRequiresTargetReconfirm(false);
    setTargetTouchedByUser(false);
    setError(null);
  }, []);

  const setFoods = useCallback(
    (next: MealComposerFood[] | ((current: MealComposerFood[]) => MealComposerFood[])) => {
      setFoodsState(next);
    },
    [],
  );

  const setTarget = useCallback((nextTarget: RecordMealTarget, nextSelectedId: string | null = null) => {
    setTargetState(nextTarget);
    setSelectedCandidateId(
      nextSelectedId ?? (nextTarget.kind === 'existing' ? nextTarget.meal_log_id : null),
    );
    setRequiresTargetReconfirm(false);
    setTargetTouchedByUser(true);
    setError(null);
  }, []);

  const applyCandidates = useCallback(
    (candidates: MealLogCandidate[], options?: { force?: boolean }) => {
      const presentation = deriveCandidatePresentation(candidates, mealType);
      setCandidateMode(presentation.mode);
      // Never clobber an explicit user choice for this slot unless forced (stale path).
      if (options?.force || !targetTouchedByUser) {
        setTargetState(presentation.target);
        setSelectedCandidateId(presentation.selectedCandidateId);
      }
      setRequiresTargetReconfirm(false);
    },
    [mealType, targetTouchedByUser],
  );

  const markTargetStaleAndRefresh = useCallback(
    (candidates: MealLogCandidate[]) => {
      const presentation = deriveCandidatePresentation(candidates, mealType);
      setCandidateMode(presentation.mode);
      setTargetState(presentation.target);
      setSelectedCandidateId(presentation.selectedCandidateId);
      setTargetTouchedByUser(false);
      setRequiresTargetReconfirm(true);
      setError('这顿饭刚被家人更新，请重新确认');
    },
    [mealType],
  );

  const clearTargetReconfirm = useCallback(() => {
    setRequiresTargetReconfirm(false);
  }, []);

  const rotateClientRequestId = useCallback(() => {
    setRecordClientRequestId(createRequestId());
  }, [createRequestId]);

  return useMemo(
    () => ({
      open,
      mode: args.mode,
      date,
      mealType,
      foods,
      target,
      selectedCandidateId,
      candidateMode,
      recordClientRequestId,
      busy,
      error,
      requiresTargetReconfirm,
      openComposer,
      close,
      discard,
      setDate,
      setMealType,
      setFoods,
      setTarget,
      applyCandidates,
      markTargetStaleAndRefresh,
      clearTargetReconfirm,
      rotateClientRequestId,
      setBusy,
      setError,
    }),
    [
      applyCandidates,
      args.mode,
      busy,
      candidateMode,
      clearTargetReconfirm,
      close,
      date,
      discard,
      error,
      foods,
      markTargetStaleAndRefresh,
      mealType,
      open,
      openComposer,
      recordClientRequestId,
      requiresTargetReconfirm,
      rotateClientRequestId,
      selectedCandidateId,
      setDate,
      setFoods,
      setMealType,
      setTarget,
      target,
    ],
  );
}
