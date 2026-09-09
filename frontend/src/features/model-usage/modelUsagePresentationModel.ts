import { modelUsageDecimalToScaledInteger, modelUsageScaledIntegerToDecimal } from './modelUsageChartModel';

/** Budget arithmetic stays in the same decimal precision as the usage ledger. */
export function modelUsageBudgetBalance(budgetValue: string | null, spendValue: string | null) {
  const budget = modelUsageDecimalToScaledInteger(budgetValue);
  const spend = modelUsageDecimalToScaledInteger(spendValue);
  if (budget === null || budget === 0n || spend === null) return null;
  const tenths = (spend * 1000n + budget / 2n) / budget;
  return {
    percentage: spend > 0n && tenths === 0n ? '<0.1' : `${tenths / 10n}.${tenths % 10n}`,
    progress: spend >= budget ? 100 : Number(spend * 10000n / budget) / 100,
    exceeded: spend > budget,
    amount: modelUsageScaledIntegerToDecimal(spend > budget ? spend - budget : budget - spend),
  };
}
