import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { aiVoiceApi, type CookingRealtimeSessionResponse } from '../../api/aiVoiceApi';
import type { VoiceRecording } from '../../hooks/useVoiceRecorder';

export type CookingRealtimeVoiceStatus = 'idle' | 'connecting' | 'listening' | 'speaking' | 'muted' | 'closed' | 'failed';

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
  onUserTranscriptDelta?: (text: string) => void;
  onUserTranscriptDone?: (text: string) => void;
  onUiActions?: (card: unknown) => void;
  onError?: (message: string) => void;
};

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error ?? new Error('语音读取失败'));
    reader.readAsDataURL(blob);
  });
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
          if (message.type === 'status' && typeof message.status === 'string') {
            setStatus(message.status as CookingRealtimeVoiceStatus);
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
        setError('小灶通话连接失败');
        setStatus('failed');
        options.onError?.('小灶通话连接失败');
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        setStatus((current) => (current === 'failed' || current === 'closed' ? current : 'closed'));
      };
      return nextSession;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '小灶通话连接失败');
      setStatus('failed');
      return null;
    }
  }, [options]);

  const hangup = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'hangup' }));
    }
    socketRef.current?.close();
    socketRef.current = null;
    setStatus('closed');
    setSession(null);
    setStartedAt(null);
    setElapsedSeconds(0);
    setLastTranscript('');
    setListenCycle(0);
  }, []);
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
    setLastTranscript(transcript);
    setStatus('speaking');
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'user_transcript_done', text: transcript }));
    }
  }, []);
  const sendRecording = useCallback(async (recording: VoiceRecording) => {
    if (status === 'muted') return;
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setError('小灶通话还没有连接好');
      options.onError?.('小灶通话还没有连接好');
      return;
    }
    setLastTranscript('');
    setStatus('connecting');
    const dataUrl = await blobToDataUrl(recording.blob);
    socketRef.current.send(JSON.stringify({
      type: 'audio_chunk_done',
      data: dataUrl,
      mime_type: recording.mimeType,
      duration_ms: recording.durationMs,
      sample_rate: 16000,
      filename: recording.mimeType.includes('mp4') ? 'voice.mp4' : 'voice.webm',
    }));
  }, [options, status]);

  useEffect(() => () => {
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

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
    toggleMute,
    markListening,
    markSpeaking,
    updateTranscript,
    sendTranscript,
    sendRecording,
  };
}
