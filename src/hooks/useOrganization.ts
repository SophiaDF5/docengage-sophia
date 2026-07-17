import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabaseClient";
import type { Organization } from "../types/database";

// There is no multi-user/team concept — every login has exactly one
// account row (`doc_organizations`, kept as the internal table name for
// historical reasons; see migration 012), auto-created the moment they
// sign up. RLS guarantees this query only ever returns that one row, so
// there's nothing to "switch" or "select" — just the caller's own data.
export function useOrganization() {
  const orgQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("doc_organizations")
        .select("id, user_id, name, auto_post_enabled, ai_system_prompt, created_at, updated_at")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as Organization | null;
    },
  });

  return {
    currentOrg: orgQuery.data ?? null,
    currentOrgId: orgQuery.data?.id ?? null,
    isLoading: orgQuery.isLoading,
  };
}
