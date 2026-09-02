import { ConfirmDialog } from '../../components/ui-kit';

export function AiAutoExecutionConsentDialog(props: { open: boolean; isSubmitting: boolean; onConfirm: () => void; onCancel: () => void }) {
  return <ConfirmDialog open={props.open} title="开启自动执行" confirmLabel="同意并开启" isSubmitting={props.isSubmitting} onConfirm={props.onConfirm} onCancel={props.onCancel} description="只有在你明确要求、目标唯一且符合已开启的低风险规则时才会直接执行；其他情况仍会请你确认。支持撤销的操作可在 1 小时内恢复。" />;
}
