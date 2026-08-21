import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "../lib/supabaseClient";
import { useOrganization } from "../hooks/useOrganization";
import { CustomFieldsDialog } from "../components/CustomFieldsDialog";
import { EditContactDialog } from "../components/EditContactDialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { ChevronDown, ExternalLink, Loader2, Pencil, Plus, Trash2, UserCircle } from "lucide-react";
import type { Contact, ContactStatus, DmLead } from "../types/database";

const STATUS_OPTIONS: { value: ContactStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "invited", label: "Invited" },
  { value: "messaged", label: "Messaged" },
  { value: "engaged", label: "Engaged" },
];

const statusBadgeVariant: Record<ContactStatus, "outline" | "default" | "secondary"> = {
  pending: "outline",
  invited: "secondary",
  messaged: "default",
  engaged: "secondary",
};

// Either a "native" doc_dm_leads row, or a doc_contacts row (Scraped/Manual)
// that's merged in here because its status is Messaged or Engaged. Kept as
// a discriminated union rather than mapping both into one flattened shape,
// so edits/deletes always write back to whichever table the row actually
// lives in.
type EngagedCard =
  | { sourceTable: "dm_leads"; key: string; lead: DmLead }
  | { sourceTable: "contacts"; key: string; lead: Contact };

export function Leads() {
  const { currentOrgId } = useOrganization();
  const queryClient = useQueryClient();

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");

  const leadsQuery = useQuery({
    queryKey: ["dm-leads", currentOrgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("doc_dm_leads")
        .select("*")
        .eq("org_id", currentOrgId!)
        .order("name");
      if (error) throw error;
      return data as DmLead[];
    },
    enabled: !!currentOrgId,
    retry: 1,
  });

  // Same query key/shape used by Scraped Leads, Manual Added Leads, and
  // Outreach. A Scraped or Manual lead whose status becomes "messaged" or
  // "engaged" shows up here too, without creating a duplicate row — it's
  // the exact same doc_contacts data, just also rendered on this page.
  const contactsQuery = useQuery({
    queryKey: ["contacts", currentOrgId],
    queryFn: async () => {
      if (!currentOrgId) return [];
      const { data, error } = await supabase
        .from("doc_contacts")
        .select(
          "id, user_id, org_id, linkedin_profile_url, full_name, headline, email, is_connected, status, source, custom_fields, tag, last_contacted_at, created_at, updated_at"
        )
        .eq("org_id", currentOrgId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Contact[];
    },
    enabled: !!currentOrgId,
    retry: 1,
  });

  useEffect(() => {
    if (leadsQuery.error || contactsQuery.error) {
      const err = leadsQuery.error ?? contactsQuery.error;
      toast.error(
        err instanceof Error ? `Failed to load leads: ${err.message}` : "Failed to load leads"
      );
    }
  }, [leadsQuery.error, contactsQuery.error]);

  const engagedContacts = useMemo(
    () => (contactsQuery.data ?? []).filter((c) => c.status === "messaged" || c.status === "engaged"),
    [contactsQuery.data]
  );

  const cards = useMemo<EngagedCard[]>(() => {
    const fromDm: EngagedCard[] = [...(leadsQuery.data ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((lead) => ({ sourceTable: "dm_leads" as const, key: `dm_leads:${lead.id}`, lead }));
    const fromContacts: EngagedCard[] = [...engagedContacts]
      .sort((a, b) => a.full_name.localeCompare(b.full_name))
      .map((lead) => ({ sourceTable: "contacts" as const, key: `contacts:${lead.id}`, lead }));
    return [...fromDm, ...fromContacts];
  }, [leadsQuery.data, engagedContacts]);

  const isLoading = leadsQuery.isLoading || contactsQuery.isLoading;

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (editingId) {
        const { error } = await supabase
          .from("doc_dm_leads")
          .update({
            name,
            bio: bio || null,
            linkedin_profile_url: linkedinUrl || null,
          })
          .eq("id", editingId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("doc_dm_leads").insert({
          org_id: currentOrgId!,
          name,
          bio: bio || null,
          linkedin_profile_url: linkedinUrl || null,
          status: "pending",
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dm-leads", currentOrgId] });
      toast.success(editingId ? "Lead updated" : "Lead saved");
      resetForm();
    },
    onError: () => toast.error("Failed to save lead"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("doc_dm_leads").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dm-leads", currentOrgId] });
      toast.success("Lead deleted");
    },
    onError: () => toast.error("Failed to delete lead"),
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({
      sourceTable,
      id,
      status,
    }: {
      sourceTable: "dm_leads" | "contacts";
      id: string;
      status: ContactStatus;
    }) => {
      const table = sourceTable === "contacts" ? "doc_contacts" : "doc_dm_leads";
      const { error } = await supabase
        .from(table)
        .update({ status, last_contacted_at: status === "messaged" ? new Date().toISOString() : undefined })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dm-leads", currentOrgId] });
      queryClient.invalidateQueries({ queryKey: ["contacts", currentOrgId] });
    },
    onError: () => toast.error("Failed to update status"),
  });

  function resetForm() {
    setShowForm(false);
    setEditingId(null);
    setName("");
    setBio("");
    setLinkedinUrl("");
  }

  function startEdit(lead: DmLead) {
    setEditingId(lead.id);
    setName(lead.name);
    setBio(lead.bio || "");
    setLinkedinUrl(lead.linkedin_profile_url || "");
    setShowForm(true);
  }

  if (!currentOrgId) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No organization selected.
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Engaged Leads</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Doctors and contacts you message regularly, plus any Scraped or Manual Added lead
            you've marked Messaged or Engaged.
          </p>
        </div>
        {!showForm && (
          <Button onClick={() => { resetForm(); setShowForm(true); }}>
            <Plus className="h-4 w-4 mr-1" />
            Add Lead
          </Button>
        )}
      </div>

      {/* Form */}
      {showForm && (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <p className="text-sm font-medium">{editingId ? "Edit Lead" : "New Lead"}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Dr. Jane Smith"
                />
              </div>
              <div className="space-y-1">
                <Label>LinkedIn URL</Label>
                <Input
                  value={linkedinUrl}
                  onChange={(e) => setLinkedinUrl(e.target.value)}
                  placeholder="https://linkedin.com/in/..."
                  type="url"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Bio / Notes</Label>
              <Textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Their specialty, interests, how you know them..."
                rows={3}
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={!name.trim() || saveMutation.isPending}
              >
                {saveMutation.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                {editingId ? "Update" : "Save"}
              </Button>
              <Button variant="outline" onClick={resetForm}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lead list */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : cards.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <UserCircle className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No leads yet. Add one to get started.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {cards.map((card) => {
            const { lead, sourceTable } = card;
            const displayName = sourceTable === "dm_leads" ? lead.name : lead.full_name;
            const displayBio = sourceTable === "dm_leads" ? lead.bio : lead.headline;
            const customFields = lead.custom_fields ?? {};
            // Both doc_contacts and doc_dm_leads carry a tag as of migration
            // 014 — e.g. "Invited", set from Outreach.
            const tag = lead.tag;

            return (
              <Card key={card.key}>
                <CardContent className="pt-4 flex items-start justify-between gap-4">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{displayName}</p>
                      {sourceTable === "contacts" && (
                        <Badge variant="outline" className="text-xs capitalize">
                          {lead.source}
                        </Badge>
                      )}
                    </div>
                    {lead.linkedin_profile_url && (
                      <a
                        href={lead.linkedin_profile_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-500 hover:underline inline-flex items-center gap-1"
                      >
                        Profile <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    {displayBio && (
                      <p className="text-sm text-muted-foreground">{displayBio}</p>
                    )}
                    {tag && (
                      <Badge variant="outline" className="text-xs font-normal">
                        {tag}
                      </Badge>
                    )}
                    {Object.keys(customFields).length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {Object.entries(customFields).map(([key, value]) => (
                          <Badge key={key} variant="outline" className="text-xs font-normal">
                            {key}: {value}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <CustomFieldsDialog
                      table={sourceTable === "contacts" ? "doc_contacts" : "doc_dm_leads"}
                      recordId={lead.id}
                      leadName={displayName}
                      customFields={customFields}
                      queryKey={sourceTable === "contacts" ? ["contacts", currentOrgId] : ["dm-leads", currentOrgId]}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="sm" className="gap-1 h-7" />}
                      >
                        <Badge variant={statusBadgeVariant[lead.status]}>
                          {lead.status.charAt(0).toUpperCase() + lead.status.slice(1)}
                        </Badge>
                        <ChevronDown className="h-3 w-3" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {STATUS_OPTIONS.map((opt) => (
                          <DropdownMenuItem
                            key={opt.value}
                            onSelect={() =>
                              updateStatusMutation.mutate({ sourceTable, id: lead.id, status: opt.value })
                            }
                          >
                            {opt.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {sourceTable === "dm_leads" ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => startEdit(lead)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => {
                            if (window.confirm(`Delete ${displayName}? This can't be undone.`)) {
                              deleteMutation.mutate(lead.id);
                            }
                          }}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    ) : (
                      // Merged-in Scraped/Manual lead — edit here, but delete
                      // from its home page (Scraped Leads / Manual Added
                      // Leads) so it's clear this is the same underlying
                      // record, not a separate copy.
                      <EditContactDialog contact={lead} queryKey={["contacts", currentOrgId]} />
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
