import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import Papa from "papaparse";
import { supabase } from "../lib/supabaseClient";
import { callEdgeFunction } from "../lib/apiClient";
import { useOrganization } from "../hooks/useOrganization";
import { CustomFieldsDialog } from "../components/CustomFieldsDialog";
import { EditContactDialog } from "../components/EditContactDialog";
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
import { ExternalLink, ChevronDown, Search, Loader2, Sparkles, Download } from "lucide-react";
import type { Contact, ContactStatus } from "../types/database";

const MAX_EMAIL_SEARCH_SELECTION = 50;

function exportContactsCsv(list: Contact[]) {
  const rows = list.map((c) => ({
    name: c.full_name,
    source: c.source,
    headline: c.headline ?? "",
    linkedin_url: c.linkedin_profile_url,
    email: c.email ?? "",
    connected: c.is_connected ? "yes" : "no",
    status: c.status,
    last_contacted_at: c.last_contacted_at ?? "",
    added_at: c.created_at,
  }));
  const csv = Papa.unparse(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `contacts-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const STATUS_OPTIONS: { value: ContactStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "invited", label: "Invited" },
  { value: "messaged", label: "Messaged" },
  { value: "engaged", label: "Engaged" },
];

const STATUS_FILTERS: { value: ContactStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  ...STATUS_OPTIONS,
];

const statusBadgeVariant: Record<ContactStatus, "outline" | "default" | "secondary"> = {
  pending: "outline",
  invited: "secondary",
  messaged: "default",
  engaged: "secondary",
};

export function Contacts() {
  const { currentOrgId, isLoading: isOrgLoading } = useOrganization();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<ContactStatus | "all">("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const contactsQuery = useQuery({
    queryKey: ["contacts", currentOrgId],
    queryFn: async () => {
      if (!currentOrgId) return [];
      const { data, error } = await supabase
        .from("doc_contacts")
        .select("id, user_id, org_id, linkedin_profile_url, full_name, headline, email, is_connected, status, source, custom_fields, tag, last_contacted_at, created_at, updated_at")
        .eq("org_id", currentOrgId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return data as Contact[];
    },
    enabled: !!currentOrgId,
    retry: 1,
  });

  // Surface load failures instead of silently showing an empty list — the
  // most common cause is a pending DB migration (a selected column that
  // doesn't exist yet on the live database).
  useEffect(() => {
    if (contactsQuery.error) {
      toast.error(
        contactsQuery.error instanceof Error
          ? `Failed to load leads: ${contactsQuery.error.message}`
          : "Failed to load leads"
      );
    }
  }, [contactsQuery.error]);

  const updateStatusMutation = useMutation({
    mutationFn: async ({ contactId, status }: { contactId: string; status: ContactStatus }) => {
      const { error } = await supabase
        .from("doc_contacts")
        .update({ status })
        .eq("id", contactId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Status updated");
      queryClient.invalidateQueries({ queryKey: ["contacts", currentOrgId] });
    },
    onError: () => {
      toast.error("Failed to update status");
    },
  });

  const toggleConnectionMutation = useMutation({
    mutationFn: async ({ contactId, is_connected }: { contactId: string; is_connected: boolean }) => {
      const { error } = await supabase
        .from("doc_contacts")
        .update({ is_connected })
        .eq("id", contactId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Connection updated");
      queryClient.invalidateQueries({ queryKey: ["contacts", currentOrgId] });
    },
    onError: () => {
      toast.error("Failed to update connection");
    },
  });

  function toggleSelect(contact: Contact) {
    if (contact.email) return; // no need to search — already has an email

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

  const enrichEmailsApolloMutation = useMutation({
    mutationFn: async () => {
      return callEdgeFunction<{
        data: { requested: number; found: number; warning: string | null };
      }>("doc_enrich_emails_apollo", {
        org_id: currentOrgId,
        contact_ids: Array.from(selectedIds).slice(0, 20),
      });
    },
    onSuccess: (result) => {
      const { requested, found, warning } = result.data;
      if (found === 0 && warning) {
        toast.warning(warning, { duration: 12000 });
      } else {
        toast.success(`Apollo found ${found} of ${requested} email${requested === 1 ? "" : "s"}`);
      }
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["contacts", currentOrgId] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Apollo search failed");
    },
  });

  if (isOrgLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  if (!currentOrgId) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No account found.
      </div>
    );
  }

  // This page is "Scraped Leads" specifically — manually added leads (via
  // Add Lead or CSV upload) live on the Manual Added Leads page instead.
  // Both still share the ["contacts", orgId] query cache/key for status sync.
  const contacts = (contactsQuery.data ?? []).filter((c) => c.source === "scraped");
  const filtered =
    statusFilter === "all"
      ? contacts
      : contacts.filter((c) => c.status === statusFilter);

  const statusCounts = contacts.reduce(
    (acc, c) => {
      acc[c.status] = (acc[c.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Scraped Leads</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {contacts.length} contact{contacts.length === 1 ? "" : "s"} in pipeline
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportContactsCsv(filtered)}
            disabled={filtered.length === 0}
          >
            <Download className="h-4 w-4 mr-1" />
            Export {statusFilter === "all" ? "All" : ""} ({filtered.length})
          </Button>
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
          {selectedIds.size > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => enrichEmailsApolloMutation.mutate()}
              disabled={enrichEmailsApolloMutation.isPending}
              title="Uses Apollo credits (limited monthly budget) — use for leads Find Emails already came up empty on"
            >
              {enrichEmailsApolloMutation.isPending ? (
                <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Searching...</>
              ) : (
                <><Sparkles className="h-4 w-4 mr-1" /> Try Apollo ({Math.min(selectedIds.size, 20)})</>
              )}
            </Button>
          )}
          <ScrapeDialog orgId={currentOrgId} />
        </div>
      </div>
      {selectedIds.size > 20 && (
        <p className="text-xs text-amber-600 -mt-4">
          "Try Apollo" only processes the first 20 selected leads per click — your Apollo plan has a
          limited monthly credit budget, so this is capped lower than "Find Emails" on purpose.
        </p>
      )}

      {/* Status filters */}
      <div className="flex gap-2">
        {STATUS_FILTERS.map((filter) => {
          const count =
            filter.value === "all"
              ? contacts.length
              : statusCounts[filter.value] ?? 0;
          return (
            <Button
              key={filter.value}
              variant={statusFilter === filter.value ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter(filter.value)}
            >
              {filter.label}
              {count > 0 && (
                <span className="ml-1.5 text-xs tabular-nums">({count})</span>
              )}
            </Button>
          );
        })}
      </div>

      {/* Contacts table */}
      {contactsQuery.isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-center py-8 text-muted-foreground">
          {contacts.length === 0
            ? "No contacts yet. Use 'Scrape Commenters' to find leads from LinkedIn posts."
            : "No contacts match this filter."}
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Headline</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Connected</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Details</TableHead>
                <TableHead>Last Contacted</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((contact) => (
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
                  <TableCell className="font-medium">
                    {contact.full_name}
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
                        <Badge variant={contact.is_connected ? "default" : "outline"}>
                          {contact.is_connected ? "Yes" : "No"}
                        </Badge>
                        <ChevronDown className="h-3 w-3" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem
                          onSelect={() =>
                            toggleConnectionMutation.mutate({
                              contactId: contact.id,
                              is_connected: true,
                            })
                          }
                        >
                          Yes
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            toggleConnectionMutation.mutate({
                              contactId: contact.id,
                              is_connected: false,
                            })
                          }
                        >
                          No
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
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
                              updateStatusMutation.mutate({
                                contactId: contact.id,
                                status: opt.value,
                              })
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

function ScrapeDialog({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);
  const [postUrl, setPostUrl] = useState("");
  const queryClient = useQueryClient();

  const scrapeMutation = useMutation({
    mutationFn: async () => {
      return callEdgeFunction<{
        data: {
          total_items: number;
          total_engagers: number;
          doctors_found: number;
          contacts_saved: number;
          run_url?: string;
          warning?: string | null;
        };
      }>("doc_scrape_post_commenters", {
        org_id: orgId,
        linkedin_post_url: postUrl,
      });
    },
    onSuccess: (result) => {
      const { total_items, total_engagers, doctors_found, contacts_saved, run_url, warning } = result.data;
      if (total_items === 0 && warning) {
        toast.warning(warning, {
          duration: 15000,
          action: run_url
            ? { label: "View run", onClick: () => window.open(run_url, "_blank") }
            : undefined,
        });
      } else {
        toast.success(`${total_items} items from Apify → ${total_engagers} unique engagers → ${doctors_found} doctors → ${contacts_saved} saved`);
      }
      setOpen(false);
      setPostUrl("");
      queryClient.invalidateQueries({ queryKey: ["contacts", orgId] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Scraping failed");
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant="outline" size="sm" />}
      >
        <Search className="h-4 w-4 mr-1" />
        Scrape Commenters
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Scrape Post Commenters</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label>LinkedIn Post URL</Label>
            <Input
              value={postUrl}
              onChange={(e) => setPostUrl(e.target.value)}
              placeholder="https://linkedin.com/posts/..."
              type="url"
            />
            <p className="text-xs text-muted-foreground">
              Paste the URL of a LinkedIn post to find doctors who commented on it
            </p>
          </div>
          <Button
            className="w-full"
            onClick={() => scrapeMutation.mutate()}
            disabled={!postUrl.trim() || scrapeMutation.isPending}
          >
            {scrapeMutation.isPending ? (
              <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Scraping (this may take a minute)...</>
            ) : (
              "Scrape Commenters"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
