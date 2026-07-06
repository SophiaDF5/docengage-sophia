import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "../lib/supabaseClient";
import { useOrganization } from "../hooks/useOrganization";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { Loader2, Pencil, Plus, Trash2, UserCircle } from "lucide-react";
import type { DmLead } from "../types/database";

export function Leads() {
  const { currentOrgId } = useOrganization();
  const queryClient = useQueryClient();

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [links, setLinks] = useState("");

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
  });

  const leads = leadsQuery.data ?? [];

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (editingId) {
        const { error } = await supabase
          .from("doc_dm_leads")
          .update({ name, bio: bio || null, links: links || null })
          .eq("id", editingId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("doc_dm_leads")
          .insert({ org_id: currentOrgId!, name, bio: bio || null, links: links || null });
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

  function resetForm() {
    setShowForm(false);
    setEditingId(null);
    setName("");
    setBio("");
    setLinks("");
  }

  function startEdit(lead: DmLead) {
    setEditingId(lead.id);
    setName(lead.name);
    setBio(lead.bio || "");
    setLinks(lead.links || "");
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
          <h1 className="text-2xl font-semibold tracking-tight">Saved Leads</h1>
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
                  value={links}
                  onChange={(e) => setLinks(e.target.value)}
                  placeholder="https://linkedin.com/in/..."
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
                  {lead.links && (
                    <a
                      href={lead.links.startsWith("http") ? lead.links : `https://${lead.links}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-500 hover:underline truncate block"
                    >
                      {lead.links}
                    </a>
                  )}
                  {lead.bio && (
                    <p className="text-sm text-muted-foreground">{lead.bio}</p>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
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
