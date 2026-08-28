import type {
  ModelUsageBreakdownItem,
  ModelUsageCapability,
  ModelUsageMeter,
  ModelUsageMeterTotal,
} from '../../api/types/modelUsage';
import {
  addCalendarDaysToDateKey,
  calendarDaysBetweenDateKeys,
  dateKeyFromUtcParts,
} from '../../lib/date';
import {
  MODEL_USAGE_CAPABILITY_OPTIONS,
  MODEL_USAGE_METER_OPTIONS,
} from './modelUsageOptions';

const DECIMAL_SCALE = 12;
const DECIMAL_FACTOR = 10n ** BigInt(DECIMAL_SCALE);
export const MODEL_USAGE_TREND_DAY_COUNT = 30;
export const MODEL_USAGE_TREND_VISIBLE_DAY_COUNT = 7;

export function modelUsageDecimalToScaledInteger(value: string | null | undefined): bigint | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const integer = match[1] ?? '0';
  const fraction = (match[2] ?? '').slice(0, DECIMAL_SCALE).padEnd(DECIMAL_SCALE, '0');
  return BigInt(integer) * DECIMAL_FACTOR + BigInt(fraction);
}

export function modelUsageScaledIntegerToDecimal(value: bigint): string {
  const integer = value / DECIMAL_FACTOR;
  const fraction = String(value % DECIMAL_FACTOR).padStart(DECIMAL_SCALE, '0');
  return `${integer}.${fraction}`;
}

export interface ModelUsageTrendWindow {
  startDate: string;
  endDate: string;
  periods: string[];
}

export interface ModelUsageTrendPoint {
  date: string;
  amount: bigint;
  hasRecord: boolean;
}

export function buildModelUsageTrendWindow(
  period: string,
  currentDate: string,
): ModelUsageTrendWindow {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new Error('Invalid model usage period');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const selectedPeriodEnd = dateKeyFromUtcParts(year, month + 1, 0);
  const endDate = currentDate.slice(0, 7) === period ? currentDate : selectedPeriodEnd;
  const startDate = addCalendarDaysToDateKey(endDate, -(MODEL_USAGE_TREND_DAY_COUNT - 1));
  const startPeriod = startDate.slice(0, 7);
  const endPeriod = endDate.slice(0, 7);
  return {
    startDate,
    endDate,
    periods: startPeriod === endPeriod ? [endPeriod] : [startPeriod, endPeriod],
  };
}

export function buildModelUsageTrendPoints(
  items: ModelUsageBreakdownItem[],
  window: Pick<ModelUsageTrendWindow, 'startDate' | 'endDate'>,
): ModelUsageTrendPoint[] {
  const amountsByDate = new Map<string, bigint>();
  for (const item of items) {
    if (!item.local_day || item.local_day < window.startDate || item.local_day > window.endDate) continue;
    const amount = modelUsageDecimalToScaledInteger(item.known_priced_cost_cny);
    if (amount === null) continue;
    amountsByDate.set(item.local_day, (amountsByDate.get(item.local_day) ?? 0n) + amount);
  }

  const dayCount = calendarDaysBetweenDateKeys(window.endDate, window.startDate) + 1;
  if (dayCount <= 0) return [];
  return Array.from({ length: dayCount }, (_, index) => {
    const date = addCalendarDaysToDateKey(window.startDate, index);
    return {
      date,
      amount: amountsByDate.get(date) ?? 0n,
      hasRecord: amountsByDate.has(date),
    };
  });
}

function formatScaledQuantity(value: bigint): string {
  const decimal = modelUsageScaledIntegerToDecimal(value);
  const concise = decimal.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  const [integer = '0', fraction] = concise.split('.');
  const groupedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${groupedInteger}.${fraction}` : groupedInteger;
}

export interface CapabilityCostDistributionEntry {
  capability: ModelUsageCapability;
  label: string;
  costCny: string;
  sharePercent: number;
  pricingComplete: boolean;
  unpricedEventCount: number;
}

export interface CapabilityCostDistribution {
  totalCostCny: string;
  entries: CapabilityCostDistributionEntry[];
}

type CapabilityAccumulator = {
  amount: bigint;
  pricingComplete: boolean;
  unpricedEventCount: number;
};

export function buildCapabilityCostDistribution(
  items: ModelUsageBreakdownItem[],
): CapabilityCostDistribution {
  const byCapability = new Map<ModelUsageCapability, CapabilityAccumulator>();

  for (const item of items) {
    if (!item.capability) continue;
    const amount = modelUsageDecimalToScaledInteger(item.known_priced_cost_cny);
    if (amount === null && item.unpriced_event_count <= 0) continue;
    const current = byCapability.get(item.capability) ?? {
      amount: 0n,
      pricingComplete: true,
      unpricedEventCount: 0,
    };
    current.amount += amount ?? 0n;
    current.pricingComplete &&= item.pricing_complete;
    current.unpricedEventCount += item.unpriced_event_count;
    byCapability.set(item.capability, current);
  }

  const total = [...byCapability.values()].reduce((sum, entry) => sum + entry.amount, 0n);
  const entries = [...byCapability.entries()]
    .filter(([, entry]) => entry.amount > 0n || entry.unpricedEventCount > 0)
    .sort(([, left], [, right]) => {
      if (left.amount !== right.amount) return left.amount > right.amount ? -1 : 1;
      return right.unpricedEventCount - left.unpricedEventCount;
    })
    .map(([capability, entry]) => {
      const shareTenths = total > 0n
        ? Number((entry.amount * 1000n + total / 2n) / total)
        : 0;
      return {
        capability,
        label: MODEL_USAGE_CAPABILITY_OPTIONS[capability].label,
        costCny: modelUsageScaledIntegerToDecimal(entry.amount),
        sharePercent: shareTenths / 10,
        pricingComplete: entry.pricingComplete,
        unpricedEventCount: entry.unpricedEventCount,
      };
    });

  return {
    totalCostCny: modelUsageScaledIntegerToDecimal(total),
    entries,
  };
}

export type ModelUsageMeterUnit = 'tokens' | 'seconds' | 'characters' | 'counts';

export interface ModelUsageMeterChartItem {
  meter: ModelUsageMeter;
  label: string;
  quantity: string;
  quantityText: string;
}

export interface ModelUsageMeterGroup {
  unit: ModelUsageMeterUnit;
  label: string;
  items: ModelUsageMeterChartItem[];
}

const METER_UNIT: Record<ModelUsageMeter, ModelUsageMeterUnit> = {
  input_tokens: 'tokens',
  uncached_input_tokens: 'tokens',
  cached_input_tokens: 'tokens',
  output_tokens: 'tokens',
  total_tokens: 'tokens',
  embedding_tokens: 'tokens',
  audio_input_tokens: 'tokens',
  audio_output_tokens: 'tokens',
  tts_tokens: 'tokens',
  audio_input_seconds: 'seconds',
  audio_output_seconds: 'seconds',
  tts_characters: 'characters',
  rerank_requests: 'counts',
  rerank_documents: 'counts',
  generated_images: 'counts',
  request_units: 'counts',
};

const METER_GROUPS: ReadonlyArray<{ unit: ModelUsageMeterUnit; label: string }> = [
  { unit: 'tokens', label: '文本用量（Token）' },
  { unit: 'seconds', label: '音频时长' },
  { unit: 'characters', label: '内容规模' },
  { unit: 'counts', label: '次数与产出' },
];

export function buildModelUsageMeterGroups(totals: ModelUsageMeterTotal[]): ModelUsageMeterGroup[] {
  const quantities = new Map<ModelUsageMeter, bigint>();
  for (const total of totals) {
    const quantity = modelUsageDecimalToScaledInteger(total.quantity);
    if (quantity === null) continue;
    quantities.set(total.meter, (quantities.get(total.meter) ?? 0n) + quantity);
  }

  return METER_GROUPS.map(({ unit, label }) => ({
    unit,
    label,
    items: [...quantities.entries()]
      .filter(([meter, quantity]) => METER_UNIT[meter] === unit && quantity > 0n)
      .map(([meter, quantity]) => ({
        meter,
        label: MODEL_USAGE_METER_OPTIONS[meter].label,
        quantity: modelUsageScaledIntegerToDecimal(quantity),
        quantityText: formatScaledQuantity(quantity),
      })),
  })).filter((group) => group.items.length > 0);
}
