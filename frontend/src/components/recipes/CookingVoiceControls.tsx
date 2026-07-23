import { AiVoiceInputButton } from '../ai/AiVoiceInputButton';
import type { VoiceRecording } from '../../hooks/useVoiceRecorder';
import { isCookingRealtimeVoiceMicDisabled, type CookingRealtimeVoiceStatus } from './useCookingRealtimeVoiceSession';

type CookingVoiceControlsProps = {
  active: boolean;
  status: CookingRealtimeVoiceStatus;
  elapsed: string;
  lastTranscript: string;
  error?: string;
  disabled?: boolean;
  autoStartToken?: number;
  silenceStopMs?: number;
  onStart: () => void;
  onHangup: () => void;
  onToggleMute: () => void;
  onTranscript: (text: string) => void;
  onRecording?: (recording: VoiceRecording) => void | Promise<void>;
  onStartRecording?: () => void;
};

const STATUS_LABELS: Record<CookingRealtimeVoiceStatus, string> = {
  idle: '未连接',
  connecting: '连接中',
  listening: '正在听',
  recording: '正在听',
  transcribing: '正在识别',
  thinking: '小灶在想',
  speaking: '小灶在说',
  stopping: '正在停止',
  muted: '已静音',
  closed: '已挂断',
  failed: '连接失败',
};

export function CookingVoiceControls({
  active,
  status,
  elapsed,
  lastTranscript,
  error,
  disabled = false,
  autoStartToken = 0,
  silenceStopMs,
  onStart,
  onHangup,
  onToggleMute,
  onTranscript,
  onRecording,
  onStartRecording,
}: CookingVoiceControlsProps) {
  const micDisabled = isCookingRealtimeVoiceMicDisabled(status, disabled);

  if (!active) {
    return (
      <button
        className="recipe-cook-ai-call-button"
        type="button"
        onClick={onStart}
        disabled={disabled}
        title="开始小灶通话"
      >
        小灶通话
      </button>
    );
  }

  return (
    <div className="recipe-cook-ai-call-bar" role="status" aria-live="polite">
      <div className="recipe-cook-ai-call-copy">
        <span>{STATUS_LABELS[status]}</span>
        <strong>{elapsed}</strong>
        <small>{error || (lastTranscript ? `识别到：${lastTranscript}` : '我会自动听你说完')}</small>
      </div>
      <AiVoiceInputButton
        surface="recipe_cook_page"
        className="recipe-cook-ai-call-mic"
        disabled={micDisabled}
        onStartRecording={onStartRecording}
        onTranscript={onTranscript}
        onRecording={onRecording}
        recordingFormat="pcm16"
        autoStartToken={autoStartToken}
        silenceStopMs={silenceStopMs}
      />
      <button
        className={`recipe-cook-ai-call-mute ${status === 'muted' ? 'active' : ''}`}
        type="button"
        onClick={onToggleMute}
        disabled={status === 'stopping'}
        title={status === 'muted' ? '取消静音' : '静音'}
      >
        {status === 'muted' ? '开麦' : '静音'}
      </button>
      <button
        className="recipe-cook-ai-call-end"
        type="button"
        onClick={onHangup}
        disabled={status === 'stopping'}
        aria-busy={status === 'stopping'}
        title="挂断"
      >
        {status === 'stopping' ? '停止中' : '挂断'}
      </button>
    </div>
  );
}
