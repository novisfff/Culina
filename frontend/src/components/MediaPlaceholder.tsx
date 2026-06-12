import { useEffect, useState } from 'react';

export function MediaPlaceholder(props: { className?: string }) {
  return (
    <span
      className={props.className ? `media-placeholder ${props.className}` : 'media-placeholder'}
      aria-hidden="true"
    >
      <span className="media-placeholder-glow" />
      <svg viewBox="0 0 72 72" focusable="false">
        <rect className="media-placeholder-frame" x="13" y="15" width="46" height="42" rx="12" />
        <circle className="media-placeholder-sun" cx="47" cy="27" r="4" />
        <path className="media-placeholder-hill" d="m19 49 11-12 8 8 6-6 9 10" />
        <path className="media-placeholder-leaf" d="M27 31c-1-7 4-12 12-13 0 8-4 13-12 13Z" />
        <path className="media-placeholder-leaf-line" d="M28 30c3-4 6-7 10-10" />
      </svg>
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
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [props.src]);

  return (
    <span className={props.className ? `media-with-placeholder ${props.className}` : 'media-with-placeholder'}>
      {(!props.src || failed || !loaded) && <MediaPlaceholder />}
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
