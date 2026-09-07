import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "../lib/supabaseClient";
import type { Organization } from "../types/database";

const CURRENT_ORG_STORAGE_KEY = "doc_current_org_id";

const ORG_COLUMNS = "id, user_id, name, auto_post_enabled, ai_system_prompt, created_at, updated_at";

// Supabase/PostgREST errors (RLS violations, constraint failures, etc.) are
// plain objects shaped like `{ message, details, hint, code }` — they are
// NOT `instanceof Error`, so `err instanceof Error ? err.message : fallback`
// (the pattern used elsewhere in this app) always falls through to the
// generic fallback text for exactly the errors most worth seeing. This pulls
// `.message` off anything that has one, Error or not, so real failures
// (e.g. an RLS policy rejecting the insert) show their actual reason instead
// of a generic "Failed to..." with no way to diagnose it.
function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return fallback;
}

// Reina asked to support separate, fully isolated "workspaces" under one
// login (e.g. one per client) — see claude.md's "Account model" section for
// the full history. The backend needed ZERO RLS/schema changes for this:
// doc_user_org_ids() (migration 012) is defined as
// `select id from doc_organizations where user_id = auth.uid()` — a
// set-returning function that already returns EVERY org row a user owns,
// not just one, and there was never a unique constraint on user_id. "One
// org per user" was only ever a product/UX convention (exactly one
// auto-created row, no UI to make more) — never a hard DB limit. So this
// hook is essentially the whole feature on the read side: fetch every org
// the user owns, track which one is "current," and the rest of the app
// keeps working unchanged, since every page already scopes every query by
// currentOrgId.
export function useOrganization() {
  const queryClient = useQueryClient();
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CURRENT_ORG_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("doc_organizations")
        .select(ORG_COLUMNS)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Organization[];
    },
  });

  const organizations = orgsQuery.data ?? [];

  // Resolved at render time rather than synced into state via a useEffect —
  // deriving it here avoids an extra render on every mismatch and is simpler
  // besides. Falls back to the earliest-created workspace whenever the
  // stored selection doesn't match any of THIS account's own orgs: covers
  // first-ever load (nothing selected yet), the previously selected
  // workspace having been deleted, and a stale id left by a different
  // account on this browser (org ids are random UUIDs, so a stale id can
  // never coincidentally match another account's — worst case it just
  // resets to this account's own first workspace).
  const currentOrgId =
    selectedOrgId !== null && organizations.some((o) => o.id === selectedOrgId)
      ? selectedOrgId
      : (organizations[0]?.id ?? null);

  const switchOrg = (orgId: string) => {
    setSelectedOrgId(orgId);
    try {
      localStorage.setItem(CURRENT_ORG_STORAGE_KEY, orgId);
    } catch {
      // Storage can fail (private browsing, quota) — worst case the
      // selection just doesn't survive a reload, not a correctness issue.
    }
  };

  const createOrgMutation = useMutation({
    mutationFn: async (name: string) => {
      const { data, error } = await supabase
        .from("doc_organizations")
        .insert({ name: name.trim() || "New Workspace" })
        .select(ORG_COLUMNS)
        .single();
      if (error) throw error;
      return data as Organization;
    },
    onSuccess: (newOrg) => {
      // Write the new row straight into the cache instead of just
      // invalidating — invalidate+refetch is async, and switchOrg() below
      // would otherwise race it: currentOrgId's derivation above would see
      // the new id "doesn't exist yet" in the still-stale cached list and
      // immediately fall back to the old first workspace instead. Setting
      // the cache synchronously avoids that race entirely.
      queryClient.setQueryData<Organization[]>(["organizations"], (old) => [
        ...(old ?? []),
        newOrg,
      ]);
      switchOrg(newOrg.id);
      toast.success(`"${newOrg.name}" workspace created`);
    },
    onError: (err) => {
      toast.error(errorMessage(err, "Failed to create workspace"));
    },
  });

  // Deletion cascades — every table's org_id FK is `on delete cascade`, so
  // deleting a workspace permanently wipes all of its leads, comments, DMs,
  // and outreach history. There's no undo and the free Supabase plan has no
  // automatic backups (see scripts/backup-leads.mjs). The UI-side
  // confirmation for this lives in Settings.tsx's danger zone, not here.
  const deleteOrgMutation = useMutation({
    mutationFn: async (orgId: string) => {
      const { error } = await supabase.from("doc_organizations").delete().eq("id", orgId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      toast.success("Workspace deleted");
    },
    onError: (err) => {
      toast.error(errorMessage(err, "Failed to delete workspace"));
    },
  });

  const renameOrgMutation = useMutation({
    mutationFn: async ({ orgId, name }: { orgId: string; name: string }) => {
      const { error } = await supabase
        .from("doc_organizations")
        .update({ name: name.trim() })
        .eq("id", orgId);
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      queryClient.setQueryData<Organization[]>(["organizations"], (old) =>
        (old ?? []).map((o) => (o.id === variables.orgId ? { ...o, name: variables.name.trim() } : o))
      );
      toast.success("Workspace renamed");
    },
    onError: (err) => {
      toast.error(errorMessage(err, "Failed to rename workspace"));
    },
  });

  const currentOrg = organizations.find((o) => o.id === currentOrgId) ?? null;

  return {
    organizations,
    currentOrg,
    currentOrgId: currentOrg?.id ?? null,
    isLoading: orgsQuery.isLoading,
    switchOrg,
    createOrg: (name: string) => createOrgMutation.mutateAsync(name),
    isCreatingOrg: createOrgMutation.isPending,
    deleteOrg: (orgId: string) => deleteOrgMutation.mutateAsync(orgId),
    isDeletingOrg: deleteOrgMutation.isPending,
    renameOrg: (orgId: string, name: string) => renameOrgMutation.mutateAsync({ orgId, name }),
    isRenamingOrg: renameOrgMutation.isPending,
  };
}
