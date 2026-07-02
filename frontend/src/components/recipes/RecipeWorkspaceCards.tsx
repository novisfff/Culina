import { AppLogoIcon } from '../../app/shellIcons';
import { buildMediaSizes, buildMediaSrcSet, resolveAssetUrl, resolveMediaUrl } from '../../lib/assets';
import { ActionButton, Badge } from '../ui-kit';
import { DIFFICULTY_LABELS, type RecipeCardViewModel } from './workspaceModel';
import type { RecipeSceneCard, RecipeUiIconName } from './RecipeWorkspaceModel';
import { MediaWithPlaceholder } from '../MediaPlaceholder';

export function RecipeUiIcon(props: { name: RecipeUiIconName; className?: string }) {
  const common = {
    viewBox: '0 0 24 24',
    'aria-hidden': true,
    className: props.className ? `recipe-ui-icon ${props.className}` : 'recipe-ui-icon',
  };

  switch (props.name) {
    case 'basket':
      return (
        <svg {...common}>
          <path d="M8 10.2 10.2 5M16 10.2 13.8 5" />
          <path d="M5.2 10.2h13.6l-1.3 8.1a2.2 2.2 0 0 1-2.2 1.9H8.7a2.2 2.2 0 0 1-2.2-1.9l-1.3-8.1Z" />
          <path d="M4 10.2h16M9.2 14v2.8M12 14v2.8M14.8 14v2.8" />
        </svg>
      );
    case 'bell':
      return (
        <svg {...common}>
          <path d="M6 9a6 6 0 0 1 12 0c0 7 3 6 3 8H3c0-2 3-1 3-8" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
      );
    case 'calendar':
      return (
        <svg {...common}>
          <path d="M7 4v3M17 4v3M5.5 9.5h13" />
          <rect x="4.5" y="6.5" width="15" height="13" rx="3" />
          <path d="M8 13h.01M12 13h.01M16 13h.01M8 16h.01M12 16h.01" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <path d="m5.5 12.4 4.1 4.1 8.9-9" />
        </svg>
      );
    case 'chevronDown':
      return (
        <svg {...common}>
          <path d="m7 9.5 5 5 5-5" />
        </svg>
      );
    case 'chevronLeft':
      return (
        <svg {...common}>
          <path d="m14.5 6-6 6 6 6" />
        </svg>
      );
    case 'chevronRight':
      return (
        <svg {...common}>
          <path d="m9.5 6 6 6-6 6" />
        </svg>
      );
    case 'clock':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.2" />
          <path d="M12 7.8v4.6l3.1 1.9" />
        </svg>
      );
    case 'clipboard':
      return (
        <svg {...common}>
          <path d="M9 5.5h6M9.4 4.2h5.2a1.4 1.4 0 0 1 1.4 1.4v1H8v-1a1.4 1.4 0 0 1 1.4-1.4Z" />
          <path d="M7.4 6.5H6.3a2 2 0 0 0-2 2v10.1a2 2 0 0 0 2 2h11.4a2 2 0 0 0 2-2V8.5a2 2 0 0 0-2-2h-1.1" />
          <path d="M8.2 12h7.6M8.2 15.5h5.4" />
        </svg>
      );
    case 'edit':
      return (
        <svg {...common}>
          <path d="M4.8 16.9 4 20l3.1-.8L18.5 7.8a2.1 2.1 0 0 0-3-3L4.8 16.9Z" />
          <path d="m14.3 6 3.2 3.2M11.5 20h7.2" />
        </svg>
      );
    case 'filter':
      return (
        <svg {...common}>
          <path d="M5 6.5h14l-5.3 6.1v4.3l-3.4 1.8v-6.1L5 6.5Z" />
        </svg>
      );
    case 'flame':
      return (
        <svg {...common}>
          <path d="M12.6 3.8c.4 2.7-1.4 4.1-2.8 5.9-1.1 1.4-1.9 2.8-1.9 4.7 0 3.4 2.6 5.8 5.9 5.8s5.9-2.3 5.9-5.8c0-2.5-1.5-4.8-4.1-7.4-.4 2-1.7 3.2-3.1 4.3" />
          <path d="M12.3 14.4c-.7 1-.8 2.1-.1 3 .4.6 1.1.9 1.9.9 1.4 0 2.4-1 2.4-2.5 0-1.1-.6-2.1-1.6-3.1-.4.9-1 1.4-1.7 1.8" />
        </svg>
      );
    case 'heart':
      return (
        <svg {...common}>
          <path d="M12 20.2 5.1 13.6C2.9 11.5 2.8 8 4.8 6c1.9-1.9 5-1.7 6.7.4l.5.6.5-.6c1.7-2.1 4.8-2.3 6.7-.4 2 2 1.9 5.5-.3 7.6L12 20.2Z" />
        </svg>
      );
    case 'image':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="14" rx="2.4" />
          <path d="m7.5 16 3.4-3.4 2.4 2.4 2.1-2.1L19 16.5" />
          <circle cx="8.7" cy="9" r="1.2" />
        </svg>
      );
    case 'info':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.2" />
          <path d="M12 10.8v5.1M12 8.1h.01" />
        </svg>
      );
    case 'leaf':
      return (
        <svg {...common}>
          <path d="M5.3 13.1c0-5.2 5.1-8.1 12.9-8.7-.4 7.8-3.5 12.8-8.7 12.8-2.5 0-4.2-1.7-4.2-4.1Z" />
          <path d="M8.3 14.8c2.4-2.7 5-4.7 8.3-6.2" />
        </svg>
      );
    case 'logo':
      return <AppLogoIcon className={common.className} />;
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case 'minus':
      return (
        <svg {...common}>
          <path d="M5 12h14" />
        </svg>
      );
    case 'pause':
      return (
        <svg {...common}>
          <path d="M9 6.5v11M15 6.5v11" />
        </svg>
      );
    case 'play':
      return (
        <svg {...common}>
          <path d="M8 5.8v12.4l10-6.2L8 5.8Z" />
        </svg>
      );
    case 'search':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
      );
    case 'plusThirty':
      return (
        <svg {...common}>
          <circle cx="11" cy="12" r="6.2" />
          <path d="M11 8.8v3.4l2.4 1.4" />
          <path d="M4.6 12h2.2M11 5.8v2.1" />
          <path d="M17 5.1v2.3M15.9 6.2h2.3" />
          <path d="M16.2 14.9v4.2M14.1 17h4.2" />
        </svg>
      );
    case 'reset':
      return (
        <svg {...common}>
          <path d="M5.1 8.5A7.2 7.2 0 1 1 4.8 16" />
          <path d="M5 4.8v3.7h3.7" />
        </svg>
      );
    case 'signal':
      return (
        <svg {...common}>
          <path d="M5.5 18.5h2.2v-4.2H5.5v4.2ZM10.9 18.5h2.2V9.7h-2.2v8.8ZM16.3 18.5h2.2V5.5h-2.2v13Z" />
        </svg>
      );
    case 'sparkle':
      return (
        <svg {...common}>
          <path d="M12 3.8 14 9l5.2 2-5.2 2-2 5.2-2-5.2-5.2-2 5.2-2L12 3.8Z" />
        </svg>
      );
    case 'star':
      return (
        <svg {...common}>
          <path d="m12 4.2 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8L12 4.2Z" />
        </svg>
      );
    case 'tag':
      return (
        <svg {...common}>
          <path d="M4.8 11.7V5.2h6.5l8.1 8.1a2.1 2.1 0 0 1 0 3l-3.1 3.1a2.1 2.1 0 0 1-3 0L4.8 11.7Z" />
          <path d="M8.1 8.1h.01" />
        </svg>
      );
    case 'utensils':
      return (
        <svg {...common}>
          <path d="M7.2 4.5v6.2M4.8 4.5v6.2M9.6 4.5v6.2M4.8 10.7h4.8M7.2 10.7v8.8M15.2 4.5c2.2 1.6 3.3 3.5 3.3 5.8 0 2.2-1.1 3.8-3.3 4.8v4.4" />
        </svg>
      );
    case 'users':
      return (
        <svg {...common}>
          <path d="M9.6 11.1a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2Z" />
          <path d="M3.9 19.1c.5-3.1 2.5-5 5.7-5s5.2 1.9 5.7 5" />
          <path d="M15.5 11.3a2.6 2.6 0 1 0-.5-5.1M17 14.2c1.8.6 2.9 2.2 3.1 4.7" />
        </svg>
      );
    case 'view':
      return (
        <svg {...common}>
          <path d="M3.8 12s3-5.2 8.2-5.2 8.2 5.2 8.2 5.2-3 5.2-8.2 5.2S3.8 12 3.8 12Z" />
          <circle cx="12" cy="12" r="2.4" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...common}>
          <path d="M12 4.2 21 19H3L12 4.2Z" />
          <path d="M12 9.3v4.4M12 16.6h.01" />
        </svg>
      );
    case 'zap':
      return (
        <svg {...common}>
          <path d="m13.3 3-7 10h5.2L10.7 21l7-10h-5.2L13.3 3Z" />
        </svg>
      );
  }
}

export function getRecipeVisualTone(recipeId: string) {
  const tones = ['tomato', 'fish', 'greens', 'egg'] as const;
  const score = [...recipeId].reduce((total, char) => total + char.charCodeAt(0), 0);
  return tones[score % tones.length];
}

export function RecipeDishIllustration(props: { title: string; tone: ReturnType<typeof getRecipeVisualTone> }) {
  return (
    <span className={`recipe-cover-illustration tone-${props.tone}`} aria-label={props.title}>
      <svg viewBox="0 0 160 120" aria-hidden="true">
        <path className="blob blob-a" d="M0 0h160v120H0z" />
        <circle className="accent accent-a" cx="32" cy="28" r="25" />
        <circle className="accent accent-b" cx="122" cy="30" r="20" />
        <path className="plate" d="M36 77c0-20 18-36 44-36s44 16 44 36v17H36V77Z" />
        <path className="plate-line" d="M53 76c0-12 11-21 27-21s27 9 27 21" />
        <circle className="food food-a" cx="60" cy="58" r="15" />
        <path className="food food-b" d="M88 43c17 4 28 14 28 25-17 2-31-3-39-16 3-5 6-8 11-9Z" />
        <path className="garnish" d="M102 48c4-11 11-16 23-18-1 11-8 18-20 21" />
      </svg>
      <small>{props.title}</small>
    </span>
  );
}

export function RecipeCover(props: { card: RecipeCardViewModel; className?: string }) {
  const url = resolveMediaUrl(props.card.coverAsset, 'card') ?? resolveAssetUrl(props.card.coverUrl);
  return (
    <div className={props.className ? `recipe-work-cover ${props.className}` : 'recipe-work-cover'}>
      <MediaWithPlaceholder
        src={url}
        srcSet={buildMediaSrcSet(props.card.coverAsset)}
        sizes={buildMediaSizes('card')}
        alt={props.card.recipe.title}
      />
    </div>
  );
}

export function RecipeCard(props: {
  card: RecipeCardViewModel;
  onDetail: () => void;
  onEdit: () => void;
  onCook: () => void;
  onShopping: () => void;
  onDelete: () => void;
  isDeleting?: boolean;
}) {
  return (
    <article className={`recipe-work-card tone-${props.card.availability}`}>
      <RecipeCover card={props.card} />
      <div className="recipe-work-card-body">
        <div className="recipe-work-card-head">
          <div>
            <h3>{props.card.recipe.title}</h3>
            <p>
              {props.card.recipe.prep_minutes} 分钟 · {props.card.recipe.servings} 人份 · {DIFFICULTY_LABELS[props.card.recipe.difficulty]}
            </p>
          </div>
          <Badge className={`recipe-availability-badge tone-${props.card.availability}`}>{props.card.availabilityLabel}</Badge>
        </div>
        <p className="recipe-work-ingredient-line">
          {props.card.ingredientPreview.join('、')}
          {props.card.hiddenIngredientCount > 0 ? `、+${props.card.hiddenIngredientCount}` : ''}
        </p>
        <p className="subtle">{props.card.availabilityDetail}</p>
        <div className="recipe-card-actions">
          <ActionButton tone="primary" size="compact" type="button" onClick={props.onCook}>
            开始做
          </ActionButton>
          <ActionButton tone="secondary" size="compact" type="button" onClick={props.onDetail}>
            查看
          </ActionButton>
          <ActionButton tone="secondary" size="compact" type="button" onClick={props.onShopping}>
            加采购
          </ActionButton>
          <ActionButton tone="tertiary" size="compact" type="button" onClick={props.onEdit}>
            编辑
          </ActionButton>
          <ActionButton tone="tertiary" size="compact" type="button" onClick={props.onDelete} disabled={props.isDeleting}>
            删除
          </ActionButton>
        </div>
      </div>
    </article>
  );
}

export function DiscoveryRecipeCard(props: {
  card: RecipeCardViewModel;
  isFavorite: boolean;
  onDetail: () => void;
  onFavorite: () => void;
  onCook: () => void;
  onPlan: () => void;
  isFavoritePending?: boolean;
}) {
  const canCook = props.card.availability === 'ready';
  return (
    <article className="recipe-discovery-card" onClick={props.onDetail}>
      <RecipeCover card={props.card} className="recipe-discovery-card-cover" />
      <button
        className={props.isFavorite ? 'recipe-favorite-button active' : 'recipe-favorite-button'}
        type="button"
        aria-label={props.isFavorite ? '取消收藏' : '收藏菜谱'}
        aria-pressed={props.isFavorite}
        disabled={props.isFavoritePending}
        onClick={(event) => {
          event.stopPropagation();
          props.onFavorite();
        }}
      >
        <RecipeUiIcon name="heart" />
      </button>
      <div className="recipe-discovery-card-body">
        <h3 title={props.card.recipe.title}>{props.card.recipe.title}</h3>
        <div className="recipe-discovery-meta">
          <span><RecipeUiIcon name="clock" />{props.card.recipe.prep_minutes} 分钟</span>
          <i aria-hidden="true">·</i>
          <span><RecipeUiIcon name="signal" />{DIFFICULTY_LABELS[props.card.recipe.difficulty]}</span>
        </div>
        <div className={`recipe-discovery-availability tone-${props.card.availability}`}>
          <span>{canCook ? <RecipeUiIcon name="sparkle" /> : <RecipeUiIcon name="filter" />}</span>
          {canCook ? '现在可做' : props.card.shortages.length > 0 ? `缺 ${props.card.shortages.length} 项` : props.card.availabilityLabel}
        </div>
        <div className="recipe-discovery-card-actions">
          <button
            className="recipe-discovery-card-hit"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onCook();
            }}
          >
            <RecipeUiIcon name="utensils" />
            开始做
          </button>
          <button
            className="recipe-discovery-view-hit"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onDetail();
            }}
          >
            <RecipeUiIcon name="view" />
            查看
          </button>
        </div>
      </div>
    </article>
  );
}

export function RecipeMiniThumb(props: { card: RecipeCardViewModel; onClick?: () => void }) {
  return (
    <button className="recipe-mini-thumb" type="button" onClick={props.onClick}>
      <RecipeCover card={props.card} />
    </button>
  );
}

export function RecipeMiniPlaceholder() {
  return <span className="recipe-mini-thumb recipe-mini-thumb-placeholder" />;
}

export function RecipeTopItem(props: { card: RecipeCardViewModel; rank: number; count: number; onClick: () => void }) {
  return (
    <button className="recipe-top-item" type="button" onClick={props.onClick}>
      <span className={`recipe-top-rank rank-${props.rank}`}>{props.rank}</span>
      <span>
        <strong>{props.card.recipe.title}</strong>
        <small>本周做了 {props.count} 次</small>
      </span>
    </button>
  );
}

export function RecipeTopPlaceholder(props: { rank: number }) {
  return (
    <span className="recipe-top-item recipe-top-placeholder">
      <span className={`recipe-top-rank rank-${props.rank}`}>{props.rank}</span>
      <span>
        <strong>待积累</strong>
        <small>记录后自动统计</small>
      </span>
    </span>
  );
}

export function RecipeSideIcon(props: { name: RecipeUiIconName }) {
  return (
    <span className="recipe-side-icon">
      <RecipeUiIcon name={props.name} />
    </span>
  );
}

export function MobileRecipeCard(props: {
  card: RecipeCardViewModel;
  featured?: boolean;
  isFavorite: boolean;
  isFavoritePending?: boolean;
  onDetail: () => void;
  onFavorite: () => void;
  onCook: () => void;
  onShopping: () => void;
}) {
  const hasShortages = props.card.shortages.length > 0;
  return (
    <article className={props.featured ? 'mobile-recipe-card mobile-recipe-card-featured' : 'mobile-recipe-card'}>
      <button className="mobile-recipe-cover" type="button" onClick={props.onDetail} aria-label={`查看菜谱：${props.card.recipe.title}`}>
        <RecipeCover card={props.card} />
        <span className={`mobile-recipe-status tone-${props.card.availability}`}>{props.card.availabilityLabel}</span>
      </button>
      <div className="mobile-recipe-card-body">
        <div className="mobile-recipe-card-head">
          <button type="button" onClick={props.onDetail}>
            <strong>{props.card.recipe.title}</strong>
            <small>{props.card.recipe.prep_minutes} 分钟 · {DIFFICULTY_LABELS[props.card.recipe.difficulty]}</small>
          </button>
          <button
            className={props.isFavorite ? 'mobile-recipe-favorite active' : 'mobile-recipe-favorite'}
            type="button"
            aria-label={props.isFavorite ? '取消收藏' : '收藏菜谱'}
            aria-pressed={props.isFavorite}
            disabled={props.isFavoritePending}
            onClick={props.onFavorite}
          >
            <RecipeUiIcon name="heart" />
          </button>
        </div>
        <p>{props.card.availabilityDetail}</p>
        <div className="mobile-recipe-chip-row">
          {(props.card.ingredientPreview.length > 0 ? props.card.ingredientPreview.slice(0, 2) : ['家庭菜谱']).map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
        <div className="mobile-recipe-card-actions">
          <button className="mobile-recipe-primary" type="button" onClick={props.onCook}>
            <RecipeUiIcon name="utensils" />
            开始做
          </button>
          <button type="button" onClick={hasShortages ? props.onShopping : props.onDetail}>
            <RecipeUiIcon name={hasShortages ? 'basket' : 'view'} />
            {hasShortages ? '采购' : '查看'}
          </button>
        </div>
      </div>
    </article>
  );
}

export function MobileRecipeSceneCard(props: {
  scene: RecipeSceneCard;
  coverUrl?: string;
  onClick: () => void;
}) {
  return (
    <button className="mobile-recipe-scene-card" type="button" onClick={props.onClick}>
      <MediaWithPlaceholder
        className="mobile-recipe-scene-media"
        src={resolveAssetUrl(props.coverUrl)}
        alt=""
        emptyLabel="暂无场景图"
        loadingLabel="加载场景图"
        errorLabel="场景图失败"
      />
      <span>
        <strong>{props.scene.name}</strong>
        <small>{props.scene.description || `${props.scene.count} 道菜谱`}</small>
      </span>
      <b aria-hidden="true">
        <RecipeUiIcon name="chevronRight" />
      </b>
    </button>
  );
}
