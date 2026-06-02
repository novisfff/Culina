type MealLogIconName =
  | 'all'
  | 'breakfast'
  | 'lunch'
  | 'dinner'
  | 'snack'
  | 'search'
  | 'photo'
  | 'note'
  | 'today'
  | 'pending'
  | 'done'
  | 'trend';

export function MealLogIcon(props: { name: MealLogIconName; className?: string }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': true,
    focusable: false,
    style: { display: 'block' },
  };
  const strokeProps = {
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  return (
    <svg {...common} className={props.className}>
      {props.name === 'all' && (
        <>
          <rect {...strokeProps} x="4.5" y="4.5" width="6" height="6" rx="1.4" />
          <rect {...strokeProps} x="13.5" y="4.5" width="6" height="6" rx="1.4" />
          <rect {...strokeProps} x="4.5" y="13.5" width="6" height="6" rx="1.4" />
          <rect {...strokeProps} x="13.5" y="13.5" width="6" height="6" rx="1.4" />
        </>
      )}
      {props.name === 'breakfast' && (
        <>
          <circle {...strokeProps} cx="12" cy="12" r="4.1" />
          <path {...strokeProps} d="M12 2.8v2.4M12 18.8v2.4M5.35 5.35l1.7 1.7M16.95 16.95l1.7 1.7M2.8 12h2.4M18.8 12h2.4M5.35 18.65l1.7-1.7M16.95 7.05l1.7-1.7" />
        </>
      )}
      {props.name === 'lunch' && (
        <>
          <path {...strokeProps} d="M7 4.5v5.2a2.3 2.3 0 0 0 4.6 0V4.5" />
          <path {...strokeProps} d="M9.3 4.5v14.8" />
          <path {...strokeProps} d="M15.5 4.5v6.2" />
          <path {...strokeProps} d="M13.6 10.7h3.8" />
          <path {...strokeProps} d="M15.5 10.7v8.6" />
        </>
      )}
      {props.name === 'dinner' && (
        <>
          <path {...strokeProps} d="M4 12h16" />
          <path {...strokeProps} d="M6.1 12a5.9 5.9 0 0 0 11.8 0" />
          <path {...strokeProps} d="M8.6 8.2c-.7-.7-.7-1.6 0-2.3" />
          <path {...strokeProps} d="M12 8.2c-.7-.7-.7-1.6 0-2.3" />
          <path {...strokeProps} d="M15.4 8.2c-.7-.7-.7-1.6 0-2.3" />
        </>
      )}
      {props.name === 'snack' && (
        <>
          <path {...strokeProps} d="M8 6.2h8l1.2 4.4a5.4 5.4 0 0 1-10.4 0L8 6.2Z" />
          <path {...strokeProps} d="M10.1 13.5v3.8M13.9 13.5v3.8" />
          <path {...strokeProps} d="M9.4 3.8h5.2" />
        </>
      )}
      {props.name === 'search' && (
        <>
          <circle {...strokeProps} cx="11" cy="11" r="6.5" />
          <path {...strokeProps} d="m16 16 4 4" />
        </>
      )}
      {props.name === 'photo' && (
        <>
          <rect {...strokeProps} x="4" y="5.5" width="16" height="13" rx="2.2" />
          <circle {...strokeProps} cx="9" cy="10" r="1.5" />
          <path {...strokeProps} d="m7 16 3.2-3.3a1.5 1.5 0 0 1 2.2.1l1.5 1.7" />
          <path {...strokeProps} d="m13.4 14 1.5-1.5a1.6 1.6 0 0 1 2.3 0L19 14.3" />
        </>
      )}
      {props.name === 'note' && (
        <>
          <path {...strokeProps} d="M7 4.5h10v15l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4v-13a2 2 0 0 1 2-2Z" />
          <path {...strokeProps} d="M9.5 9.2h5M9.5 12.4h5M9.5 15.6h3.2" />
        </>
      )}
      {props.name === 'today' && (
        <>
          <path {...strokeProps} d="M7 3.5v3.2M17 3.5v3.2" />
          <rect {...strokeProps} x="4.5" y="6" width="15" height="13.5" rx="2.2" />
          <path {...strokeProps} d="M8 10.2h8" />
          <path {...strokeProps} d="M9.2 14.2h3.8" />
        </>
      )}
      {props.name === 'pending' && (
        <>
          <path {...strokeProps} d="M12 6.5v5l3.1 2" />
          <circle {...strokeProps} cx="12" cy="12" r="7.5" />
        </>
      )}
      {props.name === 'done' && <path {...strokeProps} d="m5 12.2 4.1 4.1L19 6.4" />}
      {props.name === 'trend' && (
        <>
          <path {...strokeProps} d="M5 17.5h14" />
          <path {...strokeProps} d="m7.5 14.5 3.3-3.4 2.8 2.8 4.2-5" />
          <path {...strokeProps} d="M17.8 8.9H20v2.2" />
        </>
      )}
    </svg>
  );
}
