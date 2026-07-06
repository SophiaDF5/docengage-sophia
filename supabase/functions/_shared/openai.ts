/**
 * Shared OpenAI API helpers with retry/backoff.
 */

const OPENAI_BASE = "https://api.openai.com/v1";

function getApiKey(): string | null {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) console.error("OPENAI_API_KEY not configured");
  return key ?? null;
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.error(`Attempt ${attempt + 1} failed:`, err);
      if (attempt === maxRetries - 1) return null;
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return null;
}

/**
 * Call OpenAI chat completions (text-only).
 */
export async function callOpenAI(
  systemPrompt: string,
  userPrompt: string
): Promise<string | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  return retryWithBackoff(async () => {
    const response = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
      }),
    });

    if (response.status === 429) throw new Error("Rate limited");
    if (response.status >= 500) throw new Error(`OpenAI server error: ${response.status}`);
    if (!response.ok) {
      const errBody = await response.text();
      console.error("OpenAI error:", response.status, errBody);
      throw new Error(`OpenAI error ${response.status}: ${errBody}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? null;
  });
}

/**
 * Call OpenAI chat completions with an image (GPT-4o vision).
 */
export async function callOpenAIVision(
  systemPrompt: string,
  imageBase64: string,
  mimeType = "image/png"
): Promise<string | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  return retryWithBackoff(async () => {
    const response = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Read the LinkedIn post in this screenshot and draft a thoughtful comment.",
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${imageBase64}`,
                },
              },
            ],
          },
        ],
        temperature: 0.7,
        max_tokens: 1000,
      }),
    });

    if (response.status === 429) throw new Error("Rate limited");
    if (response.status >= 500) throw new Error(`OpenAI vision server error: ${response.status}`);
    if (!response.ok) {
      const errBody = await response.text();
      console.error("OpenAI vision error:", response.status, errBody);
      throw new Error(`OpenAI vision error ${response.status}: ${errBody}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? null;
  });
}
