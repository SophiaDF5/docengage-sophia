// Creates a brand new DocEngage account (login). Since Migration 012, every
// account is fully self-contained — creating the auth user is all that's
// needed. The doc_on_auth_user_created trigger automatically creates their
// doc_organizations row the instant this runs. No manual SQL insert needed.
//
// Usage:
//   node scripts/create-account.mjs someone@example.com "TheirPassword123!"

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

// Minimal .env loader (no "dotenv" package installed in this project) —
// reads KEY=VALUE lines from .env in the project root into process.env.
try {
  const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of envText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
} catch {
  console.error("Could not read .env in the project root — make sure it exists.");
  process.exit(1);
}

const [, , email, password] = process.argv;

if (!email || !password) {
  console.error("Usage: node scripts/create-account.mjs <email> <password>");
  process.exit(1);
}

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // bypasses RLS — local admin only, never in app code
);

const { data, error } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true, // skips the confirmation email — account is usable immediately
});

if (error) {
  console.error("Failed to create account:", error.message);
  process.exit(1);
}

console.log(`Account created for ${email} (user id: ${data.user.id})`);
console.log("Their account/organization row was auto-created by the signup trigger.");
console.log("They can log in immediately with the email + password above.");
