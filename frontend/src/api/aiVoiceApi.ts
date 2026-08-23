import { API_BASE_URL, ApiError, getAccessToken, request } from './request';

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
  mode: 'agent_backed_websocket';
  session_id: string;
  websocket_url: string;
  websocket_ticket: string;
  websocket_ticket_expires_at: string;
  expires_at: string;
};

function speechErrorDetail(payload: unknown, fallback: string) {
  if (typeof payload === 'string' && payload.trim()) return payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'detail' in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail) && 'message' in detail) {
      const message = (detail as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message;
    }
  }
  return fallback || '语音播报失败';
}

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
    const isJson = response.headers.get('Content-Type')?.includes('application/json');
    const payload = isJson ? await response.json() : await response.text();
    throw new ApiError({
      status: response.status,
      detail: speechErrorDetail(payload, response.statusText),
      path: '/api/ai/audio/speech',
      payload,
    });
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
  return url.toString();
}

export function cookingRealtimeWebSocketProtocols(ticket: string) {
  return ['culina-realtime', `culina-ticket.${ticket}`];
}

export const aiVoiceApi = {
  transcribeAudio,
  synthesizeSpeech,
  createCookingRealtimeSession,
  cookingRealtimeWebSocketUrl,
  cookingRealtimeWebSocketProtocols,
};
