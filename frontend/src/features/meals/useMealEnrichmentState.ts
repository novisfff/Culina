import { useEffect, useState } from 'react';
import { isApiError } from '../../api/request';
import type { MealLog, MediaAsset, UpdateMealLogPayload } from '../../api/types';
import { useDirectImageUploader } from '../../hooks/useImageComposer';
import {
  buildMealEntryRatingDraft,
  buildMealTitle,
  buildUpdateMealLogPayload,
  hasMeaningfulMealLogInput,
  MAX_MEAL_PHOTOS,
} from './MealLogEnrichmentModel';

export type MealEnrichmentStaleState = {
  message: string;
  current: MealLog | null;
};

function extractCurrentMeal(reason: unknown): MealLog | null {
  if (!isApiError(reason)) return null;
  const payload = reason.payload;
  if (!payload || typeof payload !== 'object') return null;
  const detail = (payload as { detail?: unknown }).detail;
  if (!detail || typeof detail !== 'object') return null;
  const current = (detail as { current?: unknown }).current;
  if (!current || typeof current !== 'object') return null;
  return current as MealLog;
}

export function useMealEnrichmentState(args: {
  meal: MealLog;
  isUpdating: boolean;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  requireMeaningfulInput?: boolean;
  onInvalidSave?: () => void;
  onSaved?: () => void;
  onStale?: (state: MealEnrichmentStaleState) => void;
}) {
  const [notes, setNotes] = useState(args.meal.notes);
  const [entryRatings, setEntryRatings] = useState<Record<string, string>>(() => buildMealEntryRatingDraft(args.meal));
  const [participants, setParticipants] = useState(args.meal.participant_user_ids);
  const [photos, setPhotos] = useState<MediaAsset[]>(() => args.meal.photos.slice(0, MAX_MEAL_PHOTOS));
  const [activePhoto, setActivePhoto] = useState<MediaAsset | null>(null);
  const [expectedRowVersion, setExpectedRowVersion] = useState(args.meal.row_version);
  const [staleMessage, setStaleMessage] = useState<string | null>(null);
  const photoUploader = useDirectImageUploader();

  useEffect(() => {
    setNotes(args.meal.notes);
    setEntryRatings(buildMealEntryRatingDraft(args.meal));
    setParticipants(args.meal.participant_user_ids);
    setPhotos(args.meal.photos.slice(0, MAX_MEAL_PHOTOS));
    setActivePhoto(null);
    setExpectedRowVersion(args.meal.row_version);
    setStaleMessage(null);
    photoUploader.reset();
  }, [args.meal.id, args.meal.row_version]);

  function toggleParticipant(memberId: string, checked: boolean) {
    setParticipants((current) => (checked ? [...current, memberId] : current.filter((item) => item !== memberId)));
  }

  function updateEntryRating(entryId: string, value: string) {
    setEntryRatings((current) => ({ ...current, [entryId]: value }));
  }

  async function save(includePhotos: boolean) {
    const mediaIds = includePhotos ? photos.map((photo) => photo.id) : undefined;
    if (
      args.requireMeaningfulInput &&
      !hasMeaningfulMealLogInput({
        meal: args.meal,
        participants,
        notes,
        entryRatings,
        mediaIds,
      })
    ) {
      args.onInvalidSave?.();
      return;
    }

    const payload = buildUpdateMealLogPayload({
      meal: args.meal,
      participants,
      notes,
      entryRatings,
      expectedRowVersion,
      ...(mediaIds ? { mediaIds } : {}),
    });

    try {
      await args.updateMealLog(args.meal.id, payload);
      setStaleMessage(null);
      args.onSaved?.();
    } catch (reason) {
      if (isApiError(reason) && reason.status === 409) {
        const current = extractCurrentMeal(reason);
        // Keep the user's draft (notes/ratings/participants/photos). Only advance
        // expected_row_version so a reviewed resubmit can succeed — do not wipe draft.
        if (current) {
          setExpectedRowVersion(current.row_version);
        }
        const message = '这餐已被其他人更新，请查看最新内容后再保存';
        setStaleMessage(message);
        args.onStale?.({ message, current });
        return;
      }
      throw reason;
    }
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
    expectedRowVersion,
    staleMessage,
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
