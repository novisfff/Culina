import { useState } from 'react';
import { api } from '../api/client';
import type { ImageInputValue } from '../api/types';
import {
  generateImageFromText,
  regenerateImageFromReference,
  uploadReferenceAndGenerateImage,
  type AiRenderPayload,
} from '../lib/aiImages';
import { emptyImages } from '../lib/ui';

export type ImageGenerationUiState = {
  isGenerating: boolean;
  errorMessage: string | null;
};

export const IDLE_IMAGE_GENERATION_STATE: ImageGenerationUiState = {
  isGenerating: false,
  errorMessage: null,
};

function resolveImageGenerationErrorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return fallback;
}

function extractReferenceAsset(reason: unknown): ImageInputValue['referenceAsset'] {
  if (reason && typeof reason === 'object' && 'referenceAsset' in reason) {
    return (reason as { referenceAsset?: ImageInputValue['referenceAsset'] }).referenceAsset;
  }
  return undefined;
}

export function useImageComposer(options: {
  value: ImageInputValue;
  payload: AiRenderPayload;
  onChange: (next: ImageInputValue) => void;
  uploadErrorMessage?: string;
  generateErrorMessage?: string;
}) {
  const [state, setState] = useState<ImageGenerationUiState>(IDLE_IMAGE_GENERATION_STATE);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const [file] = Array.from(files);
    if (!file) return;

    setState({ isGenerating: true, errorMessage: null });
    try {
      const nextImages = await uploadReferenceAndGenerateImage(file, options.payload);
      options.onChange(nextImages);
      setState(IDLE_IMAGE_GENERATION_STATE);
    } catch (reason) {
      const message = resolveImageGenerationErrorMessage(
        reason,
        options.uploadErrorMessage ?? '参考图上传或 AI 主图生成失败'
      );
      const referenceAsset = extractReferenceAsset(reason);
      if (referenceAsset) {
        options.onChange({ ...options.value, referenceAsset });
      }
      setState({
        isGenerating: false,
        errorMessage: referenceAsset ? `${message}，参考图已保留，可重试生成主图。` : message,
      });
    }
  }

  async function uploadDirect(files: FileList | null, alt: string) {
    if (!files || files.length === 0) return;
    const [file] = Array.from(files);
    if (!file) return;

    setState({ isGenerating: true, errorMessage: null });
    try {
      const asset = await api.uploadMedia(file, 'upload', alt || file.name);
      options.onChange({ generatedAsset: asset });
      setState(IDLE_IMAGE_GENERATION_STATE);
    } catch (reason) {
      setState({
        isGenerating: false,
        errorMessage: resolveImageGenerationErrorMessage(reason, '图片上传失败'),
      });
    }
  }

  async function generateWithResult(mode: 'reference' | 'text', payloadOverride?: AiRenderPayload) {
    setState({ isGenerating: true, errorMessage: null });
    try {
      const payload = payloadOverride ?? options.payload;
      const nextImages =
        mode === 'reference' && options.value.referenceAsset
          ? await regenerateImageFromReference(options.value.referenceAsset.id, payload)
          : await generateImageFromText(payload);
      options.onChange({
        referenceAsset: nextImages.referenceAsset ?? options.value.referenceAsset,
        generatedAsset: nextImages.generatedAsset,
      });
      setState(IDLE_IMAGE_GENERATION_STATE);
      return nextImages;
    } catch (reason) {
      setState({
        isGenerating: false,
        errorMessage: resolveImageGenerationErrorMessage(
          reason,
          options.generateErrorMessage ?? 'AI 主图生成失败'
        ),
      });
      throw reason;
    }
  }

  async function generate(mode: 'reference' | 'text', payloadOverride?: AiRenderPayload) {
    await generateWithResult(mode, payloadOverride);
  }

  function reset() {
    options.onChange(emptyImages());
    setState(IDLE_IMAGE_GENERATION_STATE);
  }

  return {
    state,
    setState,
    upload,
    uploadDirect,
    generateWithResult,
    generate,
    reset,
  };
}

export function useDirectImageUploader(options?: { uploadErrorMessage?: string }) {
  const [state, setState] = useState<ImageGenerationUiState>(IDLE_IMAGE_GENERATION_STATE);

  async function uploadFiles(files: File[], alt: string) {
    if (files.length === 0) return [];

    setState({ isGenerating: true, errorMessage: null });
    try {
      const assets = await Promise.all(files.map((file) => api.uploadMedia(file, 'upload', alt || file.name)));
      setState(IDLE_IMAGE_GENERATION_STATE);
      return assets;
    } catch (reason) {
      setState({
        isGenerating: false,
        errorMessage: resolveImageGenerationErrorMessage(reason, options?.uploadErrorMessage ?? '图片上传失败'),
      });
      return [];
    }
  }

  function setError(errorMessage: string) {
    setState({ isGenerating: false, errorMessage });
  }

  function reset() {
    setState(IDLE_IMAGE_GENERATION_STATE);
  }

  return {
    state,
    uploadFiles,
    setError,
    reset,
  };
}
