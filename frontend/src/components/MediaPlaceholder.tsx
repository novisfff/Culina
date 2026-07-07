import { useEffect, useState } from 'react';

export type MediaPlaceholderState = 'empty' | 'loading' | 'error';

const DEFAULT_MEDIA_PLACEHOLDER_LABELS: Record<MediaPlaceholderState, string> = {
  empty: '暂无图片',
  loading: '图片加载中',
  error: '图片加载失败',
};

function LoadingPlaceholderIcon() {
  return (
    <svg viewBox="0 0 72 72" focusable="false" className="media-placeholder-loading-icon">
      <rect className="media-placeholder-frame" x="13" y="15" width="46" height="42" rx="12" />
      <circle className="media-placeholder-sun" cx="47" cy="27" r="4" />
      <path className="media-placeholder-hill" d="m19 49 11-12 8 8 6-6 9 10" />
      <path className="media-placeholder-leaf" d="M27 31c-1-7 4-12 12-13 0 8-4 13-12 13Z" />
      <path className="media-placeholder-leaf-line" d="M28 30c3-4 6-7 10-10" />
    </svg>
  );
}

function EmptyPlaceholderIcon() {
  return (
    <svg viewBox="0 0 72 72" focusable="false" className="media-placeholder-empty-icon">
      <rect className="media-placeholder-frame" x="13" y="15" width="46" height="42" rx="12" />
      <circle className="media-placeholder-sun" cx="47" cy="27" r="4" />
      <path className="media-placeholder-hill" d="m19 49 11-12 8 8 6-6 9 10" />
      <path className="media-placeholder-leaf" d="M27 31c-1-7 4-12 12-13 0 8-4 13-12 13Z" />
      <path className="media-placeholder-leaf-line" d="M28 30c3-4 6-7 10-10" />
      <path className="media-placeholder-empty-slash-backdrop" d="M17 18 55 56" />
      <path className="media-placeholder-empty-slash" d="M17 18 55 56" />
    </svg>
  );
}

function ErrorPlaceholderIcon() {
  return (
    <svg viewBox="0 0 72 72" focusable="false" className="media-placeholder-error-icon">
      <path className="media-placeholder-error-frame" d="M56 47v-18c0-8-6-14-14-14H28c-8 0-14 6-14 14v15c0 8 6 14 14 14h18" />
      <path className="media-placeholder-error-hill" d="m20 49 11-12 8 8 6-6 8 9" />
      <path className="media-placeholder-error-leaf" d="M27 31c-1-7 4-12 12-13 0 8-4 13-12 13Z" />
      <path className="media-placeholder-error-leaf-line" d="M28 30c3-4 6-7 10-10" />
      <path className="media-placeholder-error-crack" d="M44 15l8 9-5 7 7 7-2 10" />
      <circle className="media-placeholder-error-badge" cx="51" cy="51" r="9" />
      <path className="media-placeholder-error-mark" d="M51 46v6" />
      <circle className="media-placeholder-error-mark" cx="51" cy="56" r="1.2" />
    </svg>
  );
}

function MediaPlaceholderIcon({ state }: { state: MediaPlaceholderState }) {
  if (state === 'loading') return <LoadingPlaceholderIcon />;
  if (state === 'error') return <ErrorPlaceholderIcon />;
  return <EmptyPlaceholderIcon />;
}

export function MediaPlaceholder(props: {
  className?: string;
  state?: MediaPlaceholderState;
  label?: string;
  showLabel?: boolean;
}) {
  const state = props.state ?? 'empty';
  const label = props.label ?? DEFAULT_MEDIA_PLACEHOLDER_LABELS[state];
  const className = [
    'media-placeholder',
    `state-${state}`,
    props.className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={className} aria-hidden="true" data-state={state}>
      {state === 'loading' && <span className="media-placeholder-glow" />}
      <MediaPlaceholderIcon state={state} />
      {props.showLabel !== false && <span className="media-placeholder-label">{label}</span>}
      {state === 'loading' && (
        <>
          <span className="media-placeholder-spark media-placeholder-spark-a" />
          <span className="media-placeholder-spark media-placeholder-spark-b" />
        </>
      )}
    </span>
  );
}

export function MediaWithPlaceholder(props: {
  src?: string | null;
  alt: string;
  className?: string;
  imageClassName?: string;
  srcSet?: string;
  sizes?: string;
  fallbackSrc?: string | null;
  loading?: 'eager' | 'lazy';
  decoding?: 'async' | 'auto' | 'sync';
  showLabel?: boolean;
  emptyLabel?: string;
  loadingLabel?: string;
  errorLabel?: string;
  ariaHidden?: boolean;
}) {
  const [activeSrc, setActiveSrc] = useState(props.src ?? null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setActiveSrc(props.src ?? null);
    setFailed(false);
    setLoaded(false);
  }, [props.src]);

  const state: MediaPlaceholderState | 'loaded' = !activeSrc ? 'empty' : failed ? 'error' : loaded ? 'loaded' : 'loading';
  const label =
    state === 'empty'
      ? props.emptyLabel
      : state === 'loading'
        ? props.loadingLabel
        : state === 'error'
          ? props.errorLabel
          : undefined;
  const wrapperClassName = [
    'media-with-placeholder',
    `is-${state}`,
    props.className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={wrapperClassName} data-state={state}>
      {state !== 'loaded' && <MediaPlaceholder state={state} label={label} showLabel={props.showLabel} />}
      {activeSrc && !failed && (
        <img
          src={activeSrc}
          srcSet={activeSrc === props.src ? props.srcSet : undefined}
          sizes={activeSrc === props.src ? props.sizes : undefined}
          alt={props.alt}
          className={props.imageClassName}
          loading={props.loading}
          decoding={props.decoding}
          aria-hidden={props.ariaHidden}
          onLoad={() => setLoaded(true)}
          onError={() => {
            if (props.fallbackSrc && activeSrc !== props.fallbackSrc) {
              setActiveSrc(props.fallbackSrc);
              setLoaded(false);
              return;
            }
            setLoaded(false);
            setFailed(true);
          }}
        />
      )}
    </span>
  );
}
