import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "../lib/supabaseClient";
import { callEdgeFunction } from "../lib/apiClient";
import { useOrganization } from "../hooks/useOrganization";
import { EditContactDialog } from "../components/EditContactDialog";
import { CustomFieldsDialog } from "../components/CustomFieldsDialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Skeleton } from "../components/ui/skeleton";
import {
  ChevronDown,
  ExternalLink,
  Loader2,
  Search,
  Trash2,
  UserSearch,
} from "lucide-react";
import type { Contact, ContactStatus } from "../types/database";

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

// Defensive: never render the literal string "Invalid Date" if a date ever
// comes through malformed or in a format we don't expect — show "—" instead.
function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

interface MatchedLead {
  name: string;
  profileUrl: string;
  headline: string;
  postUrl: string;
  postExcerpt: string;
  postedAt: string | null;
}

export function KeywordSearch() {
  const { currentOrgId, isLoading: isOrgLoading } = useOrganization();
  const queryClient = useQueryClient();

  const [keyword, setKeyword] = useState("");
  const [searchedKeyword, setSearchedKeyword] = useState("");
  const [results, setResults] = useState<MatchedLead[]>([]);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());

  // Same query key + shape as Scraped Leads / Manual Added Leads — keeps
  // status changes in sync everywhere via ["contacts", orgId]. This page
  // only ever shows the rows it saved itself (source: 'keyword_search').
  const contactsQuery = useQuery({
    queryKey: ["contacts", currentOrgId],
    queryFn: async () => {
      if (!currentOrgId) return [];
      const { data, error } = await supabase
        .from("doc_contacts")
        .select(
          "id, user_id, org_id, linkedin_profile_url, full_name, headline, email, is_connected, status, source, custom_fields, tag, matched_keyword, source_post_url, source_post_excerpt, source_post_date, last_contacted_at, created_at, updated_at"
        )
        .eq("org_id", currentOrgId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Contact[];
    },
    enabled: !!currentOrgId,
    retry: 1,
  });

  const savedLeads = (contactsQuery.data ?? []).filter((c) => c.source === "keyword_search");

  const searchMutation = useMutation({
    mutationFn: async () => {
      return callEdgeFunction<{
        data: {
          keyword: string;
          total_items: number;
          matched_leads: MatchedLead[];
          run_url: string;
          warning: string | null;
        };
      }>("doc_search_keyword_leads", {
        org_id: currentOrgId,
        keyword: keyword.trim(),
      });
    },
    onSuccess: (result) => {
      const { keyword: searchedFor, matched_leads, warning, run_url } = result.data;
      setResults(matched_leads);
      setSearchedKeyword(searchedFor);
      setSelectedUrls(new Set());
      if (matched_leads.length === 0 && warning) {
        toast.warning(warning, {
          duration: 12000,
          action: { label: "View run", onClick: () => window.open(run_url, "_blank") },
        });
      } else {
        toast.success(`Found ${matched_leads.length} healthcare lead${matched_leads.length === 1 ? "" : "s"} talking about "${searchedFor}"`);
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Search failed");
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const toSave = results.filter((r) => selectedUrls.has(r.profileUrl));
      const { error } = await supabase.from("doc_contacts").upsert(
        toSave.map((lead) => ({
          org_id: currentOrgId,
          linkedin_profile_url: lead.profileUrl,
          full_name: lead.name,
          headline: lead.headline || null,
          is_connected: false,
          status: "pending" as const,
          source: "keyword_search" as const,
          matched_keyword: searchedKeyword,
          source_post_url: lead.postUrl || null,
          source_post_excerpt: lead.postExcerpt || null,
          source_post_date: lead.postedAt,
        })),
        { onConflict: "org_id,linkedin_profile_url", ignoreDuplicates: true }
      );
      if (error) throw error;
      return toSave.length;
    },
    onSuccess: (count) => {
      toast.success(`Saved ${count} lead${count === 1 ? "" : "s"}`);
      setResults([]);
      setSelectedUrls(new Set());
      setKeyword("");
      queryClient.invalidateQueries({ queryKey: ["contacts", currentOrgId] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to save leads");
    },
  });

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

  function toggleSelect(profileUrl: string) {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(profileUrl)) next.delete(profileUrl);
      else next.add(profileUrl);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedUrls((prev) =>
      prev.size === results.length ? new Set() : new Set(results.map((r) => r.profileUrl))
    );
  }

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
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Keyword Search</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Search a topic (e.g. "AI and healthcare") to find physicians and healthcare experts who
          recently posted about it on LinkedIn — for reaching out while the topic is top of mind.
        </p>
      </div>

      <div className="flex gap-2 flex-wrap">
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="e.g. AI and healthcare"
          className="max-w-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && keyword.trim() && !searchMutation.isPending) {
              searchMutation.mutate();
            }
          }}
        />
        <Button
          onClick={() => searchMutation.mutate()}
          disabled={!keyword.trim() || searchMutation.isPending}
        >
          {searchMutation.isPending ? (
            <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Searching (this may take a minute)...</>
          ) : (
            <><Search className="h-4 w-4 mr-1" /> Search</>
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground -mt-6">
        Checks the past week of LinkedIn posts, up to 50 posts per search, and keeps only authors who
        look like physicians or healthcare professionals.
      </p>

      {/* Search results — not saved yet, pick who to add */}
      {results.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-sm font-medium">
              Results for "{searchedKeyword}" ({results.length})
            </h2>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={toggleSelectAll}>
                {selectedUrls.size === results.length ? "Deselect all" : "Select all"}
              </Button>
              <Button
                size="sm"
                onClick={() => saveMutation.mutate()}
                disabled={selectedUrls.size === 0 || saveMutation.isPending}
              >
                {saveMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Saving...</>
                ) : (
                  `Save Selected as Leads (${selectedUrls.size})`
                )}
              </Button>
            </div>
          </div>

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Headline</TableHead>
                  <TableHead>Their post</TableHead>
                  <TableHead>Posted</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((lead) => (
                  <TableRow key={lead.profileUrl}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selectedUrls.has(lead.profileUrl)}
                        onChange={() => toggleSelect(lead.profileUrl)}
                        className="h-4 w-4 rounded border-border"
                      />
                    </TableCell>
                    <TableCell className="font-medium whitespace-nowrap">{lead.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground truncate max-w-48">
                      {lead.headline || "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground truncate max-w-xs" title={lead.postExcerpt}>
                      {lead.postExcerpt || "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {formatDate(lead.postedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {lead.postUrl && (
                          <a
                            href={lead.postUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-foreground"
                            title="View their post"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Saved keyword-search leads */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium">
          Saved from Keyword Search ({savedLeads.length})
        </h2>

        {contactsQuery.isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : savedLeads.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <UserSearch className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No saved leads yet. Search a keyword above, then select who to save.</p>
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Headline</TableHead>
                  <TableHead>Keyword</TableHead>
                  <TableHead>Their post</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="w-20"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {savedLeads.map((contact) => (
                  <TableRow key={contact.id}>
                    <TableCell className="font-medium">{contact.full_name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground truncate max-w-48">
                      {contact.headline ?? "—"}
                    </TableCell>
                    <TableCell>
                      {contact.matched_keyword ? (
                        <Badge variant="outline">{contact.matched_keyword}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell
                      className="text-sm text-muted-foreground truncate max-w-48"
                      title={contact.source_post_excerpt ?? undefined}
                    >
                      {contact.source_post_url ? (
                        <a
                          href={contact.source_post_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-foreground hover:underline"
                        >
                          View post <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        "—"
                      )}
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
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
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
    </div>
  );
}
