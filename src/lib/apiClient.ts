import { supabase } from "./supabaseClient";

export async function callEdgeFunction<T = unknown>(
  functionName: string,
  body?: Record<string, unknown>
): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${functionName}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: body ? JSON.stringify(body) : undefined,
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || `Edge function error: ${response.status}`);
  }

  return response.json();
}

// For edge functions that must be callable before a session exists —
// registration and email verification. Uses the public anon key as the
// bearer token (it's a validly-signed project JWT, which is all Supabase's
// gateway checks) instead of a user's session token. The functions
// themselves (doc_register, doc_verify_email, doc_resend_code) never call
// requireAuth() — see the comments in each for why service_role is used
// instead.
export async function callPublicEdgeFunction<T = unknown>(
  functionName: string,
  body?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${functionName}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: body ? JSON.stringify(body) : undefined,
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || `Edge function error: ${response.status}`);
  }

  return response.json();
}
