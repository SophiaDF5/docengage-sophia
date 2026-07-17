// =============================================================================
// ABUSE TEST SCRIPT — DocEngage security verification
// =============================================================================
// Tests cross-account isolation, double-approval replay, auth bypass, and
// rate limiting.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
//     deno test --allow-net --allow-env tests/abuse-test.ts
//
// NOTE: There is no team/multi-user concept — every login is its own fully
// isolated account (see migration 012). Each user gets exactly one
// `doc_organizations` row (an internal per-account settings container, not a
// shared "organization"), auto-created on signup. These tests verify that
// User A and User B, as two entirely separate accounts, can never see or
// modify each other's data.
//
// The service_role key is used ONLY in this test script to set up test
// fixtures (create users, seed data). It is never used in app code except
// doc_inbound_post (Make.com webhook, no user session available).
// =============================================================================

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.103.3";
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

interface TestUser {
  id: string;
  token: string;
  client: SupabaseClient;
}

async function setupUser(creds: { email: string; password: string }): Promise<TestUser> {
  const { error: createError } = await admin.auth.admin.createUser({
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
let contactB_id: string;

async function cleanup() {
  for (const email of [USER_A.email, USER_B.email]) {
    const { data } = await admin.auth.admin.listUsers();
    const user = data?.users?.find((u) => u.email === email);
    if (user) {
      // Clean up in dependency order
      await admin.from("doc_comments").delete().eq("user_id", user.id);
      await admin.from("doc_posts").delete().eq("user_id", user.id);
      await admin.from("doc_contacts").delete().eq("user_id", user.id);
      await admin.from("doc_tone_samples").delete().eq("user_id", user.id);
      await admin.from("doc_organizations").delete().eq("user_id", user.id);
      await admin.auth.admin.deleteUser(user.id);
    }
  }
}

// ---------- Tests ----------

let userA: TestUser;
let userB: TestUser;

Deno.test({
  name: "Setup: Create test users and seed data",
  fn: async () => {
    await cleanup();
    userA = await setupUser(USER_A);
    userB = await setupUser(USER_B);
    assertNotEquals(userA.id, userB.id);

    // The doc_on_auth_user_created trigger (migration 012) auto-creates a
    // doc_organizations row for every new auth user. Fetch those rather
    // than inserting our own, so the test exercises the real signup path.
    const { data: oA, error: oAError } = await admin.from("doc_organizations")
      .select("id").eq("user_id", userA.id).single();
    if (oAError || !oA) throw new Error(`User A's account row was not auto-created: ${oAError?.message}`);
    orgA_id = oA.id;

    const { data: oB, error: oBError } = await admin.from("doc_organizations")
      .select("id").eq("user_id", userB.id).single();
    if (oBError || !oB) throw new Error(`User B's account row was not auto-created: ${oBError?.message}`);
    orgB_id = oB.id;

    // Create posts
    const { data: pA, error: pAError } = await admin.from("doc_posts")
      .insert({ user_id: userA.id, org_id: orgA_id, linkedin_post_url: "https://linkedin.com/test/a1", author_name: "Dr. TestA" })
      .select("id").single();
    if (pAError || !pA) throw new Error(`Failed to create post A: ${pAError?.message}`);
    postA_id = pA.id;

    const { data: pB, error: pBError } = await admin.from("doc_posts")
      .insert({ user_id: userB.id, org_id: orgB_id, linkedin_post_url: "https://linkedin.com/test/b1", author_name: "Dr. TestB" })
      .select("id").single();
    if (pBError || !pB) throw new Error(`Failed to create post B: ${pBError?.message}`);
    postB_id = pB.id;

    // Create pending comments
    const { data: cA, error: cAError } = await admin.from("doc_comments")
      .insert({ user_id: userA.id, post_id: postA_id, org_id: orgA_id, generated_content: "Test comment A", status: "pending" })
      .select("id").single();
    if (cAError || !cA) throw new Error(`Failed to create comment A: ${cAError?.message}`);
    commentA_id = cA.id;

    const { data: cB, error: cBError } = await admin.from("doc_comments")
      .insert({ user_id: userB.id, post_id: postB_id, org_id: orgB_id, generated_content: "Test comment B", status: "pending" })
      .select("id").single();
    if (cBError || !cB) throw new Error(`Failed to create comment B: ${cBError?.message}`);
    commentB_id = cB.id;

    // Create contacts
    const { data: kA, error: kAError } = await admin.from("doc_contacts")
      .insert({ user_id: userA.id, org_id: orgA_id, linkedin_profile_url: "https://linkedin.com/in/test-a", full_name: "Dr. Contact A" })
      .select("id").single();
    if (kAError || !kA) throw new Error(`Failed to create contact A: ${kAError?.message}`);

    const { data: kB, error: kBError } = await admin.from("doc_contacts")
      .insert({ user_id: userB.id, org_id: orgB_id, linkedin_profile_url: "https://linkedin.com/in/test-b", full_name: "Dr. Contact B" })
      .select("id").single();
    if (kBError || !kB) throw new Error(`Failed to create contact B: ${kBError?.message}`);
    contactB_id = kB.id;
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================
// Cross-Account Data Isolation
// ============================================================

Deno.test({
  name: "Isolation: User A cannot see User B's posts",
  fn: async () => {
    const { data } = await userA.client
      .from("doc_posts")
      .select("id")
      .eq("id", postB_id);
    assertEquals(data?.length ?? 0, 0, "User A should NOT see User B's post");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Isolation: User A cannot see User B's comments",
  fn: async () => {
    const { data } = await userA.client
      .from("doc_comments")
      .select("id")
      .eq("id", commentB_id);
    assertEquals(data?.length ?? 0, 0, "User A should NOT see User B's comment");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Isolation: User A cannot see User B's contacts",
  fn: async () => {
    const { data } = await userA.client
      .from("doc_contacts")
      .select("id")
      .eq("id", contactB_id);
    assertEquals(data?.length ?? 0, 0, "User A should NOT see User B's contact");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Isolation: User A cannot see User B's account settings row",
  fn: async () => {
    const { data } = await userA.client
      .from("doc_organizations")
      .select("id")
      .eq("id", orgB_id);
    assertEquals(data?.length ?? 0, 0, "User A should NOT see User B's account row");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Isolation: User A cannot update User B's post",
  fn: async () => {
    await userA.client
      .from("doc_posts")
      .update({ content: "Hacked" })
      .eq("id", postB_id);

    const { data } = await admin.from("doc_posts").select("content").eq("id", postB_id).single();
    assertNotEquals(data?.content, "Hacked", "User A should NOT modify User B's post");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Isolation: User A cannot delete User B's contact",
  fn: async () => {
    await userA.client.from("doc_contacts").delete().eq("id", contactB_id);

    const { data } = await admin.from("doc_contacts").select("id").eq("id", contactB_id);
    assertEquals(data?.length, 1, "User B's contact should NOT be deleted by User A");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Isolation: User A cannot update User B's account settings (auto_post_enabled)",
  fn: async () => {
    await userA.client
      .from("doc_organizations")
      .update({ auto_post_enabled: true })
      .eq("id", orgB_id);

    const { data } = await admin.from("doc_organizations")
      .select("auto_post_enabled")
      .eq("id", orgB_id)
      .single();
    assertEquals(data?.auto_post_enabled, false, "User A should NOT be able to change User B's settings");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "Isolation: User A cannot delete User B's account",
  fn: async () => {
    await userA.client
      .from("doc_organizations")
      .delete()
      .eq("id", orgB_id);

    const { data } = await admin.from("doc_organizations")
      .select("id")
      .eq("id", orgB_id);
    assertEquals(data?.length, 1, "User A should NOT be able to delete User B's account");
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
