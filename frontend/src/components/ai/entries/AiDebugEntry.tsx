import { AiRunDebugDrawer } from '../AiRunDebugDrawer';
import type { ComponentProps } from 'react';

export type AiDebugEntryProps = ComponentProps<typeof AiRunDebugDrawer>;
export default function AiDebugEntry(props: AiDebugEntryProps) {
  return <AiRunDebugDrawer {...props} />;
}
