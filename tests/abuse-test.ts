// =============================================================================
// ABUSE TEST SCRIPT — DocEngage security verification
// =============================================================================
// Tests cross-org isolation, double-approval replay, privilege escalation,
// auth bypass, and rate limiting.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
//     deno test --allow-net --allow-env tests/abuse-test.ts
//
// NOTE: The service_role key is used ONLY in this test script to set up
// test fixtures (create users, seed data). It is never used in app code
// except doc_daily_followups (cron).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  assertEquals,
  assertNotEquals,
  assert,
} from "https://deno.land/std@0.220.0/assert/mod.ts";

// ---------- Setup ----------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const USER_A = { email: "test-user-a@docengage.test", password: "TestPassword123!" };
const USER_B = { email: "test-user-b@docengage.test", password: "TestPassword456!" };
const USER_C = { email: "test-user-c@docengage.test", password: "TestPassword789!" };

interface TestUser {
  id: string;
  token: string;
  client: ReturnType<typeof createClient>;
}

async function setupUser(creds: { email: string; password: string }): Promise<TestUser> {
  const { data: authData, error: createError } = await admin.auth.admin.createUser({
    email: creds.email,
    password: creds.password,
    email_confirm: true,
  });
  if (createError && !createError.message.includes("already been registered")) {
    throw new Error(`Failed to create user: ${createError.message}`);
  }

  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn, error: signInError } = await anonClient.auth.signInWithPassword({
    email: creds.email,
    password: creds.password,
  });
  if (signInError) throw new Error(`Failed to sign in: ${signInError.message}`);

  const token = signIn.session!.access_token;
  const userId = signIn.user!.id;

  const client = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  return { id: userId, token, client };
}

// Test fixture IDs
let orgA_id: string;
let orgB_id: string;
let postA_id: string;
let postB_id: string;
let commentA_id: string;
let commentB_id: string;
let contactA_id: string;
let contactB_id: string;

async function cleanup() {
  for (const email of [USER_A.email, USER_B.email, USER_C.email]) {
    const { data } = await admin.auth.admin.listUsers();
    const user = data?.users?.find((u) => u.email === email);
    if (user) {
      // Clean up in dependency order
      await admin.from("doc_comments").delete().eq("user_id", user.id);
      await admin.from("doc_posts").delete().eq("user_id", user.id);
      await admin.from("doc_contacts").delete().eq("user_id", user.id);
      await admin.from("doc_tone_samples").delete().eq("user_id", user.id);
      await admin.from("doc_organization_members").delete().eq("user_id", user.id);
      await admin.from("doc_organizations").delete().eq("user_id", user.id);
      await admin.auth.admin.deleteUser(user.id);
    }
  }
}

// ---------- Tests ----------

let userA: TestUser;
let userB: TestUser;
let userC: TestUser;

Deno.test({
  name: "Setup: Create test users and seed data",
  fn: async () => {
    await cleanup();
    userA = await setupUser(USER_A);
    userB = await setupUser(USER_B);
    userC = await setupUser(USER_C);
    assertNotEquals(userA.id, userB.id);
    assertNotEquals(userA.id, userC.id);

    // Create orgs via service role (bypasses RLS for test setup)
    const { data: oA } = await admin.from("doc_organizations")
      .insert({ user_id: userA.id, name: "Test Org A" })
      .select("id").single();
    orgA_id = oA!.id;

    const { data: oB } = await admin.from("doc_organizations")
      .insert({ user_id: userB.id, name: "Test Org B" })
      .select("id").single();
    orgB_id = oB!.id;

    // Create memberships
    await admin.from("doc_organization_members").insert([
      { user_id: userA.id, org_id: orgA_id, role: "owner" },
      { user_id: userB.id, org_id: orgB_id, role: "owner" },
      { user_id: userC.id, org_id: orgA_id, role: "member" }, // C is member of A's org
    ]);

    // Create posts
    const { data: pA } = await admin.from("doc_posts")
      .insert({ user_id: userA.id, org_id: orgA_id, linkedin_post_url: "https://linkedin.com/test/a1", author_name: "Dr. TestA" })
      .select("id").single();
    postA_id = pA!.id;

    const { data: pB } = await admin.from("doc_posts")
      .insert({ user_id: userB.id, org_id: orgB_id, linkedin_post_url: "https://linkedin.com/test/b1", author_name: "Dr. TestB" })
      .select("id").single();
    postB_id = pB!.id;

    // Create pending comments
    const { data: cA } = await admin.from("doc_comments")
      .insert({ user_id: userA.id, post_id: postA_id, org_id: orgA_id, generated_content: "Test comment A", status: "pending" })
      .select("id").single();
    commentA_id = cA!.id;

    const { data: cB } = await admin.from("doc_comments")
      .insert({ user_id: userB.id, post_id: postB_id, org_id: orgB_id, generated_content: "Test comment B", status: "pending" })
      .select("id").single();
    commentB_id = cB!.id;

    // Create contacts
    const { data: kA } = await admin.from("doc_contacts")
      .insert({ user_id: userA.id, org_id: orgA_id, linkedin_profile_url: "https://linkedin.com/in/test-a", full_name: "Dr. Contact A" })
      .select("id").single();
    contactA_id = kA!.id;

    const { data: kB } = await admin.from("doc_contacts")
      .insert({ user_id: userB.id, org_id: orgB_id, linkedin_profile_url: "https://linkedin.com/in/test-b", full_name: "Dr. Contact B" })
      .select("id").single();
    contactB_id = kB!.id;
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================
// Cross-Org Data Isolation
// ============================================================

Deno.test({
  name: "Isolation: User A cannot see Org B's posts",
  fn: async () => {
    const { data } = await userA.client
      .from("doc_posts")
      .select("id")
      .eq("id", postB_id);
    assertEquals(data?.length ?? 0, 0, "User A should NOT see Org B's post");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Isolation: User A cannot see Org B's comments",
  fn: async () => {
    const { data } = await userA.client
      .from("doc_comments")
      .select("id")
      .eq("id", commentB_id);
    assertEquals(data?.length ?? 0, 0, "User A should NOT see Org B's comment");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Isolation: User A cannot see Org B's contacts",
  fn: async () => {
    const { data } = await userA.client
      .from("doc_contacts")
      .select("id")
      .eq("id", contactB_id);
    assertEquals(data?.length ?? 0, 0, "User A should NOT see Org B's contact");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Isolation: User A cannot see Org B's organization",
  fn: async () => {
    const { data } = await userA.client
      .from("doc_organizations")
      .select("id")
      .eq("id", orgB_id);
    assertEquals(data?.length ?? 0, 0, "User A should NOT see Org B");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Isolation: User A cannot update Org B's post",
  fn: async () => {
    await userA.client
      .from("doc_posts")
      .update({ content: "Hacked" })
      .eq("id", postB_id);

    const { data } = await admin.from("doc_posts").select("content").eq("id", postB_id).single();
    assertNotEquals(data?.content, "Hacked", "User A should NOT modify Org B's post");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Isolation: User A cannot delete Org B's contact",
  fn: async () => {
    await userA.client.from("doc_contacts").delete().eq("id", contactB_id);

    const { data } = await admin.from("doc_contacts").select("id").eq("id", contactB_id);
    assertEquals(data?.length, 1, "Org B's contact should NOT be deleted by User A");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================
// Cross-User Org Access (User C as member of Org A)
// ============================================================

Deno.test({
  name: "Org access: User C (member) CAN see Org A's posts",
  fn: async () => {
    const { data } = await userC.client
      .from("doc_posts")
      .select("id")
      .eq("id", postA_id);
    assertEquals(data?.length, 1, "User C should see Org A's post as a member");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Org access: User C (member) CAN see Org A's comments",
  fn: async () => {
    const { data } = await userC.client
      .from("doc_comments")
      .select("id")
      .eq("id", commentA_id);
    assertEquals(data?.length, 1, "User C should see Org A's comment as a member");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Org access: User C (member) cannot see Org B's posts",
  fn: async () => {
    const { data } = await userC.client
      .from("doc_posts")
      .select("id")
      .eq("id", postB_id);
    assertEquals(data?.length ?? 0, 0, "User C should NOT see Org B's post");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================
// Double-Approval Replay Prevention
// ============================================================

Deno.test({
  name: "Replay: Cannot approve an already-approved comment",
  fn: async () => {
    // First approval (via direct DB to avoid needing Make.com)
    await admin.from("doc_comments")
      .update({ status: "approved", approved_by: userA.id })
      .eq("id", commentA_id);

    // Try to approve again via edge function
    const response = await fetch(`${FUNCTIONS_URL}/doc_approve_comment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userA.token}`,
      },
      body: JSON.stringify({
        comment_id: commentA_id,
        edited_content: "Double approval attempt",
      }),
    });

    const body = await response.json();
    assert(
      response.status === 400 || body.error?.includes("not in pending"),
      "Should reject double-approval"
    );

    // Reset for other tests
    await admin.from("doc_comments")
      .update({ status: "pending", approved_by: null })
      .eq("id", commentA_id);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================
// Privilege Escalation
// ============================================================

Deno.test({
  name: "Privilege: Member (User C) cannot update org settings (auto_post_enabled)",
  fn: async () => {
    // User C (member) tries to enable auto_post on Org A
    await userC.client
      .from("doc_organizations")
      .update({ auto_post_enabled: true })
      .eq("id", orgA_id);

    // Verify it didn't change
    const { data } = await admin.from("doc_organizations")
      .select("auto_post_enabled")
      .eq("id", orgA_id)
      .single();
    assertEquals(data?.auto_post_enabled, false, "Member should NOT be able to change auto_post_enabled");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Privilege: Member (User C) cannot add members to org",
  fn: async () => {
    const { error } = await userC.client
      .from("doc_organization_members")
      .insert({ user_id: userB.id, org_id: orgA_id, role: "member" });

    assert(error !== null, "Member should NOT be able to invite others (requires admin/owner)");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Privilege: Member (User C) cannot delete the organization",
  fn: async () => {
    await userC.client
      .from("doc_organizations")
      .delete()
      .eq("id", orgA_id);

    const { data } = await admin.from("doc_organizations")
      .select("id")
      .eq("id", orgA_id);
    assertEquals(data?.length, 1, "Member should NOT be able to delete the org");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Privilege: User A cannot escalate own role via direct update",
  fn: async () => {
    // User B tries to change their role in Org B from owner to... still owner (no escalation path)
    // But User A tries to insert themselves as admin in Org B
    const { error } = await userA.client
      .from("doc_organization_members")
      .insert({ user_id: userA.id, org_id: orgB_id, role: "admin" });

    assert(error !== null, "User A should NOT be able to add themselves to Org B");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================
// Auth & Edge Function Tests
// ============================================================

Deno.test({
  name: "Auth: doc_approve_comment rejects request without JWT",
  fn: async () => {
    const response = await fetch(`${FUNCTIONS_URL}/doc_approve_comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        comment_id: commentA_id,
        edited_content: "Should fail",
      }),
    });
    assertEquals(response.status, 401, "Should return 401 without JWT");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Auth: doc_approve_comment rejects invalid JWT",
  fn: async () => {
    const response = await fetch(`${FUNCTIONS_URL}/doc_approve_comment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid.jwt.token",
      },
      body: JSON.stringify({
        comment_id: commentA_id,
        edited_content: "Should fail",
      }),
    });
    assertEquals(response.status, 401, "Should return 401 with invalid JWT");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Auth: doc_inbound_post rejects wrong secret token",
  fn: async () => {
    const response = await fetch(`${FUNCTIONS_URL}/doc_inbound_post`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
      body: JSON.stringify({
        org_id: orgA_id,
        linkedin_post_url: "https://linkedin.com/post/bad",
        author_name: "Attacker",
        content: "Should fail",
        secret_token: "wrong-secret",
      }),
    });
    assertEquals(response.status, 401, "Should return 401 for wrong secret token");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================
// Input Validation
// ============================================================

Deno.test({
  name: "Validation: doc_approve_comment rejects content over 3000 chars",
  fn: async () => {
    const response = await fetch(`${FUNCTIONS_URL}/doc_approve_comment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userA.token}`,
      },
      body: JSON.stringify({
        comment_id: commentA_id,
        edited_content: "x".repeat(3001),
      }),
    });
    assertEquals(response.status, 400, "Should return 400 for oversized content");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Validation: doc_approve_comment rejects missing fields",
  fn: async () => {
    const response = await fetch(`${FUNCTIONS_URL}/doc_approve_comment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userA.token}`,
      },
      body: JSON.stringify({}),
    });
    assertEquals(response.status, 400, "Should return 400 for missing fields");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Validation: doc_inbound_post rejects missing required fields",
  fn: async () => {
    const response = await fetch(`${FUNCTIONS_URL}/doc_inbound_post`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
      },
      body: JSON.stringify({
        org_id: orgA_id,
        // Missing linkedin_post_url, author_name, content, secret_token
      }),
    });
    assertEquals(response.status, 400, "Should return 400 for missing required fields");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================
// Rate Limiting
// ============================================================

Deno.test({
  name: "Rate limit: doc_approve_comment triggers 429 after excessive requests",
  fn: async () => {
    // Send 15 rapid requests (write tier allows 10/min)
    const promises = [];
    for (let i = 0; i < 15; i++) {
      promises.push(
        fetch(`${FUNCTIONS_URL}/doc_approve_comment`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userA.token}`,
          },
          body: JSON.stringify({
            comment_id: commentA_id,
            edited_content: `Rate limit test ${i}`,
          }),
        })
      );
    }

    const responses = await Promise.all(promises);
    const statuses = responses.map((r) => r.status);

    assert(
      statuses.includes(429),
      "Should get at least one 429 after exceeding write rate limit (10/min)"
    );
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================
// Cleanup
// ============================================================

Deno.test({
  name: "Cleanup: Remove test users and data",
  fn: async () => {
    await cleanup();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
