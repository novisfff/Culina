import { AppLogoIcon } from '../../app/shellIcons';
import { buildMediaSizes, buildMediaSrcSet, resolveAssetUrl, resolveMediaUrl } from '../../lib/assets';
import type { RecipeCardViewModel } from './workspaceModel';
import type { RecipeUiIconName } from './RecipeWorkspaceModel';
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
    case 'difficulty':
      return (
        <svg {...common}>
          <path d="M5 16.5a7.5 7.5 0 0 1 14 0" />
          <path d="M7.6 13.2 5.9 11.5M12 10V7.6M16.4 13.2l1.7-1.7" />
          <path d="m12 16 3.8-4.2" />
          <circle cx="12" cy="16" r="1.3" />
          <path d="M6 19.5h12" />
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
    case 'sort':
      return (
        <svg {...common}>
          <path d="M6 7h9M6 12h7M6 17h5" />
          <path d="M18 5.5v13M15.5 16l2.5 2.5 2.5-2.5" />
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
