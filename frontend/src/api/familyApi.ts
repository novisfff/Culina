import { request } from './request';
import type { FamilyDetail, Member } from './types';

export const familyApi = {
  getFamily: () => request<FamilyDetail>('/api/family'),
  updateFamily: (payload: {
    name: string;
    motto: string;
    location: string;
    food_preferences: string[];
    food_avoidances: string[];
    image_media_id?: string | null;
    pending_image_job_id?: string | null;
  }) =>
    request<FamilyDetail>('/api/family', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  getMembers: () => request<Member[]>('/api/members'),
  createMember: (payload: {
    username: string;
    display_name: string;
    password: string;
    role: 'Owner' | 'Member';
    email?: string;
  }) =>
    request<Member>('/api/members', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateMember: (
    memberId: string,
    payload: { display_name: string; email?: string | null; phone?: string | null; avatar_media_id?: string | null; pending_image_job_id?: string | null }
  ) =>
    request<Member>(`/api/members/${memberId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
};
