import type { AiComposerAttachment } from './useAiAttachmentState';
import { MediaWithPlaceholder } from '../MediaPlaceholder';

type Props = {
  attachments: AiComposerAttachment[];
  disabled?: boolean;
  onRemove: (clientAttachmentId: string) => void;
};

function attachmentStatusLabel(attachment: AiComposerAttachment) {
  if (attachment.status === 'uploading') return '上传中';
  if (attachment.status === 'failed') return attachment.errorMessage || '上传失败';
  return '已添加';
}

export function AiComposerAttachments({ attachments, disabled = false, onRemove }: Props) {
  if (attachments.length === 0) return null;

  return (
    <div className="ai-composer-attachments" aria-label="已添加的图片">
      {attachments.map((attachment) => (
        <div key={attachment.clientAttachmentId} className={`ai-composer-attachment is-${attachment.status}`}>
          <MediaWithPlaceholder
            src={attachment.previewUrl}
            alt=""
            className="ai-composer-attachment-media"
            showLabel={false}
            ariaHidden
          />
          <span className="ai-composer-attachment-status">{attachmentStatusLabel(attachment)}</span>
          <button
            type="button"
            aria-label={`移除 ${attachment.fileName}`}
            title="移除图片"
            disabled={disabled}
            onClick={() => onRemove(attachment.clientAttachmentId)}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
