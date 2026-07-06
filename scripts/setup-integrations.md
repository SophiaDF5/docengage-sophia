# External Integration Setup

Step-by-step guide for configuring Make.com and OpenAI credentials.

## Prerequisites

- Supabase project created (local or hosted)
- Supabase CLI installed (`supabase` command available)
- Make.com account with a plan that supports webhooks
- OpenAI API account with billing enabled

## 1. Make.com Webhook Setup

### Create the inbound scenario (LinkedIn → DocEngage)

1. Log in to [Make.com](https://www.make.com)
2. Create a new scenario
3. Add a **Webhooks → Custom webhook** trigger module
4. Click "Add" to create a new webhook — name it `docengage-inbound`
5. Copy the webhook URL (e.g., `https://hook.us1.make.com/abc123...`)
6. Add your LinkedIn scraping modules after the webhook trigger
7. Configure the webhook to POST to your Supabase edge function:
   - URL: `{SUPABASE_URL}/functions/v1/doc_inbound_post`
   - Body:
     ```json
     {
       "org_id": "<your-org-uuid>",
       "linkedin_post_url": "{{post_url}}",
       "author_name": "{{author_name}}",
       "content": "{{post_content}}",
       "secret_token": "<your-webhook-secret>"
     }
     ```
8. Activate the scenario

### Create the outbound scenario (DocEngage → LinkedIn)

1. Create a new scenario
2. Add a **Webhooks → Custom webhook** trigger module
3. Name it `docengage-outbound` — copy the webhook URL
4. This URL is your `MAKE_WEBHOOK_ID` (the path after `hook.us1.make.com/`)
5. Add modules to post the comment to LinkedIn via your preferred method
6. The incoming payload shape:
   ```json
   {
     "event": "comment_approved",
     "org_id": "uuid",
     "post_url": "https://linkedin.com/...",
     "comment_content": "The comment text...",
     "contact_name": "Dr. Smith"
   }
   ```
7. Activate the scenario

### Generate a webhook secret

Generate a strong random secret for HMAC validation:

```bash
openssl rand -base64 32
```

Save this value — you'll use it in both Make.com and Supabase.

## 2. OpenAI API Key

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Click "Create new secret key"
3. Name it `docengage-production` (or `docengage-dev` for local)
4. Copy the key immediately (it won't be shown again)
5. Ensure your account has billing enabled and sufficient credits
6. The app uses `gpt-4o` for comment generation and `whisper-1` for audio transcription

## 3. Apify API Key (LinkedIn lead scraper)

Powers the "Scrape Commenters" button on the Contacts page (`doc_scrape_post_commenters`),
which pulls doctor leads from LinkedIn post commenters via the HarvestAPI
`linkedin-post-comments` actor.

1. Go to [console.apify.com/account/integrations](https://console.apify.com/account/integrations)
2. Copy your personal API token
3. Set it as a Supabase secret (see step 4 below) as `APIFY_API_KEY`

Notes:
- This actor scrapes without LinkedIn cookies/login, so it can occasionally get soft-blocked
  by LinkedIn and return 0 comments for a run that otherwise "succeeded" (no error, just an
  empty result). If a scrape returns 0 results, the app now shows a warning toast with a link
  to the Apify run — check it, then retry.
- Actor input field names matter — it takes `posts` (array of post URLs) and `maxItems`
  (not `maxComments`). If this actor is ever swapped for another, re-check field names against
  the actor's input schema before deploying, since a wrong field name fails silently rather
  than erroring.

## 4. Configure Supabase Secrets

### Local development

```bash
# Set secrets for local edge functions
supabase secrets set MAKE_WEBHOOK_SECRET="<your-webhook-secret>"
supabase secrets set MAKE_WEBHOOK_ID="<path-from-make-webhook-url>"
supabase secrets set OPENAI_API_KEY="<your-openai-key>"
supabase secrets set APIFY_API_KEY="<your-apify-token>"
```

### Hosted (production/staging)

```bash
# Link to your project first
supabase link --project-ref <your-project-ref>

# Set secrets
supabase secrets set MAKE_WEBHOOK_SECRET="<your-webhook-secret>"
supabase secrets set MAKE_WEBHOOK_ID="<path-from-make-webhook-url>"
supabase secrets set OPENAI_API_KEY="<your-openai-key>"
supabase secrets set APIFY_API_KEY="<your-apify-token>"
```

### Verify secrets are set

```bash
supabase secrets list
```

You should see `MAKE_WEBHOOK_SECRET`, `MAKE_WEBHOOK_ID`, `OPENAI_API_KEY`, and `APIFY_API_KEY` listed.

## 4. Verify End-to-End

### Test inbound webhook

```bash
curl -X POST "${SUPABASE_URL}/functions/v1/doc_inbound_post" \
  -H "Content-Type: application/json" \
  -d '{
    "org_id": "a1111111-1111-1111-1111-111111111111",
    "linkedin_post_url": "https://linkedin.com/post/test-1",
    "author_name": "Dr. Test",
    "content": "Testing the integration pipeline.",
    "secret_token": "<your-webhook-secret>"
  }'
```

Expected: `200` with `{ "data": { "id": "...", "status": "pending" } }`

### Test comment approval

```bash
# Get a JWT first by signing in
TOKEN=$(curl -s -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"email":"test-user-a@example.com","password":"TestPassword123!"}' \
  | jq -r '.access_token')

curl -X POST "${SUPABASE_URL}/functions/v1/doc_approve_comment" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{
    "comment_id": "<comment-uuid-from-above>",
    "edited_content": "Testing the approval flow."
  }'
```

Expected: `200` with `{ "data": { "id": "...", "status": "approved", "posted": true } }`

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401` on inbound webhook | Wrong `secret_token` | Verify `MAKE_WEBHOOK_SECRET` matches between Make.com and Supabase |
| `500` with "OPENAI_API_KEY not configured" | Secret not set | Run `supabase secrets set OPENAI_API_KEY=...` |
| Comment stuck in `generation_failed` | OpenAI rate limit or key issue | Check edge function logs: `supabase functions logs doc_inbound_post` |
| Make.com webhook returns 404 | Wrong `MAKE_WEBHOOK_ID` | Verify the path portion of your Make webhook URL |
| `429` on approval | Rate limit triggered | Wait 60 seconds, or adjust `RATE_LIMIT_TIERS` in `rate-limit.ts` |
| `500` with "Apify API key not configured" | Secret not set | Run `supabase secrets set APIFY_API_KEY=...` |
| Scrape reports 0 items / 0 saved with no error | Actor ran but found nothing — usually a LinkedIn soft-block on the no-cookie scraper, a post with genuinely no comments, or a bad URL | Click "View run" on the warning toast (or `supabase functions logs doc_scrape_post_commenters`) to see the actual Apify run, then retry |
| Scrape times out after ~2 minutes | Post has too many comments for the 120s poll budget | Retry — large posts may need a second attempt; consider raising `maxWaitMs` in `doc_scrape_post_commenters/index.ts` if this recurs often |
