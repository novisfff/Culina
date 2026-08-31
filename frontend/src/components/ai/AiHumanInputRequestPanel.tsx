import { useEffect, useState } from 'react';
import type { AiHumanInputRequest, AiHumanInputResponse, AiMessage } from '../../api/types';

export type AiHumanInputResponseSubmit = (
  message: AiMessage,
  request: AiHumanInputRequest,
  response: { selected_option_ids?: string[]; text?: string },
) => Promise<void>;

type PendingHumanInputOption = {
  id: string;
  label: string;
};

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

export function HumanInputRequestPanel({
  message,
  request,
  isLatest,
  isPending,
  isCancelled,
  response,
  onResponse,
}: {
  message: AiMessage;
  request: AiHumanInputRequest;
  isLatest: boolean;
  isPending: boolean;
  isCancelled: boolean;
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
  const isResolved = isCancelled || isAnswered || !isPending;
  const isInteractive = isLatest && isPending && !isResolved && Boolean(onResponse);
  const isDisabled = !isInteractive || isSubmitting;
  const answerSummary = isCancelled ? '' : submittedAnswerSummary || persistedAnswerSummary || (isResolved ? '已提交回答' : '');

  useEffect(() => {
    if (isCancelled) {
      setSelectedIds([]);
      setText('');
      setSubmittedAnswerSummary('');
      setIsSubmitting(false);
      setIsAnswered(false);
      setIsExpanded(false);
      setPendingOption(null);
      setError('');
      return;
    }
    if (!isPending) {
      setIsAnswered(true);
      setIsExpanded(false);
    }
  }, [isCancelled, isPending]);

  useEffect(() => {
    if (!response) return;
    setSelectedIds(response.selectedOptionIds ?? []);
    setText(response.text ?? '');
    setSubmittedAnswerSummary(persistedAnswerSummary);
  }, [persistedAnswerSummary, response]);

  const submitResponse = async ({ selectedOptionIds, answerText, summary }: {
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
      await onResponse(message, request, { selected_option_ids: selectedOptionIds, text: answerText || undefined });
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
    void submitResponse({ selectedOptionIds: [option.id], summary: option.label });
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
    void submitResponse({
      selectedOptionIds: [],
      answerText: manualText,
      summary: buildHumanInputAnswerSummary(request, [], text) || '已提交回答',
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
            <div className="ai-approval-title-row"><h3>{request.question}</h3></div>
            {request.reason ? <p>{request.reason}</p> : null}
            {isCancelled ? <p className="ai-human-input-cancelled-summary">这次处理已取消，回答未提交</p> : isResolved ? (
              <p className="ai-human-input-answer-summary"><span>回答</span><strong>{answerSummary}</strong></p>
            ) : null}
          </div>
          {isResolved ? (
            <div className="ai-approval-head-actions">
              <span className={`ai-approval-status ${isCancelled ? 'status-cancelled' : 'status-approved'}`}>{isCancelled ? '已取消' : '已提交'}</span>
              <span className={`ai-approval-toggle-icon ${isExpanded ? 'is-expanded' : ''}`} aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
              </span>
            </div>
          ) : null}
        </div>
        <div className="ai-approval-body-wrapper" aria-hidden={isResolved && !isExpanded}>
          <div className="ai-approval-body-content">
            {canChoose && request.options.length > 0 ? (
              <div className="ai-clarification-options">
                {request.options.map((option, index) => (
                  <button key={option.id} type="button" className={`ai-clarification-option ${selectedIds.includes(option.id) ? 'is-selected' : ''}`} onClick={() => handleChoiceClick({ id: option.id, label: option.label })} disabled={isDisabled}>
                    <span className="ai-clarification-option-index">{index + 1}</span>
                    <span><strong>{option.label}</strong>{option.description ? <p>{option.description}</p> : null}</span>
                  </button>
                ))}
                {canType ? (
                  <button type="button" className={`ai-clarification-option ai-clarification-option-manual ${isManualOpen ? 'is-selected' : ''}`} onClick={() => { if (!isDisabled) { setPendingOption(null); setIsManualOpen(true); setSelectedIds([]); } }} disabled={isDisabled}>
                    <span className="ai-clarification-option-index">{request.options.length + 1}</span>
                    <span><strong>手动输入</strong><p>自己补充希望 AI 处理的内容。</p></span>
                  </button>
                ) : null}
              </div>
            ) : null}
            {pendingOption ? (
              <div className="ai-human-input-switch-warning" role="alert">
                <div><strong>手动输入还没提交</strong><span>改选会清空刚写的内容，确认改为「{pendingOption.label}」吗？</span></div>
                <div>
                  <button className="ghost-button" type="button" onClick={() => setPendingOption(null)} disabled={isSubmitting}>继续手动输入</button>
                  <button className="solid-button" type="button" onClick={confirmPendingOption} disabled={isSubmitting}>改选此项</button>
                </div>
              </div>
            ) : null}
            {canType && isManualOpen ? (
              <div className="ai-human-input-manual-panel">
                <label className="ai-approval-comment-field">
                  <span>手动输入</span>
                  <textarea className="text-input" rows={3} value={text} disabled={isDisabled} onChange={(event) => { setText(event.target.value); setPendingOption(null); }} placeholder="告诉 AI 你希望怎么处理，AI 会按你的要求继续。" />
                </label>
                <div className="ai-approval-actions"><button className="solid-button ai-human-input-submit" type="button" onClick={submitManual} disabled={isDisabled || !hasManualAnswer}>{isSubmitting ? '正在提交…' : '提交回答'}</button></div>
              </div>
            ) : null}
            {error ? <p className="form-error">{error}</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
