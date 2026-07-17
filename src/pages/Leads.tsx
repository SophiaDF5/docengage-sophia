import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "../lib/supabaseClient";
import { useOrganization } from "../hooks/useOrganization";
import { CustomFieldsDialog } from "../components/CustomFieldsDialog";
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
import type { ContactStatus, DmLead } from "../types/database";

const STATUS_OPTIONS: { value: ContactStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "messaged", label: "Messaged" },
  { value: "engaged", label: "Engaged" },
];

const statusBadgeVariant: Record<ContactStatus, "outline" | "default" | "secondary"> = {
  pending: "outline",
  messaged: "default",
  engaged: "secondary",
};

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

  useEffect(() => {
    if (leadsQuery.error) {
      toast.error(
        leadsQuery.error instanceof Error
          ? `Failed to load leads: ${leadsQuery.error.message}`
          : "Failed to load leads"
      );
    }
  }, [leadsQuery.error]);

  const leads = leadsQuery.data ?? [];

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
    mutationFn: async ({ id, status }: { id: string; status: ContactStatus }) => {
      const { error } = await supabase
        .from("doc_dm_leads")
        .update({ status, last_contacted_at: status === "messaged" ? new Date().toISOString() : undefined })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dm-leads", currentOrgId] });
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
            Doctors and contacts you message regularly.
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
      {leadsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : leads.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <UserCircle className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No leads yet. Add one to get started.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {leads.map((lead) => (
            <Card key={lead.id}>
              <CardContent className="pt-4 flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-0.5">
                  <p className="font-medium">{lead.name}</p>
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
                  {lead.bio && (
                    <p className="text-sm text-muted-foreground">{lead.bio}</p>
                  )}
                  {Object.keys(lead.custom_fields ?? {}).length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {Object.entries(lead.custom_fields).map(([key, value]) => (
                        <Badge key={key} variant="outline" className="text-xs font-normal">
                          {key}: {value}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <CustomFieldsDialog
                    table="doc_dm_leads"
                    recordId={lead.id}
                    leadName={lead.name}
                    customFields={lead.custom_fields ?? {}}
                    queryKey={["dm-leads", currentOrgId]}
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
                            updateStatusMutation.mutate({ id: lead.id, status: opt.value })
                          }
                        >
                          {opt.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
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
                    onClick={() => deleteMutation.mutate(lead.id)}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
