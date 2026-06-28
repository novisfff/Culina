import { request } from './request';
import type { SearchEntityType, SearchIndexJobResponse, SearchResponse } from './types';

export interface SearchParams {
  q: string;
  scopes?: SearchEntityType[];
  limit?: number;
  offset?: number;
}

export const searchApi = {
  search: (params: SearchParams) => {
    const search = new URLSearchParams();
    search.set('q', params.q.trim());
    if (params.scopes?.length) {
      search.set('scopes', params.scopes.join(','));
    }
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.offset !== undefined) search.set('offset', String(params.offset));
    return request<SearchResponse>(`/api/search?${search.toString()}`);
  },
  getActiveSearchIndexJobs: () => request<SearchIndexJobResponse[]>('/api/search/index-jobs/active'),
  retrySearchIndexJob: (jobId: string) =>
    request<SearchIndexJobResponse>(`/api/search/index-jobs/${jobId}/retry`, {
      method: 'POST',
    }),
};
