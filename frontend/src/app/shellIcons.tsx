import type { ReactNode } from 'react';

const APP_LOGO_SRC = '/icon-192.png';

export type ShellIconName =
  | 'logo'
  | 'home'
  | 'foods'
  | 'recipes'
  | 'ingredients'
  | 'logs'
  | 'ai'
  | 'family'
  | 'panel-open'
  | 'panel-close'
  | 'logout';

export type DashboardIconName =
  | 'family'
  | 'leaf'
  | 'bell'
  | 'search'
  | 'cart'
  | 'pot'
  | 'plus'
  | 'receipt'
  | 'list'
  | 'chevron'
  | 'arrow-left'
  | 'arrow-right'
  | 'edit'
  | 'check'
  | 'circle'
  | 'speaker'
  | 'speaker-off'
  | 'calendar'
  | 'flame'
  | 'mail'
  | 'map-pin'
  | 'user-plus'
  | 'lock'
  | 'more'
  | 'shield'
  | 'bar-chart'
  | 'link'
  | 'refresh'
  | 'clear'
  | 'trash'
  | 'x';

function IconBase(props: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

export function AppLogoIcon(props: { className?: string }) {
  return (
    <img
      className={props.className ? `shell-logo-image ${props.className}` : 'shell-logo-image'}
      src={APP_LOGO_SRC}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

export function ShellIcon(props: { name: ShellIconName }) {
  switch (props.name) {
    case 'logo':
      return <AppLogoIcon />;
    case 'home':
      return (
        <IconBase>
          <path d="M4 10.5 12 4l8 6.5" />
          <path d="M6.5 9.5V20h11V9.5" />
          <path d="M10 20v-5h4v5" />
        </IconBase>
      );
    case 'foods':
      return (
        <IconBase>
          <path d="M5 13h14" />
          <path d="M6 13a6 6 0 0 0 12 0" />
          <path d="M9 4.5c0 1-1 1.4-1 2.4S9 8.5 9 9.5" />
          <path d="M13 4.5c0 1-1 1.4-1 2.4s1 1.6 1 2.6" />
        </IconBase>
      );
    case 'recipes':
      return (
        <IconBase>
          <path d="M7 5.5h10a2 2 0 0 1 2 2V19H9a3 3 0 0 0-3 3" />
          <path d="M7 5.5V22" />
          <path d="M10 9h6" />
          <path d="M10 13h6" />
        </IconBase>
      );
    case 'ingredients':
      return (
        <IconBase>
          <path d="M19 4c-6 1-10 5-11 11" />
          <path d="M7 20c-2-4-2-8 1-11s7-4 11-5c1 4-1 8-4 11s-7 5-8 5Z" />
        </IconBase>
      );
    case 'logs':
      return (
        <IconBase>
          <rect x="6" y="5" width="12" height="15" rx="2" />
          <path d="M9 5.5h6" />
          <path d="M9 10h6" />
          <path d="M9 14h6" />
        </IconBase>
      );
    case 'ai':
      return (
        <IconBase>
          <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z" />
          <path d="M19 4v3" />
          <path d="M20.5 5.5h-3" />
          <path d="M18 16v2" />
          <path d="M19 17h-2" />
        </IconBase>
      );
    case 'family':
      return (
        <IconBase>
          <path d="M16 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1" />
          <circle cx="10" cy="8" r="3" />
          <path d="M20 20v-1a4 4 0 0 0-3-3.87" />
          <path d="M17 5.3a3 3 0 0 1 0 5.4" />
        </IconBase>
      );
    case 'panel-open':
      return (
        <IconBase>
          <path d="m9 6 6 6-6 6" />
        </IconBase>
      );
    case 'panel-close':
      return (
        <IconBase>
          <path d="m15 6-6 6 6 6" />
        </IconBase>
      );
    case 'logout':
      return (
        <IconBase>
          <path d="M10 7V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-2" />
          <path d="M15 12H4" />
          <path d="m8 8-4 4 4 4" />
        </IconBase>
      );
  }
}

export function DashboardIcon(props: { name: DashboardIconName }) {
  switch (props.name) {
    case 'family':
      return (
        <IconBase>
          <path d="M16 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1" />
          <circle cx="10" cy="8" r="3" />
          <path d="M20 20v-1a4 4 0 0 0-3-3.87" />
          <path d="M17 5.3a3 3 0 0 1 0 5.4" />
        </IconBase>
      );
    case 'leaf':
      return (
        <IconBase>
          <path d="M19 4c-6 1-10 5-11 11" />
          <path d="M7 20c-2-4-2-8 1-11s7-4 11-5c1 4-1 8-4 11s-7 5-8 5Z" />
        </IconBase>
      );
    case 'bell':
      return (
        <IconBase>
          <path d="M6 9a6 6 0 0 1 12 0c0 7 3 6 3 8H3c0-2 3-1 3-8" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </IconBase>
      );
    case 'search':
      return (
        <IconBase>
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </IconBase>
      );
    case 'cart':
      return (
        <IconBase>
          <path d="M5 5h2l1.5 10h8.5l2-7H8" />
          <circle cx="10" cy="19" r="1" />
          <circle cx="17" cy="19" r="1" />
        </IconBase>
      );
    case 'pot':
      return (
        <IconBase>
          <path d="M6 10h12" />
          <path d="M7 10v4a5 5 0 0 0 10 0v-4" />
          <path d="M17 12h1.5a2 2 0 0 1 0 4H17" />
          <path d="M10 7V5" />
          <path d="M14 7V5" />
        </IconBase>
      );
    case 'plus':
      return (
        <IconBase>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </IconBase>
      );
    case 'receipt':
      return (
        <IconBase>
          <path d="M7 4h10v16l-2-1.2-2 1.2-2-1.2-2 1.2-2-1.2V4Z" />
          <path d="M10 9h4" />
          <path d="M10 13h4" />
        </IconBase>
      );
    case 'list':
      return (
        <IconBase>
          <path d="M9 7h10" />
          <path d="M9 12h10" />
          <path d="M9 17h10" />
          <path d="M5 7h.01" />
          <path d="M5 12h.01" />
          <path d="M5 17h.01" />
        </IconBase>
      );
    case 'chevron':
      return (
        <IconBase>
          <path d="m9 6 6 6-6 6" />
        </IconBase>
      );
    case 'arrow-left':
      return (
        <IconBase>
          <path d="m15 6-6 6 6 6" />
        </IconBase>
      );
    case 'arrow-right':
      return (
        <IconBase>
          <path d="m9 6 6 6-6 6" />
        </IconBase>
      );
    case 'edit':
      return (
        <IconBase>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5Z" />
        </IconBase>
      );
    case 'check':
      return (
        <IconBase>
          <path d="m7 12 3 3 7-7" />
        </IconBase>
      );
    case 'circle':
      return (
        <IconBase>
          <circle cx="12" cy="12" r="8" />
        </IconBase>
      );
    case 'speaker':
      return (
        <IconBase>
          <path d="M5 9v6h4l5 4V5L9 9H5Z" />
          <path d="M17 9.5a4 4 0 0 1 0 5" />
          <path d="M19.5 7a7.5 7.5 0 0 1 0 10" />
        </IconBase>
      );
    case 'speaker-off':
      return (
        <IconBase>
          <path d="M5 9v6h4l5 4V5L9 9H5Z" />
          <path d="m18 9 4 4" />
          <path d="m22 9-4 4" />
        </IconBase>
      );
    case 'calendar':
      return (
        <IconBase>
          <path d="M7 3v4" />
          <path d="M17 3v4" />
          <rect x="4" y="6" width="16" height="14" rx="2" />
          <path d="M8 11h8" />
        </IconBase>
      );
    case 'flame':
      return (
        <IconBase>
          <path d="M12 22c4 0 7-3 7-7 0-3-2-5-4-7 .2 2-1 3-2 3-1.5 0-2.5-1.4-2-4-3 2-5 5-5 8 0 4 2 7 6 7Z" />
        </IconBase>
      );
    case 'mail':
      return (
        <IconBase>
          <rect x="4" y="6" width="16" height="12" rx="2" />
          <path d="m4.5 7 7.5 6 7.5-6" />
        </IconBase>
      );
    case 'map-pin':
      return (
        <IconBase>
          <path d="M19 10c0 5-7 11-7 11s-7-6-7-11a7 7 0 0 1 14 0Z" />
          <circle cx="12" cy="10" r="2.4" />
        </IconBase>
      );
    case 'user-plus':
      return (
        <IconBase>
          <path d="M15 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1" />
          <circle cx="9" cy="8" r="3" />
          <path d="M19 8v6" />
          <path d="M16 11h6" />
        </IconBase>
      );
    case 'lock':
      return (
        <IconBase>
          <rect x="5" y="10" width="14" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </IconBase>
      );
    case 'more':
      return (
        <IconBase>
          <path d="M12 6h.01" />
          <path d="M12 12h.01" />
          <path d="M12 18h.01" />
        </IconBase>
      );
    case 'shield':
      return (
        <IconBase>
          <path d="M12 3 19 6v5c0 4.5-2.8 8-7 10-4.2-2-7-5.5-7-10V6l7-3Z" />
          <path d="m9 12 2 2 4-5" />
        </IconBase>
      );
    case 'bar-chart':
      return (
        <IconBase>
          <path d="M6 20V10" />
          <path d="M12 20V4" />
          <path d="M18 20v-7" />
        </IconBase>
      );
    case 'link':
      return (
        <IconBase>
          <path d="M10 13a5 5 0 0 0 7.1 0l1.4-1.4a5 5 0 0 0-7.1-7.1L10.5 5" />
          <path d="M14 11a5 5 0 0 0-7.1 0l-1.4 1.4a5 5 0 0 0 7.1 7.1l.9-.9" />
        </IconBase>
      );
    case 'refresh':
      return (
        <IconBase>
          <path d="M20 12a8 8 0 0 1-13.5 5.8" />
          <path d="M4 12A8 8 0 0 1 17.5 6.2" />
          <path d="M17 3v4h-4" />
          <path d="M7 21v-4h4" />
        </IconBase>
      );
    case 'clear':
      return (
        <IconBase>
          <path d="m5 15 7.6-7.6a2 2 0 0 1 2.8 0l1.2 1.2a2 2 0 0 1 0 2.8L10 18H5v-3Z" />
          <path d="m10.5 9.5 4 4" />
          <path d="M13 18h6" />
        </IconBase>
      );
    case 'trash':
      return (
        <IconBase>
          <path d="M5 7h14" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
          <path d="M8 7l1-3h6l1 3" />
          <path d="M7 7l1 14h8l1-14" />
        </IconBase>
      );
    case 'x':
      return (
        <IconBase>
          <path d="m7 7 10 10" />
          <path d="m17 7-10 10" />
        </IconBase>
      );
  }
}

export function DashboardMealIcon(props: { mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack' }) {
  switch (props.mealType) {
    case 'breakfast':
      return (
        <IconBase>
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 3.5v2" />
          <path d="M12 18.5v2" />
          <path d="M3.5 12h2" />
          <path d="M18.5 12h2" />
          <path d="m6 6 1.4 1.4" />
          <path d="m16.6 16.6 1.4 1.4" />
          <path d="m18 6-1.4 1.4" />
          <path d="m7.4 16.6-1.4 1.4" />
        </IconBase>
      );
    case 'lunch':
      return (
        <IconBase>
          <path d="M5 12h14" />
          <path d="M7 12a5 5 0 0 0 10 0" />
          <path d="M9 8c0-1 1-1.4 1-2.4" />
          <path d="M13 8c0-1 1-1.4 1-2.4" />
          <path d="M8 17h8" />
        </IconBase>
      );
    case 'dinner':
      return (
        <IconBase>
          <path d="M18 14.5A6.5 6.5 0 0 1 9.5 6a7 7 0 1 0 8.5 8.5Z" />
          <path d="M16.5 5.5h.01" />
          <path d="M19 8h.01" />
        </IconBase>
      );
    case 'snack':
      return (
        <IconBase>
          <path d="M12 7c3 0 5 2.3 5 5.8 0 4.2-2.2 7-5 7s-5-2.8-5-7C7 9.3 9 7 12 7Z" />
          <path d="M12 7c.2-2 1.3-3.2 3.2-3.6" />
          <path d="M10 5.5c-1.2-.8-2.4-.9-3.7-.3" />
        </IconBase>
      );
  }
}
