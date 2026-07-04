import { useCallback, useRef, useState } from 'react';
import { aiVoiceApi, type AiVoiceProvider } from '../api/aiVoiceApi';

type PcmStreamOptions = {
  sampleRate: number;
  contentType?: string;
  channels?: number;
};

export type VoicePlaybackTraceEvent = {
  stage: string;
  elapsedMs: number;
  at: number;
  details?: Record<string, unknown>;
};

type WindowWithWebkitAudioContext = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

const PCM_INITIAL_BUFFER_SECONDS = 0.3;
const PCM_MIN_SCHEDULE_SECONDS = 0.12;
const PCM_START_LEAD_SECONDS = 0.12;
const PCM_LOW_WATER_SECONDS = 0.22;
const PCM_MONITOR_INTERVAL_MS = 120;
const PCM_FINISH_GRACE_MS = 120;

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function pcm16ToFloat32(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const output = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true);
    output[index] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
  }
  return output;
}

function concatBytes(chunks: Uint8Array[], totalLength: number) {
  const output = new Uint8Array(totalLength);
  let offset = 0;
  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return output;
}

export function useVoicePlayback() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isEnabled, setIsEnabled] = useState(true);
  const [error, setError] = useState('');
  const [traceEvents, setTraceEvents] = useState<VoicePlaybackTraceEvent[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string>('');
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamIdRef = useRef(0);
  const scheduledAtRef = useRef(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const finishTimerRef = useRef<number | null>(null);
  const monitorTimerRef = useRef<number | null>(null);
  const playbackStartTimerRef = useRef<number | null>(null);
  const pendingPcmChunksRef = useRef<Uint8Array[]>([]);
  const pendingPcmByteLengthRef = useRef(0);
  const pcmStreamStartedRef = useRef(false);
  const pcmStreamOptionsRef = useRef<PcmStreamOptions | null>(null);
  const streamStartedAtRef = useRef(0);
  const firstAudioDeltaReceivedRef = useRef(false);
  const playbackStartMarkedRef = useRef(false);
  const streamFinishedRef = useRef(false);
  const lowWaterActiveRef = useRef(false);
  const rebufferingRef = useRef(false);
  const lowWaterCountRef = useRef(0);

  const clearFinishTimer = useCallback(() => {
    if (finishTimerRef.current !== null) {
      window.clearTimeout(finishTimerRef.current);
      finishTimerRef.current = null;
    }
  }, []);

  const markTrace = useCallback((stage: string, details?: Record<string, unknown>) => {
    const at = Date.now();
    const startedAt = streamStartedAtRef.current || at;
    const event: VoicePlaybackTraceEvent = {
      stage,
      elapsedMs: Math.max(0, at - startedAt),
      at,
      details,
    };
    setTraceEvents((current) => [...current.slice(-79), event]);
  }, []);

  const clearMonitorTimer = useCallback(() => {
    if (monitorTimerRef.current !== null) {
      window.clearInterval(monitorTimerRef.current);
      monitorTimerRef.current = null;
    }
  }, []);

  const clearPlaybackStartTimer = useCallback(() => {
    if (playbackStartTimerRef.current !== null) {
      window.clearTimeout(playbackStartTimerRef.current);
      playbackStartTimerRef.current = null;
    }
  }, []);

  const pendingPcmDurationSeconds = useCallback(() => {
    const options = pcmStreamOptionsRef.current;
    if (!options) return 0;
    const channels = options.channels ?? 1;
    return pendingPcmByteLengthRef.current / 2 / channels / options.sampleRate;
  }, []);

  const scheduledAheadSeconds = useCallback(() => {
    const context = audioContextRef.current;
    if (!context) return 0;
    return Math.max(0, scheduledAtRef.current - context.currentTime);
  }, []);

  const startLowWaterMonitor = useCallback(() => {
    if (monitorTimerRef.current !== null) return;
    monitorTimerRef.current = window.setInterval(() => {
      if (!pcmStreamStartedRef.current || streamFinishedRef.current) return;
      const bufferedSeconds = scheduledAheadSeconds() + pendingPcmDurationSeconds();
      if (bufferedSeconds > 0 && bufferedSeconds < PCM_LOW_WATER_SECONDS) {
        if (!lowWaterActiveRef.current) {
          lowWaterActiveRef.current = true;
          lowWaterCountRef.current += 1;
          markTrace('frontend_playback_low_water', {
            count: lowWaterCountRef.current,
            buffered_seconds: Number(bufferedSeconds.toFixed(3)),
          });
        }
        return;
      }
      if (bufferedSeconds >= PCM_LOW_WATER_SECONDS) {
        lowWaterActiveRef.current = false;
      }
    }, PCM_MONITOR_INTERVAL_MS);
  }, [markTrace, pendingPcmDurationSeconds, scheduledAheadSeconds]);

  const clearObjectAudio = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = '';
    }
  }, []);

  const stop = useCallback(() => {
    streamIdRef.current += 1;
    clearFinishTimer();
    clearMonitorTimer();
    clearPlaybackStartTimer();
    clearObjectAudio();
    activeSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        // Ignore already-ended buffer sources.
      }
      source.disconnect();
    });
    activeSourcesRef.current = [];
    pendingPcmChunksRef.current = [];
    pendingPcmByteLengthRef.current = 0;
    pcmStreamStartedRef.current = false;
    pcmStreamOptionsRef.current = null;
    firstAudioDeltaReceivedRef.current = false;
    playbackStartMarkedRef.current = false;
    streamFinishedRef.current = false;
    lowWaterActiveRef.current = false;
    rebufferingRef.current = false;
    lowWaterCountRef.current = 0;
    scheduledAtRef.current = 0;
    setIsSpeaking(false);
  }, [clearFinishTimer, clearMonitorTimer, clearObjectAudio, clearPlaybackStartTimer]);

  const getAudioContext = useCallback(() => {
    const existing = audioContextRef.current;
    if (existing && existing.state !== 'closed') return existing;
    const AudioContextClass = window.AudioContext || (window as WindowWithWebkitAudioContext).webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error('当前浏览器不支持流式语音播放');
    }
    const context = new AudioContextClass();
    audioContextRef.current = context;
    return context;
  }, []);

  const startPcmStream = useCallback((options: PcmStreamOptions) => {
    if (!isEnabled) return;
    stop();
    streamIdRef.current += 1;
    streamStartedAtRef.current = Date.now();
    scheduledAtRef.current = 0;
    pendingPcmChunksRef.current = [];
    pendingPcmByteLengthRef.current = 0;
    pcmStreamStartedRef.current = false;
    pcmStreamOptionsRef.current = options;
    firstAudioDeltaReceivedRef.current = false;
    playbackStartMarkedRef.current = false;
    streamFinishedRef.current = false;
    lowWaterActiveRef.current = false;
    rebufferingRef.current = false;
    lowWaterCountRef.current = 0;
    setTraceEvents([]);
    setError('');
    setIsSpeaking(true);
    try {
      const context = getAudioContext();
      if (context.state === 'suspended') void context.resume();
      if (options.contentType && !options.contentType.includes('pcm')) {
        setError('暂不支持该流式音频格式');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '语音播报失败');
      setIsSpeaking(false);
    }
  }, [getAudioContext, isEnabled, stop]);

  const flushPcmQueue = useCallback((force = false) => {
    const options = pcmStreamOptionsRef.current;
    if (!options || pendingPcmByteLengthRef.current < 2) return;
    const channels = options.channels ?? 1;
    const queuedDuration = pendingPcmByteLengthRef.current / 2 / channels / options.sampleRate;
    if (!pcmStreamStartedRef.current && !force && queuedDuration < PCM_INITIAL_BUFFER_SECONDS) return;
    if (
      pcmStreamStartedRef.current
      && !force
      && scheduledAheadSeconds() < PCM_LOW_WATER_SECONDS
      && queuedDuration < PCM_INITIAL_BUFFER_SECONDS
    ) {
      if (!rebufferingRef.current) {
        rebufferingRef.current = true;
        markTrace('frontend_playback_rebuffering', {
          queued_seconds: Number(queuedDuration.toFixed(3)),
          scheduled_ahead_seconds: Number(scheduledAheadSeconds().toFixed(3)),
        });
      }
      return;
    }
    if (pcmStreamStartedRef.current && !force && queuedDuration < PCM_MIN_SCHEDULE_SECONDS) return;

    try {
      const context = getAudioContext();
      if (context.state === 'suspended') void context.resume();
      const bytes = concatBytes(pendingPcmChunksRef.current, pendingPcmByteLengthRef.current);
      pendingPcmChunksRef.current = [];
      pendingPcmByteLengthRef.current = 0;
      if (bytes.byteLength < 2) return;
      const samples = pcm16ToFloat32(bytes);
      const buffer = context.createBuffer(channels, samples.length / channels, options.sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const startAt = Math.max(context.currentTime + PCM_START_LEAD_SECONDS, scheduledAtRef.current || 0);
      scheduledAtRef.current = startAt + buffer.duration;
      if (rebufferingRef.current) {
        rebufferingRef.current = false;
        lowWaterActiveRef.current = false;
        markTrace('frontend_playback_rebuffered', {
          queued_seconds: Number(buffer.duration.toFixed(3)),
        });
      }
      if (!playbackStartMarkedRef.current) {
        playbackStartMarkedRef.current = true;
        const streamId = streamIdRef.current;
        const delayMs = Math.max(0, Math.round((startAt - context.currentTime) * 1000));
        clearPlaybackStartTimer();
        playbackStartTimerRef.current = window.setTimeout(() => {
          if (streamIdRef.current === streamId) {
            markTrace('frontend_playback_start', { scheduled_delay_ms: delayMs });
          }
        }, delayMs);
      }
      pcmStreamStartedRef.current = true;
      startLowWaterMonitor();
      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter((item) => item !== source);
      };
      activeSourcesRef.current.push(source);
      source.start(startAt);
      setIsSpeaking(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '语音播报失败');
      stop();
    }
  }, [clearPlaybackStartTimer, getAudioContext, markTrace, scheduledAheadSeconds, startLowWaterMonitor, stop]);

  const appendPcmChunk = useCallback((audio: string | Uint8Array, options: PcmStreamOptions) => {
    if (!isEnabled) return;
    clearFinishTimer();
    const bytes = typeof audio === 'string' ? base64ToBytes(audio) : audio;
    if (bytes.byteLength < 2) return;
    if (!firstAudioDeltaReceivedRef.current) {
      firstAudioDeltaReceivedRef.current = true;
      markTrace('frontend_first_audio_delta_received', { bytes: bytes.byteLength });
    }
    pcmStreamOptionsRef.current = options;
    pendingPcmChunksRef.current.push(bytes);
    pendingPcmByteLengthRef.current += bytes.byteLength;
    flushPcmQueue(false);
  }, [clearFinishTimer, flushPcmQueue, isEnabled, markTrace]);

  const finishStream = useCallback(() => {
    streamFinishedRef.current = true;
    flushPcmQueue(true);
    const context = audioContextRef.current;
    if (!context || scheduledAtRef.current <= context.currentTime) {
      setIsSpeaking(false);
      return;
    }
    const currentStreamId = streamIdRef.current;
    const remainingMs = Math.max(0, (scheduledAtRef.current - context.currentTime) * 1000) + PCM_FINISH_GRACE_MS;
    clearFinishTimer();
    finishTimerRef.current = window.setTimeout(() => {
      if (streamIdRef.current === currentStreamId) {
        setIsSpeaking(false);
      }
    }, remainingMs);
  }, [clearFinishTimer, flushPcmQueue]);

  const failStream = useCallback((message: string) => {
    setError(message || '语音播报失败');
    finishStream();
  }, [finishStream]);

  const recordTrace = useCallback((stage: string, details?: Record<string, unknown>) => {
    markTrace(stage, details);
  }, [markTrace]);

  const speak = useCallback(async (text: string, options: { provider?: AiVoiceProvider } = {}) => {
    if (!isEnabled || !text.trim()) return;
    stop();
    setError('');
    try {
      const blob = await aiVoiceApi.synthesizeSpeech({
        surface: 'recipe_cook_page',
        text,
        provider: options.provider,
      });
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = stop;
      audio.onerror = () => {
        setError('语音播报失败');
        stop();
      };
      setIsSpeaking(true);
      await audio.play();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '语音播报失败');
      stop();
    }
  }, [isEnabled, stop]);

  const playBlob = useCallback(async (blob: Blob) => {
    if (!isEnabled || blob.size <= 0) return;
    stop();
    setError('');
    try {
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = stop;
      audio.onerror = () => {
        setError('语音播报失败');
        stop();
      };
      setIsSpeaking(true);
      await audio.play();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '语音播报失败');
      stop();
    }
  }, [isEnabled, stop]);

  return {
    isEnabled,
    setIsEnabled,
    isSpeaking,
    error,
    traceEvents,
    speak,
    playBlob,
    startPcmStream,
    appendPcmChunk,
    finishStream,
    failStream,
    recordTrace,
    stop,
  };
}
