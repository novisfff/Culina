import type { ReactNode } from 'react';

export type AiDraftTone = 'plan' | 'warning' | 'danger' | 'neutral' | 'success';

export type AiDraftSummaryItem = {
  label: string;
  value: ReactNode;
};

export type AiDraftResolvedStatus = 'approved' | 'rejected' | 'expired' | 'cancelled' | 'canceled';
