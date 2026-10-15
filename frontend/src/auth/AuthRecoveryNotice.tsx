import { useState } from 'react';
import { createPortal } from 'react-dom';
import { FormActions, WorkspaceModal, WorkspaceOverlayFrame } from '../components/ui-kit';

export function AuthRecoveryNotice(props: { error: string; busy: boolean; onRetry: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const close = () => { if (!props.busy) setDismissed(true); };

  return createPortal(
    <WorkspaceOverlayFrame busy={props.busy} onClose={close}>
      <WorkspaceModal
        size="small"
        title="登录状态暂未更新"
        description={props.error}
        closeLabel="暂时关闭"
        busy={props.busy}
        onClose={close}
        footerActions={
          <FormActions
            primaryLabel="重试连接"
            submittingLabel="正在重试…"
            isSubmitting={props.busy}
            onPrimary={props.onRetry}
            secondaryLabel="暂时关闭"
            onSecondary={close}
          />
        }
      >
        {null}
      </WorkspaceModal>
    </WorkspaceOverlayFrame>,
    document.body,
  );
}
