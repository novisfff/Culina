import { AppLogoIcon } from '../../app/shellIcons';

export type FoodIconName =
  | 'bell'
  | 'bookOpen'
  | 'bowl'
  | 'calendar'
  | 'cloche'
  | 'heart'
  | 'heartFilled'
  | 'home'
  | 'clock'
  | 'plus'
  | 'receipt'
  | 'search'
  | 'list'
  | 'logo'
  | 'star'
  | 'refresh'
  | 'arrowLeft'
  | 'arrowRight'
  | 'check'
  | 'clipboard'
  | 'moon'
  | 'save'
  | 'sun'
  | 'tag'
  | 'trash';

export function FoodUiIcon(props: { name: FoodIconName; className?: string }) {
  if (props.name === 'logo') {
    return <AppLogoIcon className={props.className} />;
  }

  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': true,
  };
  const strokeProps = {
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  return (
    <svg {...common} className={props.className}>
      {props.name === 'bowl' && (
        <>
          <path {...strokeProps} d="M5 12h14a7 7 0 0 1-14 0Z" />
          <path {...strokeProps} d="M8 19h8" />
          <path {...strokeProps} d="M8 8c-.7-.8-.7-1.6 0-2.4" />
          <path {...strokeProps} d="M12 8c-.7-.8-.7-1.6 0-2.4" />
          <path {...strokeProps} d="M16 8c-.7-.8-.7-1.6 0-2.4" />
        </>
      )}
      {props.name === 'bookOpen' && (
        <>
          <path {...strokeProps} d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22V5.5Z" />
          <path {...strokeProps} d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5A2.5 2.5 0 0 1 20 22V5.5Z" />
        </>
      )}
      {props.name === 'bell' && (
        <>
          <path {...strokeProps} d="M6 9a6 6 0 0 1 12 0c0 7 3 6 3 8H3c0-2 3-1 3-8" />
          <path {...strokeProps} d="M10 20a2 2 0 0 0 4 0" />
        </>
      )}
      {props.name === 'calendar' && (
        <>
          <path {...strokeProps} d="M7 3v4" />
          <path {...strokeProps} d="M17 3v4" />
          <rect {...strokeProps} x="4" y="6" width="16" height="14" rx="2" />
          <path {...strokeProps} d="M8 11h8" />
        </>
      )}
      {props.name === 'cloche' && (
        <>
          <path {...strokeProps} d="M4 17h16" />
          <path {...strokeProps} d="M6 17a6 6 0 0 1 12 0" />
          <path {...strokeProps} d="M12 8V5" />
          <path {...strokeProps} d="M9.5 5h5" />
          <path {...strokeProps} d="M3 20h18" />
        </>
      )}
      {props.name === 'heart' && (
        <path {...strokeProps} d="M20.4 5.6a5 5 0 0 0-7.1 0L12 6.9l-1.3-1.3a5 5 0 0 0-7.1 7.1L12 21l8.4-8.3a5 5 0 0 0 0-7.1Z" />
      )}
      {props.name === 'heartFilled' && (
        <path
          d="M20.4 5.6a5 5 0 0 0-7.1 0L12 6.9l-1.3-1.3a5 5 0 0 0-7.1 7.1L12 21l8.4-8.3a5 5 0 0 0 0-7.1Z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {props.name === 'home' && (
        <>
          <path {...strokeProps} d="m3 11 9-8 9 8" />
          <path {...strokeProps} d="M5 10v10h14V10" />
          <path {...strokeProps} d="M10 20v-6h4v6" />
        </>
      )}
      {props.name === 'clock' && (
        <>
          <circle {...strokeProps} cx="12" cy="12" r="9" />
          <path {...strokeProps} d="M12 7v5l3.5 2" />
        </>
      )}
      {props.name === 'plus' && (
        <>
          <circle {...strokeProps} cx="12" cy="12" r="9" />
          <path {...strokeProps} d="M12 8v8M8 12h8" />
        </>
      )}
      {props.name === 'receipt' && (
        <>
          <path {...strokeProps} d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" />
          <path {...strokeProps} d="M9 8h6M9 12h3" />
          <path {...strokeProps} d="M15.5 13.5 17 15l3-3" />
        </>
      )}
      {props.name === 'search' && (
        <>
          <circle {...strokeProps} cx="11" cy="11" r="6.5" />
          <path {...strokeProps} d="m16 16 4 4" />
        </>
      )}
      {props.name === 'list' && (
        <>
          <path {...strokeProps} d="M9 7h10" />
          <path {...strokeProps} d="M9 12h10" />
          <path {...strokeProps} d="M9 17h10" />
          <path {...strokeProps} d="M5 7h.01" />
          <path {...strokeProps} d="M5 7h.01" />
          <path {...strokeProps} d="M5 12h.01" />
          <path {...strokeProps} d="M5 17h.01" />
        </>
      )}
      {props.name === 'star' && (
        <path {...strokeProps} d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z" />
      )}
      {props.name === 'refresh' && (
        <>
          <path {...strokeProps} d="M20 11a8 8 0 0 0-14.4-4.7L4 8" />
          <path {...strokeProps} d="M4 4v4h4" />
          <path {...strokeProps} d="M4 13a8 8 0 0 0 14.4 4.7L20 16" />
          <path {...strokeProps} d="M20 20v-4h-4" />
        </>
      )}
      {props.name === 'arrowLeft' && (
        <>
          <path {...strokeProps} d="M19 12H5" />
          <path {...strokeProps} d="m12 19-7-7 7-7" />
        </>
      )}
      {props.name === 'arrowRight' && (
        <>
          <path {...strokeProps} d="M5 12h14" />
          <path {...strokeProps} d="m12 5 7 7-7 7" />
        </>
      )}
      {props.name === 'check' && <path {...strokeProps} d="m5 12 4 4L19 6" />}
      {props.name === 'clipboard' && (
        <>
          <path {...strokeProps} d="M9 4h6l1 2h2a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l1-2Z" />
          <path {...strokeProps} d="M9 4h6v4H9z" />
          <path {...strokeProps} d="M9 13h6M9 17h4" />
        </>
      )}
      {props.name === 'moon' && <path {...strokeProps} d="M20 14.5A7.5 7.5 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />}
      {props.name === 'save' && (
        <>
          <path {...strokeProps} d="M5 4h12l2 2v14H5V4Z" />
          <path {...strokeProps} d="M8 4v6h8V4" />
          <path {...strokeProps} d="M8 20v-6h8v6" />
        </>
      )}
      {props.name === 'sun' && (
        <>
          <circle {...strokeProps} cx="12" cy="12" r="4" />
          <path {...strokeProps} d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
        </>
      )}
      {props.name === 'tag' && (
        <>
          <path {...strokeProps} d="M20 13.5 13.5 20 4 10.5V4h6.5L20 13.5Z" />
          <circle {...strokeProps} cx="8.5" cy="8.5" r="1" />
        </>
      )}
      {props.name === 'trash' && (
        <>
          <path {...strokeProps} d="M4 7h16" />
          <path {...strokeProps} d="M10 11v6M14 11v6" />
          <path {...strokeProps} d="M6 7l1 14h10l1-14" />
          <path {...strokeProps} d="M9 7V4h6v3" />
        </>
      )}
    </svg>
  );
}
