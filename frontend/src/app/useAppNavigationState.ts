import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import {
  migrateLegacyNavigation,
  parsePersistedNavigation,
  persistedNavigationFromState,
  reduceNavigation,
  type AppNavigationState,
  type AppNavigationTarget,
  type EatBaseView,
} from './appNavigationModel';
import { readStringStorage, writeJsonStorage } from '../lib/storage';

export type AppNavigationService = {
  state: AppNavigationState;
  navigate: (target: AppNavigationTarget, trigger?: HTMLElement | null) => void;
  selectEatView: (view: EatBaseView, trigger?: HTMLElement | null) => void;
  closeTask: () => void;
  registerTaskHeading: (element: HTMLElement | null) => void;
  registerBaseViewFocusTarget: (element: HTMLElement | null) => void;
};

type FocusIntent = 'task' | 'restore' | null;

const NAVIGATION_V2_KEY = 'culina-navigation-v2';
const LEGACY_ACTIVE_TAB_KEY = 'culina-active-tab';

function restoreNavigationState(): AppNavigationState {
  const rawV2 = localStorage.getItem(NAVIGATION_V2_KEY);
  if (rawV2) {
    return parsePersistedNavigation(rawV2);
  }

  const legacyTab = readStringStorage(LEGACY_ACTIVE_TAB_KEY, '');
  if (legacyTab) {
    return migrateLegacyNavigation(legacyTab);
  }

  return parsePersistedNavigation(null);
}

function targetOpensEatTask(target: AppNavigationTarget): boolean {
  if (target.workspace !== 'eat') return false;
  if (target.view === 'food' || target.view === 'recipe' || target.view === 'cook' || target.view === 'meal-create') {
    return true;
  }
  if (target.view === 'plan') return Boolean(target.foodPlanItemId);
  if (target.view === 'history') return Boolean(target.mealLogId);
  return false;
}

function focusWithoutScroll(element: HTMLElement): void {
  element.focus({ preventScroll: true });
}

export function useAppNavigationState(): AppNavigationService {
  const triggerRef = useRef<HTMLElement | null>(null);
  const taskHeadingRef = useRef<HTMLElement | null>(null);
  const baseViewFocusTargetRef = useRef<HTMLElement | null>(null);
  const focusIntentRef = useRef<FocusIntent>(null);
  const [state, dispatch] = useReducer(reduceNavigation, undefined, restoreNavigationState);

  useEffect(() => {
    writeJsonStorage(NAVIGATION_V2_KEY, persistedNavigationFromState(state));
  }, [state.primaryTab, state.eat.baseView, state.eat.discoverSection]);

  const navigate = useCallback((target: AppNavigationTarget, trigger?: HTMLElement | null) => {
    triggerRef.current = trigger ?? null;
    focusIntentRef.current = targetOpensEatTask(target) ? 'task' : null;
    dispatch({ type: 'navigate', target });
  }, []);

  const closeTask = useCallback(() => {
    focusIntentRef.current = 'restore';
    dispatch({ type: 'close-task' });
  }, []);

  const selectEatView = useCallback((view: EatBaseView, trigger?: HTMLElement | null) => {
    triggerRef.current = trigger ?? null;
    focusIntentRef.current = state.eat.task ? 'restore' : null;
    dispatch({ type: 'select-eat-view', view });
  }, [state.eat.task]);

  const registerTaskHeading = useCallback((element: HTMLElement | null) => {
    taskHeadingRef.current = element;
    if (element && focusIntentRef.current === 'task') {
      focusWithoutScroll(element);
      focusIntentRef.current = null;
    }
  }, []);

  const registerBaseViewFocusTarget = useCallback((element: HTMLElement | null) => {
    baseViewFocusTargetRef.current = element;
    if (element && focusIntentRef.current === 'restore' && !triggerRef.current?.isConnected) {
      focusWithoutScroll(element);
      triggerRef.current = null;
      focusIntentRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    if (focusIntentRef.current === 'task' && state.eat.task && taskHeadingRef.current) {
      focusWithoutScroll(taskHeadingRef.current);
      focusIntentRef.current = null;
      return;
    }
    if (focusIntentRef.current !== 'restore' || state.eat.task) return;
    const trigger = triggerRef.current;
    const target = trigger?.isConnected ? trigger : baseViewFocusTargetRef.current;
    if (!target) return;
    focusWithoutScroll(target);
    triggerRef.current = null;
    focusIntentRef.current = null;
  }, [state.eat.task]);

  return {
    state,
    navigate,
    selectEatView,
    closeTask,
    registerTaskHeading,
    registerBaseViewFocusTarget,
  };
}
