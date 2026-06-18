import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type {
  AiInventoryOperationAction,
  AiInventoryResultItem,
  AiMessage,
  AiResultCard,
  AiRunEvent,
  AiTodayRecommendationItem,
  Food,
  Ingredient,
  UserSummary,
} from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { avatarColor, initials } from '../../lib/ui';
import { ApprovalPanel } from './AiApprovalPanel';
import type { AiApprovalDecisionSubmit, AiResourceOptionLoader } from './AiApprovalPanel';
import { ResultCard } from './AiResultCards';

export { ApprovalPanel } from './AiApprovalPanel';
export type { AiApprovalDecisionSubmit, AiResourceOptionLoader } from './AiApprovalPanel';

const MarkdownMessage = lazy(() => import('./MarkdownMessage'));

function resolveAiAvatarUrl(url: string | null | undefined) {
  return resolveAssetUrl(url) ?? null;
}

function formatMessageTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function lastOf<T>(items: T[]) {
  return items.length > 0 ? items[items.length - 1] : undefined;
}

function formatRunEventTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function isActiveRunStatus(status: AiRunEvent['status']) {
  return status === 'pending' || status === 'running';
}

function runStatusText(status: AiRunEvent['status']) {
  if (status === 'failed') return '执行失败';
  if (status === 'waiting') return '待补充';
  if (status === 'completed') return '已完成';
  return '正在执行';
}

function runEventStatusText(event: AiRunEvent) {
  if (event.type === 'skill' && isActiveRunStatus(event.status)) return '开始执行';
  if (event.type === 'tool' && event.status === 'waiting') return '待补充';
  return runStatusText(event.status);
}

function extractSkillName(event: AiRunEvent | undefined) {
  if (!event) return '任务规划';
  const match = event.user_message.match(/「(.+?)」技能/);
  return match?.[1] ?? event.user_message;
}

const TOOL_REVEAL_INTERVAL_MS = 2000;

type ToolEventEntry = {
  key: string;
  event: AiRunEvent;
};

function runEventKey(event: AiRunEvent, index: number) {
  return event.id || `${event.internal_code}-${event.created_at}-${event.user_message}-${index}`;
}

function isDraftToolEvent(event: AiRunEvent) {
  return event.internal_code.includes('.create_draft') || event.user_message.startsWith('生成「');
}

function isMessageFooterReady(message: AiMessage) {
  if (message.role === 'user') return true;
  const status = message.status.toLowerCase();
  return status !== 'pending' && status !== 'running';
}

function hasDraftContent(message: AiMessage) {
  return message.parts.some((part) => Boolean(part.approval || part.draft));
}

function ToolEventIcon({ event }: { event: AiRunEvent }) {
  if (isDraftToolEvent(event)) {
    return (
      <svg className="ai-run-tool-icon icon-form" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="3.75" width="14" height="16.5" rx="3" />
        <path d="M8.25 8.25h7.5" />
        <path d="M8.25 12h7.5" />
        <path d="M8.25 15.75h4.75" />
      </svg>
    );
  }
  return (
    <svg className="ai-run-tool-icon icon-tool" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M15.9 2.9a5.15 5.15 0 0 0-5.1 6.05l-7.25 7.25a3.05 3.05 0 0 0 4.25 4.25l7.25-7.25A5.15 5.15 0 0 0 21.1 7.1l-3.35 3.35-4.2-4.2L16.9 2.9h-1Zm-9.75 16.3a1.35 1.35 0 1 0 0-2.7 1.35 1.35 0 0 0 0 2.7Z"
      />
    </svg>
  );
}

function ProgressEventIcon({ event }: { event: AiRunEvent }) {
  if (event.type === 'tool') {
    return <ToolEventIcon event={event} />;
  }
  return <span className="ai-run-detail-status-dot" aria-hidden="true" />;
}

function RunProgressTimeline({ events, isLive }: { events: AiRunEvent[]; isLive: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const sortedEvents = [...events].sort((left, right) => {
    const leftTime = new Date(left.created_at).getTime();
    const rightTime = new Date(right.created_at).getTime();
    return (Number.isNaN(leftTime) ? 0 : leftTime) - (Number.isNaN(rightTime) ? 0 : rightTime);
  });
  const skillEvents = sortedEvents.filter((event) => event.type === 'skill');
  const currentSkill = lastOf(skillEvents);
  const toolEvents = sortedEvents.filter((event) => event.type === 'tool');
  const toolEntries: ToolEventEntry[] = toolEvents.map((event, index) => ({ key: runEventKey(event, index), event }));
  const toolEntrySignature = toolEntries.map((entry) => entry.key).join('\u001f');
  const shouldQueueToolEvents = useRef(isLive);
  if (isLive) {
    shouldQueueToolEvents.current = true;
  }
  const [toolDisplay, setToolDisplay] = useState(() => ({
    visibleKeys: shouldQueueToolEvents.current ? [] : toolEntries.map((entry) => entry.key),
    queuedKeys: [] as string[],
    latestKey: null as string | null,
    revealVersion: 0,
    lastRevealAt: null as number | null,
  }));
  useEffect(() => {
    setToolDisplay((current) => {
      if (!shouldQueueToolEvents.current) {
        const visibleKeys = toolEntries.map((entry) => entry.key);
        const hasSameVisibleKeys = visibleKeys.length === current.visibleKeys.length && visibleKeys.every((key, index) => key === current.visibleKeys[index]);
        if (hasSameVisibleKeys && current.queuedKeys.length === 0) {
          return current;
        }
        return { ...current, visibleKeys, queuedKeys: [], latestKey: null };
      }
      const knownKeys = new Set(toolEntries.map((entry) => entry.key));
      const visibleKeys = current.visibleKeys.filter((key) => knownKeys.has(key));
      const queuedKeys = current.queuedKeys.filter((key) => knownKeys.has(key));
      const existingKeys = new Set([...visibleKeys, ...queuedKeys]);
      for (const entry of toolEntries) {
        if (!existingKeys.has(entry.key)) {
          queuedKeys.push(entry.key);
          existingKeys.add(entry.key);
        }
      }
      const latestKey = current.latestKey && knownKeys.has(current.latestKey) ? current.latestKey : null;
      if (
        visibleKeys.length === current.visibleKeys.length &&
        queuedKeys.length === current.queuedKeys.length &&
        latestKey === current.latestKey
      ) {
        return current;
      }
      return { ...current, visibleKeys, queuedKeys, latestKey };
    });
  }, [toolEntrySignature]);
  useEffect(() => {
    if (toolDisplay.queuedKeys.length === 0) return undefined;
    const elapsedMs = toolDisplay.lastRevealAt === null ? TOOL_REVEAL_INTERVAL_MS : Date.now() - toolDisplay.lastRevealAt;
    const waitMs = Math.max(0, TOOL_REVEAL_INTERVAL_MS - elapsedMs);
    const timer = window.setTimeout(() => {
      setToolDisplay((current) => {
        const [nextKey, ...queuedKeys] = current.queuedKeys;
        if (!nextKey) return current;
        return {
          visibleKeys: current.visibleKeys.includes(nextKey) ? current.visibleKeys : [...current.visibleKeys, nextKey],
          queuedKeys,
          latestKey: nextKey,
          revealVersion: current.revealVersion + 1,
          lastRevealAt: Date.now(),
        };
      });
    }, waitMs);
    return () => window.clearTimeout(timer);
  }, [toolDisplay.queuedKeys.length, toolDisplay.lastRevealAt]);
  if (events.length === 0) return null;
  const visibleToolKeys = new Set(toolDisplay.visibleKeys);
  const visibleToolEvents = toolEntries.filter((entry) => visibleToolKeys.has(entry.key)).reverse();
  const hasActiveEvent = Boolean(currentSkill && isActiveRunStatus(currentSkill.status)) || toolEvents.some((event) => isActiveRunStatus(event.status));
  const currentSkillName = extractSkillName(currentSkill);
  const currentStatus: AiRunEvent['status'] =
    hasActiveEvent || (isLive && currentSkill?.status !== 'failed' && currentSkill?.status !== 'waiting')
      ? 'running'
      : currentSkill?.status ?? 'completed';

  return (
    <section className={`ai-run-progress${isExpanded ? ' is-expanded' : ''}`} aria-label="AI 执行进度">
      <div className={`ai-run-progress-bar${toolEvents.length > 0 ? ' has-tools' : ''}`}>
        <div className={`ai-run-current-skill status-${currentStatus}${hasActiveEvent ? ' is-active' : ''}`}>
          <span className="ai-run-status-dot" aria-hidden="true" />
          <strong>{runStatusText(currentStatus)}</strong>
          <span title={currentSkillName}>{currentSkillName}</span>
        </div>
        {toolEvents.length > 0 && (
          <div className="ai-run-tool-marquee" aria-label="执行工具">
            <div className="ai-run-tool-track">
              {visibleToolEvents.map(({ event, key }) => {
                const movementClass =
                  key === toolDisplay.latestKey
                    ? ' is-newest'
                    : toolDisplay.latestKey
                      ? ` is-shifted shift-${toolDisplay.revealVersion % 2 === 0 ? 'even' : 'odd'}`
                      : '';
                return (
                  <span
                    key={key}
                    className={`ai-run-tool-chip ${isDraftToolEvent(event) ? 'kind-form' : 'kind-tool'} status-${event.status}${movementClass}`}
                    title={event.user_message}
                  >
                    <ToolEventIcon event={event} />
                    {event.user_message}
                  </span>
                );
              })}
            </div>
          </div>
        )}
        <button className={`ai-run-progress-toggle${isExpanded ? ' is-expanded' : ''}`} type="button" onClick={() => setIsExpanded((current) => !current)}>
          <span>{isExpanded ? '收起进度' : '查看详情'}</span>
          <span className="ai-run-toggle-chevron" aria-hidden="true" />
        </button>
      </div>
      {isExpanded && (
        <div className="ai-run-progress-detail">
          <div className="ai-run-progress-steps">
            {sortedEvents.map((event, index) => (
              <div key={event.id || `${event.internal_code}-${index}`} className={`ai-run-progress-step status-${event.status}`}>
                <ProgressEventIcon event={event} />
                <strong>{runEventStatusText(event)}</strong>
                <p title={event.user_message}>{event.user_message}</p>
                <time dateTime={event.created_at}>{formatRunEventTime(event.created_at)}</time>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function MessageBubble({
  message,
  user,
  foods = [],
  ingredients = [],
  resourceOptionLoader,
  runEvents = [],
  isLatestAssistant = false,
  onApprovalDecision,
  onAddRecommendationToPlan,
  onInventoryAction,
  isInventoryActionPending,
}: {
  message: AiMessage;
  user: UserSummary | null;
  foods?: Food[];
  ingredients?: Ingredient[];
  resourceOptionLoader?: AiResourceOptionLoader;
  runEvents?: AiRunEvent[];
  isLatestAssistant?: boolean;
  onApprovalDecision: AiApprovalDecisionSubmit;
  onAddRecommendationToPlan?: (item: AiTodayRecommendationItem, card: AiResultCard, messageId: string, partId: string) => void;
  onInventoryAction?: (
    item: AiInventoryResultItem,
    action: AiInventoryOperationAction,
    card: AiResultCard,
    messageId: string,
    partId: string,
  ) => void;
  isInventoryActionPending?: boolean;
}) {
  const isUser = message.role === 'user';
  const userName = user?.display_name || user?.username || '我';
  const userAvatarUrl = resolveAiAvatarUrl(user?.avatar_image?.url);
  const messageTime = formatMessageTime(message.created_at);
  const hasRenderableParts = message.parts.some((part) => {
    if (part.type === 'text') return Boolean(part.text?.trim());
    return Boolean(part.card || part.approval || part.draft);
  });
  const isWaitingForAssistant = !isUser && message.status === 'running' && !hasRenderableParts && runEvents.length === 0;
  const isGeneratingDraft = !isUser && message.status === 'running' && runEvents.some(isDraftToolEvent) && !hasDraftContent(message);

  const [messageCopied, setMessageCopied] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);
  const showFooter = isMessageFooterReady(message);

  const copyMessageText = async () => {
    const textContent = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n\n') || message.content || '';
    try {
      await navigator.clipboard.writeText(textContent);
      setMessageCopied(true);
      setTimeout(() => setMessageCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy message text: ', err);
    }
  };

  const showActions = showFooter && !isUser && hasRenderableParts;

  return (
    <article className={`ai-message ai-message-${message.role}`}>
      <div className={isUser ? 'ai-message-avatar ai-message-avatar-user' : 'ai-message-avatar ai-message-avatar-assistant'} aria-hidden="true">
        {isUser ? (
          userAvatarUrl ? (
            <img className="ai-user-avatar-image" src={userAvatarUrl} alt="" />
          ) : (
            <span className="ai-user-avatar-fallback" style={{ backgroundColor: avatarColor(user?.avatar_seed || userName) }}>
              {initials(userName)}
            </span>
          )
        ) : (
          <img className="ai-bot-avatar-image" src="/assets/chatbot.webp" alt="" />
        )}
      </div>
      <div className="ai-message-content">
        <div className="ai-message-role">{isUser ? userName : 'AI 厨房助手'}</div>
        <div className="ai-message-body">
          {!isUser && <RunProgressTimeline events={runEvents} isLive={message.status === 'running'} />}
          {isWaitingForAssistant && (
            <div className="ai-thinking-cue" aria-live="polite">
              <span>正在整理回复</span>
              <i aria-hidden="true" />
              <i aria-hidden="true" />
              <i aria-hidden="true" />
            </div>
          )}
          {message.parts.map((part) => {
            if (part.type === 'text') {
              return (
                <Suspense key={part.id} fallback={<p>{part.text}</p>}>
                  <MarkdownMessage text={part.text ?? ''} />
                </Suspense>
              );
            }
            if ((part.type === 'result_card' || part.type === 'error_recovery') && part.card) {
              return (
                <div key={part.id} className="ai-message-part">
                  <ResultCard
                    card={part.card}
                    onAddToPlan={(item, card) => onAddRecommendationToPlan?.(item, card, message.id, part.id)}
                    onInventoryAction={(item, action, card) => onInventoryAction?.(item, action, card, message.id, part.id)}
                    isInventoryActionPending={isInventoryActionPending}
                  />
                </div>
              );
            }
            if (part.type === 'approval_request' && part.approval) {
              return (
                <ApprovalPanel
                  key={part.id}
                  approval={part.approval}
                  foods={foods}
                  ingredients={ingredients}
                  resourceOptionLoader={resourceOptionLoader}
                  onDecision={onApprovalDecision}
                  isLatest={isLatestAssistant}
                />
              );
            }
            return null;
          })}
          {isGeneratingDraft && (
            <div className="ai-draft-generating-cue" aria-live="polite">
              <span className="ai-draft-generating-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <rect x="5" y="3.75" width="14" height="16.5" rx="3" />
                  <path d="M8.25 8.25h7.5" />
                  <path d="M8.25 12h7.5" />
                  <path d="M8.25 15.75h4.75" />
                </svg>
              </span>
              <span>
                <strong>正在准备可确认草稿</strong>
                <small>生成后会在这里等你核对，确认前不会保存到家庭数据。</small>
              </span>
            </div>
          )}
          {showFooter && (showActions || messageTime) && (
            <div className={`ai-message-footer${showActions ? ' has-actions' : ''}`}>
              {showActions && (
                <div className="ai-message-actions-bar">
                  <button
                    className={`ai-message-action-btn ${messageCopied ? 'copied' : ''}`}
                    title={messageCopied ? '已复制' : '复制回复'}
                    type="button"
                    onClick={copyMessageText}
                  >
                    {messageCopied ? (
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    )}
                  </button>
                  <button
                    className={`ai-message-action-btn ${feedback === 'up' ? 'active' : ''}`}
                    title="赞同"
                    type="button"
                    onClick={() => setFeedback(feedback === 'up' ? null : 'up')}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>
                  </button>
                  <button
                    className={`ai-message-action-btn ${feedback === 'down' ? 'active' : ''}`}
                    title="反对"
                    type="button"
                    onClick={() => setFeedback(feedback === 'down' ? null : 'down')}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm12-5v9a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z"></path></svg>
                  </button>
                </div>
              )}
              {messageTime && (
                <span className="ai-message-time">
                  {messageTime}
                  {isUser && <span className="ai-message-sent-mark" aria-label="已发送">✓✓</span>}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
