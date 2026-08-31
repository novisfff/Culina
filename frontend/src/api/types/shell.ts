/** Application shell, identity, and family-administration contracts. */
import type { MediaAsset } from './media';
import type { UserRole } from './primitives';

export interface AiRecommendation {
  id: string;
  family_id: string;
  title: string;
  detail: string;
  created_at: string;
}

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

export interface ActivityLog {
  id: string;
  family_id: string;
  actor_id: string;
  actor_name?: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  created_at: string;
}

export interface ActivityLogQuery {
  start_date?: string;
  end_date?: string;
  actor_id?: string;
  action?: string;
  entity_type?: string;
  limit?: number;
  offset?: number;
}

export type ActivityHighlightKind =
  | 'shopping'
  | 'inventory'
  | 'meal_plan'
  | 'meal'
  | 'family';

export type ActivityHighlight = {
  id: string;
  kind: ActivityHighlightKind;
  summary: string;
  actor_id: string;
  actor_name: string;
  created_at: string;
};

export type ActivityHighlightsResponse = {
  items: ActivityHighlight[];
  week_highlight_count: number;
};
