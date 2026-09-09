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
  // Set only when this draft is a reply to someone's comment rather than a
  // comment on the post. parent_comment_id points at the harvested comment
  // and goes null if that row is removed; the reply_to_* copy is what keeps
  // the reply readable in the history when it does — see migration 014.
  parent_comment_id: string | null;
  reply_to_name: string | null;
  reply_to_linkedin_url: string | null;
  reply_to_text: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A comment somebody else left on a post, harvested by the scraper.
 *
 * The scraper used to read these, decide whether the commenter looked like a
 * doctor, and throw the words away. They are kept now because replying to a
 * comment means answering what it actually said.
 */
export interface PostComment {
  id: string;
  user_id: string;
  org_id: string;
  post_id: string;
  linkedin_comment_id: string;
  linkedin_comment_url: string | null;
  commenter_name: string;
  commenter_headline: string | null;
  commenter_linkedin_url: string | null;
  comment_text: string | null;
  is_doctor_lead: boolean;
  commented_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PostCommentWithPost extends PostComment {
  doc_posts: Pick<Post, "id" | "linkedin_post_url" | "author_name" | "content">;
}

export interface CommentWithPost extends Comment {
  doc_posts: Post;
}

// Lifecycle order: pending -> invited -> messaged -> engaged. "invited"
// added in migration 015 (previously a separate freeform tag — see
// doc_contacts.tag / doc_dm_leads.tag for other freeform labels).
export type ContactStatus = "pending" | "invited" | "messaged" | "engaged";
// 'keyword_search' added in migration 016 — leads found by searching a
// keyword/topic on LinkedIn (see doc_search_keyword_leads), as opposed to
// 'scraped' (commenters off one known post URL) or 'manual' (added by hand).
export type ContactSource = "scraped" | "manual" | "keyword_search";
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
  // The keyword/topic search that surfaced this lead, plus a snapshot of the
  // post that matched — only populated for source='keyword_search' rows.
  // See migration 016 / doc_search_keyword_leads.
  matched_keyword: string | null;
  source_post_url: string | null;
  source_post_excerpt: string | null;
  source_post_date: string | null;
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
  // Freeform label (e.g. "YouTube") — see migration 014. Same tag vocabulary
  // as doc_contacts.tag, kept independent per table since each lead lives in
  // exactly one of the two. Null means untagged. Not used for "Invited"
  // anymore — that's a status value now, see ContactStatus above.
  tag: string | null;
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
