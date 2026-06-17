import { api } from '../api/client';
import type { AiRenderResponse, CreateAiRenderRequest, ImageInputValue, MediaAsset } from '../api/types';

export type AiRenderPayload = Omit<CreateAiRenderRequest, 'mode' | 'reference_media_id'>;
export type AiImageGenerationError = Error & { referenceAsset?: MediaAsset };

export function getMediaIds(images: ImageInputValue) {
  return images.generatedAsset ? [images.generatedAsset.id] : [];
}

export function getPendingImageJobId(images: ImageInputValue) {
  const job = images.pendingJob;
  return job?.job_id && (job.status === 'queued' || job.status === 'running') ? job.job_id : null;
}

function resolveQueuedImages(response: AiRenderResponse, referenceAsset?: MediaAsset): ImageInputValue {
  if (response.status === 'failed') {
    throw new Error(response.error || 'AI 主图生成失败');
  }
  return {
    referenceAsset: response.reference_asset ?? referenceAsset,
    generatedAsset: response.generated_asset ?? undefined,
    pendingJob: response.generated_asset ? undefined : response,
  };
}

export async function uploadReferenceAndGenerateImage(file: File, payload: AiRenderPayload): Promise<ImageInputValue> {
  const referenceAsset = await api.uploadMedia(file, 'upload', file.name);
  try {
    return resolveQueuedImages(
      await api.renderAiImage({
        ...payload,
        mode: 'reference',
        reference_media_id: referenceAsset.id,
      }),
      referenceAsset
    );
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
  return resolveQueuedImages(
    await api.renderAiImage({
      ...payload,
      mode: 'reference',
      reference_media_id: referenceMediaId,
    })
  );
}

export async function generateImageFromText(payload: AiRenderPayload): Promise<ImageInputValue> {
  return resolveQueuedImages(
    await api.renderAiImage({
      ...payload,
      mode: 'text',
    })
  );
}
