import type {
  ModelUsageCapability,
  ModelUsageFamilyRequestFilters,
  ModelUsagePersonalRequestFilters,
  ModelUsageScope,
} from '../../api/types/modelUsage';

export type ModelUsageRequestStatus = '' | 'priced' | 'estimated' | 'unpriced' | 'needs_review';

export type ModelUsageRequestLogFilters = {
  dateFrom: string;
  dateTo: string;
  capability: '' | ModelUsageCapability;
  provider: string;
  model: string;
  status: ModelUsageRequestStatus;
  page: number;
  limit: number;
};

function periodEnd(period: string): string {
  const [year, month] = period.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(lastDay).padStart(2, '0')}`;
}

export function createModelUsageRequestLogFilters(period: string): ModelUsageRequestLogFilters {
  return {
    dateFrom: `${period}-01`,
    dateTo: periodEnd(period),
    capability: '',
    provider: '',
    model: '',
    status: '',
    page: 0,
    limit: 20,
  };
}

function baseRequestFilters(filters: ModelUsageRequestLogFilters): ModelUsagePersonalRequestFilters {
  return {
    date_from: filters.dateFrom,
    date_to: filters.dateTo,
    ...(filters.capability ? { capability: filters.capability } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    limit: filters.limit,
    offset: filters.page * filters.limit,
  };
}

/** The returned type has no Provider/model fields, including optional ones. */
export function toPersonalModelUsageRequestFilters(
  filters: ModelUsageRequestLogFilters,
): ModelUsagePersonalRequestFilters {
  return baseRequestFilters(filters);
}

export function toFamilyModelUsageRequestFilters(
  filters: ModelUsageRequestLogFilters,
): ModelUsageFamilyRequestFilters {
  return {
    ...baseRequestFilters(filters),
    ...(filters.provider.trim() ? { provider: filters.provider.trim() } : {}),
    ...(filters.model.trim() ? { model: filters.model.trim() } : {}),
  };
}

export function transitionModelUsageRequestLogScope(
  scope: ModelUsageScope,
  filters: ModelUsageRequestLogFilters,
): { scope: ModelUsageScope; filters: ModelUsageRequestLogFilters } {
  if (scope === 'me') {
    return {
      scope,
      filters: { ...filters, provider: '', model: '', page: 0 },
    };
  }
  return { scope, filters: { ...filters, page: 0 } };
}
