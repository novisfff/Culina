import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { aiVoiceApi, type CookingRealtimeSessionResponse } from '../../api/aiVoiceApi';
import type { VoiceRecording } from '../../hooks/useVoiceRecorder';

export type CookingRealtimeVoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'recording'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'muted'
  | 'closed'
  | 'failed';

type StartSessionArgs = {
  recipeId: string;
  cookSessionId: string;
  sessionRevision: number;
  subject: Record<string, unknown>;
};

type CookingRealtimeVoiceSessionOptions = {
  onAssistantDelta?: (text: string) => void;
  onAssistantDone?: (text: string) => void;
  onAssistantAudio?: (audio: Blob) => void;
  onAssistantAudioStart?: (event: { content_type: string; sample_rate: number; channels: number }) => void;
  onAssistantAudioDelta?: (event: { audio: string; sequence: number }) => void;
  onAssistantAudioDone?: (event: { sequence: number }) => void;
  onAssistantAudioError?: (message: string) => void;
  onAssistantAudioTrace?: (event: { stage: string; elapsed_ms?: number; [key: string]: unknown }) => void;
  onVoiceTrace?: (event: { stage: string; details?: Record<string, unknown> }) => void;
  onUserTranscriptDelta?: (text: string) => void;
  onUserTranscriptDone?: (text: string) => void;
  onUiActions?: (card: unknown) => void;
  onError?: (message: string) => void;
};

type PendingTurnCancellation = {
  turnId: string;
  mode: 'cancel' | 'hangup';
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: number;
};

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error ?? new Error('语音读取失败'));
    reader.readAsDataURL(blob);
  });
}

export function isCookingRealtimeVoiceMicDisabled(status: CookingRealtimeVoiceStatus, disabled = false) {
  return disabled || status === 'connecting' || status === 'muted' || status === 'closed' || status === 'failed';
}

export function useCookingRealtimeVoiceSession(options: CookingRealtimeVoiceSessionOptions = {}) {
  const [status, setStatus] = useState<CookingRealtimeVoiceStatus>('idle');
  const [session, setSession] = useState<CookingRealtimeSessionResponse | null>(null);
  const [error, setError] = useState('');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [lastTranscript, setLastTranscript] = useState('');
  const [listenCycle, setListenCycle] = useState(0);
  const timerRef = useRef<number | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const activeTurnIdRef = useRef('');
  const turnCounterRef = useRef(0);
  const pendingTurnCancellationRef = useRef<PendingTurnCancellation | null>(null);

  const settlePendingTurnCancellation = useCallback((error?: Error) => {
    const pending = pendingTurnCancellationRef.current;
    if (!pending) return;
    pendingTurnCancellationRef.current = null;
    window.clearTimeout(pending.timeoutId);
    if (error) {
      pending.reject(error);
    } else {
      pending.resolve();
    }
  }, []);

  const waitForTurnCancellation = useCallback((turnId: string, mode: 'cancel' | 'hangup') => {
    const existing = pendingTurnCancellationRef.current;
    if (existing && existing.turnId === turnId && existing.mode === mode) {
      return existing.promise;
    }
    if (existing) {
      settlePendingTurnCancellation(new Error('上一条语音取消请求已被替换'));
    }
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timeoutId = window.setTimeout(() => {
      const pending = pendingTurnCancellationRef.current;
      if (!pending || pending.promise !== promise) return;
      const timeoutError = new Error('小灶停止确认超时，请稍后重试');
      setError(timeoutError.message);
      options.onError?.(timeoutError.message);
      settlePendingTurnCancellation(timeoutError);
    }, 5000);
    pendingTurnCancellationRef.current = {
      turnId,
      mode,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timeoutId,
    };
    return promise;
  }, [options, settlePendingTurnCancellation]);

  const nextTurnId = useCallback(() => {
    turnCounterRef.current += 1;
    const turnId = `voice_turn-${Date.now()}-${turnCounterRef.current}`;
    activeTurnIdRef.current = turnId;
    return turnId;
  }, []);

  const belongsToActiveTurn = useCallback((message: { turn_id?: unknown }) => {
    const turnId = typeof message.turn_id === 'string' ? message.turn_id : '';
    return !turnId || !activeTurnIdRef.current || turnId === activeTurnIdRef.current;
  }, []);

  useEffect(() => {
    if (startedAt === null) return undefined;
    timerRef.current = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [startedAt]);

  const start = useCallback(async (args: StartSessionArgs) => {
    setStatus('connecting');
    setError('');
    socketRef.current?.close();
    socketRef.current = null;
    try {
      const nextSession = await aiVoiceApi.createCookingRealtimeSession({
        recipe_id: args.recipeId,
        cook_session_id: args.cookSessionId,
        session_revision: args.sessionRevision,
        subject: args.subject,
      });
      setSession(nextSession);
      setStartedAt(Date.now());
      setElapsedSeconds(0);
      const socket = new WebSocket(aiVoiceApi.cookingRealtimeWebSocketUrl(nextSession.websocket_url));
      socketRef.current = socket;
      socket.onopen = () => {
        setStatus('listening');
        setListenCycle((current) => current + 1);
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (!belongsToActiveTurn(message)) {
            return;
          }
          if (message.type === 'turn_cancelled' || message.type === 'turn_cancel_requested') {
            const pending = pendingTurnCancellationRef.current;
            const turnId = typeof message.turn_id === 'string' ? message.turn_id : '';
            if (pending && pending.turnId === turnId) {
              const mode = pending.mode;
              settlePendingTurnCancellation();
              activeTurnIdRef.current = '';
              if (mode === 'cancel') {
                setStatus('listening');
                setListenCycle((current) => current + 1);
              }
            }
          }
          if (message.type === 'status' && typeof message.status === 'string') {
            setStatus(message.status as CookingRealtimeVoiceStatus);
            if (message.status === 'closed' && pendingTurnCancellationRef.current?.mode === 'hangup') {
              settlePendingTurnCancellation();
            }
            if (message.status === 'listening') {
              setListenCycle((current) => current + 1);
            }
          }
          if (message.type === 'user_transcript_delta' && typeof message.text === 'string') {
            setLastTranscript((current) => `${current}${message.text}`);
            options.onUserTranscriptDelta?.(message.text);
          }
          if (message.type === 'user_transcript_done' && typeof message.text === 'string') {
            setLastTranscript(message.text);
            options.onUserTranscriptDone?.(message.text);
          }
          if (message.type === 'assistant_transcript_delta' && typeof message.text === 'string') {
            options.onAssistantDelta?.(message.text);
          }
          if (message.type === 'assistant_transcript_done' && typeof message.text === 'string') {
            options.onAssistantDone?.(message.text);
          }
          if (message.type === 'assistant_audio_done' && typeof message.audio === 'string') {
            const contentType = typeof message.content_type === 'string' ? message.content_type : 'audio/mpeg';
            const bytes = Uint8Array.from(atob(message.audio), (char) => char.charCodeAt(0));
            options.onAssistantAudio?.(new Blob([bytes], { type: contentType }));
          }
          if (message.type === 'assistant_audio_start') {
            setStatus('speaking');
            options.onAssistantAudioStart?.({
              content_type: typeof message.content_type === 'string' ? message.content_type : 'audio/pcm',
              sample_rate: typeof message.sample_rate === 'number' ? message.sample_rate : 24000,
              channels: typeof message.channels === 'number' ? message.channels : 1,
            });
          }
          if (message.type === 'assistant_audio_delta' && typeof message.audio === 'string') {
            options.onAssistantAudioDelta?.({
              audio: message.audio,
              sequence: typeof message.sequence === 'number' ? message.sequence : 0,
            });
          }
          if (message.type === 'assistant_audio_done' && typeof message.audio !== 'string') {
            options.onAssistantAudioDone?.({
              sequence: typeof message.sequence === 'number' ? message.sequence : 0,
            });
          }
          if (message.type === 'assistant_audio_error' && typeof message.message === 'string') {
            options.onAssistantAudioError?.(message.message);
          }
          if (message.type === 'assistant_audio_trace' && typeof message.stage === 'string') {
            options.onAssistantAudioTrace?.(message);
          }
          if (message.type === 'ui_actions' && message.card) {
            options.onUiActions?.(message.card);
          }
          if (message.type === 'error' && typeof message.message === 'string') {
            setError(message.message);
            options.onError?.(message.message);
          }
        } catch {
          setError('小灶通话消息解析失败');
          options.onError?.('小灶通话消息解析失败');
        }
      };
      socket.onerror = () => {
        const connectionError = new Error('小灶通话连接失败');
        settlePendingTurnCancellation(connectionError);
        setError(connectionError.message);
        setStatus('failed');
        options.onError?.(connectionError.message);
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        const pending = pendingTurnCancellationRef.current;
        if (pending?.mode === 'hangup') {
          settlePendingTurnCancellation();
        } else if (pending) {
          settlePendingTurnCancellation(new Error('小灶通话已断开，停止状态未确认'));
        }
        setStatus((current) => (current === 'failed' || current === 'closed' ? current : 'closed'));
      };
      return nextSession;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '小灶通话连接失败');
      setStatus('failed');
      return null;
    }
  }, [belongsToActiveTurn, options, settlePendingTurnCancellation]);

  const closeLocalSession = useCallback((socket: WebSocket | null) => {
    socket?.close();
    if (socketRef.current === socket) {
      socketRef.current = null;
    }
    setStatus('closed');
    setSession(null);
    setStartedAt(null);
    setElapsedSeconds(0);
    setLastTranscript('');
    setListenCycle(0);
    activeTurnIdRef.current = '';
  }, []);

  const cancelTurn = useCallback(async () => {
    const socket = socketRef.current;
    const turnId = activeTurnIdRef.current;
    if (!turnId || socket?.readyState !== WebSocket.OPEN) return;
    setError('');
    const acknowledgement = waitForTurnCancellation(turnId, 'cancel');
    socket.send(JSON.stringify({ type: 'cancel_turn', turn_id: turnId }));
    try {
      await acknowledgement;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '小灶停止失败');
    }
  }, [waitForTurnCancellation]);

  const hangup = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      closeLocalSession(socket);
      return;
    }
    const turnId = activeTurnIdRef.current;
    setError('');
    const acknowledgement = waitForTurnCancellation(turnId, 'hangup');
    socket.send(JSON.stringify({ type: 'hangup', turn_id: turnId }));
    try {
      await acknowledgement;
      closeLocalSession(socket);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '小灶停止失败');
    }
  }, [closeLocalSession, waitForTurnCancellation]);
  const toggleMute = useCallback(() => {
    setStatus((current) => {
      if (current === 'muted') {
        setListenCycle((cycle) => cycle + 1);
        return 'listening';
      }
      return 'muted';
    });
  }, []);

  const markListening = useCallback(() => {
    setStatus('listening');
    setListenCycle((current) => current + 1);
  }, []);
  const markSpeaking = useCallback(() => setStatus('speaking'), []);
  const updateTranscript = useCallback((text: string) => {
    setLastTranscript(text);
    setStatus('speaking');
  }, []);
  const sendTranscript = useCallback((text: string) => {
    const transcript = text.trim();
    if (!transcript) return;
    const turnId = nextTurnId();
    setLastTranscript(transcript);
    setStatus('thinking');
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'user_transcript_done', text: transcript, turn_id: turnId }));
    }
  }, [nextTurnId]);
  const sendRecording = useCallback(async (recording: VoiceRecording) => {
    if (status === 'muted') return;
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setError('小灶通话还没有连接好');
      options.onError?.('小灶通话还没有连接好');
      return;
    }
    const turnId = nextTurnId();
    setLastTranscript('');
    setStatus('transcribing');
    options.onVoiceTrace?.({
      stage: 'frontend_recording_done',
      details: {
        turn_id: turnId,
        duration_ms: recording.durationMs,
        bytes: recording.blob.size,
        mime_type: recording.mimeType,
      },
    });
    const dataUrl = await blobToDataUrl(recording.blob);
    socketRef.current.send(JSON.stringify({
      type: 'audio_chunk_done',
      turn_id: turnId,
      data: dataUrl,
      mime_type: recording.mimeType,
      duration_ms: recording.durationMs,
      sample_rate: 16000,
      filename: recording.mimeType.includes('mp4') ? 'voice.mp4' : 'voice.webm',
    }));
    options.onVoiceTrace?.({
      stage: 'frontend_audio_sent',
      details: {
        turn_id: turnId,
        duration_ms: recording.durationMs,
        bytes: recording.blob.size,
        mime_type: recording.mimeType,
      },
    });
  }, [nextTurnId, options, status]);

  useEffect(() => () => {
    settlePendingTurnCancellation();
    socketRef.current?.close();
    socketRef.current = null;
    activeTurnIdRef.current = '';
  }, [settlePendingTurnCancellation]);

  const formattedElapsed = useMemo(() => {
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }, [elapsedSeconds]);

  return {
    status,
    session,
    error,
    elapsedSeconds,
    formattedElapsed,
    lastTranscript,
    listenCycle,
    isActive: status !== 'idle' && status !== 'closed' && status !== 'failed',
    start,
    hangup,
    cancelTurn,
    toggleMute,
    markListening,
    markSpeaking,
    updateTranscript,
    sendTranscript,
    sendRecording,
  };
}
