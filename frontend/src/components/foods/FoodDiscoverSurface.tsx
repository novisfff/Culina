import type { ReactNode } from 'react';
import { ActionButton, EmptyState, StateBlock } from '../ui-kit';

export type FoodDiscoverSurfaceProps = {
  desktopContent: ReactNode;
  mobileContent: ReactNode;
  loading: boolean;
  errorMessage: string | null;
  isEmpty: boolean;
  onCreateFood: () => void;
};

export function FoodDiscoverSurface(props: FoodDiscoverSurfaceProps) {
  if (props.loading) {
    return <StateBlock status="loading" title="正在准备家庭食物" description="正在加载家庭食物与推荐。" />;
  }

  return (
    <section className="eat-discover-surface" aria-label="发现">
      {props.errorMessage ? (
        <StateBlock status="error" title="部分推荐暂不可用" description={props.errorMessage} />
      ) : null}
      {props.isEmpty ? (
        <EmptyState
          title="还没有可选的食物"
          description="先添加一道家常菜、外卖或成品。"
          action={
            <ActionButton tone="primary" type="button" onClick={props.onCreateFood}>
              添加食物
            </ActionButton>
          }
        />
      ) : null}
      <div className="food-desktop-view">{props.desktopContent}</div>
      <div className="food-mobile-view">{props.mobileContent}</div>
    </section>
  );
}
