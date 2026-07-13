import type { ReactNode } from 'react';
import { PageHeader } from '../ui-kit';

type FoodHubViewProps = {
  heroActions: ReactNode;
  recommendationSection: ReactNode;
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
        description="从常吃、临期、外卖外食和可记录的家常菜里快速选一份，马上记到今天。"
        actions={props.heroActions}
      />

      <div className="food-content-layout">
        <div className="food-content-main">
          {props.recommendationSection}
          {props.filtersSection}
          {props.feedbackSection}
          {props.gridSection}
        </div>
        {props.sidebar}
      </div>
    </>
  );
}
