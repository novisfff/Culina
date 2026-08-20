import type {
  FamilyModelConfigDraft,
  FamilyModelDraftValidation,
  FamilyModelPrices,
  FamilyModelSearchReplacement,
  FamilyModelSettings,
} from '../../api/types';
import type { FamilyModelSettingsDraft } from './familyModelSettingsModel';
import type { FamilyModelSettingsOverview } from './familyModelSettingsOverviewModel';
import type { useFamilyModelSettingsActions } from './useFamilyModelSettingsActions';
import type {
  FamilyModelSettingsBusyAction,
  FamilyModelSettingsState,
  FamilyModelSettingsSection,
} from './useFamilyModelSettingsState';

export type FamilyModelSettingsMutationActions = ReturnType<typeof useFamilyModelSettingsActions>['actions'];

export type FamilyModelProfileRebindOptions = {
  refreshServerDraft?: boolean;
};

export type FamilyModelSettingsSurfaceProps = {
  overview: FamilyModelSettingsOverview;
  settings: FamilyModelSettings;
  serverDraft: FamilyModelConfigDraft;
  draft: FamilyModelSettingsDraft;
  prices: FamilyModelPrices | null;
  validation: FamilyModelDraftValidation | null;
  searchReplacement: FamilyModelSearchReplacement | null;
  state: FamilyModelSettingsState;
  actions: FamilyModelSettingsMutationActions;
  busyAction: FamilyModelSettingsBusyAction | null;
  errorMessage: string | null;
  stale: boolean;
  replacementProfileId: string | null;
  onBack: () => void;
  onSelectSection: (section: FamilyModelSettingsSection) => void;
  onSelectProfile: (profileId: string | null) => void;
  onRebindCreatedProfile: (
    fromProfileId: string,
    toProfileId: string,
    options?: FamilyModelProfileRebindOptions,
  ) => Promise<void>;
  onPushMobileTask: (section: FamilyModelSettingsSection) => void;
  onPopMobileTask: () => void;
  onDraftChange: (draft: FamilyModelSettingsDraft) => void;
  onSaveDraft: () => Promise<void>;
  onValidate: () => Promise<void>;
  onPublish: (input: { currentPassword: string; configChecksum: string; priceChecksum: string }) => Promise<void>;
  onReplacementProfileIdChange: (profileId: string | null) => void;
};
