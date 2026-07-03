import { API_BASE_URL, getAccessToken, request } from './request';

export type AiVoiceSurface = 'main_ai' | 'recipe_cook_page';
export type AiVoiceProvider = 'openai' | 'dashscope';

export type AudioTranscriptionResponse = {
  text: string;
  language: string | null;
  provider: string;
  model: string;
  duration_seconds: number | null;
};

export type CookingRealtimeSessionRequest = {
  provider?: AiVoiceProvider;
  recipe_id: string;
  cook_session_id: string;
  session_revision: number;
  subject: Record<string, unknown>;
};

export type CookingRealtimeSessionResponse = {
  provider: string;
  mode: 'agent_backed_websocket';
  session_id: string;
  websocket_url: string;
  expires_at: string;
};

export async function transcribeAudio(args: {
  file: Blob;
  filename?: string;
  surface: AiVoiceSurface;
  languageHint?: string;
  provider?: AiVoiceProvider;
  signal?: AbortSignal;
}): Promise<AudioTranscriptionResponse> {
  const formData = new FormData();
  formData.set('file', args.file, args.filename ?? 'voice.webm');
  formData.set('surface', args.surface);
  if (args.languageHint) formData.set('language_hint', args.languageHint);
  if (args.provider) formData.set('provider', args.provider);
  return request<AudioTranscriptionResponse>('/api/ai/audio/transcriptions', {
    method: 'POST',
    body: formData,
    signal: args.signal,
  });
}

export async function synthesizeSpeech(args: {
  text: string;
  surface: AiVoiceSurface;
  voice?: string;
  provider?: AiVoiceProvider;
  signal?: AbortSignal;
}): Promise<Blob> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const token = getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_BASE_URL}/api/ai/audio/speech`, {
    method: 'POST',
    headers,
    signal: args.signal,
    body: JSON.stringify({
      surface: args.surface,
      text: args.text,
      voice: args.voice,
      provider: args.provider,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || response.statusText || '语音播报失败');
  }
  return response.blob();
}

export function createCookingRealtimeSession(payload: CookingRealtimeSessionRequest) {
  return request<CookingRealtimeSessionResponse>('/api/ai/realtime/cooking/session', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function cookingRealtimeWebSocketUrl(path: string) {
  const base = API_BASE_URL || window.location.origin;
  const url = new URL(path, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getAccessToken();
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

export const aiVoiceApi = {
  transcribeAudio,
  synthesizeSpeech,
  createCookingRealtimeSession,
  cookingRealtimeWebSocketUrl,
};
