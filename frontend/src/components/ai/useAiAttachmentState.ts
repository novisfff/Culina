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

function revokeAttachments(items: AiComposerAttachment[]) {
  items.forEach((item) => revokePreview(item.previewUrl));
}

function mapScopeRecord(
  current: Record<string, AiComposerAttachment[]>,
  scopeKey: string,
  updater: (items: AiComposerAttachment[]) => AiComposerAttachment[],
) {
  const nextItems = updater(current[scopeKey] ?? []);
  if (nextItems === (current[scopeKey] ?? []) && scopeKey in current) return current;
  return { ...current, [scopeKey]: nextItems };
}

function commitAttachmentsByScope(
  current: Record<string, AiComposerAttachment[]>,
  next: Record<string, AiComposerAttachment[]>,
  attachmentsByScopeRef: { current: Record<string, AiComposerAttachment[]> },
) {
  if (next === current) return current;
  attachmentsByScopeRef.current = next;
  return next;
}

export function useAiAttachmentState(scopeKey: string) {
  const [attachmentsByScope, setAttachmentsByScope] = useState<Record<string, AiComposerAttachment[]>>({});
  const attachmentsByScopeRef = useRef<Record<string, AiComposerAttachment[]>>({});
  const hiddenAttachmentsByScopeRef = useRef<Record<string, AiComposerAttachment[]>>({});
  const scopeKeyRef = useRef(scopeKey);

  useEffect(() => {
    scopeKeyRef.current = scopeKey;
  }, [scopeKey]);

  useEffect(() => {
    attachmentsByScopeRef.current = attachmentsByScope;
  }, [attachmentsByScope]);

  const attachments = attachmentsByScope[scopeKey] ?? [];

  const updateAttachmentsByScope = useCallback((
    updater: (current: Record<string, AiComposerAttachment[]>) => Record<string, AiComposerAttachment[]>,
  ) => {
    setAttachmentsByScope((current) => {
      const next = updater(current);
      return commitAttachmentsByScope(current, next, attachmentsByScopeRef);
    });
  }, []);

  const updateScopeAttachments = useCallback((
    targetScope: string,
    updater: (items: AiComposerAttachment[]) => AiComposerAttachment[],
  ) => {
    updateAttachmentsByScope((current) => mapScopeRecord(current, targetScope, updater));
  }, [updateAttachmentsByScope]);

  const uploadFiles = useCallback((files: File[]) => {
    const imageFiles = files.filter((file) => ACCEPTED_IMAGE_TYPES.has(file.type));
    if (imageFiles.length === 0) return;
    const uploadScopeKey = scopeKeyRef.current;

    updateAttachmentsByScope((current) => {
      const existing = current[uploadScopeKey] ?? [];
      const remainingSlots = Math.max(0, MAX_ATTACHMENTS - existing.length);
      const acceptedFiles = imageFiles.slice(0, remainingSlots);
      if (acceptedFiles.length === 0) return current;
      const pendingAttachments = acceptedFiles.map((file) => ({
        clientAttachmentId: createAttachmentId(),
        status: 'uploading' as const,
        fileName: file.name || '图片',
        previewUrl: URL.createObjectURL(file),
      }));

      for (const [index, attachment] of pendingAttachments.entries()) {
        const file = acceptedFiles[index];
        void api.uploadMedia(file, 'upload', file.name || 'AI 对话图片').then((asset) => {
          updateAttachmentsByScope((itemsByScope) => mapScopeRecord(itemsByScope, uploadScopeKey, (items) => (
            items.map((item) => (
              item.clientAttachmentId === attachment.clientAttachmentId
                ? { ...item, status: 'ready', asset, errorMessage: undefined }
                : item
            ))
          )));
        }).catch((reason) => {
          const errorMessage = reason instanceof Error && reason.message.trim() ? reason.message : '图片上传失败';
          updateAttachmentsByScope((itemsByScope) => mapScopeRecord(itemsByScope, uploadScopeKey, (items) => (
            items.map((item) => (
              item.clientAttachmentId === attachment.clientAttachmentId
                ? { ...item, status: 'failed', errorMessage }
                : item
            ))
          )));
        });
      }

      return {
        ...current,
        [uploadScopeKey]: [...existing, ...pendingAttachments],
      };
    });
  }, [updateAttachmentsByScope]);

  const removeAttachment = useCallback((clientAttachmentId: string) => {
    const targetScope = scopeKeyRef.current;
    updateScopeAttachments(targetScope, (current) => {
      const removed = current.find((item) => item.clientAttachmentId === clientAttachmentId);
      if (removed) revokePreview(removed.previewUrl);
      return current.filter((item) => item.clientAttachmentId !== clientAttachmentId);
    });
  }, [updateScopeAttachments]);

  const clearAttachments = useCallback(() => {
    const targetScope = scopeKeyRef.current;
    updateScopeAttachments(targetScope, (current) => {
      revokeAttachments(current);
      return [];
    });
  }, [updateScopeAttachments]);

  const hideAttachments = useCallback((clientAttachmentIds: string[]) => {
    if (clientAttachmentIds.length === 0) return;
    const targetScope = scopeKeyRef.current;
    const hiddenIds = new Set(clientAttachmentIds);
    const scopeAttachments = attachmentsByScopeRef.current[targetScope] ?? [];
    const hidden = scopeAttachments.filter((item) => hiddenIds.has(item.clientAttachmentId));
    if (hidden.length === 0) return;
    const existingHidden = hiddenAttachmentsByScopeRef.current[targetScope] ?? [];
    hiddenAttachmentsByScopeRef.current = {
      ...hiddenAttachmentsByScopeRef.current,
      [targetScope]: [
        ...existingHidden.filter((item) => !hiddenIds.has(item.clientAttachmentId)),
        ...hidden,
      ],
    };
    updateAttachmentsByScope((current) => {
      const currentScopeAttachments = current[targetScope] ?? [];
      return {
        ...current,
        [targetScope]: currentScopeAttachments.filter((item) => !hiddenIds.has(item.clientAttachmentId)),
      };
    });
  }, [updateAttachmentsByScope]);

  const restoreHiddenAttachments = useCallback((items: AiComposerAttachment[]) => {
    if (items.length === 0) return;
    const targetScope = scopeKeyRef.current;
    const itemIds = new Set(items.map((item) => item.clientAttachmentId));
    const existingHidden = hiddenAttachmentsByScopeRef.current[targetScope] ?? [];
    hiddenAttachmentsByScopeRef.current = {
      ...hiddenAttachmentsByScopeRef.current,
      [targetScope]: existingHidden.filter((item) => !itemIds.has(item.clientAttachmentId)),
    };
    updateScopeAttachments(targetScope, (current) => {
      const currentIds = new Set(current.map((item) => item.clientAttachmentId));
      return [
        ...items.filter((item) => !currentIds.has(item.clientAttachmentId)),
        ...current,
      ];
    });
  }, [updateScopeAttachments]);

  const discardHiddenAttachments = useCallback((items: AiComposerAttachment[]) => {
    if (items.length === 0) return;
    const targetScope = scopeKeyRef.current;
    const itemIds = new Set(items.map((item) => item.clientAttachmentId));
    const existingHidden = hiddenAttachmentsByScopeRef.current[targetScope] ?? [];
    hiddenAttachmentsByScopeRef.current = {
      ...hiddenAttachmentsByScopeRef.current,
      [targetScope]: existingHidden.filter((item) => {
        if (!itemIds.has(item.clientAttachmentId)) return true;
        revokePreview(item.previewUrl);
        return false;
      }),
    };
  }, []);

  const moveScope = useCallback((from: string, to: string) => {
    if (from === to) return;
    if (scopeKeyRef.current === from) {
      scopeKeyRef.current = to;
    }

    updateAttachmentsByScope((current) => {
      if (!(from in current) && !(to in current)) return current;
      const next = { ...current };
      const moving = next[from] ?? [];
      const superseded = next[to] ?? [];
      if (superseded.length > 0) {
        revokeAttachments(superseded);
      }
      delete next[from];
      if (moving.length > 0 || to in current) {
        next[to] = moving;
      }
      return next;
    });

    const hiddenFrom = hiddenAttachmentsByScopeRef.current[from] ?? [];
    const hiddenTo = hiddenAttachmentsByScopeRef.current[to] ?? [];
    if (hiddenTo.length > 0) {
      revokeAttachments(hiddenTo);
    }
    const nextHidden = { ...hiddenAttachmentsByScopeRef.current };
    delete nextHidden[from];
    if (hiddenFrom.length > 0 || to in hiddenAttachmentsByScopeRef.current) {
      nextHidden[to] = hiddenFrom;
    } else {
      delete nextHidden[to];
    }
    hiddenAttachmentsByScopeRef.current = nextHidden;
  }, [updateAttachmentsByScope]);

  const clearScope = useCallback((key: string) => {
    updateAttachmentsByScope((current) => {
      if (!(key in current)) return current;
      revokeAttachments(current[key] ?? []);
      const next = { ...current };
      delete next[key];
      return next;
    });
    const hidden = hiddenAttachmentsByScopeRef.current[key] ?? [];
    if (hidden.length > 0) {
      revokeAttachments(hidden);
    }
    if (key in hiddenAttachmentsByScopeRef.current) {
      const nextHidden = { ...hiddenAttachmentsByScopeRef.current };
      delete nextHidden[key];
      hiddenAttachmentsByScopeRef.current = nextHidden;
    }
  }, [updateAttachmentsByScope]);

  useEffect(() => {
    return () => {
      Object.values(attachmentsByScopeRef.current).forEach(revokeAttachments);
      Object.values(hiddenAttachmentsByScopeRef.current).forEach(revokeAttachments);
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
    hideAttachments,
    restoreHiddenAttachments,
    discardHiddenAttachments,
    moveScope,
    clearScope,
  };
}
