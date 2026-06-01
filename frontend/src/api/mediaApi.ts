import { request } from './request';
import type { AiRenderResponse, CreateAiRenderRequest, MediaAsset } from './types';

export const mediaApi = {
  uploadMedia: async (file: File, source: 'upload' | 'ai', alt: string) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('source', source);
    formData.append('alt', alt);
    return request<MediaAsset>(
      '/api/media/upload',
      {
        method: 'POST',
        body: formData,
      }
    );
  },
  renderAiImage: (payload: CreateAiRenderRequest) =>
    request<AiRenderResponse>('/api/media/ai-render', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getAiRenderJob: (jobId: string) => request<AiRenderResponse>(`/api/media/ai-render/${jobId}`),
};
