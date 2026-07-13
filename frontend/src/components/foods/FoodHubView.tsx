import type { ReactNode } from 'react';

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
      {props.heroActions}
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
