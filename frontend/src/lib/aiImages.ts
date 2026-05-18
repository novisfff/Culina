import { api } from '../api/client';
import type { CreateAiRenderRequest, ImageInputValue, MediaAsset } from '../api/types';

export type AiRenderPayload = Omit<CreateAiRenderRequest, 'mode' | 'reference_media_id'>;
export type AiImageGenerationError = Error & { referenceAsset?: MediaAsset };

export function getMediaIds(images: ImageInputValue) {
  return images.generatedAsset ? [images.generatedAsset.id] : [];
}

export async function uploadReferenceAndGenerateImage(file: File, payload: AiRenderPayload): Promise<ImageInputValue> {
  const referenceAsset = await api.uploadMedia(file, 'upload', file.name);
  try {
    const response = await api.renderAiImage({
      ...payload,
      mode: 'reference',
      reference_media_id: referenceAsset.id,
    });

    return {
      referenceAsset: response.reference_asset ?? referenceAsset,
      generatedAsset: response.generated_asset,
    };
  } catch (reason) {
    const error =
      reason instanceof Error ? (reason as AiImageGenerationError) : (new Error('AI 主图生成失败') as AiImageGenerationError);
    error.referenceAsset = referenceAsset;
    throw error;
  }
}

export async function regenerateImageFromReference(
  referenceMediaId: string,
  payload: AiRenderPayload
): Promise<ImageInputValue> {
  const response = await api.renderAiImage({
    ...payload,
    mode: 'reference',
    reference_media_id: referenceMediaId,
  });

  return {
    referenceAsset: response.reference_asset ?? undefined,
    generatedAsset: response.generated_asset,
  };
}

export async function generateImageFromText(payload: AiRenderPayload): Promise<ImageInputValue> {
  const response = await api.renderAiImage({
    ...payload,
    mode: 'text',
  });

  return {
    generatedAsset: response.generated_asset,
  };
}
