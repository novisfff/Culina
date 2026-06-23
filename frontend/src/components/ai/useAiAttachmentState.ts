import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { MediaAsset } from '../../api/types';

export type AiComposerAttachment = {
  clientAttachmentId: string;
  status: 'uploading' | 'ready' | 'failed';
  fileName: string;
  previewUrl: string;
  asset?: MediaAsset;
  errorMessage?: string;
};

const MAX_ATTACHMENTS = 6;
const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp']);

function createAttachmentId() {
  return `attachment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function revokePreview(url: string) {
  if (url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

export function useAiAttachmentState() {
  const [attachments, setAttachments] = useState<AiComposerAttachment[]>([]);
  const attachmentsRef = useRef<AiComposerAttachment[]>([]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const uploadFiles = useCallback((files: File[]) => {
    const imageFiles = files.filter((file) => ACCEPTED_IMAGE_TYPES.has(file.type));
    if (imageFiles.length === 0) return;

    setAttachments((current) => {
      const remainingSlots = Math.max(0, MAX_ATTACHMENTS - current.length);
      const acceptedFiles = imageFiles.slice(0, remainingSlots);
      const pendingAttachments = acceptedFiles.map((file) => ({
        clientAttachmentId: createAttachmentId(),
        status: 'uploading' as const,
        fileName: file.name || '图片',
        previewUrl: URL.createObjectURL(file),
      }));

      for (const [index, attachment] of pendingAttachments.entries()) {
        const file = acceptedFiles[index];
        void api.uploadMedia(file, 'upload', file.name || 'AI 对话图片').then((asset) => {
          setAttachments((items) => items.map((item) => (
            item.clientAttachmentId === attachment.clientAttachmentId
              ? { ...item, status: 'ready', asset, errorMessage: undefined }
              : item
          )));
        }).catch((reason) => {
          const errorMessage = reason instanceof Error && reason.message.trim() ? reason.message : '图片上传失败';
          setAttachments((items) => items.map((item) => (
            item.clientAttachmentId === attachment.clientAttachmentId
              ? { ...item, status: 'failed', errorMessage }
              : item
          )));
        });
      }

      return [...current, ...pendingAttachments];
    });
  }, []);

  const removeAttachment = useCallback((clientAttachmentId: string) => {
    setAttachments((current) => {
      const removed = current.find((item) => item.clientAttachmentId === clientAttachmentId);
      if (removed) revokePreview(removed.previewUrl);
      return current.filter((item) => item.clientAttachmentId !== clientAttachmentId);
    });
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments((current) => {
      current.forEach((item) => revokePreview(item.previewUrl));
      return [];
    });
  }, []);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((item) => revokePreview(item.previewUrl));
    };
  }, []);

  return {
    attachments,
    readyAttachments: attachments.filter((item) => item.status === 'ready' && item.asset),
    hasUploadingAttachment: attachments.some((item) => item.status === 'uploading'),
    hasFailedAttachment: attachments.some((item) => item.status === 'failed'),
    canAddMore: attachments.length < MAX_ATTACHMENTS,
    uploadFiles,
    removeAttachment,
    clearAttachments,
  };
}
