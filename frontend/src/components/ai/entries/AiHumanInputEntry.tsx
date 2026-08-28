import { HumanInputRequestPanel } from '../AiConversationThread';
import type { ComponentProps } from 'react';

export type AiHumanInputEntryProps = ComponentProps<typeof HumanInputRequestPanel>;
export default function AiHumanInputEntry(props: AiHumanInputEntryProps) {
  return <HumanInputRequestPanel {...props} />;
}
