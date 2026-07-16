import type { ReactNode } from 'react';
import { PageHeader } from '../ui-kit';

type FoodHubViewProps = {
  heroActions: ReactNode;
  filtersSection: ReactNode;
  feedbackSection: ReactNode;
  gridSection: ReactNode;
  sidebar: ReactNode;
};

export function FoodHubView(props: FoodHubViewProps) {
  return (
    <>
      <PageHeader
        variant="compact"
        title="吃什么"
        description="选一份，安排这餐。"
        actions={props.heroActions}
      />

      <div className="food-content-layout">
        <div className="food-content-main">
          {props.filtersSection}
          {props.feedbackSection}
          {props.gridSection}
        </div>
        {props.sidebar}
      </div>
    </>
  );
}
