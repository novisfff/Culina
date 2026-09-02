import { createContext, lazy, Suspense, useContext, useEffect, useState, type ReactNode } from 'react';
import type {
  AiInventoryCardAction,
  AiInventoryResultItem,
  AiMessage,
  AiMessageImagePartData,
  AiProductLoopPrompt,
  AiResultCard,
  AiRunEvent,
  AiTodayRecommendationItem,
  Food,
  Ingredient,
  UserSummary,
} from '../../api/types';
import type { AppNavigationTarget } from '../../app/appNavigationModel';
import {
  ModelUsageDegradationNotice,
  modelUsageFallbackCodeFromMessageMetadata,
} from '../../features/model-usage/ModelUsageDegradationNotice';
import { resolveAssetUrl } from '../../lib/assets';
import { avatarColor, initials } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ApprovalPanel } from './AiApprovalPanel';
import type { AiApprovalDecisionSubmit, AiResourceOptionLoader } from './AiApprovalPanel';
import { AiMessageImageGrid } from './AiMessageImageGrid';
import { AiApprovalHost } from './views/AiApprovalHost';
import { AiHumanInputHost } from './views/AiHumanInputHost';
import { AiMessagePartRenderer, type NormalizedAiMessagePart } from './views/AiMessagePartRenderer';
import { loadAiApproval } from './entries';
import { loadAiHumanInput } from './entries';
import { ResultCard } from './AiResultCards';
import {
  extractRunActivitySkillName,
  isDraftRunActivityEvent,
  isPendingHumanInputPart,
  operationResultDisplayParts,
  preferredRunActivityEvent,
  runActivityCollapseKey,
} from './aiWorkspaceHelpers';

export { ApprovalPanel } from './AiApprovalPanel';
export type { AiApprovalDecisionSubmit, AiResourceOptionLoader } from './AiApprovalPanel';
import { HumanInputRequestPanel, type AiHumanInputResponseSubmit } from './AiHumanInputRequestPanel';

type AiResultCardReplacement = (card: AiResultCard, messageId: string, partId: string) => void;

const AiResultCardReplacementContext = createContext<AiResultCardReplacement | undefined>(undefined);

export function AiResultCardReplacementProvider({
  children,
  onResultCard,
}: {
  children: ReactNode;
  onResultCard: AiResultCardReplacement;
}) {
  return (
    <AiResultCardReplacementContext.Provider value={onResultCard}>
      {children}
    </AiResultCardReplacementContext.Provider>
  );
}

const MarkdownMessage = lazy(() => import('./MarkdownMessage'));
const LazyAiApprovalEntry = lazy(loadAiApproval);
void LazyAiApprovalEntry;
const LazyAiHumanInputEntry = lazy(loadAiHumanInput);
void LazyAiHumanInputEntry;

function resolveAiAvatarUrl(url: string | null | undefined) {
  return resolveAssetUrl(url) ?? null;
}

function formatMessageTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function isActiveRunStatus(status: AiRunEvent['status']) {
  return status === 'pending' || status === 'running';
}

function extractSkillName(event: AiRunEvent | undefined) {
  return extractRunActivitySkillName(event);
}

type RunActivityEventEntry = {
  key: string;
  event: AiRunEvent;
  sequence: number;
};

function runEventKey(event: AiRunEvent, index: number) {
  return event.id || `${event.internal_code}-${event.created_at}-${event.user_message}-${index}`;
}

const isDraftToolEvent = isDraftRunActivityEvent;

type RunActivityItem = {
  key: string;
  event: AiRunEvent;
  kind: 'skill' | 'tool' | 'draft';
  label: string;
};

function toRunEventEntries(events: AiRunEvent[]) {
  return events
    .map((event, index) => ({ key: runEventKey(event, index), event, sequence: index + 1 }));
}

function collapseRunActivityEntries(entries: RunActivityEventEntry[]) {
  const collapsedEntries: RunActivityEventEntry[] = [];
  const indexByCollapseKey = new Map<string, number>();
  entries.forEach((entry) => {
    const collapseKey = runActivityCollapseKey(entry.event);
    if (!collapseKey) {
      collapsedEntries.push(entry);
      return;
    }
    const existingIndex = indexByCollapseKey.get(collapseKey);
    if (existingIndex === undefined) {
      indexByCollapseKey.set(collapseKey, collapsedEntries.length);
      collapsedEntries.push(entry);
      return;
    }
    collapsedEntries[existingIndex] = {
      ...collapsedEntries[existingIndex],
      event: preferredRunActivityEvent(collapsedEntries[existingIndex].event, entry.event),
    };
  });
  return collapsedEntries.map((entry, index) => ({ ...entry, sequence: index + 1 }));
}

function runActivitySkillLabel(event: AiRunEvent) {
  const skillName = extractSkillName(event);
  return event.status === 'completed' ? `已完成：${skillName}` : `正在处理：${skillName}`;
}

function runActivityScriptLabel(event: AiRunEvent) {
  if (event.status === 'failed') return '自动处理失败';
  if (event.status === 'completed') return '自动处理已完成';
  return '正在自动处理';
}

function normalizeToolMessage(message: string) {
  return message.replace(/执行完成$/, '').trim();
}

function runActivityToolLabel(event: AiRunEvent) {
  if (event.type === 'script') return runActivityScriptLabel(event);
  if (event.status === 'waiting') return `等你补充：${event.user_message}`;
  if (event.status === 'failed') return `处理失败：${event.user_message}`;
  if (isDraftToolEvent(event)) {
    const message = event.user_message.startsWith('生成「') ? event.user_message : `生成「${event.user_message}」`;
    return event.status === 'completed' ? `已${message}` : `正在${message}`;
  }
  const message = normalizeToolMessage(event.user_message);
  const normalized = message.replace(/^处理：/, '').trim();
  return event.status === 'completed' ? `已完成：${normalized}` : `正在处理：${normalized}`;
}

function runActivityKind(event: AiRunEvent): RunActivityItem['kind'] {
  if (event.type === 'skill') return 'skill';
  return isDraftToolEvent(event) ? 'draft' : 'tool';
}

function runActivityEventLabel(event: AiRunEvent) {
  if (event.status === 'cancelled') return event.user_message.trim() || '已取消这次任务';
  if (event.type === 'skill') return runActivitySkillLabel(event);
  return runActivityToolLabel(event);
}

const UNFINISHED_ASSISTANT_MESSAGE_STATUSES = new Set(['pending', 'running', 'waiting_approval', 'waiting_input']);

function isPendingApprovalPart(part: AiMessage['parts'][number]) {
  if (part.type !== 'approval_request' || !part.approval) return false;
  const status = part.approval.status.toLowerCase();
  return status === 'pending' || status === 'pending_retry';
}

function isUnfinishedAssistantMessage(message: AiMessage) {
  if (message.role !== 'assistant') return false;
  const status = message.status.toLowerCase();
  return UNFINISHED_ASSISTANT_MESSAGE_STATUSES.has(status)
    || message.parts.some((part) => isPendingApprovalPart(part) || isPendingHumanInputPart(part));
}

function hasActiveRunEvent(runEvents: AiRunEvent[]) {
  return runEvents.some((event) => isActiveRunStatus(event.status));
}

function isMessageFooterReady(message: AiMessage, isAssistantResponseActive: boolean, runEvents: AiRunEvent[]) {
  if (message.role === 'user') return true;
  if (isAssistantResponseActive || hasActiveRunEvent(runEvents)) return false;
  return !isUnfinishedAssistantMessage(message);
}

function hasDraftOutcome(message: AiMessage) {
  return message.parts.some((part) => (
    Boolean(part.approval || part.draft)
    || (part.type === 'result_card' && part.card?.type === 'operation_result')
  ));
}

function ToolEventIcon({ event }: { event: AiRunEvent }) {
  if (isDraftToolEvent(event)) {
    return (
      <svg className="ai-run-activity-icon ai-run-tool-icon icon-form" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="3.75" width="14" height="16.5" rx="3" />
        <path d="M8.25 8.25h7.5" />
        <path d="M8.25 12h7.5" />
        <path d="M8.25 15.75h4.75" />
      </svg>
    );
  }
  return (
    <svg className="ai-run-activity-icon ai-run-tool-icon icon-tool" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M15.9 2.9a5.15 5.15 0 0 0-5.1 6.05l-7.25 7.25a3.05 3.05 0 0 0 4.25 4.25l7.25-7.25A5.15 5.15 0 0 0 21.1 7.1l-3.35 3.35-4.2-4.2L16.9 2.9h-1Zm-9.75 16.3a1.35 1.35 0 1 0 0-2.7 1.35 1.35 0 0 0 0 2.7Z"
      />
    </svg>
  );
}

function SkillEventIcon() {
  return (
    <svg className="ai-run-activity-icon ai-run-skill-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.75" y="4.75" width="6.5" height="6.5" rx="1.8" />
      <rect x="12.75" y="4.75" width="6.5" height="6.5" rx="1.8" />
      <rect x="4.75" y="12.75" width="6.5" height="6.5" rx="1.8" />
      <path d="M14.3 16h3.4" />
      <path d="M16 14.3v3.4" />
    </svg>
  );
}

function RunActivityInline({
  entries,
  events = [],
  isLive,
  includeCompletedSkill = false,
}: {
  entries?: RunActivityEventEntry[];
  events?: AiRunEvent[];
  isLive: boolean;
  includeCompletedSkill?: boolean;
}) {
  const activityEntries = collapseRunActivityEntries(entries ?? toRunEventEntries(events));
  const skillEntries = activityEntries.filter(({ event }) => event.type === 'skill');
  const displayedSkillEntry = includeCompletedSkill && !isLive
    ? skillEntries[skillEntries.length - 1]
    : [...skillEntries].reverse().find(({ event }) => event.status !== 'completed') ?? (includeCompletedSkill ? skillEntries[skillEntries.length - 1] : undefined);
  const visibleActivityItems: RunActivityItem[] = activityEntries
    .filter(({ event, key }) => event.type !== 'skill' || (displayedSkillEntry?.key === key && (includeCompletedSkill || event.status !== 'completed')))
    .map(({ event, key }) => ({
      key,
      event,
      kind: runActivityKind(event),
      label: runActivityEventLabel(event),
    }));
  if (visibleActivityItems.length === 0) return null;
  const newestKey = isLive ? visibleActivityItems[visibleActivityItems.length - 1]?.key : null;

  return (
    <section className="ai-run-activity" aria-label="AI 处理过程">
      <div className="ai-run-activity-summary">
        {visibleActivityItems.map((item) => {
          const movementClass = item.key === newestKey ? ' is-newest' : '';
          const displayStatus = item.kind === 'skill' ? 'called' : item.event.status;
          const isActive = item.kind !== 'skill' && isActiveRunStatus(item.event.status);
          return (
            <div
              key={item.key}
              className={`ai-run-activity-row kind-${item.kind} status-${displayStatus}${isActive ? ' is-active' : ''}${movementClass}`}
            >
              {item.kind === 'skill' ? <SkillEventIcon /> : <ToolEventIcon event={item.event} />}
              <span title={item.label}>{item.label}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

type MessageTimelineItem =
  | { key: string; type: 'activity'; entry: RunActivityEventEntry }
  | { key: string; type: 'text'; text: string }
  | { key: string; type: 'part'; part: AiMessage['parts'][number] };

function isOperationResultPart(part: AiMessage['parts'][number]) {
  return part.type === 'result_card' && part.card?.type === 'operation_result';
}

function movePostApprovalTextAfterOperationResult(
  timeline: MessageTimelineItem[],
  parts: AiMessage['parts'],
) {
  if (!parts.some(isOperationResultPart)) return timeline;

  let hasSettledApproval = false;
  const postApprovalTextKeys = new Set<string>();
  parts.forEach((part) => {
    if (part.type === 'approval_request' && part.approval && !isPendingApprovalPart(part)) {
      hasSettledApproval = true;
      return;
    }
    if (part.type !== 'text' || !hasSettledApproval) return;
    const textSegments = (part.text ?? '').split(/\n\n+/).map((segment) => segment.trim()).filter(Boolean);
    textSegments.forEach((_text, segmentIndex) => {
      postApprovalTextKeys.add(`text:${part.id}:${segmentIndex}`);
    });
  });
  if (postApprovalTextKeys.size === 0) return timeline;

  const movedText = timeline.filter((item) => postApprovalTextKeys.has(item.key));
  if (movedText.length === 0) return timeline;
  const remaining = timeline.filter((item) => !postApprovalTextKeys.has(item.key));
  let lastOperationResultIndex = -1;
  remaining.forEach((item, index) => {
    if (item.type === 'part' && isOperationResultPart(item.part)) lastOperationResultIndex = index;
  });
  if (lastOperationResultIndex < 0) return timeline;
  return [
    ...remaining.slice(0, lastOperationResultIndex + 1),
    ...movedText,
    ...remaining.slice(lastOperationResultIndex + 1),
  ];
}

function createMessageTimelineItems(parts: AiMessage['parts'], runEventEntries: RunActivityEventEntry[]): MessageTimelineItem[] {
  if (parts.some((part) => part.type === 'run_activity' && part.activity)) {
    const activityStateByCollapseKey = new Map<string, { event: AiRunEvent; partIndex: number }>();
    parts.forEach((part, partIndex) => {
      if (part.type !== 'run_activity' || !part.activity) return;
      const collapseKey = runActivityCollapseKey(part.activity);
      if (collapseKey) {
        const existing = activityStateByCollapseKey.get(collapseKey);
        activityStateByCollapseKey.set(collapseKey, {
          event: existing ? preferredRunActivityEvent(existing.event, part.activity) : part.activity,
          partIndex,
        });
      }
    });
    const timeline = parts.flatMap((part, partIndex): MessageTimelineItem[] => {
      if (part.type === 'run_activity' && part.activity) {
        const collapseKey = runActivityCollapseKey(part.activity);
        const activityState = collapseKey ? activityStateByCollapseKey.get(collapseKey) : undefined;
        if (activityState && activityState.partIndex !== partIndex) return [];
        const activity = activityState?.event ?? part.activity;
        return [{
          key: `activity-part:${part.id || partIndex}`,
          type: 'activity',
          entry: { key: part.activity.id || part.id || `activity-${partIndex}`, event: activity, sequence: partIndex + 1 },
        }];
      }
      if (part.type === 'text') {
        const textSegments = (part.text ?? '').split(/\n\n+/).map((segment) => segment.trim()).filter(Boolean);
        return textSegments.map((text, segmentIndex) => ({
          key: `text:${part.id}:${segmentIndex}`,
          type: 'text',
          text,
        }));
      }
      return [{ key: `part:${part.id || partIndex}`, type: 'part', part }];
    });
    return movePostApprovalTextAfterOperationResult(timeline, parts);
  }
  const collapsedRunEventEntries = collapseRunActivityEntries(runEventEntries);
  const eventCount = collapsedRunEventEntries.length;
  const groupedParts = new Map<number, MessageTimelineItem[]>();
  const addPartAtBoundary = (boundary: number, item: MessageTimelineItem) => {
    const normalizedBoundary = Math.max(0, Math.min(boundary, eventCount));
    groupedParts.set(normalizedBoundary, [...(groupedParts.get(normalizedBoundary) ?? []), item]);
  };
  parts.forEach((part, partIndex) => {
    if (part.type === 'text') {
      const textSegments = (part.text ?? '').split(/\n\n+/).map((segment) => segment.trim()).filter(Boolean);
      textSegments.forEach((text, segmentIndex) => {
        addPartAtBoundary(0, {
          key: `text:${part.id}:${segmentIndex}`,
          type: 'text',
          text,
        });
      });
      return;
    }
    addPartAtBoundary(eventCount, {
      key: `part:${part.id || partIndex}`,
      type: 'part',
      part,
    });
  });

  const timeline: MessageTimelineItem[] = [...(groupedParts.get(0) ?? [])];
  const displayedSkillNames = new Set<string>();
  collapsedRunEventEntries.forEach((entry) => {
    if (entry.event.type === 'skill') {
      const skillName = extractSkillName(entry.event);
      if (displayedSkillNames.has(skillName)) {
        timeline.push(...(groupedParts.get(entry.sequence) ?? []));
        return;
      }
      displayedSkillNames.add(skillName);
    }
    timeline.push({ key: `activity:${entry.key}`, type: 'activity', entry });
    timeline.push(...(groupedParts.get(entry.sequence) ?? []));
  });
  return movePostApprovalTextAfterOperationResult(timeline, parts);
}

export { HumanInputRequestPanel };
export type { AiHumanInputResponseSubmit };
export function MessageBubble({
  message,
  user,
  foods = [],
  ingredients = [],
  resourceOptionLoader,
  runEvents = [],
  isThinking = false,
  isLatestAssistant = false,
  isAssistantResponseActive = false,
  activeStreamRunId = null,
  submittingApprovalId = null,
  onApprovalDecision,
  onAddRecommendationToPlan,
  onInventoryAction,
  isInventoryActionPending,
  onPromptAction,
  onProductLoopPrompt,
  isPromptActionPending,
  onHumanInputResponse,
  onOpenRunDebug,
  onNavigate,
  onResultCard,
}: {
  message: AiMessage;
  user: UserSummary | null;
  foods?: Food[];
  ingredients?: Ingredient[];
  resourceOptionLoader?: AiResourceOptionLoader;
  runEvents?: AiRunEvent[];
  isThinking?: boolean;
  isLatestAssistant?: boolean;
  isAssistantResponseActive?: boolean;
  activeStreamRunId?: string | null;
  submittingApprovalId?: string | null;
  onApprovalDecision: AiApprovalDecisionSubmit;
  onAddRecommendationToPlan?: (item: AiTodayRecommendationItem, card: AiResultCard, messageId: string, partId: string) => void;
  onInventoryAction?: (
    item: AiInventoryResultItem,
    action: AiInventoryCardAction,
    card: AiResultCard,
    messageId: string,
    partId: string,
  ) => void;
  isInventoryActionPending?: boolean;
  onPromptAction?: (prompt: string) => void;
  onProductLoopPrompt?: (prompt: AiProductLoopPrompt) => void;
  isPromptActionPending?: boolean;
  onHumanInputResponse?: AiHumanInputResponseSubmit;
  onOpenRunDebug?: (runId: string) => void;
  onNavigate?: (target: AppNavigationTarget) => void;
  onResultCard?: (card: AiResultCard, messageId: string, partId: string) => void;
}) {
  const inheritedResultCardReplacement = useContext(AiResultCardReplacementContext);
  const replaceResultCard = onResultCard ?? inheritedResultCardReplacement;
  const isUser = message.role === 'user';
  const userName = user?.display_name || user?.username || '我';
  const userAvatarUrl = resolveAiAvatarUrl(user?.avatar_image?.url);
  const messageTime = formatMessageTime(message.created_at);
  const displayParts = operationResultDisplayParts(message.parts);
  const hasRenderableParts = displayParts.some((part) => {
    if (part.type === 'text') return Boolean(part.text?.trim());
    if (part.type === 'run_activity') return Boolean(part.activity);
    if (part.type === 'image') return Boolean(part.image);
    if (part.type === 'error_recovery') return Boolean(part.card || part.text?.trim());
    return Boolean(part.card || part.approval || part.draft || part.request);
  });
  const isGeneratingDraft = !isUser && message.status === 'running' && runEvents.some(isDraftToolEvent) && !hasDraftOutcome(message);
  const hasPendingApprovalPart = message.parts.some(isPendingApprovalPart);
  const hasPendingHumanInputRequest = message.parts.some(isPendingHumanInputPart);
  const hasPendingInteractivePart = hasPendingApprovalPart || (hasPendingHumanInputRequest && !isThinking);
  const hasSpecificProgressCue = hasActiveRunEvent(runEvents) || isGeneratingDraft || hasPendingInteractivePart;
  const shouldShowThinking =
    !isUser
    && !hasSpecificProgressCue
    && isThinking;
  const runEventEntries = !isUser ? toRunEventEntries(runEvents) : [];
  const timelineItems = createMessageTimelineItems(displayParts, runEventEntries);
  const firstPendingApprovalId = displayParts.find((part) => part.approval?.status === 'pending')?.approval?.id ?? null;
  const fallbackCode = isUser ? null : modelUsageFallbackCodeFromMessageMetadata(message.metadata);

  const [messageCopied, setMessageCopied] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);
  const showFooter = isMessageFooterReady(message, isAssistantResponseActive, runEvents);

  const copyMessageText = async () => {
    const textContent = displayParts
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

  const canOpenRunDebug = !isUser && Boolean(message.run_id && onOpenRunDebug);
  const showActions = showFooter && !isUser && (hasRenderableParts || canOpenRunDebug);

  return (
    <article className={`ai-message ai-message-${message.role}`}>
      <div className={isUser ? 'ai-message-avatar ai-message-avatar-user' : 'ai-message-avatar ai-message-avatar-assistant'} aria-hidden="true">
        {isUser ? (
          userAvatarUrl ? (
            <MediaWithPlaceholder
              className="ai-user-avatar-image"
              src={userAvatarUrl}
              alt=""
              showLabel={false}
              ariaHidden
            />
          ) : (
            <span className="ai-user-avatar-fallback" style={{ backgroundColor: avatarColor(user?.avatar_seed || userName) }}>
              {initials(userName)}
            </span>
          )
        ) : (
          <img
            className="ai-bot-avatar-image"
            src="/assets/chatbot.webp"
            alt=""
          />
        )}
      </div>
      <div className="ai-message-content">
        <div className="ai-message-role">{isUser ? userName : 'AI 厨房助手'}</div>
        <div className="ai-message-body">
          {fallbackCode ? <ModelUsageDegradationNotice capability="llm" code={fallbackCode} /> : null}
          {timelineItems.map((item) => {
            if (item.type === 'activity') {
              return <RunActivityInline key={item.key} entries={[item.entry]} isLive={isUnfinishedAssistantMessage(message)} includeCompletedSkill />;
            }
            if (item.type === 'text') {
              return (
                <div key={item.key} className="ai-message-text-block">
                  <Suspense fallback={<p>{item.text}</p>}>
                    <MarkdownMessage text={item.text} />
                  </Suspense>
                </div>
              );
            }
            const { part } = item;
            if (part.type === 'image' && part.image) {
              return (
                <div key={item.key} className="ai-message-part ai-message-image-part">
                  <AiMessageImageGrid images={[part.image as AiMessageImagePartData]} />
                </div>
              );
            }
            if (part.type === 'error_recovery' && !part.card) {
              const upgradeText = part.text?.trim() || '当前版本暂不支持新的做菜确认，请刷新后再试。原草稿已安全保留。';
              return (
                <div key={item.key} className="ai-message-part ai-error-recovery-part" role="status">
                  <div className="ai-recipe-danger-impact">
                    <strong>需要更新后继续</strong>
                    <p className="ai-approval-compare-copy">{upgradeText}</p>
                  </div>
                </div>
              );
            }
            if ((part.type === 'result_card' || part.type === 'error_recovery') && part.card) {
              return (
                <div key={item.key} className="ai-message-part">
                  <ResultCard
                    card={part.card}
                    conversationId={message.conversation_id}
                    onAddToPlan={(item, card) => onAddRecommendationToPlan?.(item, card, message.id, part.id)}
                    onInventoryAction={(item, action, card) => onInventoryAction?.(item, action, card, message.id, part.id)}
                    isInventoryActionPending={isInventoryActionPending}
                    onPromptAction={onPromptAction}
                    onProductLoopPrompt={onProductLoopPrompt}
                    isPromptActionPending={isPromptActionPending}
                    onNavigate={onNavigate}
                    onResultCard={(card) => replaceResultCard?.(card, message.id, part.id)}
                  />
                </div>
              );
            }
            if (part.type === 'approval_request' && part.approval) {
              const isPendingApproval = part.approval.status === 'pending';
              const isSubmittingThisApproval = isPendingApproval && part.approval.id === submittingApprovalId;
              const isApprovalResumeReady =
                message.status !== 'pending'
                && message.status !== 'running'
                && (
                  !part.approval.run_id
                  || part.approval.run_id !== activeStreamRunId
                  || isSubmittingThisApproval
                );
              const canSubmitApproval =
                isLatestAssistant
                && isPendingApproval
                && part.approval.id === firstPendingApprovalId
                && isApprovalResumeReady;
              const submitDisabledReason = isPendingApproval && part.approval.id !== firstPendingApprovalId
                  ? '请先完成上一个草稿的确认，再处理这一项。'
                  : isPendingApproval && !isApprovalResumeReady
                    ? '确认功能暂时不可用，请稍后再试。'
                  : !isLatestAssistant && isPendingApproval
                    ? '请先处理最新的待确认草稿。'
                    : undefined;
              return (
                <AiApprovalHost key={item.key} open busy={isSubmittingThisApproval}>
                <ApprovalPanel
                  approval={part.approval}
                  foods={foods}
                  ingredients={ingredients}
                  resourceOptionLoader={resourceOptionLoader}
                  onDecision={onApprovalDecision}
                  isLatest={isLatestAssistant}
                  canSubmit={canSubmitApproval || !isPendingApproval}
                  submitDisabledReason={submitDisabledReason}
                />
                </AiApprovalHost>
              );
            }
            if (part.type === 'human_input_request' && part.request) {
              const isPendingHumanInput = isPendingHumanInputPart(part);
              const isCancelledHumanInput = part.status === 'cancelled';
              return (
                <AiHumanInputHost key={item.key} open>
                <HumanInputRequestPanel
                  message={message}
                  request={part.request}
                  response={part.response}
                  isLatest={isLatestAssistant && isPendingHumanInput}
                  isPending={isPendingHumanInput}
                  isCancelled={isCancelledHumanInput}
                  onResponse={onHumanInputResponse}
                />
                </AiHumanInputHost>
              );
            }
            return <AiMessagePartRenderer key={item.key} part={part as unknown as NormalizedAiMessagePart} />;
          })}
          {shouldShowThinking && (
            <div className="ai-thinking-cue" aria-live="polite">
              <span>正在思考</span>
              <i aria-hidden="true" />
              <i aria-hidden="true" />
              <i aria-hidden="true" />
            </div>
          )}
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
                <strong>正在准备待确认草稿</strong>
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
                  {canOpenRunDebug && message.run_id ? (
                    <button
                      className="ai-message-action-btn ai-message-debug-btn"
                      title="查看调试信息"
                      aria-label="查看调试信息"
                      type="button"
                      onClick={() => onOpenRunDebug?.(message.run_id as string)}
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="m8 10 3 2.5L8 15"></path><path d="M13 15h4"></path></svg>
                    </button>
                  ) : null}
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
