import { buildMediaSizes } from '../../lib/assets';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { FoodPlanSurface, type FoodPlanSurfaceProps } from './FoodPlanSurface';

export type FoodTabletManagementMetric = {
  label: string;
  value: number;
  title?: string;
  onClick: () => void;
};

export type FoodTabletScene = {
  name: string;
  description: string;
  imageUrl?: string;
  imageSrcSet?: string;
  active: boolean;
  onSelect: () => void;
};

export function FoodTabletSupportSurface(props: {
  metrics: FoodTabletManagementMetric[];
  nextTaskLabel: string;
  nextTaskSummary: string;
  canOpenNextTask: boolean;
  onOpenNextTask: () => void;
  plan: FoodPlanSurfaceProps;
  scenes: FoodTabletScene[];
}) {
  return (
    <aside className="food-tablet-support-surface" aria-label="Pad 食物辅助操作">
      <section className="food-tablet-management-band">
        <div className="food-tablet-management-title">
          <strong>食物管理</strong>
        </div>
        <div className="food-tablet-management-metrics" aria-label="食物管理摘要">
          {props.metrics.map((metric) => (
            <button
              key={metric.label}
              className="food-tablet-management-metric"
              type="button"
              title={metric.title}
              onClick={metric.onClick}
            >
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
            </button>
          ))}
        </div>
        <div className="food-tablet-next-task">
          <span>
            <small>{props.nextTaskLabel}</small>
            <strong>{props.nextTaskSummary}</strong>
          </span>
          <button type="button" disabled={!props.canOpenNextTask} onClick={props.onOpenNextTask}>
            去处理
          </button>
        </div>
      </section>

      <FoodPlanSurface
        {...props.plan}
        presentation="tabletLandscape"
        mobileWeekPage={null}
        weekSectionRef={undefined}
      />

      <section className="food-tablet-scenes-section">
        <div className="food-tablet-scenes-head">
          <strong>按场景探索</strong>
        </div>
        <div className="food-tablet-scene-scroller" aria-label="按场景探索">
          {props.scenes.length > 0 ? props.scenes.map((scene) => (
            <button
              key={scene.name}
              className={scene.active ? 'active' : undefined}
              type="button"
              aria-pressed={scene.active}
              onClick={scene.onSelect}
            >
              <span className="food-tablet-scene-media">
                <MediaWithPlaceholder
                  src={scene.imageUrl}
                  srcSet={scene.imageSrcSet}
                  sizes={buildMediaSizes('thumb')}
                  alt=""
                  showLabel={false}
                />
              </span>
              <span className="food-tablet-scene-copy">
                <strong>{scene.name}</strong>
                <span>{scene.description}</span>
              </span>
            </button>
          )) : (
            <span className="food-tablet-scene-empty">暂无场景标签</span>
          )}
        </div>
      </section>
    </aside>
  );
}
