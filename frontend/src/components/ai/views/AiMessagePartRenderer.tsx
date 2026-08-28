import type { ReactNode } from 'react';

export type NormalizedAiMessagePart = {
  type: string;
  id?: string;
  text?: string;
  [key: string]: unknown;
};

export function AiMessagePartRenderer(props: {
  part: NormalizedAiMessagePart;
  onAction?: (action: string, part: NormalizedAiMessagePart) => void;
}): ReactNode {
  const { part } = props;
  if (part.type === 'text') return <div className="ai-message-text-block">{part.text ?? ''}</div>;
  if (part.type === 'image') return <div className="ai-message-image-part" aria-label="图片内容">图片</div>;
  if (part.type === 'result_card') return <div className="ai-message-result-card">结果卡片</div>;
  return <div className="ai-message-part-fallback" role="status">这条内容暂时无法显示</div>;
}
