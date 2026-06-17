import { describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { generateImageFromText, getPendingImageJobId } from './aiImages';

vi.mock('../api/client', () => ({
  api: {
    renderAiImage: vi.fn(),
  },
}));

describe('ai image helpers', () => {
  it('returns a pending job after text image generation is queued', async () => {
    vi.mocked(api.renderAiImage).mockResolvedValueOnce({
      job_id: 'image-job-1',
      status: 'queued',
      generated_asset: null,
      reference_asset: null,
      generation_mode: 'text',
      target_entity_type: null,
      target_entity_id: null,
      bind_status: 'unbound',
    });

    const result = await generateImageFromText({
      entity_type: 'food',
      title: '番茄炒蛋',
    });

    expect(api.renderAiImage).toHaveBeenCalledWith({
      mode: 'text',
      entity_type: 'food',
      title: '番茄炒蛋',
    });
    expect(result.pendingJob?.job_id).toBe('image-job-1');
    expect(result.generatedAsset).toBeUndefined();
  });

  it('returns pending image job ids only for active jobs', () => {
    expect(getPendingImageJobId({ pendingJob: { job_id: 'image-job-1', status: 'running', generation_mode: 'text' } })).toBe('image-job-1');
    expect(getPendingImageJobId({ pendingJob: { job_id: 'image-job-2', status: 'succeeded', generation_mode: 'text' } })).toBeNull();
    expect(getPendingImageJobId({})).toBeNull();
  });
});
