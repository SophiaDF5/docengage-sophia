// =============================================================================
// INPUT VALIDATION MIDDLEWARE (Zod)
// =============================================================================
// Every edge function that accepts a request body MUST validate it against
// a Zod schema before any database interaction.
//
// Why this matters:
// - Prevents type coercion attacks (string "50; DROP TABLE" as a number field)
// - Blocks logic abuse (negative quantities, oversized payloads)
// - Catches payload bloat before it hits the DB
// - Makes your function's contract explicit and self-documenting
//
// Install: Zod is available via esm.sh for Deno Edge Functions.
// =============================================================================

import { z, ZodSchema, ZodError } from "https://esm.sh/zod@3.23.8";

// Re-export z so functions can define schemas without a separate import
export { z };

// Maximum request body size (in bytes) — prevents memory exhaustion
// ADAPT: Adjust based on your needs. 100KB is generous for most JSON payloads.
const MAX_BODY_SIZE = 100 * 1024; // 100KB

/**
 * Parses and validates a request body against a Zod schema.
 * Returns a tuple: [validatedData, errorResponse]
 * - If valid: [data, null]
 * - If invalid: [null, Response] — return the Response immediately
 *
 * Usage:
 *   const CreateItemSchema = z.object({
 *     name: z.string().min(1).max(200),
 *     quantity: z.number().int().positive().max(10000),
 *     tags: z.array(z.string().max(50)).max(20).optional(),
 *   });
 *
 *   const [body, validationError] = await validateBody(req, CreateItemSchema);
 *   if (validationError) return validationError;
 *   // body is now typed and safe to use
 */
export async function validateBody<T>(
  req: Request,
  schema: ZodSchema<T>
): Promise<[T, null] | [null, Response]> {
  // Check content length before reading body
  const contentLength = req.headers.get("Content-Length");
  if (contentLength && parseInt(contentLength) > MAX_BODY_SIZE) {
    return [
      null,
      new Response(JSON.stringify({ error: "Request body too large" }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      }),
    ];
  }

  // Parse JSON body
  let rawBody: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_SIZE) {
      return [
        null,
        new Response(JSON.stringify({ error: "Request body too large" }), {
          status: 413,
          headers: { "Content-Type": "application/json" },
        }),
      ];
    }
    rawBody = JSON.parse(text);
  } catch {
    return [
      null,
      new Response(JSON.stringify({ error: "Invalid JSON in request body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    ];
  }

  // Validate against schema
  try {
    const validated = schema.parse(rawBody);
    return [validated, null];
  } catch (err) {
    if (err instanceof ZodError) {
      // Return user-friendly validation errors
      // but don't expose internal schema details
      const issues = err.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));

      return [
        null,
        new Response(
          JSON.stringify({
            error: "Validation failed",
            details: issues,
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        ),
      ];
    }

    return [
      null,
      new Response(JSON.stringify({ error: "Validation error" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    ];
  }
}

/**
 * Validates query/URL parameters against a schema.
 * Useful for GET endpoints with search params.
 *
 * Usage:
 *   const QuerySchema = z.object({
 *     page: z.coerce.number().int().positive().default(1),
 *     limit: z.coerce.number().int().min(1).max(100).default(20),
 *   });
 *
 *   const [params, paramError] = validateParams(req, QuerySchema);
 *   if (paramError) return paramError;
 */
export function validateParams<T>(
  req: Request,
  schema: ZodSchema<T>
): [T, null] | [null, Response] {
  const url = new URL(req.url);
  const rawParams = Object.fromEntries(url.searchParams.entries());

  try {
    const validated = schema.parse(rawParams);
    return [validated, null];
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));

      return [
        null,
        new Response(
          JSON.stringify({ error: "Invalid query parameters", details: issues }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        ),
      ];
    }

    return [
      null,
      new Response(JSON.stringify({ error: "Parameter validation error" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    ];
  }
}
