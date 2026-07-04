import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from 'react';
import { useVoiceRecorder } from '../../hooks/useVoiceRecorder';
import type { VoiceRecording } from '../../hooks/useVoiceRecorder';
import { useVoiceTranscription } from '../../hooks/useVoiceTranscription';
import type { AiVoiceSurface } from '../../api/aiVoiceApi';

type AiVoiceInputButtonProps = {
  surface: AiVoiceSurface;
  disabled?: boolean;
  className?: string;
  onTranscript: (text: string, context?: { interaction: VoiceInputInteraction }) => void;
  onStartRecording?: () => void;
  onRecording?: (recording: VoiceRecording) => void | Promise<void>;
  recordingFormat?: 'media' | 'pcm16';
  autoStartToken?: number;
  silenceStopMs?: number;
  interactionMode?: 'toggle' | 'hold';
  buttonRef?: RefObject<HTMLButtonElement>;
  enableHoldToSend?: boolean;
  onStateChange?: (state: { status: VoiceInputStatus; interaction: VoiceInputInteraction | null }) => void;
};

type VoiceInputInteraction = 'tap' | 'hold';
type VoiceInputStatus = 'idle' | 'recording' | 'recognizing';

const HOLD_TO_SEND_THRESHOLD_MS = 220;

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function AiVoiceInputButton({
  surface,
  disabled = false,
  className = '',
  onTranscript,
  onStartRecording,
  onRecording,
  recordingFormat = 'media',
  autoStartToken = 0,
  silenceStopMs,
  interactionMode = 'toggle',
  buttonRef,
  enableHoldToSend = false,
  onStateChange,
}: AiVoiceInputButtonProps) {
  const lastAutoStartTokenRef = useRef(0);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const pendingHoldStopRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const recordingInteractionRef = useRef<VoiceInputInteraction | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [recordingInteraction, setRecordingInteraction] = useState<VoiceInputInteraction | null>(null);
  const [isHoldArming, setIsHoldArming] = useState(false);
  const transcription = useVoiceTranscription();
  const handleRecordingComplete = useCallback(async (recording: VoiceRecording, interaction: VoiceInputInteraction = recordingInteractionRef.current ?? 'tap') => {
    if (onRecording) {
      await onRecording(recording);
      return;
    }
    const transcript = await transcription.transcribe({ blob: recording.blob, surface });
    if (transcript) onTranscript(transcript, { interaction });
  }, [onRecording, onTranscript, surface, transcription]);
  const recorder = useVoiceRecorder({
    format: recordingFormat,
    silenceStopMs,
    onAutoStop: (recording) => {
      void handleRecordingComplete(recording);
    },
  });
  const isBusy = recorder.isBusy || transcription.isTranscribing;
  const isActive = recorder.isRecording;
  const isRecognizing = transcription.isTranscribing || recorder.status === 'stopping';
  const isPreparing = Boolean(recordingInteraction) && !isActive && !isRecognizing && recorder.status !== 'error';
  const isStarting = recorder.status === 'requesting_permission';
  const inputStatus: VoiceInputStatus = isActive ? 'recording' : isRecognizing ? 'recognizing' : 'idle';

  const displayLevels = useMemo(() => {
    const result: number[] = [];
    for (const level of recorder.waveformLevels) {
      result.push(level, level);
    }
    return result;
  }, [recorder.waveformLevels]);

  const beginRecording = useCallback((interaction: VoiceInputInteraction) => {
    recordingInteractionRef.current = interaction;
    setRecordingInteraction(interaction);
    onStartRecording?.();
    void recorder.start()
      .then((started) => {
        if (started) return;
        pendingHoldStopRef.current = false;
        longPressTriggeredRef.current = false;
        recordingInteractionRef.current = null;
        setRecordingInteraction(null);
        setIsHoldArming(false);
      })
      .catch(() => {
        pendingHoldStopRef.current = false;
        longPressTriggeredRef.current = false;
        recordingInteractionRef.current = null;
        setRecordingInteraction(null);
        setIsHoldArming(false);
      });
  }, [onStartRecording, recorder]);

  const handleClick = useCallback(async () => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    if (interactionMode === 'hold') return;
    if (disabled || isBusy) return;
    if (!recorder.isRecording) {
      beginRecording('tap');
      return;
    }
    const recording = await recorder.stop();
    if (!recording) return;
    await handleRecordingComplete(recording, recordingInteractionRef.current ?? 'tap');
  }, [beginRecording, disabled, handleRecordingComplete, interactionMode, isBusy, recorder]);

  const title = isPreparing ? '准备听你说话' : recorder.isRecording ? '停止录音' : transcription.isTranscribing ? '正在识别' : '语音输入';
  const error = recorder.error || transcription.error;

  const stopRecording = useCallback(async () => {
    const recording = await recorder.stop();
    if (!recording) return;
    await handleRecordingComplete(recording, recordingInteractionRef.current ?? 'tap');
  }, [handleRecordingComplete, recorder]);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (disabled || isBusy || recorder.isRecording) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    suppressNextClickRef.current = true;
    longPressTriggeredRef.current = false;
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    if (interactionMode === 'hold') {
      event.preventDefault();
      setIsHoldArming(true);
      beginRecording('hold');
      return;
    }
    if (enableHoldToSend) {
      setIsHoldArming(true);
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        longPressTriggeredRef.current = true;
        recordingInteractionRef.current = 'hold';
        setRecordingInteraction('hold');
        setIsHoldArming(false);
      }, HOLD_TO_SEND_THRESHOLD_MS);
    }
    beginRecording('tap');
  }, [beginRecording, disabled, enableHoldToSend, interactionMode, isBusy, recorder]);

  const handlePointerEnd = useCallback(async (event: PointerEvent<HTMLButtonElement>) => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    setIsHoldArming(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (interactionMode !== 'hold' && !longPressTriggeredRef.current) return;
    event.preventDefault();
    suppressNextClickRef.current = true;
    if (!recorder.isRecording) {
      pendingHoldStopRef.current = true;
      return;
    }
    await stopRecording();
  }, [interactionMode, recorder.isRecording, stopRecording]);

  useEffect(() => {
    if (!autoStartToken || lastAutoStartTokenRef.current === autoStartToken) return;
    if (disabled || isBusy || recorder.isRecording) return;
    lastAutoStartTokenRef.current = autoStartToken;
    beginRecording('tap');
  }, [autoStartToken, beginRecording, disabled, isBusy, recorder]);

  useEffect(() => {
    if (inputStatus === 'idle') {
      recordingInteractionRef.current = null;
      setRecordingInteraction(null);
      longPressTriggeredRef.current = false;
      pendingHoldStopRef.current = false;
      setIsHoldArming(false);
    }
    onStateChange?.({ status: inputStatus, interaction: recordingInteractionRef.current });
  }, [inputStatus, onStateChange]);

  useEffect(() => () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!recorder.isRecording || !pendingHoldStopRef.current) return;
    pendingHoldStopRef.current = false;
    void stopRecording();
  }, [recorder.isRecording, stopRecording]);

  useEffect(() => {
    if (!recorder.isRecording) {
      setElapsedSeconds(0);
      return undefined;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
    return () => window.clearInterval(timer);
  }, [recorder.isRecording]);

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`ai-voice-input-button ${isPreparing ? 'preparing' : ''} ${isActive ? 'recording' : ''} ${recordingInteraction === 'hold' ? 'hold-recording' : ''} ${isHoldArming ? 'hold-arming' : ''} ${isStarting ? 'starting' : ''} ${isRecognizing ? 'recognizing' : ''} ${isBusy ? 'busy' : ''} ${className}`.trim()}
      disabled={disabled}
      aria-busy={isBusy || isPreparing || undefined}
      title={error || title}
      aria-label={error || title}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      <span className="ai-voice-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <path d="M12 18v3" />
        </svg>
      </span>
      <span className="ai-voice-recording-ui" aria-hidden="true">
        <span className="ai-voice-stop-mark" />
        <span className="ai-voice-waveform">
          {displayLevels.map((level, index) => (
            <i
              key={index}
              style={{
                height: `${Math.round(5 + level * 27)}px`,
                opacity: Math.min(0.96, 0.24 + level * 0.76),
              } satisfies CSSProperties}
            />
          ))}
        </span>
        <span className="ai-voice-timer">{formatElapsed(elapsedSeconds)}</span>
      </span>
      <span className="ai-voice-processing-ui" aria-hidden="true">
        <span className="ai-voice-spinner" />
        <span>正在识别</span>
      </span>
      <span className="ai-voice-preparing-ui" aria-hidden="true">
        <span className="ai-voice-listening-dot" />
        <span>准备听</span>
      </span>
      <span className="ai-voice-press-label">{transcription.isTranscribing ? '识别中' : '按住说话'}</span>
    </button>
  );
}
