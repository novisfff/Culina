import { HumanInputRequestPanel } from '../AiHumanInputRequestPanel';
import type { ComponentProps } from 'react';

export type AiHumanInputEntryProps = ComponentProps<typeof HumanInputRequestPanel>;
export default function AiHumanInputEntry(props: AiHumanInputEntryProps) {
  return <HumanInputRequestPanel {...props} />;
}
