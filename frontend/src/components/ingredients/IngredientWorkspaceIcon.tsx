import { AppLogoIcon } from '../../app/shellIcons';

export type IngredientWorkspaceIconName =
  | 'logo'
  | 'archive'
  | 'inventory'
  | 'shopping'
  | 'search'
  | 'filter'
  | 'status'
  | 'reset'
  | 'alert'
  | 'bell'
  | 'check'
  | 'chevronDown'
  | 'link'
  | 'metricList'
  | 'metricCircle'
  | 'sort'
  | 'plus'
  | 'star'
  | 'stocked'
  | 'total'
  | 'calendar'
  | 'scale'
  | 'swap'
  | 'edit'
  | 'clock'
  | 'user'
  | 'lightbulb'
  | 'exclamation'
  | 'image';

export function IngredientWorkspaceIcon(props: { name: IngredientWorkspaceIconName }) {
  switch (props.name) {
    case 'logo':
      return <AppLogoIcon />;
    case 'archive':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="5" y="4.5" width="14" height="15" rx="2" />
          <path d="M8.5 8.5h7" />
          <path d="M8.5 12h7" />
          <path d="M8.5 15.5h4.5" />
        </svg>
      );
    case 'inventory':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 9.5h14v9H5z" />
          <path d="M7 9.5 8.5 5h7L17 9.5" />
          <path d="M9 14h6" />
        </svg>
      );
    case 'shopping':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 7h1.5l1.2 8.2h7.8l1.3-5.6H8.2" />
          <circle cx="10" cy="18" r="1.2" />
          <circle cx="16" cy="18" r="1.2" />
        </svg>
      );
    case 'search':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
      );
    case 'filter':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 7h14" />
          <path d="M8 12h8" />
          <path d="M10.5 17h3" />
        </svg>
      );
    case 'status':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5.5 8h13" />
          <path d="M5.5 12h13" />
          <path d="M5.5 16h13" />
          <path d="M9 6.7v2.6" />
          <path d="M15 10.7v2.6" />
          <path d="M11.5 14.7v2.6" />
        </svg>
      );
    case 'reset':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 8.5A6.5 6.5 0 1 1 6.7 15" />
          <path d="M7 5v3.5h3.5" />
        </svg>
      );
    case 'alert':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5.5 20 19H4z" />
          <path d="M12 10v4" />
          <path d="M12 17h.01" />
        </svg>
      );
    case 'bell':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9a6 6 0 0 1 12 0c0 7 3 6 3 8H3c0-2 3-1 3-8" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
      );
    case 'check':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 12.4 4 4L18.5 8" />
        </svg>
      );
    case 'chevronDown':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m7 10 5 5 5-5" />
        </svg>
      );
    case 'link':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9.4 14.6 14.6 9.4" />
          <path d="M10.8 7.2 12 6a4 4 0 0 1 5.7 5.7l-1.2 1.2" />
          <path d="M13.2 16.8 12 18a4 4 0 0 1-5.7-5.7l1.2-1.2" />
        </svg>
      );
    case 'metricList':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="6.5" y="5" width="11" height="14" rx="2" />
          <path d="M9.2 9h5.6" />
          <path d="M9.2 12h5.6" />
          <path d="M9.2 15h3.6" />
          <path d="M15.2 3.8v3.4" />
        </svg>
      );
    case 'metricCircle':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7" />
        </svg>
      );
    case 'sort':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 5v14" />
          <path d="m5 8 3-3 3 3" />
          <path d="M16 19V5" />
          <path d="m13 16 3 3 3-3" />
        </svg>
      );
    case 'plus':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7" />
          <path d="M12 8.5v7" />
          <path d="M8.5 12h7" />
        </svg>
      );
    case 'star':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m12 4.5 2.1 4.3 4.7.7-3.4 3.3.8 4.7-4.2-2.2-4.2 2.2.8-4.7-3.4-3.3 4.7-.7z" />
        </svg>
      );
    case 'stocked':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9h12v9H6z" />
          <path d="M8 9V6h8v3" />
          <path d="M9.5 13.5h5" />
        </svg>
      );
    case 'total':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="5" y="5" width="14" height="14" rx="3" />
          <path d="M9 9h6" />
          <path d="M9 12h6" />
          <path d="M9 15h4" />
        </svg>
      );
    case 'calendar':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="5" y="6" width="14" height="13" rx="2" />
          <path d="M8 4.5v3" />
          <path d="M16 4.5v3" />
          <path d="M5 10h14" />
          <path d="M9 14h3.5" />
          <path d="M9 16.5h2" />
        </svg>
      );
    case 'scale':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8.5 19h7" />
          <path d="M12 16.5V5" />
          <path d="M7 7h10" />
          <path d="m7 7-3 6h6z" />
          <path d="m17 7-3 6h6z" />
        </svg>
      );
    case 'swap':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 8h11" />
          <path d="m15 5 3 3-3 3" />
          <path d="M17 16H6" />
          <path d="m9 13-3 3 3 3" />
        </svg>
      );
    case 'edit':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 18h12" />
          <path d="M7.5 14.5 15 7l2 2-7.5 7.5H7.5z" />
          <path d="m14 8 2 2" />
        </svg>
      );
    case 'clock':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7" />
          <path d="M12 8v4.2l2.8 1.6" />
        </svg>
      );
    case 'user':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="8.2" r="3" />
          <path d="M6.5 19a5.5 5.5 0 0 1 11 0" />
        </svg>
      );
    case 'lightbulb':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 17h6" />
          <path d="M10 20h4" />
          <path d="M8.5 13.8a5.2 5.2 0 1 1 7 0c-.7.6-1 1.2-1.1 2H9.6c-.1-.8-.4-1.4-1.1-2z" />
        </svg>
      );
    case 'exclamation':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 6.8v7.2" />
          <path d="M12 17.4h.01" />
        </svg>
      );
    case 'image':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="5" y="6" width="14" height="12" rx="2" />
          <circle cx="9" cy="10" r="1.3" />
          <path d="m7 16 3.3-3.4 2.4 2.4 1.5-1.6L17 16" />
        </svg>
      );
  }
}

