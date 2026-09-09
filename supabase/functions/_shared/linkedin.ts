/**
 * One spelling for a LinkedIn post URL.
 *
 * doc_posts is unique on (org_id, linkedin_post_url), so the same post must
 * arrive at that column as the same string every time. The scraper was
 * stripping the query string and the comment generator was not, which meant
 * a post opened from a feed link and the same post opened from a share link
 * became two rows and the constraint never fired.
 *
 * Lowercases the host, drops the query string and fragment (LinkedIn puts
 * tracking parameters there), and drops a trailing slash. The path itself is
 * left alone — LinkedIn post slugs are case-sensitive.
 */
export function normalizePostUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    url.search = "";
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, "");
  } catch {
    // Not parseable as a URL — hand back what we were given rather than
    // inventing a value. Validation upstream is what rejects bad input.
    return trimmed;
  }
}
