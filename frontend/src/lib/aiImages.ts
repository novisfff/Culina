import { api } from '../api/client';
import type { AiRenderResponse, CreateAiRenderRequest, ImageInputValue, MediaAsset } from '../api/types';

export type AiRenderPayload = Omit<CreateAiRenderRequest, 'mode' | 'reference_media_id'>;
export type AiImageGenerationError = Error & { referenceAsset?: MediaAsset };

export function getMediaIds(images: ImageInputValue) {
  return images.generatedAsset ? [images.generatedAsset.id] : [];
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForAiRender(response: AiRenderResponse): Promise<AiRenderResponse> {
  if (response.status === 'succeeded' && response.generated_asset) {
    return response;
  }
  if (response.status === 'failed') {
    throw new Error(response.error || 'AI 主图生成失败');
  }
  if (!response.job_id) {
    throw new Error('AI 主图生成任务缺少 ID');
  }

  for (let attempt = 0; attempt < 90; attempt += 1) {
    await sleep(attempt < 8 ? 800 : 1500);
    const nextResponse = await api.getAiRenderJob(response.job_id);
    if (nextResponse.status === 'succeeded' && nextResponse.generated_asset) {
      return nextResponse;
    }
    if (nextResponse.status === 'failed') {
      throw new Error(nextResponse.error || 'AI 主图生成失败');
    }
  }

  throw new Error('AI 主图生成超时');
}

export async function uploadReferenceAndGenerateImage(file: File, payload: AiRenderPayload): Promise<ImageInputValue> {
  const referenceAsset = await api.uploadMedia(file, 'upload', file.name);
  try {
    const response = await waitForAiRender(await api.renderAiImage({
      ...payload,
      mode: 'reference',
      reference_media_id: referenceAsset.id,
    }));

    return {
      referenceAsset: response.reference_asset ?? referenceAsset,
      generatedAsset: response.generated_asset ?? undefined,
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
  const response = await waitForAiRender(await api.renderAiImage({
    ...payload,
    mode: 'reference',
    reference_media_id: referenceMediaId,
  }));

  return {
    referenceAsset: response.reference_asset ?? undefined,
    generatedAsset: response.generated_asset ?? undefined,
  };
}

export async function generateImageFromText(payload: AiRenderPayload): Promise<ImageInputValue> {
  const response = await waitForAiRender(await api.renderAiImage({
    ...payload,
    mode: 'text',
  }));

  return {
    generatedAsset: response.generated_asset ?? undefined,
  };
}
