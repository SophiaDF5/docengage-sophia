import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth, createUserClient } from "../_shared/auth.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { safeError } from "../_shared/error-handler.ts";
import { validateBody, z } from "../_shared/validate.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ProcessToneSchema = z.object({
  sample_id: z.string().uuid(),
});

/**
 * Calls OpenAI Whisper API to transcribe audio, with exponential backoff on 429s.
 */
async function transcribeAudio(fileBytes: Uint8Array, fileName: string): Promise<string | null> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    console.error("OPENAI_API_KEY not configured");
    return null;
  }

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const formData = new FormData();
      formData.append("file", new Blob([fileBytes]), fileName);
      formData.append("model", "whisper-1");

      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
        },
        body: formData,
      });

      if (response.status === 429) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (response.status >= 500) {
        console.error("OpenAI Whisper server error:", response.status, await response.text());
        return null;
      }

      if (!response.ok) {
        console.error("OpenAI Whisper error:", response.status, await response.text());
        return null;
      }

      const data = await response.json();
      return data.text ?? null;
    } catch (err) {
      console.error("OpenAI Whisper request failed:", err);
      if (attempt === maxRetries - 1) return null;
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return null;
}

/**
 * Uses OpenAI chat to analyze transcribed text and produce a tone profile.
 */
async function analyzeTone(text: string): Promise<string | null> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return null;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "Analyze the following text sample and extract the speaker's communication style. Produce a concise system prompt (under 500 words) that instructs an AI to write LinkedIn comments in this person's voice. Focus on: tone, vocabulary level, sentence structure, level of formality, use of industry jargon, and personality traits evident in the speech.",
          },
          {
            role: "user",
            content: text,
          },
        ],
        temperature: 0.5,
      }),
    });

    if (!response.ok) {
      console.error("OpenAI tone analysis error:", response.status, await response.text());
      return null;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.error("OpenAI tone analysis failed:", err);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Authenticate
    const [user, authError] = await requireAuth(req);
    if (authError) return authError;

    // 2. Rate limit (expensive tier)
    const [, rateLimitError] = await rateLimit(user.id, "expensive");
    if (rateLimitError) return rateLimitError;

    // 3. Validate input
    const [body, validationError] = await validateBody(req, ProcessToneSchema);
    if (validationError) return validationError;

    // 4. Create user-scoped client (RLS enforced)
    const supabase = createUserClient(req);

    // 5. Fetch the tone sample record
    const { data: sample, error: fetchError } = await supabase
      .from("doc_tone_samples")
      .select("id, org_id, file_path, processing_status")
      .eq("id", body.sample_id)
      .single();

    if (fetchError || !sample) {
      return new Response(
        JSON.stringify({ error: "Tone sample not found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 6. Early return if already processed
    if (sample.processing_status === "completed") {
      return new Response(
        JSON.stringify({ data: { id: sample.id, status: "completed" } }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 7. Download the file from storage
    // Use service role for storage access since user client may not have direct access
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: fileData, error: downloadError } = await serviceClient
      .storage
      .from("doc_tone_uploads")
      .download(sample.file_path);

    if (downloadError || !fileData) {
      console.error("Failed to download tone file:", downloadError);
      // Never delete the file — mark as failed
      await supabase
        .from("doc_tone_samples")
        .update({ processing_status: "failed" })
        .eq("id", sample.id);

      return new Response(
        JSON.stringify({ error: "Failed to download file for processing" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 8. Transcribe the audio via Whisper
    const fileBytes = new Uint8Array(await fileData.arrayBuffer());
    const fileName = sample.file_path.split("/").pop() ?? "audio.wav";
    const transcribedText = await transcribeAudio(fileBytes, fileName);

    if (!transcribedText) {
      console.error("Whisper transcription failed for sample:", sample.id, "file:", sample.file_path);
      // Never delete file on failure
      await supabase
        .from("doc_tone_samples")
        .update({ processing_status: "failed" })
        .eq("id", sample.id);

      return new Response(
        JSON.stringify({ error: "AI draft unavailable - manual entry required" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 9. Analyze tone and generate system prompt
    const tonePrompt = await analyzeTone(transcribedText);

    if (!tonePrompt) {
      console.error("Tone analysis failed for sample:", sample.id);
      await supabase
        .from("doc_tone_samples")
        .update({
          extracted_text: transcribedText,
          processing_status: "failed",
        })
        .eq("id", sample.id);

      return new Response(
        JSON.stringify({ error: "AI draft unavailable - manual entry required" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 10. Update the tone sample record
    const { error: updateSampleError } = await supabase
      .from("doc_tone_samples")
      .update({
        extracted_text: transcribedText,
        processing_status: "completed",
      })
      .eq("id", sample.id);

    if (updateSampleError) {
      console.error("Failed to update tone sample:", updateSampleError);
      return safeError(updateSampleError);
    }

    // 11. Update the organization's ai_system_prompt
    const { error: updateOrgError } = await supabase
      .from("doc_organizations")
      .update({ ai_system_prompt: tonePrompt })
      .eq("id", sample.org_id);

    if (updateOrgError) {
      console.error("Failed to update org system prompt:", updateOrgError);
      return safeError(updateOrgError);
    }

    return new Response(
      JSON.stringify({ data: { id: sample.id, status: "completed" } }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return safeError(err);
  }
});
