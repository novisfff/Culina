import { useEffect, useState } from 'react';
import type { MediaAsset } from '../../api/types';
import { MediaPlaceholder, MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';

export type MealCoverFood = {
  id: string;
  name: string;
  cover?: MediaAsset | null;
};

export type MealCoverProps = {
  alt: string;
  mealPhoto?: MediaAsset | null;
  foods: MealCoverFood[];
  className?: string;
};

export function selectMealCoverFoods(foods: MealCoverFood[]): MealCoverFood[] {
  const withCover = foods.filter((food) => food.cover);
  const withoutCover = foods.filter((food) => !food.cover);
  return [...withCover, ...withoutCover].slice(0, 4);
}

function FoodTile({ food }: { food: MealCoverFood }) {
  return (
    <span className="meal-cover-tile" data-testid="meal-cover-tile">
      {food.cover ? (
        <MediaWithPlaceholder
          src={resolveMediaUrl(food.cover, 'thumb')}
          srcSet={buildMediaSrcSet(food.cover)}
          sizes={buildMediaSizes('thumb')}
          alt=""
          showLabel={false}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className="meal-cover-empty-state" data-testid="meal-cover-empty-state">
          <MediaPlaceholder showLabel={false} />
        </span>
      )}
    </span>
  );
}

export function MealCover(props: MealCoverProps) {
  const [mealPhotoFailed, setMealPhotoFailed] = useState(false);
  const mealPhotoKey = props.mealPhoto ? `${props.mealPhoto.id}:${props.mealPhoto.url}` : '';

  useEffect(() => {
    setMealPhotoFailed(false);
  }, [mealPhotoKey]);

  const selectedFoods = selectMealCoverFoods(props.foods);
  const hasFoodCover = selectedFoods.some((food) => food.cover);
  const showMealPhoto = Boolean(props.mealPhoto) && !mealPhotoFailed;
  const mode = showMealPhoto
    ? 'photo'
    : !hasFoodCover
      ? 'empty'
      : selectedFoods.length === 1
        ? 'single'
        : 'mosaic';
  const className = [
    'meal-cover',
    `meal-cover-${mode}`,
    mode === 'mosaic' ? `meal-cover-count-${selectedFoods.length}` : null,
    props.className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={className}
      role="img"
      aria-label={props.alt}
      data-meal-cover-mode={mode}
      data-meal-cover-count={mode === 'mosaic' ? selectedFoods.length : undefined}
    >
      {showMealPhoto && props.mealPhoto ? (
        <MediaWithPlaceholder
          src={resolveMediaUrl(props.mealPhoto, 'thumb')}
          srcSet={buildMediaSrcSet(props.mealPhoto)}
          sizes={buildMediaSizes('thumb')}
          alt=""
          showLabel={false}
          loading="lazy"
          decoding="async"
          onLoadError={() => setMealPhotoFailed(true)}
        />
      ) : mode === 'empty' ? (
        <span className="meal-cover-empty-state" data-testid="meal-cover-empty-state">
          <MediaPlaceholder showLabel={false} />
        </span>
      ) : (
        selectedFoods.map((food) => <FoodTile key={food.id} food={food} />)
      )}
    </span>
  );
}
