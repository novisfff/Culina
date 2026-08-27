import { DashboardIcon, type DashboardIconName } from '../../app/shellIcons';
import { isApiError } from '../../api/request';

export type ModelUsageNoticeCapability =
  | 'rerank'
  | 'stt'
  | 'tts'
  | 'image_generation'
  | 'llm'
  | 'realtime_audio'
  | 'ledger';

type ModelUsageOnsiteOption = {
  tone: 'warning' | 'danger';
  message: string;
  icon: DashboardIconName;
};

type Props = {
  code: string | null | undefined;
  capability: ModelUsageNoticeCapability;
  className?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUsageLimitCode(code: string | null | undefined) {
  return code === 'model_usage_budget_exceeded' || code === 'model_usage_capability_limit_exceeded';
}

export function modelUsageErrorCodeFromReason(reason: unknown): string | null {
  if (!isApiError(reason) || !isRecord(reason.payload)) return null;
  const detail = reason.payload.detail;
  if (!isRecord(detail) || typeof detail.code !== 'string') return null;
  return detail.code.startsWith('model_usage_') ? detail.code : null;
}

export function modelUsageFallbackCodeFromMessageMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const fallback = metadata?.modelUsageFallback;
  if (!isRecord(fallback) || fallback.used !== true || typeof fallback.reasonCode !== 'string') return null;
  return fallback.reasonCode.startsWith('model_usage_') ? fallback.reasonCode : null;
}

export function onsiteModelUsageOption(
  code: string | null | undefined,
  capability: ModelUsageNoticeCapability,
): ModelUsageOnsiteOption | null {
  if (code === 'model_usage_ledger_unavailable') {
    return {
      tone: 'danger',
      icon: 'shield',
      message: '模型服务暂时不可用，请稍后再试。',
    };
  }
  if (!isUsageLimitCode(code)) return null;

  const optionByCapability: Record<ModelUsageNoticeCapability, ModelUsageOnsiteOption> = {
    rerank: {
      tone: 'warning',
      icon: 'list',
      message: '搜索排序额度达到限制，本次已改用基础排序。',
    },
    stt: {
      tone: 'warning',
      icon: 'speaker-off',
      message: '语音转文字额度达到限制，可以直接输入文字继续。',
    },
    tts: {
      tone: 'warning',
      icon: 'speaker-off',
      message: '语音播报额度达到限制，文字回复仍可继续阅读。',
    },
    image_generation: {
      tone: 'warning',
      icon: 'receipt',
      message: '图片生成额度达到限制，本次未请求模型服务。',
    },
    llm: {
      tone: 'warning',
      icon: 'shield',
      message: '当前模型额度受限，已切换到可用模型继续完成回复。',
    },
    realtime_audio: {
      tone: 'warning',
      icon: 'speaker-off',
      message: '语音额度已达到限制，本次会话已结束；可以继续使用文字。',
    },
    ledger: {
      tone: 'danger',
      icon: 'shield',
      message: '模型服务暂时不可用，请稍后再试。',
    },
  };
  return optionByCapability[capability];
}

export function hasOnsiteModelUsageOption(
  code: string | null | undefined,
  capability: ModelUsageNoticeCapability,
) {
  return onsiteModelUsageOption(code, capability) !== null;
}

export function ModelUsageDegradationNotice({ code, capability, className = '' }: Props) {
  const option = onsiteModelUsageOption(code, capability);
  if (!option) return null;
  const classes = ['model-usage-degradation', `tone-${option.tone}`, className].filter(Boolean).join(' ');

  return (
    <div className={classes} role="status" aria-live="polite">
      <DashboardIcon name={option.icon} />
      <span>{option.message}</span>
    </div>
  );
}
