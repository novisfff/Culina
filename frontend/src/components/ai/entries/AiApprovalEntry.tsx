import { ApprovalPanel } from '../AiApprovalPanel';
import type { ComponentProps } from 'react';

export type AiApprovalEntryProps = ComponentProps<typeof ApprovalPanel>;
export default function AiApprovalEntry(props: AiApprovalEntryProps) {
  return <ApprovalPanel {...props} />;
}
