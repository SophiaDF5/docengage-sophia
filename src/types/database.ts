// Table name kept as "doc_organizations" for historical reasons (see
// migration 012) — there is no team/multi-user concept anymore. Every
// login gets exactly one of these rows, auto-created on signup, and it's
// purely an internal account-settings container, never user-facing as
// an "organization."
export interface Organization {
  id: string;
  user_id: string;
  name: string;
  auto_post_enabled: boolean;
  ai_system_prompt: string | null;
  created_at: string;
  updated_at: string;
}

export interface Post {
  id: string;
  user_id: string;
  org_id: string;
  linkedin_post_url: string;
  author_name: string;
  author_headline: string | null;
  content: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export type CommentStatus = "pending" | "approved" | "rejected" | "generation_failed";
export type CommentSource = "caption" | "image" | "link";

export interface Comment {
  id: string;
  user_id: string;
  post_id: string;
  org_id: string;
  generated_content: string | null;
  edited_content: string | null;
  status: CommentStatus;
  approved_by: string | null;
  source: CommentSource;
  created_at: string;
  updated_at: string;
}

export interface CommentWithPost extends Comment {
  doc_posts: Post;
}

export type ContactStatus = "pending" | "messaged" | "engaged";
export type ContactSource = "scraped" | "manual";
// Freeform key/value info a user attaches to a lead (title, company, phone,
// specialty, etc.) — see migration 011. No fixed schema on purpose.
export type CustomFields = Record<string, string>;

export interface Contact {
  id: string;
  user_id: string;
  org_id: string;
  linkedin_profile_url: string;
  full_name: string;
  headline: string | null;
  email: string | null;
  is_connected: boolean;
  status: ContactStatus;
  source: ContactSource;
  custom_fields: CustomFields;
  // Freeform label set at upload/add time (e.g. "YouTube", "Conference 2026") —
  // see migration 013. Only meaningful for source='manual' rows in practice,
  // but not enforced. Null means untagged.
  tag: string | null;
  last_contacted_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ToneProcessingStatus = "pending" | "completed" | "failed";

export interface ToneSample {
  id: string;
  user_id: string;
  org_id: string;
  file_path: string;
  extracted_text: string | null;
  processing_status: ToneProcessingStatus;
  created_at: string;
  updated_at: string;
}

export interface DmLead {
  id: string;
  user_id: string;
  org_id: string;
  name: string;
  bio: string | null;
  links: string | null;
  linkedin_profile_url: string | null;
  status: ContactStatus;
  custom_fields: CustomFields;
  last_contacted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DmDraft {
  id: string;
  user_id: string;
  org_id: string;
  conversation_context: string;
  last_reply: string;
  generated_content: string | null;
  edited_content: string | null;
  created_at: string;
  updated_at: string;
}

export interface OutreachMessage {
  id: string;
  user_id: string;
  org_id: string;
  contact_id: string | null;
  dm_lead_id: string | null;
  message_content: string;
  sent_at: string;
  created_at: string;
}
