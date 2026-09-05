import { useCallback, useReducer } from 'react';

export type FamilyModelSettingsSection =
  | 'overview'
  | 'providers'
  | 'capabilities'
  | 'prices'
  | 'search'
  | 'review';

export type FamilyModelSettingsOverlay =
  | { kind: 'provider'; profileId: string | null }
  | { kind: 'rotate-key'; profileId: string }
  | { kind: 'search-replacement' }
  | null;

export type FamilyModelSettingsBusyAction =
  | 'save'
  | 'validate'
  | 'rotate'
  | 'test'
  | 'rebuild'
  | 'delete';

export type FamilyModelSettingsState = {
  section: FamilyModelSettingsSection;
  selectedProfileId: string | null;
  overlay: FamilyModelSettingsOverlay;
  dirty: boolean;
  busyAction: FamilyModelSettingsBusyAction | null;
  mobileTaskStack: FamilyModelSettingsSection[];
};

export const initialFamilyModelSettingsState: FamilyModelSettingsState = {
  section: 'overview',
  selectedProfileId: null,
  overlay: null,
  dirty: false,
  busyAction: null,
  mobileTaskStack: [],
};

export type FamilyModelSettingsStateAction =
  | { type: 'select-section'; section: FamilyModelSettingsSection }
  | { type: 'select-profile'; profileId: string | null }
  | { type: 'open-overlay'; overlay: Exclude<FamilyModelSettingsOverlay, null> }
  | { type: 'close-overlay' }
  | { type: 'mark-dirty'; dirty?: boolean }
  | { type: 'busy'; action: FamilyModelSettingsBusyAction }
  | { type: 'settled' }
  | { type: 'push-mobile-task'; section: FamilyModelSettingsSection }
  | { type: 'pop-mobile-task' }
  | { type: 'reset'; section?: FamilyModelSettingsSection };

function isBlocked(state: FamilyModelSettingsState): boolean {
  return state.busyAction !== null;
}

export function reduceFamilyModelSettingsState(
  state: FamilyModelSettingsState,
  action: FamilyModelSettingsStateAction,
): FamilyModelSettingsState {
  switch (action.type) {
    case 'select-section':
      return isBlocked(state) || state.section === action.section
        ? state
        : { ...state, section: action.section, overlay: null };
    case 'select-profile':
      return isBlocked(state) || state.selectedProfileId === action.profileId
        ? state
        : { ...state, selectedProfileId: action.profileId };
    case 'open-overlay':
      return isBlocked(state) ? state : { ...state, overlay: action.overlay };
    case 'close-overlay':
      return isBlocked(state) || state.overlay === null ? state : { ...state, overlay: null };
    case 'mark-dirty':
      return { ...state, dirty: action.dirty ?? true };
    case 'busy':
      return isBlocked(state) ? state : { ...state, busyAction: action.action };
    case 'settled':
      return state.busyAction === null ? state : { ...state, busyAction: null };
    case 'push-mobile-task':
      return isBlocked(state)
        ? state
        : {
          ...state,
          section: action.section,
          mobileTaskStack: [...state.mobileTaskStack, state.section],
        };
    case 'pop-mobile-task': {
      if (isBlocked(state) || state.mobileTaskStack.length === 0) return state;
      const previous = state.mobileTaskStack.at(-1) as FamilyModelSettingsSection;
      return {
        ...state,
        section: previous,
        mobileTaskStack: state.mobileTaskStack.slice(0, -1),
      };
    }
    case 'reset':
      return {
        ...initialFamilyModelSettingsState,
        section: action.section ?? initialFamilyModelSettingsState.section,
      };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export function useFamilyModelSettingsState() {
  const [state, dispatch] = useReducer(reduceFamilyModelSettingsState, initialFamilyModelSettingsState);

  return {
    state,
    actions: {
      selectSection: useCallback((section: FamilyModelSettingsSection) => {
        dispatch({ type: 'select-section', section });
      }, []),
      selectProfile: useCallback((profileId: string | null) => {
        dispatch({ type: 'select-profile', profileId });
      }, []),
      openOverlay: useCallback((overlay: Exclude<FamilyModelSettingsOverlay, null>) => {
        dispatch({ type: 'open-overlay', overlay });
      }, []),
      closeOverlay: useCallback(() => {
        dispatch({ type: 'close-overlay' });
      }, []),
      markDirty: useCallback((dirty = true) => {
        dispatch({ type: 'mark-dirty', dirty });
      }, []),
      begin: useCallback((action: FamilyModelSettingsBusyAction) => {
        dispatch({ type: 'busy', action });
      }, []),
      settle: useCallback(() => {
        dispatch({ type: 'settled' });
      }, []),
      pushMobileTask: useCallback((section: FamilyModelSettingsSection) => {
        dispatch({ type: 'push-mobile-task', section });
      }, []),
      popMobileTask: useCallback(() => {
        dispatch({ type: 'pop-mobile-task' });
      }, []),
      reset: useCallback((section?: FamilyModelSettingsSection) => {
        dispatch({ type: 'reset', section });
      }, []),
    },
  };
}
