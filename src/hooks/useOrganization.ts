import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { supabase } from "../lib/supabaseClient";
import type { Organization, OrganizationMember } from "../types/database";

export function useOrganization() {
  const [currentOrgId, setCurrentOrgId] = useState<string | null>(() => {
    return localStorage.getItem("doc_current_org_id");
  });

  useEffect(() => {
    if (currentOrgId) {
      localStorage.setItem("doc_current_org_id", currentOrgId);
    }
  }, [currentOrgId]);

  const membershipsQuery = useQuery({
    queryKey: ["memberships"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("doc_organization_members")
        .select("id, user_id, org_id, role, created_at, updated_at");
      if (error) throw error;
      return data as OrganizationMember[];
    },
  });

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("doc_organizations")
        .select("id, user_id, name, auto_post_enabled, ai_system_prompt, created_at, updated_at");
      if (error) throw error;
      return data as Organization[];
    },
  });

  // Auto-select first org if none selected or stored org no longer exists
  useEffect(() => {
    if (orgsQuery.data && orgsQuery.data.length > 0) {
      const validOrg = orgsQuery.data.find((o) => o.id === currentOrgId);
      if (!validOrg) {
        setCurrentOrgId(orgsQuery.data[0].id);
      }
    }
  }, [currentOrgId, orgsQuery.data]);

  const currentOrg = orgsQuery.data?.find((o) => o.id === currentOrgId) ?? null;
  const currentMembership = membershipsQuery.data?.find(
    (m) => m.org_id === currentOrgId
  ) ?? null;

  return {
    organizations: orgsQuery.data ?? [],
    memberships: membershipsQuery.data ?? [],
    currentOrg,
    currentOrgId,
    currentMembership,
    setCurrentOrgId,
    isLoading: orgsQuery.isLoading || membershipsQuery.isLoading,
  };
}
