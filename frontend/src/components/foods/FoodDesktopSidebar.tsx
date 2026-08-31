import type { Food, FoodScene } from '../../api/types/food';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { FoodPlanSurface, type FoodPlanSurfaceProps } from './FoodPlanSurface';
import type { FoodSceneCardView } from './useFoodSceneState';
import { resolveFoodAssetUrl } from './FoodWorkspaceModel';

type RepeatFood = { food: Food };

export type FoodDesktopSidebarProps = {
  repeatFoods: RepeatFood[];
  repeatFoodCount: number;
  managementIssueCount: number;
  needsInfoCount: number;
  foodScenes: FoodScene[];
  sceneCards: FoodSceneCardView[];
  sceneFilter: string;
  nextGovernanceFood: Food | null;
  nextGovernanceSummary: string;
  plan: FoodPlanSurfaceProps;
  onSetLensFavorite: () => void;
  onSetLensExpiring: () => void;
  onOpenGovernanceIssue: () => void;
  onOpenSceneManager: () => void;
  onOpenNextGovernanceFood: () => void;
  onToggleScene: (sceneName: string) => void;
};

export function FoodDesktopSidebar({
  repeatFoods,
  repeatFoodCount,
  managementIssueCount,
  needsInfoCount,
  foodScenes,
  sceneCards,
  sceneFilter,
  nextGovernanceFood,
  nextGovernanceSummary,
  plan,
  onSetLensFavorite,
  onSetLensExpiring,
  onOpenGovernanceIssue,
  onOpenSceneManager,
  onOpenNextGovernanceFood,
  onToggleScene,
}: FoodDesktopSidebarProps) {
  return (
    <aside className="food-task-sidebar" aria-label="食物页辅助操作">
      <div className="food-task-sidebar-head">
        <strong>食物管理</strong>
        <span className="eyebrow">管理食物，安排下一餐</span>
      </div>
      <div className="food-sidebar-section food-sidebar-quick-section">
        <div className="food-sidebar-section-head"><strong>常用筛选</strong></div>
        <div className="food-library-insight" aria-label="食物快捷筛选">
          <button type="button" onClick={onSetLensFavorite} title={repeatFoods.map(({ food }) => food.name).join('、') || '常吃清单'}>
            <span>常吃清单</span>
            <strong>{repeatFoodCount}</strong>
          </button>
          <button type="button" onClick={onSetLensExpiring}>
            <span>临期或需要完善信息</span>
            <strong>{managementIssueCount}</strong>
          </button>
          <button type="button" onClick={onOpenGovernanceIssue}>
            <span>需要完善</span>
            <strong>{needsInfoCount}</strong>
          </button>
        </div>
      </div>
      <div className="food-sidebar-section food-sidebar-management-section">
        <div className="food-sidebar-section-head"><strong>管理</strong></div>
        <div className="food-library-insight" aria-label="食物管理入口">
          <button type="button" onClick={onOpenSceneManager}>
            <span>场景管理</span>
            <strong>{foodScenes.filter((scene) => !scene.hidden).length}</strong>
          </button>
        </div>
        <div className="food-library-next-task">
          <span>{nextGovernanceFood ? '下一项' : '需要完善'}</span>
          <strong>{nextGovernanceSummary}</strong>
          <button type="button" disabled={!nextGovernanceFood} onClick={onOpenNextGovernanceFood}>继续完善</button>
        </div>
      </div>
      <FoodPlanSurface {...plan} mobileWeekPage={null} />
      <div className="food-sidebar-section food-sidebar-scenes-section">
        <div className="food-sidebar-section-head">
          <strong>按场景探索</strong>
          <span>按场景浏览食物</span>
        </div>
        <div className="food-sidebar-scene-list" aria-label="按场景探索">
          {sceneCards.length > 0 ? sceneCards.map((scene) => {
            const sceneImageUrl = resolveMediaUrl(scene.imageAsset, 'thumb') ?? (scene.imageUrl ? resolveFoodAssetUrl(scene.imageUrl) : undefined);
            return (
              <button key={scene.name} className={sceneFilter === scene.name ? 'active' : ''} type="button" onClick={() => onToggleScene(scene.name)}>
                <span className="food-sidebar-scene-thumb">
                  <MediaWithPlaceholder src={sceneImageUrl} srcSet={buildMediaSrcSet(scene.imageAsset)} sizes={buildMediaSizes('thumb')} alt="" />
                </span>
                <span className="food-sidebar-scene-copy">
                  <strong>{scene.name}</strong>
                  <span>{scene.description || (scene.count > 0 ? `${scene.count} 种食物` : '浏览这个场景')}</span>
                </span>
              </button>
            );
          }) : <span className="food-sidebar-empty">还没有场景标签</span>}
        </div>
      </div>
    </aside>
  );
}
