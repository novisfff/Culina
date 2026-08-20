import type { FamilyModelCapability, FamilyModelSettings } from '../../api/types';
import type { FamilyModelSettingsDraft } from './familyModelSettingsModel';
import { validateFamilyModelPriceRates } from './familyModelSettingsModel';
import { profileSupportsCapability } from './familyModelSettingsOptions';
import type { FamilyModelSettingsSection } from './useFamilyModelSettingsState';

export type FamilyModelSetupStepStatus = 'complete' | 'current' | 'upcoming';

export type FamilyModelSetupStep = {
  id: 'providers' | 'capabilities' | 'prices' | 'review';
  number: number;
  label: string;
  description: string;
  status: FamilyModelSetupStepStatus;
};

export type FamilyModelPublication = {
  kind: 'unpublished' | 'local_changes' | 'published';
  label: string;
  description: string;
};

export type FamilyModelSettingsOverview = {
  providerCount: number;
  enabledCapabilityCount: number;
  pricedCapabilityCount: number;
  publication: FamilyModelPublication;
  steps: FamilyModelSetupStep[];
  primarySection: FamilyModelSettingsSection;
  primaryLabel: string;
};

export type DeriveFamilyModelSettingsOverviewInput = {
  settings: FamilyModelSettings;
  draft: FamilyModelSettingsDraft;
  dirty: boolean;
};

const STEP_CONTENT: Array<Pick<FamilyModelSetupStep, 'id' | 'number' | 'label' | 'description'>> = [
  { id: 'providers', number: 1, label: '连接服务', description: '保存服务地址与凭据' },
  { id: 'capabilities', number: 2, label: '绑定能力', description: '选择每类任务使用的模型' },
  { id: 'prices', number: 3, label: '设置价格', description: '补齐启用能力的计量价格' },
  { id: 'review', number: 4, label: '检查发布', description: '验证配置并确认生效' },
];

function enabledCapabilitySet(draft: FamilyModelSettingsDraft): Set<FamilyModelCapability> {
  return new Set(draft.bindings.filter((binding) => binding.enabled).map((binding) => binding.capability));
}

function pricedCapabilityCount(draft: FamilyModelSettingsDraft, enabled: Set<FamilyModelCapability>): number {
  let count = 0;
  for (const capability of enabled) {
    const bindings = draft.bindings.filter((binding) => binding.enabled && binding.capability === capability);
    const rates = draft.price_rates.filter((rate) => rate.capability === capability);
    if (validateFamilyModelPriceRates(bindings, rates).valid) count += 1;
  }
  return count;
}

function publicationFor(settings: FamilyModelSettings, dirty: boolean): FamilyModelPublication {
  const hasPublishedRevision = Boolean(settings.active_config_revision_id && settings.active_price_version_id);
  if (!hasPublishedRevision) {
    return {
      kind: dirty ? 'local_changes' : 'unpublished',
      label: dirty ? '有本地修改' : '尚未发布',
      description: dirty ? '修改只保存在当前页面，完成检查并发布后才会生效。' : '完成四步配置后，家庭成员才能使用这些 AI 能力。',
    };
  }
  if (dirty) {
    return {
      kind: 'local_changes',
      label: '有本地修改',
      description: '当前发布版本仍在生效；本地修改尚未保存或发布。',
    };
  }
  return {
    kind: 'published',
    label: '已有发布版本',
    description: '当前家庭已有生效配置；如需确认服务端草稿是否有变化，请重新检查发布。',
  };
}

export function deriveFamilyModelSettingsOverview(
  input: DeriveFamilyModelSettingsOverviewInput,
): FamilyModelSettingsOverview {
  const providerCount = input.settings.provider_profiles.filter((profile) => !profile.archived).length;
  const usableProviderCount = input.settings.provider_profiles.filter(
    (profile) => !profile.archived && profile.status === 'active',
  ).length;
  const enabledBindings = input.draft.bindings.filter((binding) => binding.enabled);
  const enabled = enabledCapabilitySet(input.draft);
  const enabledCapabilityCount = enabled.size;
  const pricedCount = pricedCapabilityCount(input.draft, enabled);
  const capabilitiesReady = enabledBindings.length > 0 && enabledBindings.every((binding) => {
    const profile = input.settings.provider_profiles.find((candidate) => candidate.id === binding.provider_profile_id);
    return Boolean(
      binding.requested_model.trim()
      && profile
      && profileSupportsCapability(profile, binding.capability),
    );
  });
  const pricingReady = capabilitiesReady
    && validateFamilyModelPriceRates(input.draft.bindings, input.draft.price_rates).valid;

  let primarySection: FamilyModelSettingsSection = 'providers';
  let primaryLabel = providerCount > 0 ? '启用可用的 AI 服务' : '连接第一个 AI 服务';
  if (usableProviderCount > 0 && !capabilitiesReady) {
    primarySection = 'capabilities';
    primaryLabel = '绑定需要的能力';
  } else if (usableProviderCount > 0 && !pricingReady) {
    primarySection = 'prices';
    primaryLabel = '补齐模型价格';
  } else if (usableProviderCount > 0 && pricingReady) {
    primarySection = 'review';
    primaryLabel = input.settings.active_config_revision_id && input.settings.active_price_version_id && !input.dirty
      ? '检查发布状态'
      : '检查并发布';
  }

  const completed = {
    providers: usableProviderCount > 0,
    capabilities: capabilitiesReady,
    prices: pricingReady,
    review: Boolean(input.settings.active_config_revision_id && input.settings.active_price_version_id) && !input.dirty,
  } satisfies Record<FamilyModelSetupStep['id'], boolean>;

  return {
    providerCount,
    enabledCapabilityCount,
    pricedCapabilityCount: pricedCount,
    publication: publicationFor(input.settings, input.dirty),
    steps: STEP_CONTENT.map((step) => ({
      ...step,
      status: completed[step.id] ? 'complete' : step.id === primarySection ? 'current' : 'upcoming',
    })),
    primarySection,
    primaryLabel,
  };
}
