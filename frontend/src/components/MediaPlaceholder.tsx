import { useEffect, useState } from 'react';

export type MediaPlaceholderState = 'empty' | 'loading' | 'error';

const DEFAULT_MEDIA_PLACEHOLDER_LABELS: Record<MediaPlaceholderState, string> = {
  empty: '暂无图片',
  loading: '图片加载中',
  error: '图片加载失败',
};

export function MediaPlaceholder(props: {
  className?: string;
  state?: MediaPlaceholderState;
  label?: string;
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
      <span className="media-placeholder-glow" />
      {state === 'loading' ? (
        <span className="media-placeholder-loader">
          <span />
          <span />
          <span />
        </span>
      ) : (
        <svg viewBox="0 0 72 72" focusable="false">
          <rect className="media-placeholder-frame" x="13" y="15" width="46" height="42" rx="12" />
          <circle className="media-placeholder-sun" cx="47" cy="27" r="4" />
          <path className="media-placeholder-hill" d="m19 49 11-12 8 8 6-6 9 10" />
          <path className="media-placeholder-leaf" d="M27 31c-1-7 4-12 12-13 0 8-4 13-12 13Z" />
          <path className="media-placeholder-leaf-line" d="M28 30c3-4 6-7 10-10" />
        </svg>
      )}
      <span className="media-placeholder-label">{label}</span>
      <span className="media-placeholder-spark media-placeholder-spark-a" />
      <span className="media-placeholder-spark media-placeholder-spark-b" />
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
  emptyLabel?: string;
  loadingLabel?: string;
  errorLabel?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [props.src]);

  const state: MediaPlaceholderState | 'loaded' = !props.src ? 'empty' : failed ? 'error' : loaded ? 'loaded' : 'loading';
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
      {state !== 'loaded' && <MediaPlaceholder state={state} label={label} />}
      {props.src && !failed && (
        <img
          src={props.src}
          srcSet={props.srcSet}
          sizes={props.sizes}
          alt={props.alt}
          className={props.imageClassName}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false);
            setFailed(true);
          }}
        />
      )}
    </span>
  );
}
