import { corsHeaders } from "./cors.ts";

export function safeError(
  error: unknown,
  statusCode = 500
): Response {
  // Log the real error server-side for debugging
  console.error("Edge function error:", error);

  // Never return raw error details to the client
  const message =
    error instanceof Error && statusCode < 500
      ? error.message
      : "An unexpected error occurred";

  return new Response(
    JSON.stringify({ error: message }),
    {
      status: statusCode,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}
