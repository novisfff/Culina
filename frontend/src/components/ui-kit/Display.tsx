import type { ReactNode } from 'react';
import { resolveAssetUrl } from '../../lib/assets';
import { avatarColor, initials } from '../../lib/ui';

export function Badge(props: { children: ReactNode; className?: string }) {
  return <span className={props.className ? `badge ${props.className}` : 'badge'}>{props.children}</span>;
}

export function Avatar(props: { label: string; seed: string; large?: boolean; imageUrl?: string | null }) {
  const imageUrl = props.imageUrl ? (resolveAssetUrl(props.imageUrl) ?? props.imageUrl) : undefined;
  const className = [
    'avatar',
    props.large ? 'large' : '',
    imageUrl ? 'avatar-has-image' : '',
  ].filter(Boolean).join(' ');
  return (
    <div className={className} style={imageUrl ? undefined : { backgroundColor: avatarColor(props.seed) }}>
      {imageUrl ? <img src={imageUrl} alt={props.label} /> : initials(props.label)}
    </div>
  );
}

export function EmptyState(props: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <h3>{props.title}</h3>
      <p>{props.description}</p>
      {props.action}
    </div>
  );
}
