import { lazy, Suspense, useEffect, useState } from 'react';
import type {
  AiHumanInputRequest,
  AiHumanInputResponse,
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
import { resolveAssetUrl } from '../../lib/assets';
import { avatarColor, initials } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ApprovalPanel } from './AiApprovalPanel';
import type { AiApprovalDecisionSubmit, AiResourceOptionLoader } from './AiApprovalPanel';
import { AiMessageImageGrid } from './AiMessageImageGrid';
import { ResultCard } from './AiResultCards';
import {
  extractRunActivitySkillName,
  isDraftRunActivityEvent,
  isPendingHumanInputPart,
  preferredRunActivityEvent,
  runActivityCollapseKey,
} from './aiWorkspaceHelpers';

export { ApprovalPanel } from './AiApprovalPanel';
export type { AiApprovalDecisionSubmit, AiResourceOptionLoader } from './AiApprovalPanel';
export type AiHumanInputResponseSubmit = (
  message: AiMessage,
  request: AiHumanInputRequest,
  response: { selected_option_ids?: string[]; text?: string },
) => Promise<void>;

const MarkdownMessage = lazy(() => import('./MarkdownMessage'));

function buildHumanInputAnswerSummary(request: AiHumanInputRequest, selectedIds: string[], text: string) {
  const selectedLabels = selectedIds
    .map((id) => request.options.find((option) => option.id === id)?.label)
    .filter((label): label is string => Boolean(label));
  const trimmedText = text.trim();
  return [...selectedLabels, trimmedText].join('；');
}

function humanInputResponseSummary(request: AiHumanInputRequest, response?: AiHumanInputResponse | null) {
  if (!response) return '';
  return response.summary?.trim() || buildHumanInputAnswerSummary(request, response.selectedOptionIds ?? [], response.text ?? '');
}

type PendingHumanInputOption = {
  id: string;
  label: string;
};

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
  return `调用技能：${skillName}`;
}

function extractScriptName(event: AiRunEvent) {
  const match = event.user_message.match(/脚本「(.+?)」/);
  if (match?.[1]) return match[1];
  return event.internal_code.replace(/^script\./, '') || event.user_message;
}

function runActivityScriptLabel(event: AiRunEvent) {
  const scriptName = extractScriptName(event);
  if (event.status === 'failed') return `脚本「${scriptName}」执行失败`;
  return `调用脚本「${scriptName}」`;
}

function normalizeToolMessage(message: string) {
  return message.replace(/执行完成$/, '').trim();
}

function runActivityToolLabel(event: AiRunEvent) {
  if (event.type === 'script') return runActivityScriptLabel(event);
  if (event.status === 'waiting') return `等待补充：${event.user_message}`;
  if (event.status === 'failed') return `执行失败：${event.user_message}`;
  if (isDraftToolEvent(event)) return event.user_message.startsWith('生成「') ? event.user_message : `生成「${event.user_message}」`;
  const message = normalizeToolMessage(event.user_message);
  return message.startsWith('调用「') ? message : `调用「${message}」`;
}

function runActivityKind(event: AiRunEvent): RunActivityItem['kind'] {
  if (event.type === 'skill') return 'skill';
  return isDraftToolEvent(event) ? 'draft' : 'tool';
}

function runActivityEventLabel(event: AiRunEvent) {
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

function hasDraftContent(message: AiMessage) {
  return message.parts.some((part) => Boolean(part.approval || part.draft));
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
    <section className="ai-run-activity" aria-label="AI 执行过程">
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
    return parts.flatMap((part, partIndex): MessageTimelineItem[] => {
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
  return timeline;
}

function HumanInputRequestPanel({
  message,
  request,
  isLatest,
  isPending,
  response,
  onResponse,
}: {
  message: AiMessage;
  request: AiHumanInputRequest;
  isLatest: boolean;
  isPending: boolean;
  response?: AiHumanInputResponse | null;
  onResponse?: AiHumanInputResponseSubmit;
}) {
  const persistedAnswerSummary = humanInputResponseSummary(request, response);
  const [selectedIds, setSelectedIds] = useState<string[]>(response?.selectedOptionIds ?? []);
  const [text, setText] = useState(response?.text ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAnswered, setIsAnswered] = useState(!isPending);
  const [isExpanded, setIsExpanded] = useState(isPending);
  const [isManualOpen, setIsManualOpen] = useState(request.inputMode === 'text' || (request.inputMode === 'choice_or_text' && request.options.length === 0));
  const [submittedAnswerSummary, setSubmittedAnswerSummary] = useState(persistedAnswerSummary);
  const [pendingOption, setPendingOption] = useState<PendingHumanInputOption | null>(null);
  const [error, setError] = useState('');
  const canChoose = request.inputMode === 'choice' || request.inputMode === 'choice_or_text';
  const canType = request.inputMode === 'text' || request.inputMode === 'choice_or_text';
  const manualText = text.trim();
  const hasManualAnswer = manualText.length > 0 || !request.required;
  const isResolved = isAnswered || !isPending;
  const isInteractive = isLatest && isPending && !isResolved && Boolean(onResponse);
  const isDisabled = !isInteractive || isSubmitting;
  const answerSummary = submittedAnswerSummary || persistedAnswerSummary || (isResolved ? '已提交回答' : '');

  useEffect(() => {
    if (!isPending) {
      setIsAnswered(true);
      setIsExpanded(false);
    }
  }, [isPending]);
  useEffect(() => {
    if (!response) return;
    setSelectedIds(response.selectedOptionIds ?? []);
    setText(response.text ?? '');
    setSubmittedAnswerSummary(persistedAnswerSummary);
  }, [persistedAnswerSummary, response]);

  const submitResponse = async ({
    selectedOptionIds,
    answerText,
    summary,
  }: {
    selectedOptionIds: string[];
    answerText?: string;
    summary: string;
  }) => {
    if (!onResponse || isDisabled) return;
    const previousSelectedIds = selectedIds;
    const previousSubmittedAnswerSummary = submittedAnswerSummary;
    const previousIsAnswered = isAnswered;
    const previousIsExpanded = isExpanded;
    const previousPendingOption = pendingOption;
    setError('');
    setIsSubmitting(true);
    setSelectedIds(selectedOptionIds);
    setSubmittedAnswerSummary(summary || '已提交回答');
    setIsAnswered(true);
    setIsExpanded(false);
    setPendingOption(null);
    try {
      await onResponse(message, request, {
        selected_option_ids: selectedOptionIds,
        text: answerText || undefined,
      });
    } catch (err) {
      setSelectedIds(previousSelectedIds);
      setSubmittedAnswerSummary(previousSubmittedAnswerSummary);
      setIsAnswered(previousIsAnswered);
      setIsExpanded(previousIsAnswered ? previousIsExpanded : true);
      setPendingOption(previousPendingOption);
      setError(err instanceof Error ? err.message : '提交失败，请稍后重试。');
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitChoice = (option: PendingHumanInputOption) => {
    void submitResponse({
      selectedOptionIds: [option.id],
      summary: option.label,
    });
  };

  const handleChoiceClick = (option: PendingHumanInputOption) => {
    if (isDisabled) return;
    if (isManualOpen && manualText.length > 0) {
      setPendingOption(option);
      return;
    }
    submitChoice(option);
  };

  const submitManual = () => {
    if (!hasManualAnswer || isDisabled) return;
    const summary = buildHumanInputAnswerSummary(request, [], text) || '已提交回答';
    void submitResponse({
      selectedOptionIds: [],
      answerText: manualText,
      summary,
    });
  };

  const confirmPendingOption = () => {
    if (!pendingOption) return;
    setText('');
    setIsManualOpen(false);
    submitChoice(pendingOption);
  };

  return (
    <div className={`ai-message-part ai-human-input-request${isResolved ? ' is-resolved' : ''}`}>
      <div className={`ai-approval-panel ${isResolved && !isExpanded ? 'is-collapsed is-human-input-resolved' : 'is-expanded'}`}>
        <div
          className="ai-approval-head"
          role={isResolved ? 'button' : undefined}
          tabIndex={isResolved ? 0 : undefined}
          aria-expanded={isResolved ? isExpanded : undefined}
          onClick={isResolved ? () => setIsExpanded((current) => !current) : undefined}
          onKeyDown={isResolved ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setIsExpanded((current) => !current);
            }
          } : undefined}
        >
          <div className="ai-approval-head-copy">
            <div className="ai-approval-title-row">
              <h3>{request.question}</h3>
            </div>
            {request.reason ? <p>{request.reason}</p> : null}
            {isResolved ? (
              <p className="ai-human-input-answer-summary">
                <span>回答</span>
                <strong>{answerSummary}</strong>
              </p>
            ) : null}
          </div>
          {isResolved ? (
            <div className="ai-approval-head-actions">
              <span className="ai-approval-status status-approved">已提交</span>
              <span className={`ai-approval-toggle-icon ${isExpanded ? 'is-expanded' : ''}`} aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </span>
            </div>
          ) : null}
        </div>
        <div className="ai-approval-body-wrapper" aria-hidden={isResolved && !isExpanded}>
          <div className="ai-approval-body-content">
            {canChoose && request.options.length > 0 ? (
              <div className="ai-clarification-options">
                {request.options.map((option, index) => {
                  const isSelected = selectedIds.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={`ai-clarification-option ${isSelected ? 'is-selected' : ''}`}
                      onClick={() => handleChoiceClick({ id: option.id, label: option.label })}
                      disabled={isDisabled}
                    >
                      <span className="ai-clarification-option-index">{index + 1}</span>
                      <span>
                        <strong>{option.label}</strong>
                        {option.description ? <p>{option.description}</p> : null}
                      </span>
                    </button>
                  );
                })}
                {canType ? (
                  <button
                    type="button"
                    className={`ai-clarification-option ai-clarification-option-manual ${isManualOpen ? 'is-selected' : ''}`}
                    onClick={() => {
                      if (isDisabled) return;
                      setPendingOption(null);
                      setIsManualOpen(true);
                      setSelectedIds([]);
                    }}
                    disabled={isDisabled}
                  >
                    <span className="ai-clarification-option-index">{request.options.length + 1}</span>
                    <span>
                      <strong>手动输入</strong>
                      <p>自己补充处理方式。</p>
                    </span>
                  </button>
                ) : null}
              </div>
            ) : null}
            {pendingOption ? (
              <div className="ai-human-input-switch-warning" role="alert">
                <div>
                  <strong>手动输入还没提交</strong>
                  <span>改选会清空刚写的内容，确认改为「{pendingOption.label}」吗？</span>
                </div>
                <div>
                  <button className="ghost-button" type="button" onClick={() => setPendingOption(null)} disabled={isSubmitting}>
                    继续手动输入
                  </button>
                  <button className="solid-button" type="button" onClick={confirmPendingOption} disabled={isSubmitting}>
                    改选此项
                  </button>
                </div>
              </div>
            ) : null}
            {canType && isManualOpen ? (
              <div className="ai-human-input-manual-panel">
                <label className="ai-approval-comment-field">
                  <span>手动输入</span>
                  <textarea
                    className="text-input"
                    rows={3}
                    value={text}
                    disabled={isDisabled}
                    onChange={(event) => {
                      setText(event.target.value);
                      setPendingOption(null);
                    }}
                    placeholder="写下你的处理方式，AI 会按这条继续。"
                  />
                </label>
                <div className="ai-approval-actions">
                  <button className="solid-button ai-human-input-submit" type="button" onClick={submitManual} disabled={isDisabled || !hasManualAnswer}>
                    {isSubmitting ? '提交中...' : '提交回答'}
                  </button>
                </div>
              </div>
            ) : null}
            {error ? <p className="form-error">{error}</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

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
}) {
  const isUser = message.role === 'user';
  const userName = user?.display_name || user?.username || '我';
  const userAvatarUrl = resolveAiAvatarUrl(user?.avatar_image?.url);
  const messageTime = formatMessageTime(message.created_at);
  const hasRenderableParts = message.parts.some((part) => {
    if (part.type === 'text') return Boolean(part.text?.trim());
    if (part.type === 'run_activity') return Boolean(part.activity);
    if (part.type === 'image') return Boolean(part.image);
    if (part.type === 'error_recovery') return Boolean(part.card || part.text?.trim());
    return Boolean(part.card || part.approval || part.draft || part.request);
  });
  const isGeneratingDraft = !isUser && message.status === 'running' && runEvents.some(isDraftToolEvent) && !hasDraftContent(message);
  const hasPendingApprovalPart = message.parts.some(isPendingApprovalPart);
  const hasPendingHumanInputRequest = message.parts.some(isPendingHumanInputPart);
  const hasPendingInteractivePart = hasPendingApprovalPart || (hasPendingHumanInputRequest && !isThinking);
  const hasSpecificProgressCue = hasActiveRunEvent(runEvents) || isGeneratingDraft || hasPendingInteractivePart;
  const shouldShowThinking =
    !isUser
    && !hasSpecificProgressCue
    && isThinking;
  const runEventEntries = !isUser ? toRunEventEntries(runEvents) : [];
  const timelineItems = createMessageTimelineItems(message.parts, runEventEntries);
  const firstPendingApprovalId = message.parts.find((part) => part.approval?.status === 'pending')?.approval?.id ?? null;

  const [messageCopied, setMessageCopied] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);
  const showFooter = isMessageFooterReady(message, isAssistantResponseActive, runEvents);

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
              const upgradeText = part.text?.trim() || '当前应用版本不支持新的做菜确认，请刷新并更新后继续。原草稿仍会安全保留。';
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
                    onAddToPlan={(item, card) => onAddRecommendationToPlan?.(item, card, message.id, part.id)}
                    onInventoryAction={(item, action, card) => onInventoryAction?.(item, action, card, message.id, part.id)}
                    isInventoryActionPending={isInventoryActionPending}
                    onPromptAction={onPromptAction}
                    onProductLoopPrompt={onProductLoopPrompt}
                    isPromptActionPending={isPromptActionPending}
                    onNavigate={onNavigate}
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
                  ? '请先处理上一个草稿，再确认这一项。'
                  : isPendingApproval && !isApprovalResumeReady
                    ? '确认入口正在准备，稍后即可确认。'
                  : !isLatestAssistant && isPendingApproval
                    ? '请先处理最新的待确认草稿。'
                    : undefined;
              return (
                <ApprovalPanel
                  key={item.key}
                  approval={part.approval}
                  foods={foods}
                  ingredients={ingredients}
                  resourceOptionLoader={resourceOptionLoader}
                  onDecision={onApprovalDecision}
                  isLatest={isLatestAssistant}
                  canSubmit={canSubmitApproval || !isPendingApproval}
                  submitDisabledReason={submitDisabledReason}
                />
              );
            }
            if (part.type === 'human_input_request' && part.request) {
              const isPendingHumanInput = isPendingHumanInputPart(part);
              return (
                <HumanInputRequestPanel
                  key={item.key}
                  message={message}
                  request={part.request}
                  response={part.response}
                  isLatest={isLatestAssistant && isPendingHumanInput}
                  isPending={isPendingHumanInput}
                  onResponse={onHumanInputResponse}
                />
              );
            }
            return null;
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
