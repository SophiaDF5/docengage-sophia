import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth, createUserClient } from "../_shared/auth.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { safeError } from "../_shared/error-handler.ts";
import { validateBody, z } from "../_shared/validate.ts";
import { callOpenAI } from "../_shared/openai.ts";

const GenerateDmSchema = z.object({
  org_id: z.string().uuid(),
  my_last_reply: z.string().max(5000).optional(),
  their_last_reply: z.string().max(3000).optional(),
  new_topic: z.string().max(3000).optional(),
  lead_name: z.string().max(200).optional(),
  lead_bio: z.string().max(1000).optional(),
  lead_links: z.string().max(500).optional(),
}).refine(
  (d) => (d.my_last_reply && d.their_last_reply) || d.new_topic,
  { message: "Provide both replies to continue a conversation, or a new topic to start one" }
);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Auth + rate limit
    const [user, authError] = await requireAuth(req);
    if (authError) return authError;

    const [, rateLimitError] = await rateLimit(user.id, "expensive");
    if (rateLimitError) return rateLimitError;

    // 2. Validate
    const [body, validationError] = await validateBody(req, GenerateDmSchema);
    if (validationError) return validationError;

    // 3. Fetch org settings
    const supabase = createUserClient(req);
    const { data: org, error: orgError } = await supabase
      .from("doc_organizations")
      .select("ai_system_prompt")
      .eq("id", body.org_id)
      .single();

    if (orgError || !org) {
      return new Response(
        JSON.stringify({ error: "Organization not found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const basePrompt = org.ai_system_prompt ||
      "You are a professional CEO. Write warm, professional direct messages that build genuine relationships with healthcare professionals.";

    const humanStyleGuide = `

FORMATTING RULES — this is critical:
- Write like a real human texting. NOT like a corporate email.
- Use "..." for trailing thoughts and natural pauses (e.g. "been thinking about this a lot...")
- Use ALL CAPS sparingly for genuine emphasis (e.g. "that is SO true" or "I LOVE that")
- Lowercase is fine for casual feel — you don't need to capitalize every sentence
- Use "right?" and "you know?" as natural connectors
- Short sentences. Fragment sentences are fine. Like this.
- No bullet points, no numbered lists, no formal structure
- Never use phrases like "I'd love to connect", "Let's schedule a call", or "Wow..." — too corporate or performative
- No emojis unless they fit naturally (max 1-2)
- Sound like you're talking to a friend, not writing a LinkedIn message`;

    let leadContext = "";
    if (body.lead_name || body.lead_bio || body.lead_links) {
      leadContext = "\n\nAbout the person you're messaging:";
      if (body.lead_name) leadContext += `\nName: ${body.lead_name}`;
      if (body.lead_bio) leadContext += `\nBio: ${body.lead_bio}`;
      if (body.lead_links) leadContext += `\nLinks: ${body.lead_links}`;
    }

    const isNewConvo = !body.my_last_reply && !body.their_last_reply;

    const systemPrompt = `${basePrompt}${humanStyleGuide}\n\n${
      isNewConvo
        ? "You are drafting an opening direct message to start a new conversation. Make it feel natural and genuine — not salesy or forced."
        : "You are drafting a direct message reply. Match the tone and energy of the ongoing conversation. Keep your reply concise and natural — avoid sounding scripted."
    }${body.new_topic && !isNewConvo ? " The user also wants to naturally bring up a new topic in this reply — weave it in so it doesn't feel forced." : ""}${leadContext}`;

    let userPrompt: string;

    if (isNewConvo) {
      userPrompt = `Open a new conversation based on this (their post or bio):\n\n"${body.new_topic}"`;
    } else {
      userPrompt = `Your last message:\n"${body.my_last_reply}"\n\nTheir reply:\n"${body.their_last_reply}"`;
      if (body.new_topic) {
        userPrompt += `\n\nAlso bring up this new topic naturally in your reply:\n"${body.new_topic}"`;
      }
    }

    userPrompt += "\n\nDraft a reply:";

    // 4. Generate reply
    const generatedContent = await callOpenAI(systemPrompt, userPrompt);

    if (!generatedContent) {
      return new Response(
        JSON.stringify({ error: "AI draft unavailable - please try again" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. Save to doc_dm_drafts
    const { data: draft, error: draftError } = await supabase
      .from("doc_dm_drafts")
      .insert({
        org_id: body.org_id,
        conversation_context: body.my_last_reply || body.new_topic || "",
        last_reply: body.their_last_reply || "",
        generated_content: generatedContent,
      })
      .select("id")
      .single();

    if (draftError) {
      console.error("Failed to save DM draft:", draftError);
    }

    return new Response(
      JSON.stringify({
        data: {
          id: draft?.id ?? null,
          generated_content: generatedContent,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return safeError(err);
  }
});
