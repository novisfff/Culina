import { StateBlock } from '../components/ui-kit';

export function AuthRecoveryNotice(props: { error: string; busy: boolean; onRetry: () => void }) {
  return (
    <StateBlock
      status={props.busy ? 'loading' : 'error'}
      title="登录状态暂未更新"
      description={props.error}
      actionLabel={props.busy ? undefined : '重试连接'}
      onAction={props.onRetry}
    />
  );
}
