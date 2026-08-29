import type { Food, Recipe } from '../../api/types/food';
import {
  getFoodGovernanceIssues,
  isFoodExpiring,
  isFoodMissingDecisionInfo,
} from './FoodWorkspaceHelpers';
import type { FoodGovernanceIssue } from './FoodWorkspaceOptions';

type GovernanceIssueOption = {
  value: FoodGovernanceIssue;
  label: string;
  description: string;
};

export function buildFoodGovernanceData(
  foods: Food[],
  recipes: Recipe[],
  issueFilter: FoodGovernanceIssue | 'all',
  issueOptions: readonly GovernanceIssueOption[],
) {
  const expiringFoods = foods.filter(isFoodExpiring);
  const needsInfoFoods = foods.filter((food) => isFoodMissingDecisionInfo(food, recipes));
  const governanceIssueSummaries = issueOptions.map((item) => ({
    ...item,
    count: foods.filter((food) => getFoodGovernanceIssues(food, recipes).includes(item.value)).length,
  }));
  const governanceQueue = needsInfoFoods
    .filter((food) => issueFilter === 'all' || getFoodGovernanceIssues(food, recipes).includes(issueFilter))
    .slice()
    .sort((left, right) => (
      getFoodGovernanceIssues(right, recipes).length - getFoodGovernanceIssues(left, recipes).length
      || right.updated_at.localeCompare(left.updated_at)
    ));

  return { expiringFoods, needsInfoFoods, governanceIssueSummaries, governanceQueue };
}

export function useFoodGovernanceData(args: {
  foods: Food[];
  recipes: Recipe[];
  issueFilter: FoodGovernanceIssue | 'all';
  issueOptions: readonly GovernanceIssueOption[];
}) {
  return useMemo(
    () => buildFoodGovernanceData(args.foods, args.recipes, args.issueFilter, args.issueOptions),
    [args.foods, args.issueFilter, args.issueOptions, args.recipes],
  );
}
import { useMemo } from 'react';
