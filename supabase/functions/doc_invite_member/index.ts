import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { safeError } from "../_shared/error-handler.ts";
import { validateBody, z } from "../_shared/validate.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const InviteMemberSchema = z.object({
  org_id: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(["admin", "member"]),
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Authenticate
    const [user, authError] = await requireAuth(req);
    if (authError) return authError;

    // 2. Rate limit
    const [, rateLimitError] = await rateLimit(user.id, "write");
    if (rateLimitError) return rateLimitError;

    // 3. Validate input
    const [body, validationError] = await validateBody(req, InviteMemberSchema);
    if (validationError) return validationError;

    // 4. Service client for admin operations
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 5. Verify caller is owner/admin of the target org
    const { data: callerMembership } = await adminClient
      .from("doc_organization_members")
      .select("role")
      .eq("user_id", user.id)
      .eq("org_id", body.org_id)
      .single();

    if (!callerMembership || !["owner", "admin"].includes(callerMembership.role)) {
      return new Response(
        JSON.stringify({ error: "Only owners and admins can invite members" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 6. Check if user already exists in auth
    const { data: existingUsers } = await adminClient.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find((u) => u.email === body.email);

    let invitedUserId: string;

    if (existingUser) {
      invitedUserId = existingUser.id;

      // Check if already a member of this org
      const { data: existingMember } = await adminClient
        .from("doc_organization_members")
        .select("id")
        .eq("user_id", invitedUserId)
        .eq("org_id", body.org_id)
        .maybeSingle();

      if (existingMember) {
        return new Response(
          JSON.stringify({ error: "User is already a member of this organization" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    } else {
      // 7. Create user via invite (sends email)
      const { data: newUser, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(
        body.email
      );

      if (inviteError || !newUser?.user) {
        console.error("Failed to invite user:", inviteError);
        return new Response(
          JSON.stringify({ error: "Failed to send invitation" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      invitedUserId = newUser.user.id;
    }

    // 8. Create organization membership
    const { error: memberError } = await adminClient
      .from("doc_organization_members")
      .insert({
        user_id: invitedUserId,
        org_id: body.org_id,
        role: body.role,
      });

    if (memberError) {
      console.error("Failed to create membership:", memberError);
      return new Response(
        JSON.stringify({ error: "Failed to add member to organization" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        data: {
          user_id: invitedUserId,
          org_id: body.org_id,
          role: body.role,
          invited: !existingUser,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return safeError(err);
  }
});
