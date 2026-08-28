/** Application shell, identity, and family-administration contracts. */
import type { AiRecommendation } from '../types';
import type { MediaAsset } from './media';
import type { UserRole } from './primitives';

export interface UserSummary {
  id: string;
  username: string;
  display_name: string;
  email?: string | null;
  phone?: string | null;
  avatar_seed: string;
  avatar_image?: MediaAsset | null;
}

export interface MembershipSummary {
  id: string;
  family_id: string;
  user_id: string;
  role: UserRole;
  status: string;
}

export interface FamilyDetail {
  id: string;
  name: string;
  motto: string;
  location: string;
  food_preferences: string[];
  food_avoidances: string[];
  image?: MediaAsset | null;
  created_at: string;
  updated_at: string;
  ai_recommendations: AiRecommendation[];
}

export interface AuthSnapshot {
  user: UserSummary;
  membership: MembershipSummary;
  family: FamilyDetail;
}

export interface LoginResponse extends AuthSnapshot {
  access_token: string;
}

export interface Member extends UserSummary {
  role: UserRole;
  status: string;
}

export type { ActivityLog, ActivityLogQuery } from '../types';
