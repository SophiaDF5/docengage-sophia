import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "../lib/supabaseClient";
import { callEdgeFunction } from "../lib/apiClient";
import { parseLeadFile } from "../lib/csvImport";
import { useOrganization } from "../hooks/useOrganization";
import { AddContactDialog } from "../components/AddContactDialog";
import { EditContactDialog } from "../components/EditContactDialog";
import { CustomFieldsDialog } from "../components/CustomFieldsDialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Skeleton } from "../components/ui/skeleton";
import { ChevronDown, ExternalLink, Loader2, Sparkles, Trash2, Upload, UserPlus } from "lucide-react";
import type { Contact, ContactStatus } from "../types/database";

const MAX_EMAIL_SEARCH_SELECTION = 50;
const UNTAGGED = "__untagged__";

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

export function ManualLeads() {
  const { currentOrgId, isLoading: isOrgLoading } = useOrganization();
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<string>("all");

  // Same query key as Scraped Leads (Contacts.tsx) and Outreach — they all
  // read/write doc_contacts, so sharing ["contacts", orgId] is what keeps
  // status changes in sync everywhere without extra plumbing.
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
    if (contactsQuery.error) {
      toast.error(
        contactsQuery.error instanceof Error
          ? `Failed to load leads: ${contactsQuery.error.message}`
          : "Failed to load leads"
      );
    }
  }, [contactsQuery.error]);

  // Manually added leads: added one-by-one via the Add Lead dialog, or
  // uploaded via CSV/Excel here — both are tagged source: 'manual' in
  // doc_contacts. Each batch/lead can also carry a freeform `tag` (e.g.
  // "YouTube") which drives the filter chips below — no fixed list, it's
  // just whatever distinct tag values currently exist.
  const allManualLeads = (contactsQuery.data ?? []).filter((c) => c.source === "manual");

  const distinctTags = useMemo(() => {
    const set = new Set<string>();
    for (const l of allManualLeads) {
      if (l.tag && l.tag.trim()) set.add(l.tag.trim());
    }
    return [...set].sort();
  }, [allManualLeads]);

  const leads = useMemo(() => {
    if (tagFilter === "all") return allManualLeads;
    if (tagFilter === UNTAGGED) return allManualLeads.filter((l) => !l.tag || !l.tag.trim());
    return allManualLeads.filter((l) => l.tag === tagFilter);
  }, [allManualLeads, tagFilter]);

  const updateStatusMutation = useMutation({
    mutationFn: async ({ contactId, status }: { contactId: string; status: ContactStatus }) => {
      const { error } = await supabase.from("doc_contacts").update({ status }).eq("id", contactId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contacts", currentOrgId] });
    },
    onError: () => toast.error("Failed to update status"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (contactId: string) => {
      const { error } = await supabase.from("doc_contacts").delete().eq("id", contactId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Lead deleted");
      queryClient.invalidateQueries({ queryKey: ["contacts", currentOrgId] });
    },
    onError: () => toast.error("Failed to delete lead"),
  });

  function toggleSelect(contact: Contact) {
    if (contact.email) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(contact.id)) {
        next.delete(contact.id);
        return next;
      }
      if (next.size >= MAX_EMAIL_SEARCH_SELECTION) {
        toast.error(`You can only select up to ${MAX_EMAIL_SEARCH_SELECTION} leads at a time for email search.`);
        return prev;
      }
      next.add(contact.id);
      return next;
    });
  }

  const enrichEmailsMutation = useMutation({
    mutationFn: async () => {
      return callEdgeFunction<{
        data: { requested: number; found: number; run_url: string; warning: string | null };
      }>("doc_enrich_emails", {
        org_id: currentOrgId,
        contact_ids: Array.from(selectedIds),
      });
    },
    onSuccess: (result) => {
      const { requested, found, run_url, warning } = result.data;
      if (found === 0 && warning) {
        toast.warning(warning, {
          duration: 12000,
          action: { label: "View run", onClick: () => window.open(run_url, "_blank") },
        });
      } else {
        toast.success(`Found ${found} of ${requested} email${requested === 1 ? "" : "s"}`);
      }
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["contacts", currentOrgId] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Email search failed");
    },
  });

  if (isOrgLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  if (!currentOrgId) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No workspace found.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Manual Added Leads</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {allManualLeads.length} lead{allManualLeads.length === 1 ? "" : "s"} added by hand or via CSV/Excel upload
          </p>
        </div>
        <div className="flex gap-2">
          {selectedIds.size > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => enrichEmailsMutation.mutate()}
              disabled={enrichEmailsMutation.isPending}
            >
              {enrichEmailsMutation.isPending ? (
                <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Searching...</>
              ) : (
                <><Sparkles className="h-4 w-4 mr-1" /> Find Emails ({selectedIds.size})</>
              )}
            </Button>
          )}
          <UploadLeadsDialog orgId={currentOrgId} existingTags={distinctTags} />
          <AddContactDialog orgId={currentOrgId} />
        </div>
      </div>

      {distinctTags.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground mr-1">Filter by tag:</span>
          <Badge
            variant={tagFilter === "all" ? "default" : "outline"}
            className="cursor-pointer select-none"
            onClick={() => setTagFilter("all")}
          >
            All ({allManualLeads.length})
          </Badge>
          {distinctTags.map((tag) => (
            <Badge
              key={tag}
              variant={tagFilter === tag ? "default" : "outline"}
              className="cursor-pointer select-none"
              onClick={() => setTagFilter(tag)}
            >
              {tag} ({allManualLeads.filter((l) => l.tag === tag).length})
            </Badge>
          ))}
          {allManualLeads.some((l) => !l.tag || !l.tag.trim()) && (
            <Badge
              variant={tagFilter === UNTAGGED ? "default" : "outline"}
              className="cursor-pointer select-none"
              onClick={() => setTagFilter(UNTAGGED)}
            >
              Untagged ({allManualLeads.filter((l) => !l.tag || !l.tag.trim()).length})
            </Badge>
          )}
        </div>
      )}

      {contactsQuery.isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : leads.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <UserPlus className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">
            {allManualLeads.length === 0
              ? "No manually added leads yet. Use \"Upload Leads\" or \"Add Lead\" above."
              : "No leads match this tag filter."}
          </p>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Tag</TableHead>
                <TableHead>Headline</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Details</TableHead>
                <TableHead>Last Contacted</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-20"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map((contact) => (
                <TableRow key={contact.id}>
                  <TableCell>
                    {contact.email ? (
                      <span className="text-xs text-muted-foreground" title="Already has an email">✓</span>
                    ) : (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(contact.id)}
                        onChange={() => toggleSelect(contact)}
                        className="h-4 w-4 rounded border-border"
                      />
                    )}
                  </TableCell>
                  <TableCell className="font-medium">{contact.full_name}</TableCell>
                  <TableCell>
                    {contact.tag ? (
                      <Badge variant="outline">{contact.tag}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground truncate max-w-48">
                    {contact.headline ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {contact.email ?? "—"}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="sm" className="gap-1 h-7" />}
                      >
                        <Badge variant={statusBadgeVariant[contact.status]}>
                          {contact.status.charAt(0).toUpperCase() + contact.status.slice(1)}
                        </Badge>
                        <ChevronDown className="h-3 w-3" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {STATUS_OPTIONS.map((opt) => (
                          <DropdownMenuItem
                            key={opt.value}
                            onClick={() =>
                              updateStatusMutation.mutate({ contactId: contact.id, status: opt.value })
                            }
                            disabled={contact.status === opt.value}
                          >
                            {opt.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                  <TableCell>
                    <CustomFieldsDialog
                      table="doc_contacts"
                      recordId={contact.id}
                      leadName={contact.full_name}
                      customFields={contact.custom_fields}
                      queryKey={["contacts", currentOrgId]}
                    />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {contact.last_contacted_at
                      ? new Date(contact.last_contacted_at).toLocaleDateString()
                      : "Never"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(contact.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <EditContactDialog contact={contact} queryKey={["contacts", currentOrgId]} />
                      <a
                        href={contact.linkedin_profile_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => {
                          if (window.confirm(`Delete ${contact.full_name}? This can't be undone.`)) {
                            deleteMutation.mutate(contact.id);
                          }
                        }}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function UploadLeadsDialog({ orgId, existingTags }: { orgId: string; existingTags: string[] }) {
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  function resetAndClose() {
    setOpen(false);
    setTag("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      const rows = await parseLeadFile(file);

      if (rows.length === 0) {
        toast.error("No LinkedIn URLs found — check the column headers include something like 'LinkedIn URL' or 'Profile'.");
        return;
      }

      const trimmedTag = tag.trim();

      const { error } = await supabase
        .from("doc_contacts")
        .upsert(
          rows.map((r) => ({
            org_id: orgId,
            linkedin_profile_url: r.linkedin_profile_url,
            full_name: r.full_name || "Unknown",
            status: "pending" as const,
            source: "manual" as const,
            tag: trimmedTag || null,
          })),
          { onConflict: "org_id,linkedin_profile_url", ignoreDuplicates: false }
        );

      if (error) throw error;

      await queryClient.invalidateQueries({ queryKey: ["contacts", orgId] });

      toast.success(
        `${rows.length} lead${rows.length === 1 ? "" : "s"} imported${trimmedTag ? ` and tagged "${trimmedTag}"` : ""}`
      );
      resetAndClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import file");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : resetAndClose())}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Upload className="h-4 w-4 mr-1" />
        Upload Leads
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload Leads from CSV / Excel</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label>Tag (optional)</Label>
            <Input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="e.g. YouTube, Conference 2026..."
            />
            <p className="text-xs text-muted-foreground">
              Labels every lead in this file with the same tag, so you can filter by it afterward.
              Leave blank to import without a tag.
            </p>
            {existingTags.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {existingTags.map((t) => (
                  <Badge
                    key={t}
                    variant="outline"
                    className="cursor-pointer select-none"
                    onClick={() => setTag(t)}
                  >
                    {t}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Label>File</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFileChange}
              disabled={isUploading}
              className="block w-full text-sm text-muted-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-input file:bg-background file:text-sm file:font-medium hover:file:bg-accent"
            />
            {isUploading && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Importing...
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
