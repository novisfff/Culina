import type { AiMessageImagePartData } from '../../api/types';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { resolveAssetUrl } from '../../lib/assets';

type Props = {
  images: AiMessageImagePartData[];
};

function resolveMessageImageUrl(image: AiMessageImagePartData, variant: 'thumb' | 'card' | 'large' | 'original' = 'thumb') {
  const asset = image.asset;
  if (variant !== 'original') {
    const variantUrl = asset.variants?.[variant]?.url;
    if (variantUrl) return resolveAssetUrl(variantUrl);
  }
  return resolveAssetUrl(asset.variants?.thumb?.url)
    ?? resolveAssetUrl(asset.variants?.card?.url)
    ?? resolveAssetUrl(asset.variants?.large?.url)
    ?? resolveAssetUrl(asset.url);
}

export function AiMessageImageGrid({ images }: Props) {
  if (images.length === 0) return null;

  return (
    <div className="ai-message-image-grid" data-count={images.length}>
      {images.map((image) => {
        const thumbnailUrl = resolveMessageImageUrl(image, 'thumb');
        const fullUrl = resolveMessageImageUrl(image, 'large') ?? thumbnailUrl;
        if (!thumbnailUrl) return null;
        return (
          <a
            key={image.media_id}
            className="ai-message-image-link"
            href={fullUrl ?? thumbnailUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={image.alt || '查看上传图片'}
          >
            <MediaWithPlaceholder
              src={thumbnailUrl}
              alt={image.alt || '上传图片'}
              loading="lazy"
              className="ai-message-image-media"
              showLabel={false}
            />
          </a>
        );
      })}
    </div>
  );
}
