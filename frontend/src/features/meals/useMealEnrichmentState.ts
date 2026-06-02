import { useEffect, useState } from 'react';
import type { MealLog, MediaAsset, UpdateMealLogPayload } from '../../api/types';
import { useDirectImageUploader } from '../../hooks/useImageComposer';
import { buildMealEntryRatingDraft, buildMealTitle, buildUpdateMealLogPayload, hasMeaningfulMealLogInput, MAX_MEAL_PHOTOS } from './MealLogEnrichmentModel';

export function useMealEnrichmentState(args: {
  meal: MealLog;
  isUpdating: boolean;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  requireMeaningfulInput?: boolean;
  onInvalidSave?: () => void;
  onSaved?: () => void;
}) {
  const [notes, setNotes] = useState(args.meal.notes);
  const [entryRatings, setEntryRatings] = useState<Record<string, string>>(() => buildMealEntryRatingDraft(args.meal));
  const [participants, setParticipants] = useState(args.meal.participant_user_ids);
  const [photos, setPhotos] = useState<MediaAsset[]>(() => args.meal.photos.slice(0, MAX_MEAL_PHOTOS));
  const [activePhoto, setActivePhoto] = useState<MediaAsset | null>(null);
  const photoUploader = useDirectImageUploader();

  useEffect(() => {
    setNotes(args.meal.notes);
    setEntryRatings(buildMealEntryRatingDraft(args.meal));
    setParticipants(args.meal.participant_user_ids);
    setPhotos(args.meal.photos.slice(0, MAX_MEAL_PHOTOS));
    setActivePhoto(null);
    photoUploader.reset();
  }, [args.meal.id]);

  function toggleParticipant(memberId: string, checked: boolean) {
    setParticipants((current) => checked ? [...current, memberId] : current.filter((item) => item !== memberId));
  }

  function updateEntryRating(entryId: string, value: string) {
    setEntryRatings((current) => ({ ...current, [entryId]: value }));
  }

  async function save(includePhotos: boolean) {
    const mediaIds = includePhotos ? photos.map((photo) => photo.id) : undefined;
    if (args.requireMeaningfulInput && !hasMeaningfulMealLogInput({
      meal: args.meal,
      participants,
      notes,
      entryRatings,
      mediaIds,
    })) {
      args.onInvalidSave?.();
      return;
    }

    const payload = buildUpdateMealLogPayload({
      meal: args.meal,
      participants,
      notes,
      entryRatings,
      ...(mediaIds ? { mediaIds } : {}),
    });
    await args.updateMealLog(args.meal.id, payload);
    args.onSaved?.();
  }

  async function uploadPhotos(files: FileList | null) {
    if (!files || files.length === 0) return;
    const remainingCount = MAX_MEAL_PHOTOS - photos.length;
    if (remainingCount <= 0) {
      photoUploader.setError('最多只能添加 6 张照片');
      return;
    }

    const selectedFiles = Array.from(files).slice(0, remainingCount);
    const uploadedAssets = await photoUploader.uploadFiles(selectedFiles, buildMealTitle(args.meal));
    if (uploadedAssets.length === 0) return;

    setPhotos((current) => [...current, ...uploadedAssets].slice(0, MAX_MEAL_PHOTOS));
    if (files.length > remainingCount) {
      photoUploader.setError('已添加前 6 张照片，其余照片未上传');
    }
  }

  function removePhoto(photoId: string) {
    setPhotos((current) => current.filter((photo) => photo.id !== photoId));
  }

  return {
    notes,
    setNotes,
    entryRatings,
    participants,
    photos,
    activePhoto,
    setActivePhoto,
    photoState: photoUploader.state,
    isBusy: args.isUpdating || photoUploader.state.isGenerating,
    hasPhotoCapacity: photos.length < MAX_MEAL_PHOTOS,
    toggleParticipant,
    updateEntryRating,
    save,
    uploadPhotos,
    removePhoto,
  };
}
