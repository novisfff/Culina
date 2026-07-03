import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceRecorderStatus = 'idle' | 'requesting_permission' | 'recording' | 'stopping' | 'error';

export type VoiceRecording = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
};

const DEFAULT_MAX_DURATION_MS = 60_000;
const PCM_SAMPLE_RATE = 16000;
const DEFAULT_SILENCE_STOP_MS = 900;
const DEFAULT_VOICE_THRESHOLD = 0.018;
const WAVEFORM_BAR_COUNT = 72;
const MIN_WAVEFORM_LEVEL = 0.06;
const SILENT_WAVEFORM = Array.from({ length: WAVEFORM_BAR_COUNT }, () => MIN_WAVEFORM_LEVEL);
type VoiceRecorderFormat = 'media' | 'pcm16';
type WindowWithWebkitAudioContext = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

function preferredMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/wav'];
  return candidates.find((item) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(item)) ?? '';
}

function encodePcm16(samples: Float32Array[]) {
  const length = samples.reduce((total, chunk) => total + chunk.length, 0);
  const output = new ArrayBuffer(length * 2);
  const view = new DataView(output);
  let offset = 0;
  samples.forEach((chunk) => {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[index]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  });
  return output;
}

function resampleMono(input: Float32Array, inputSampleRate: number, outputSampleRate = PCM_SAMPLE_RATE) {
  if (inputSampleRate === outputSampleRate) return new Float32Array(input);
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(input.length - 1, left + 1);
    const weight = sourceIndex - left;
    output[index] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}

function rmsFromFloatSamples(input: Float32Array) {
  let sum = 0;
  for (let index = 0; index < input.length; index += 1) {
    const sample = input[index] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / Math.max(1, input.length));
}

function rmsFromByteSamples(input: Uint8Array) {
  let sum = 0;
  for (let index = 0; index < input.length; index += 1) {
    const sample = ((input[index] ?? 128) - 128) / 128;
    sum += sample * sample;
  }
  return Math.sqrt(sum / Math.max(1, input.length));
}

function waveformLevelFromRms(rms: number) {
  const noiseFloor = 0.004;
  const normalized = Math.max(0, rms - noiseFloor) * 12;
  const shapedLevel = MIN_WAVEFORM_LEVEL + Math.pow(Math.min(1, normalized), 0.72) * (1 - MIN_WAVEFORM_LEVEL);
  return Math.min(1, Math.max(MIN_WAVEFORM_LEVEL, shapedLevel));
}

function appendWaveformLevel(levels: number[], level: number) {
  return [...levels.slice(1), level];
}

export function useVoiceRecorder(options: {
  maxDurationMs?: number;
  onAutoStop?: (recording: VoiceRecording) => void;
  format?: VoiceRecorderFormat;
  silenceStopMs?: number;
  voiceThreshold?: number;
} = {}) {
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const onAutoStop = options.onAutoStop;
  const format = options.format ?? 'media';
  const silenceStopMs = options.silenceStopMs;
  const voiceThreshold = options.voiceThreshold ?? DEFAULT_VOICE_THRESHOLD;
  const [status, setStatus] = useState<VoiceRecorderStatus>('idle');
  const [error, setError] = useState<string>('');
  const [waveformLevels, setWaveformLevels] = useState<number[]>(SILENT_WAVEFORM);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserFrameRef = useRef<number | null>(null);
  const analyserSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const lastWaveformAtRef = useRef(0);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef(0);
  const timeoutRef = useRef<number | null>(null);
  const stopResolverRef = useRef<((recording: VoiceRecording | null) => void) | null>(null);
  const autoStopRef = useRef(false);
  const heardVoiceRef = useRef(false);
  const lastVoiceAtRef = useRef(0);

  const cleanup = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (analyserFrameRef.current !== null) {
      window.cancelAnimationFrame(analyserFrameRef.current);
      analyserFrameRef.current = null;
    }
    analyserSourceRef.current?.disconnect();
    analyserSourceRef.current = null;
    processorRef.current?.disconnect();
    processorRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    pcmChunksRef.current = [];
    stopResolverRef.current = null;
    autoStopRef.current = false;
    heardVoiceRef.current = false;
    lastVoiceAtRef.current = 0;
    lastWaveformAtRef.current = 0;
    setWaveformLevels(SILENT_WAVEFORM);
  }, []);

  const startMediaWaveform = useCallback((stream: MediaStream) => {
    const AudioContextClass = window.AudioContext || (window as WindowWithWebkitAudioContext).webkitAudioContext;
    if (!AudioContextClass) return;
    const audioContext = new AudioContextClass();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    audioContextRef.current = audioContext;
    analyserSourceRef.current = source;
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      const now = Date.now();
      if (now - lastWaveformAtRef.current >= 70) {
        lastWaveformAtRef.current = now;
        const level = waveformLevelFromRms(rmsFromByteSamples(data));
        setWaveformLevels((levels) => appendWaveformLevel(levels, level));
      }
      analyserFrameRef.current = window.requestAnimationFrame(tick);
    };
    tick();
  }, []);

  const finalizeRecording = useCallback((recorder: MediaRecorder): VoiceRecording | null => {
    const mimeType = recorder.mimeType || 'audio/webm';
    const blob = new Blob(chunksRef.current, { type: mimeType });
    const durationMs = Date.now() - startedAtRef.current;
    cleanup();
    setStatus('idle');
    return blob.size > 0 ? { blob, mimeType, durationMs } : null;
  }, [cleanup]);

  const finalizePcmRecording = useCallback((): VoiceRecording | null => {
    const blob = new Blob([encodePcm16(pcmChunksRef.current)], { type: 'audio/pcm' });
    const durationMs = Date.now() - startedAtRef.current;
    cleanup();
    setStatus('idle');
    return blob.size > 0 ? { blob, mimeType: 'audio/pcm', durationMs } : null;
  }, [cleanup]);

  const autoStopPcmRecording = useCallback(() => {
    if (!audioContextRef.current || autoStopRef.current) return;
    autoStopRef.current = true;
    setStatus('stopping');
    const recording = finalizePcmRecording();
    if (recording) onAutoStop?.(recording);
  }, [finalizePcmRecording, onAutoStop]);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('当前浏览器不支持录音');
      setStatus('error');
      return false;
    }
    if (format === 'media' && typeof MediaRecorder === 'undefined') {
      setError('当前浏览器不支持录音');
      setStatus('error');
      return false;
    }
    cleanup();
    setError('');
    setStatus('requesting_permission');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: format === 'pcm16'
          ? { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true }
          : true,
      });
      streamRef.current = stream;
      if (format === 'pcm16') {
        const AudioContextClass = window.AudioContext || (window as WindowWithWebkitAudioContext).webkitAudioContext;
        if (!AudioContextClass) {
          throw new Error('当前浏览器不支持 PCM 录音');
        }
        const audioContext = new AudioContextClass({ sampleRate: 16000 });
        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        pcmChunksRef.current = [];
        heardVoiceRef.current = false;
        lastVoiceAtRef.current = Date.now();
        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          pcmChunksRef.current.push(resampleMono(input, event.inputBuffer.sampleRate));
          const rms = rmsFromFloatSamples(input);
          setWaveformLevels((levels) => appendWaveformLevel(levels, waveformLevelFromRms(rms)));
          if (silenceStopMs) {
            const now = Date.now();
            if (rms >= voiceThreshold) {
              heardVoiceRef.current = true;
              lastVoiceAtRef.current = now;
              return;
            }
            if (heardVoiceRef.current && now - lastVoiceAtRef.current >= silenceStopMs) {
              autoStopPcmRecording();
            }
          }
        };
        source.connect(processor);
        processor.connect(audioContext.destination);
        audioContextRef.current = audioContext;
        processorRef.current = processor;
        startedAtRef.current = Date.now();
        setStatus('recording');
        timeoutRef.current = window.setTimeout(() => {
          autoStopRef.current = true;
          setStatus('stopping');
          const recording = finalizePcmRecording();
          if (recording) onAutoStop?.(recording);
        }, maxDurationMs);
        return true;
      }
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      startMediaWaveform(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const resolve = stopResolverRef.current;
        const shouldNotifyAutoStop = !resolve && autoStopRef.current;
        const recording = finalizeRecording(recorder);
        resolve?.(recording);
        if (shouldNotifyAutoStop && recording) onAutoStop?.(recording);
      };
      recorder.start();
      startedAtRef.current = Date.now();
      setStatus('recording');
      timeoutRef.current = window.setTimeout(() => {
        if (recorderRef.current?.state === 'recording') {
          autoStopRef.current = true;
          setStatus('stopping');
          recorderRef.current.stop();
        }
      }, maxDurationMs);
      return true;
    } catch {
      cleanup();
      setError('麦克风权限没有打开');
      setStatus('error');
      return false;
    }
  }, [autoStopPcmRecording, cleanup, finalizePcmRecording, finalizeRecording, format, maxDurationMs, onAutoStop, silenceStopMs, startMediaWaveform, voiceThreshold]);

  const stop = useCallback(() => {
    if (format === 'pcm16' && audioContextRef.current) {
      setStatus('stopping');
      const recording = finalizePcmRecording();
      const shouldNotifyAutoStop = autoStopRef.current;
      if (shouldNotifyAutoStop && recording) onAutoStop?.(recording);
      return Promise.resolve(recording);
    }
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return Promise.resolve<VoiceRecording | null>(null);
    setStatus('stopping');
    return new Promise<VoiceRecording | null>((resolve) => {
      stopResolverRef.current = resolve;
      recorder.stop();
    });
  }, [finalizePcmRecording, format, onAutoStop]);

  const cancel = useCallback(() => {
    cleanup();
    setStatus('idle');
  }, [cleanup]);

  return {
    status,
    error,
    isRecording: status === 'recording',
    isBusy: status === 'requesting_permission' || status === 'stopping',
    waveformLevels,
    start,
    stop,
    cancel,
  };
}
