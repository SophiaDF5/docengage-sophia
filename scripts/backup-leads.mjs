// Manual backup for DocEngage — since the free Supabase plan has no
// automatic backups or Point-in-Time Recovery, this is the safety net.
// Dumps every lead-related table to a single timestamped JSON file in
// backups/ (gitignored — never committed, since it contains real lead
// data/emails). Run this regularly, and always before doing any manual
// cleanup in the Supabase SQL Editor.
//
// Usage:
//   node scripts/backup-leads.mjs
//
// To restore from a backup file, send the file to Claude and ask for
// help writing the restore — don't guess at it yourself.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

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

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // bypasses RLS — local admin only, backs up every account
);

const TABLES = [
  "doc_organizations",
  "doc_contacts",
  "doc_dm_leads",
  "doc_outreach_messages",
  "doc_dm_drafts",
];

async function main() {
  const backup = {
    taken_at: new Date().toISOString(),
    tables: {},
  };

  let totalRows = 0;

  for (const table of TABLES) {
    const { data, error } = await supabase.from(table).select("*");
    if (error) {
      console.error(`Failed to back up ${table}:`, error.message);
      process.exit(1);
    }
    backup.tables[table] = data;
    totalRows += data.length;
    console.log(`  ${table}: ${data.length} rows`);
  }

  mkdirSync(new URL("../backups/", import.meta.url), { recursive: true });

  const stamp = backup.taken_at.replace(/[:.]/g, "-");
  const filePath = new URL(`../backups/backup-${stamp}.json`, import.meta.url);
  writeFileSync(filePath, JSON.stringify(backup, null, 2));

  console.log(`\nBackup saved: backups/backup-${stamp}.json`);
  console.log(`Total rows backed up: ${totalRows}`);
}

main();
