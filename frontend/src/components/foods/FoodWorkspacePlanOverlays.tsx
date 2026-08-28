import type { ComponentProps } from 'react';
import { FoodPlanDialog } from './FoodPlanDialog';
import { FoodPlanDetailWithCandidates } from './FoodPlanDetailWithCandidates';

type PlanDialogProps = ComponentProps<typeof FoodPlanDialog>;
type PlanDetailProps = ComponentProps<typeof FoodPlanDetailWithCandidates>;

export type FoodWorkspacePlanOverlaysProps = {
  planDialog: PlanDialogProps | null;
  planDetail: (Omit<PlanDetailProps, 'onComplete' | 'onDelete'> & {
    completePlanItem: PlanDetailProps['onComplete'];
    deletePlanItem: PlanDetailProps['onDelete'];
  }) | null;
};

export function FoodWorkspacePlanOverlays(props: FoodWorkspacePlanOverlaysProps) {
  const renderPlanDetail = () => {
    if (!props.planDetail) return null;
    const { completePlanItem, deletePlanItem, ...detail } = props.planDetail;
    return <FoodPlanDetailWithCandidates {...detail} onComplete={completePlanItem} onDelete={deletePlanItem} />;
  };
  return <>
    {props.planDialog ? <FoodPlanDialog {...props.planDialog} /> : null}
    {renderPlanDetail()}
  </>;
}
