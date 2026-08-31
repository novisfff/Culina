import type { ReactNode } from 'react';
import { AiWorkspaceShell } from './AiWorkspaceShell';

export function AiWorkspaceRoute(props: {
  children: ReactNode;
  loading?: boolean;
  error?: string | null;
  notice?: ReactNode;
}) {
  return <AiWorkspaceShell {...props} />;
}
