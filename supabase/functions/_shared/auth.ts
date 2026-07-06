// =============================================================================
// AUTH MIDDLEWARE — JWT verification + user derivation
// =============================================================================
// Every edge function MUST call requireAuth() before any data access.
// Identity is ALWAYS derived from the JWT. Never from request body/query.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface AuthenticatedUser {
  id: string;
  email?: string;
}

/**
 * Verifies the JWT from the Authorization header and returns the authenticated user.
 * Returns a tuple: [user, errorResponse]
 * - If auth succeeds: [user, null]
 * - If auth fails: [null, Response] — return the Response immediately
 *
 * Usage:
 *   const [user, authError] = await requireAuth(req);
 *   if (authError) return authError;
 *   // user.id is now the verified user ID
 */
export async function requireAuth(
  req: Request
): Promise<[AuthenticatedUser, null] | [null, Response]> {
  const authHeader = req.headers.get("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return [
      null,
      new Response(JSON.stringify({ error: "Missing or invalid authorization header" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ];
  }

  const token = authHeader.replace("Bearer ", "");

  // Create a Supabase client with the user's JWT
  // This ensures all subsequent queries run in the user's RLS context
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  );

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return [
      null,
      new Response(JSON.stringify({ error: "Invalid or expired token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ];
  }

  return [{ id: user.id, email: user.email }, null];
}

/**
 * Creates a Supabase client scoped to the authenticated user's JWT.
 * All queries through this client are automatically filtered by RLS.
 *
 * Usage:
 *   const client = createUserClient(req);
 *   const { data } = await client.from("items").select("*");
 *   // Returns only the authenticated user's items
 */
export function createUserClient(req: Request) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";

  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  );
}
