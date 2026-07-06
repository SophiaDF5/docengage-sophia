import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RATE_LIMIT_TIERS: Record<string, { max: number; windowSeconds: number }> = {
  write: { max: 10, windowSeconds: 60 },
  expensive: { max: 3, windowSeconds: 60 },
  auth: { max: 5, windowSeconds: 60 },
};

export async function rateLimit(
  userId: string,
  tier: string
): Promise<[true, null] | [null, Response]> {
  const config = RATE_LIMIT_TIERS[tier];
  if (!config) {
    return [true, null];
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const windowStart = new Date(
    Date.now() - config.windowSeconds * 1000
  ).toISOString();

  const key = `${tier}:${userId}`;

  const { count, error: countError } = await supabase
    .from("doc_rate_limits")
    .select("id", { count: "exact", head: true })
    .eq("key", key)
    .gte("created_at", windowStart);

  if (countError) {
    // Fail open on rate limit infrastructure errors
    return [true, null];
  }

  if ((count ?? 0) >= config.max) {
    return [
      null,
      new Response(
        JSON.stringify({ error: "Too many requests, please wait" }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(config.windowSeconds),
          },
        }
      ),
    ];
  }

  // Record this request
  await supabase
    .from("doc_rate_limits")
    .insert({ key, user_id: userId });

  return [true, null];
}
