import type { FamilyModelCapability, FamilyModelSettings } from '../../api/types';
import type { FamilyModelSettingsDraft } from './familyModelSettingsModel';
import { FAMILY_MODEL_REQUIRED_METERS, validateFamilyModelPriceRates, validateMoneyInput } from './familyModelSettingsModel';
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

export type FamilyModelConfigurationStatus = {
  kind: 'unconfigured' | 'saving' | 'active';
  label: string;
  description: string;
};

export type FamilyModelSettingsOverview = {
  title: string;
  providerCount: number;
  enabledCapabilityCount: number;
  pricedCapabilityCount: number;
  configurationStatus: FamilyModelConfigurationStatus;
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
  { id: 'providers', number: 1, label: '添加模型服务', description: '保存服务地址与密钥' },
  { id: 'capabilities', number: 2, label: '选择功能', description: '选择每类功能使用的模型' },
  { id: 'prices', number: 3, label: '设置价格（可选）', description: '未填写的计费项按 0 元计入费用' },
  { id: 'review', number: 4, label: '配置检查', description: '检查配置是否完整，并查看提醒' },
];

function enabledCapabilitySet(draft: FamilyModelSettingsDraft): Set<FamilyModelCapability> {
  return new Set(draft.bindings.filter((binding) => binding.enabled).map((binding) => binding.capability));
}

function pricedCapabilityCount(draft: FamilyModelSettingsDraft, enabled: Set<FamilyModelCapability>): number {
  let count = 0;
  for (const capability of enabled) {
    const bindings = draft.bindings.filter((binding) => binding.enabled && binding.capability === capability);
    const allMetersPriced = bindings.every((binding) => (
      FAMILY_MODEL_REQUIRED_METERS[binding.capability].every((meter) => {
        const rate = draft.price_rates.find((candidate) => (
          candidate.capability === binding.capability
          && candidate.variant_key === binding.variant_key
          && candidate.meter === meter
        ));
        return Boolean(
          rate
          && !validateMoneyInput(rate.unit_price)
          && Number(rate.unit_price) > 0,
        );
      })
    ));
    if (bindings.length > 0 && allMetersPriced) count += 1;
  }
  return count;
}

function configurationStatusFor(
  settings: FamilyModelSettings,
  dirty: boolean,
): FamilyModelConfigurationStatus {
  const hasActiveConfiguration = Boolean(
    settings.active_config_revision_id && settings.active_price_version_id,
  );
  if (!hasActiveConfiguration) {
    return {
      kind: dirty ? 'saving' : 'unconfigured',
      label: dirty ? '正在保存' : '未配置',
      description: dirty ? '修改会自动保存；信息完整后立即生效。' : '添加模型服务并选择需要的功能后即可使用。',
    };
  }
  if (dirty) {
    return {
      kind: 'saving',
      label: '正在保存',
      description: '修改会自动保存；保存完成后立即切换到新配置。',
    };
  }
  return {
    kind: 'active',
    label: '配置已生效',
    description: '当前家庭正在使用这份配置，后续修改也会自动保存并生效。',
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
  let primaryLabel = providerCount > 0 ? '启用可用的 AI 服务' : '添加第一个 AI 服务';
  if (usableProviderCount > 0 && !capabilitiesReady) {
    primarySection = 'capabilities';
    primaryLabel = '选择需要的功能';
  } else if (usableProviderCount > 0 && !pricingReady) {
    primarySection = 'prices';
    primaryLabel = '设置模型价格（可选）';
  } else if (usableProviderCount > 0 && pricingReady) {
    primarySection = 'review';
    primaryLabel = input.settings.active_config_revision_id && input.settings.active_price_version_id && !input.dirty
      ? '查看配置是否完整'
      : '检查配置是否完整';
  }

  const completed = {
    providers: usableProviderCount > 0,
    capabilities: capabilitiesReady,
    prices: pricingReady,
    review: Boolean(input.settings.active_config_revision_id && input.settings.active_price_version_id) && !input.dirty,
  } satisfies Record<FamilyModelSetupStep['id'], boolean>;

  return {
    title: input.settings.active_config_revision_id && enabledCapabilityCount > 0
      ? '家庭 AI 服务已配置'
      : providerCount > 0
        ? '继续配置家庭 AI 服务'
        : '还没有配置服务',
    providerCount,
    enabledCapabilityCount,
    pricedCapabilityCount: pricedCount,
    configurationStatus: configurationStatusFor(input.settings, input.dirty),
    steps: STEP_CONTENT.map((step) => ({
      ...step,
      status: completed[step.id] ? 'complete' : step.id === primarySection ? 'current' : 'upcoming',
    })),
    primarySection,
    primaryLabel,
  };
}
