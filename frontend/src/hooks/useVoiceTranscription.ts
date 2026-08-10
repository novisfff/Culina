import { useCallback, useRef, useState } from 'react';
import { aiVoiceApi, type AiVoiceProvider, type AiVoiceSurface } from '../api/aiVoiceApi';
import {
  hasOnsiteModelUsageOption,
  modelUsageErrorCodeFromReason,
} from '../features/model-usage/ModelUsageDegradationNotice';

export function useVoiceTranscription() {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const transcribe = useCallback(async (args: {
    blob: Blob;
    surface: AiVoiceSurface;
    provider?: AiVoiceProvider;
    languageHint?: string;
  }) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsTranscribing(true);
    setError('');
    setErrorCode(null);
    try {
      const result = await aiVoiceApi.transcribeAudio({
        file: args.blob,
        surface: args.surface,
        provider: args.provider,
        languageHint: args.languageHint ?? 'zh',
        signal: controller.signal,
      });
      return result.text.trim();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '没听清，可以再说一次';
      const nextErrorCode = modelUsageErrorCodeFromReason(reason);
      setErrorCode(nextErrorCode);
      setError(
        hasOnsiteModelUsageOption(nextErrorCode, 'stt')
          ? ''
          : message || '没听清，可以再说一次',
      );
      return '';
    } finally {
      setIsTranscribing(false);
    }
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setIsTranscribing(false);
  }, []);

  return { isTranscribing, error, errorCode, transcribe, abort };
}
