import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "../lib/supabaseClient";
import { callEdgeFunction } from "../lib/apiClient";
import { useOrganization } from "../hooks/useOrganization";
import { useUnifiedLeads, type UnifiedLead, type FilterType } from "../hooks/useUnifiedLeads";
import { InvitedTagBadge } from "../components/InvitedTagBadge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import {
  Sparkles,
  ExternalLink,
  Loader2,
  CheckCircle2,
  Copy,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import type { ContactStatus } from "../types/database";

type Mode = "bulk" | "personalized";
const UNTAGGED = "__untagged__";

const FILTER_OPTIONS: { value: FilterType; label: string }[] = [
  { value: "scraped", label: "Scraped" },
  { value: "engaged", label: "Engaged" },
  { value: "manual", label: "Manual Added" },
];

const STATUS_FILTER_OPTIONS: { value: ContactStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "messaged", label: "Messaged" },
  { value: "engaged", label: "Engaged" },
];

export function Outreach() {
  const { currentOrgId } = useOrganization();
  const queryClient = useQueryClient();

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [activeFilters, setActiveFilters] = useState<Set<FilterType>>(
    new Set(["scraped", "engaged", "manual"])
  );
  // Empty set = no restriction (show every status / every tag). Clicking a
  // chip adds a restriction; clicking it again removes it. This is separate
  // from activeFilters (source) so you can combine "Manual Added" + tag
  // "YouTube" + "Pending only" + a name search all at once.
  const [activeStatusFilters, setActiveStatusFilters] = useState<Set<ContactStatus>>(new Set());
  const [activeTagFilters, setActiveTagFilters] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState("");
  const [mode, setMode] = useState<Mode>("bulk");
  const [bulkMessage, setBulkMessage] = useState("");
  const [personalMessages, setPersonalMessages] = useState<Record<string, string>>({});
  const [generatingKey, setGeneratingKey] = useState<string | null>(null);
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);

  // Same query keys used by the Scraped Leads (Contacts.tsx), Manual Added
  // Leads (ManualLeads.tsx), and Engaged Leads (Leads.tsx) pages — this is
  // what keeps status changes in sync across the app. Whichever page updates
  // a lead invalidates ["contacts", orgId] or ["dm-leads", orgId], and every
  // page (including this one) re-fetches.
  const { allLeads, isLoading } = useUnifiedLeads(currentOrgId);

  // Every source (Scraped/Manual via doc_contacts, Engaged via doc_dm_leads —
  // see migration 014) carries a tag now — built from whatever's currently in
  // scope after the source filter, so the tag chip list doesn't show tags
  // that don't apply to the sources you've already narrowed down to.
  const sourceFilteredLeads = useMemo(
    () => allLeads.filter((l) => activeFilters.has(l.filterType)),
    [allLeads, activeFilters]
  );

  const distinctTags = useMemo(() => {
    const set = new Set<string>();
    for (const l of sourceFilteredLeads) {
      if (l.tag && l.tag.trim()) set.add(l.tag.trim());
    }
    return [...set].sort();
  }, [sourceFilteredLeads]);

  const hasUntagged = useMemo(
    () => sourceFilteredLeads.some((l) => !l.tag || !l.tag.trim()),
    [sourceFilteredLeads]
  );

  const visibleLeads = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return sourceFilteredLeads.filter((l) => {
      if (activeStatusFilters.size > 0 && !activeStatusFilters.has(l.status)) return false;
      if (activeTagFilters.size > 0) {
        const tagKey = l.tag && l.tag.trim() ? l.tag.trim() : UNTAGGED;
        if (!activeTagFilters.has(tagKey)) return false;
      }
      if (q) {
        const matchesName = l.full_name.toLowerCase().includes(q);
        const matchesHeadline = l.headline?.toLowerCase().includes(q) ?? false;
        if (!matchesName && !matchesHeadline) return false;
      }
      return true;
    });
  }, [sourceFilteredLeads, activeStatusFilters, activeTagFilters, searchText]);

  const leadsByKey = useMemo(() => {
    const map = new Map<string, UnifiedLead>();
    for (const l of allLeads) map.set(l.key, l);
    return map;
  }, [allLeads]);

  const queue = [...selectedKeys]
    .map((k) => leadsByKey.get(k))
    .filter((l): l is UnifiedLead => !!l);

  function toggleFilter(value: FilterType) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function toggleStatusFilter(value: ContactStatus) {
    setActiveStatusFilters((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function toggleTagFilter(value: string) {
    setActiveTagFilters((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  const hasActiveRefinement =
    activeStatusFilters.size > 0 || activeTagFilters.size > 0 || searchText.trim() !== "";

  function clearRefinements() {
    setActiveStatusFilters(new Set());
    setActiveTagFilters(new Set());
    setSearchText("");
  }

  function toggleSelect(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const allSelected = visibleLeads.length > 0 && visibleLeads.every((l) => selectedKeys.has(l.key));

  function toggleSelectAll() {
    setSelectedKeys((prev) => {
      if (allSelected) {
        const next = new Set(prev);
        for (const l of visibleLeads) next.delete(l.key);
        return next;
      }
      const next = new Set(prev);
      for (const l of visibleLeads) next.add(l.key);
      return next;
    });
  }

  function openAllTabs() {
    const withUrls = queue.filter((l) => l.linkedin_profile_url);
    if (withUrls.length === 0) return;
    if (withUrls.length > 6) {
      toast.warning(
        `Opening ${withUrls.length} tabs at once — your browser will likely ask you to allow pop-ups for this site. Allow it, then it'll open the rest.`,
        { duration: 8000 }
      );
    }
    let opened = 0;
    for (const lead of withUrls) {
      const win = window.open(lead.linkedin_profile_url!, "_blank", "noopener,noreferrer");
      if (win) opened++;
    }
    if (opened < withUrls.length) {
      toast.error(
        `Only ${opened} of ${withUrls.length} tabs opened — your browser blocked the rest as pop-ups. Allow pop-ups for this site and try again.`
      );
    } else {
      toast.success(`Opened ${opened} LinkedIn tab${opened === 1 ? "" : "s"}`);
    }
  }

  // AI drafting is rate-limited to 3 requests/minute per account (same "expensive"
  // tier used by Comments and DM Assistant). Pace requests in batches of 3 with a
  // cooldown between batches so a big queue completes instead of silently failing
  // partway through with 429s.
  const AI_RATE_LIMIT_PER_MINUTE = 3;
  const AI_RATE_LIMIT_COOLDOWN_MS = 22_000; // slightly over 60s/3 to be safe

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function draftFor(lead: UnifiedLead) {
    return callEdgeFunction<{ data: { generated_content: string } }>("doc_generate_dm", {
      org_id: currentOrgId,
      lead_name: lead.full_name,
      lead_bio: lead.headline || undefined,
      new_topic:
        "Write a friendly opening LinkedIn message to start a genuine conversation with this healthcare professional.",
    });
  }

  async function generateAllMissing() {
    const targets = queue.filter((l) => !personalMessages[l.key]?.trim());
    if (targets.length === 0) {
      toast.error("Every lead in the queue already has a message");
      return;
    }

    if (targets.length > AI_RATE_LIMIT_PER_MINUTE) {
      const batches = Math.ceil(targets.length / AI_RATE_LIMIT_PER_MINUTE);
      const estMinutes = Math.max(1, Math.ceil(((batches - 1) * AI_RATE_LIMIT_COOLDOWN_MS) / 60_000));
      toast.info(
        `AI drafting is limited to ${AI_RATE_LIMIT_PER_MINUTE}/minute — generating ${targets.length} messages will take about ${estMinutes} minute${estMinutes === 1 ? "" : "s"} and paces itself automatically.`,
        { duration: 8000 }
      );
    }

    setIsGeneratingAll(true);
    let done = 0;

    for (let i = 0; i < targets.length; i++) {
      const lead = targets[i];

      if (i > 0 && i % AI_RATE_LIMIT_PER_MINUTE === 0) {
        toast.info(`Generated ${done} so far — pausing briefly to stay under the rate limit...`);
        await sleep(AI_RATE_LIMIT_COOLDOWN_MS);
      }

      try {
        setGeneratingKey(lead.key);
        const result = await draftFor(lead);
        setPersonalMessages((prev) => ({ ...prev, [lead.key]: result.data.generated_content }));
        done++;
      } catch (err) {
        // If we still hit a rate limit despite pacing, back off longer once and retry this lead.
        if (err instanceof Error && err.message.toLowerCase().includes("too many requests")) {
          await sleep(AI_RATE_LIMIT_COOLDOWN_MS);
          try {
            const retryResult = await draftFor(lead);
            setPersonalMessages((prev) => ({
              ...prev,
              [lead.key]: retryResult.data.generated_content,
            }));
            done++;
          } catch (retryErr) {
            console.error("Failed to generate for", lead.full_name, "(after retry)", retryErr);
          }
        } else {
          console.error("Failed to generate for", lead.full_name, err);
        }
      }
    }

    setGeneratingKey(null);
    setIsGeneratingAll(false);
    toast.success(`Generated ${done} of ${targets.length} messages`);
  }

  async function copyMessage(message: string) {
    if (!message.trim()) {
      toast.error("Write or generate a message first");
      return;
    }
    await navigator.clipboard.writeText(message);
    toast.success("Message copied — paste it into that lead's LinkedIn tab");
  }

  const generateMutation = useMutation({
    mutationFn: async (lead: UnifiedLead) => {
      setGeneratingKey(lead.key);
      return draftFor(lead);
    },
    onSuccess: (result, lead) => {
      setPersonalMessages((prev) => ({
        ...prev,
        [lead.key]: result.data.generated_content,
      }));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Draft generation failed");
    },
    onSettled: () => setGeneratingKey(null),
  });

  const markSentMutation = useMutation({
    mutationFn: async ({ lead, message }: { lead: UnifiedLead; message: string }) => {
      const { error: logError } = await supabase.from("doc_outreach_messages").insert({
        org_id: currentOrgId,
        contact_id: lead.sourceTable === "contacts" ? lead.id : null,
        dm_lead_id: lead.sourceTable === "dm_leads" ? lead.id : null,
        message_content: message,
      });
      if (logError) throw logError;

      const table = lead.sourceTable === "contacts" ? "doc_contacts" : "doc_dm_leads";
      const { error: updateError } = await supabase
        .from(table)
        .update({ status: "messaged", last_contacted_at: new Date().toISOString() })
        .eq("id", lead.id);
      if (updateError) throw updateError;
    },
    onSuccess: () => {
      toast.success("Marked as sent");
      queryClient.invalidateQueries({ queryKey: ["contacts", currentOrgId] });
      queryClient.invalidateQueries({ queryKey: ["dm-leads", currentOrgId] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    },
  });

  async function openAndCopy(lead: UnifiedLead, message: string) {
    if (!message.trim()) {
      toast.error("Write or generate a message first");
      return;
    }
    await navigator.clipboard.writeText(message);
    if (lead.linkedin_profile_url) {
      window.open(lead.linkedin_profile_url, "_blank", "noopener,noreferrer");
    }
    toast.success("Message copied — paste it into LinkedIn, then click Mark as Sent");
  }

  if (!currentOrgId) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No organization selected.
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Outreach</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pick leads, write your message, then send it yourself on LinkedIn — DocEngage preps everything
          and tracks who's been contacted.
        </p>
      </div>

      {/* Step 1: pick leads */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <h2 className="text-sm font-medium">1. Choose your leads</h2>

          <Input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search by name or headline..."
            className="max-w-sm"
          />

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">Source:</span>
            {FILTER_OPTIONS.map((opt) => (
              <Badge
                key={opt.value}
                variant={activeFilters.has(opt.value) ? "default" : "outline"}
                className="cursor-pointer select-none"
                onClick={() => toggleFilter(opt.value)}
              >
                {opt.label}
              </Badge>
            ))}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">Status:</span>
            {STATUS_FILTER_OPTIONS.map((opt) => (
              <Badge
                key={opt.value}
                variant={activeStatusFilters.has(opt.value) ? "default" : "outline"}
                className="cursor-pointer select-none"
                onClick={() => toggleStatusFilter(opt.value)}
              >
                {opt.label}
              </Badge>
            ))}
            <span className="text-xs text-muted-foreground">
              {activeStatusFilters.size === 0 ? "(showing all)" : ""}
            </span>
          </div>

          {(distinctTags.length > 0 || hasUntagged) && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground mr-1">Tag:</span>
              {distinctTags.map((tag) => (
                <Badge
                  key={tag}
                  variant={activeTagFilters.has(tag) ? "default" : "outline"}
                  className="cursor-pointer select-none"
                  onClick={() => toggleTagFilter(tag)}
                >
                  {tag}
                </Badge>
              ))}
              {hasUntagged && (
                <Badge
                  variant={activeTagFilters.has(UNTAGGED) ? "default" : "outline"}
                  className="cursor-pointer select-none"
                  onClick={() => toggleTagFilter(UNTAGGED)}
                >
                  Untagged
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {activeTagFilters.size === 0 ? "(showing all)" : ""}
              </span>
            </div>
          )}

          {hasActiveRefinement && (
            <Button variant="ghost" size="sm" onClick={clearRefinements} className="h-7 -ml-2">
              <X className="h-3.5 w-3.5 mr-1" /> Clear status/tag/search filters
            </Button>
          )}

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading leads...</p>
          ) : allLeads.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No leads yet — add leads from Scraped Leads, Manual Added Leads, or Engaged Leads first.
            </p>
          ) : visibleLeads.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No leads match the current filters.
            </p>
          ) : (
            <div className="border rounded-md divide-y">
              <label className="flex items-center gap-3 px-3 py-2 text-sm bg-muted/40 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  className="h-4 w-4 rounded border-border"
                />
                <span className="font-medium">
                  {allSelected ? "Deselect all" : `Select all (${visibleLeads.length})`}
                </span>
              </label>
              <div className="max-h-64 overflow-y-auto divide-y">
                {visibleLeads.map((l) => (
                <label
                  key={l.key}
                  className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedKeys.has(l.key)}
                    onChange={() => toggleSelect(l.key)}
                    className="h-4 w-4 rounded border-border"
                  />
                  <span className="flex-1 min-w-0 truncate">{l.full_name}</span>
                  {l.headline && (
                    <span className="text-xs text-muted-foreground truncate max-w-[200px] hidden sm:inline">
                      {l.headline}
                    </span>
                  )}
                  <Badge variant="outline" className="capitalize">
                    {l.filterType}
                  </Badge>
                  {l.tag && l.tag !== "Invited" && <Badge variant="outline">{l.tag}</Badge>}
                  <InvitedTagBadge
                    table={l.sourceTable === "contacts" ? "doc_contacts" : "doc_dm_leads"}
                    recordId={l.id}
                    tag={l.tag}
                    queryKey={l.sourceTable === "contacts" ? ["contacts", currentOrgId] : ["dm-leads", currentOrgId]}
                  />
                  <Badge variant={l.status === "messaged" ? "default" : "outline"}>
                    {l.status}
                  </Badge>
                </label>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {selectedKeys.size} lead{selectedKeys.size === 1 ? "" : "s"} selected
            {visibleLeads.length !== allLeads.length && ` — ${visibleLeads.length} of ${allLeads.length} leads shown`}
          </p>
        </CardContent>
      </Card>

      {/* Step 2: compose */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <h2 className="text-sm font-medium">2. Write your message</h2>
          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList>
              <TabsTrigger value="bulk">Same message for everyone</TabsTrigger>
              <TabsTrigger value="personalized">Personalize per lead</TabsTrigger>
            </TabsList>
            <TabsContent value="bulk" className="pt-4">
              <Textarea
                value={bulkMessage}
                onChange={(e) => setBulkMessage(e.target.value)}
                placeholder="Write the message that will go to every selected lead..."
                rows={4}
              />
              <p className="text-xs text-muted-foreground mt-2">
                Heads up: sending the identical message to many people at once is what most often
                gets flagged as spam-like behavior on LinkedIn. Use sparingly.
              </p>
            </TabsContent>
            <TabsContent value="personalized" className="pt-4">
              <p className="text-xs text-muted-foreground">
                Each lead below gets their own message — generate a draft with AI or write one by hand.
              </p>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Step 3 + 4: queue + send */}
      {queue.length > 0 && (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-sm font-medium">3. Review &amp; send</h2>
              <div className="flex gap-2">
                {mode === "personalized" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={generateAllMissing}
                    disabled={isGeneratingAll}
                  >
                    {isGeneratingAll ? (
                      <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Generating...</>
                    ) : (
                      <><Sparkles className="h-3.5 w-3.5 mr-1" /> Generate All</>
                    )}
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={openAllTabs}>
                  <SquareArrowOutUpRight className="h-3.5 w-3.5 mr-1" /> Open All LinkedIn Tabs
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground -mt-2">
              Open all the tabs first, then work through the list below: click "Copy Message" for a
              lead, switch to their already-open tab, paste and send, then come back and click
              "Mark as Sent."
            </p>
            {queue.length > 10 && (
              <p className="text-xs text-amber-600 -mt-2">
                Heads up: if you're messaging leads you're not connected with, Sales Navigator's
                default plan includes 50 InMail credits/month. Sending to {queue.length} leads in one
                batch may use up more than you expect if this isn't your first batch this month.
              </p>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead className="w-[140px]">Status</TableHead>
                  <TableHead className="w-[220px]">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queue.map((lead) => {
                  const message =
                    mode === "bulk" ? bulkMessage : personalMessages[lead.key] ?? "";
                  const alreadySent = lead.status === "messaged";

                  return (
                    <TableRow key={lead.key}>
                      <TableCell className="align-top">
                        <p className="font-medium">{lead.full_name}</p>
                        <div className="flex items-center gap-1 mb-1 flex-wrap">
                          <Badge variant="outline" className="capitalize">
                            {lead.filterType}
                          </Badge>
                          {lead.tag && lead.tag !== "Invited" && (
                            <Badge variant="outline">{lead.tag}</Badge>
                          )}
                          <InvitedTagBadge
                            table={lead.sourceTable === "contacts" ? "doc_contacts" : "doc_dm_leads"}
                            recordId={lead.id}
                            tag={lead.tag}
                            queryKey={
                              lead.sourceTable === "contacts"
                                ? ["contacts", currentOrgId]
                                : ["dm-leads", currentOrgId]
                            }
                          />
                        </div>
                        {lead.linkedin_profile_url ? (
                          <a
                            href={lead.linkedin_profile_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-500 hover:underline flex items-center gap-1"
                          >
                            Profile <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <p className="text-xs text-muted-foreground">No LinkedIn URL</p>
                        )}
                      </TableCell>
                      <TableCell className="align-top min-w-[280px]">
                        {mode === "personalized" ? (
                          <div className="space-y-2">
                            <Textarea
                              value={message}
                              onChange={(e) =>
                                setPersonalMessages((prev) => ({
                                  ...prev,
                                  [lead.key]: e.target.value,
                                }))
                              }
                              rows={3}
                              className="text-sm"
                              placeholder="Write or generate a message..."
                            />
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => generateMutation.mutate(lead)}
                              disabled={generatingKey === lead.key}
                            >
                              {generatingKey === lead.key ? (
                                <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Generating...</>
                              ) : (
                                <><Sparkles className="h-3.5 w-3.5 mr-1" /> Generate with AI</>
                              )}
                            </Button>
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground line-clamp-3">
                            {message || "— write a message above —"}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        {alreadySent ? (
                          <Badge className="gap-1">
                            <CheckCircle2 className="h-3 w-3" /> Sent
                          </Badge>
                        ) : (
                          <Badge variant="outline">Not sent</Badge>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="flex flex-col gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => copyMessage(message)}
                          >
                            <Copy className="h-3.5 w-3.5 mr-1" /> Copy Message
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openAndCopy(lead, message)}
                            disabled={!lead.linkedin_profile_url}
                          >
                            <SquareArrowOutUpRight className="h-3.5 w-3.5 mr-1" /> Copy &amp; Open Tab
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => markSentMutation.mutate({ lead, message })}
                            disabled={!message.trim() || markSentMutation.isPending}
                          >
                            Mark as Sent
                          </Button>
                          <div className="pt-0.5">
                            <InvitedTagBadge
                              table={lead.sourceTable === "contacts" ? "doc_contacts" : "doc_dm_leads"}
                              recordId={lead.id}
                              tag={lead.tag}
                              queryKey={
                                lead.sourceTable === "contacts"
                                  ? ["contacts", currentOrgId]
                                  : ["dm-leads", currentOrgId]
                              }
                            />
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
