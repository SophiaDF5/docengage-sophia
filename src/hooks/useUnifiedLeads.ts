import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "../lib/supabaseClient";
import type { Contact, ContactStatus, DmLead } from "../types/database";

export type SourceTable = "contacts" | "dm_leads";
export type FilterType = "scraped" | "manual" | "engaged";

export interface UnifiedLead {
  key: string; // `${sourceTable}:${id}`
  id: string;
  sourceTable: SourceTable;
  filterType: FilterType;
  full_name: string;
  linkedin_profile_url: string | null;
  headline: string | null;
  status: ContactStatus;
  tag: string | null;
}

// Merges doc_contacts (scraped + manual) and doc_dm_leads (engaged) into one
// list. Shared by Outreach, Engaged Leads, and Messaged Leads — anywhere
// that needs to look at leads across every source table at once, usually
// filtered further by each page's own criteria (status, source, etc.).
// Uses the exact same query keys (["contacts", orgId] / ["dm-leads", orgId])
// as Scraped Leads / Manual Added Leads / Engaged Leads, so a status change
// made anywhere invalidates the right cache and every consumer re-syncs —
// see the "Status sync" note in claude.md.
export function useUnifiedLeads(orgId: string | null) {
  const contactsQuery = useQuery({
    queryKey: ["contacts", orgId],
    queryFn: async () => {
      if (!orgId) return [];
      const { data, error } = await supabase
        .from("doc_contacts")
        .select(
          "id, user_id, org_id, linkedin_profile_url, full_name, headline, email, is_connected, status, source, custom_fields, tag, last_contacted_at, created_at, updated_at"
        )
        .eq("org_id", orgId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Contact[];
    },
    enabled: !!orgId,
    retry: 1,
  });

  const dmLeadsQuery = useQuery({
    queryKey: ["dm-leads", orgId],
    queryFn: async () => {
      if (!orgId) return [];
      const { data, error } = await supabase
        .from("doc_dm_leads")
        .select("*")
        .eq("org_id", orgId)
        .order("name");
      if (error) throw error;
      return data as DmLead[];
    },
    enabled: !!orgId,
    retry: 1,
  });

  useEffect(() => {
    if (contactsQuery.error || dmLeadsQuery.error) {
      const err = contactsQuery.error ?? dmLeadsQuery.error;
      toast.error(err instanceof Error ? `Failed to load leads: ${err.message}` : "Failed to load leads");
    }
  }, [contactsQuery.error, dmLeadsQuery.error]);

  const allLeads = useMemo<UnifiedLead[]>(() => {
    const fromContacts: UnifiedLead[] = (contactsQuery.data ?? []).map((c) => ({
      key: `contacts:${c.id}`,
      id: c.id,
      sourceTable: "contacts",
      filterType: c.source === "scraped" ? "scraped" : "manual",
      full_name: c.full_name,
      linkedin_profile_url: c.linkedin_profile_url,
      headline: c.headline,
      status: c.status,
      tag: c.tag,
    }));
    const fromDmLeads: UnifiedLead[] = (dmLeadsQuery.data ?? []).map((l) => ({
      key: `dm_leads:${l.id}`,
      id: l.id,
      sourceTable: "dm_leads",
      filterType: "engaged",
      full_name: l.name,
      linkedin_profile_url: l.linkedin_profile_url,
      headline: l.bio,
      status: l.status,
      tag: null,
    }));
    return [...fromContacts, ...fromDmLeads];
  }, [contactsQuery.data, dmLeadsQuery.data]);

  return {
    allLeads,
    contacts: contactsQuery.data ?? [],
    dmLeads: dmLeadsQuery.data ?? [],
    isLoading: contactsQuery.isLoading || dmLeadsQuery.isLoading,
    contactsQuery,
    dmLeadsQuery,
  };
}
