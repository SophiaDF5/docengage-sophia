import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { supabase } from "../lib/supabaseClient";
import { callEdgeFunction } from "../lib/apiClient";
import { useOrganization } from "../hooks/useOrganization";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
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
  Upload,
  Sparkles,
  ExternalLink,
  Loader2,
  CheckCircle2,
  Copy,
  SquareArrowOutUpRight,
} from "lucide-react";
import type { Contact, ContactStatus, DmLead } from "../types/database";

type Mode = "bulk" | "personalized";
type SourceTable = "contacts" | "dm_leads";
type FilterType = "scraped" | "manual" | "engaged";

interface UnifiedLead {
  key: string; // `${sourceTable}:${id}`
  id: string;
  sourceTable: SourceTable;
  filterType: FilterType;
  full_name: string;
  linkedin_profile_url: string | null;
  headline: string | null;
  status: ContactStatus;
}

const FILTER_OPTIONS: { value: FilterType; label: string }[] = [
  { value: "scraped", label: "Scraped" },
  { value: "engaged", label: "Engaged" },
  { value: "manual", label: "Manual Added" },
];

interface ParsedRow {
  full_name?: string;
  linkedin_profile_url: string;
}

function normalizeKey(key: string) {
  return key.trim().toLowerCase();
}

function extractRows(rows: Record<string, unknown>[]): ParsedRow[] {
  return rows
    .map((row) => {
      let name: string | undefined;
      let url: string | undefined;

      for (const [key, value] of Object.entries(row)) {
        const k = normalizeKey(key);
        const v = typeof value === "string" ? value.trim() : String(value ?? "").trim();
        if (!v) continue;

        if (!url && (k.includes("linkedin") || k.includes("url") || k.includes("profile"))) {
          url = v;
        } else if (!name && k.includes("name")) {
          name = v;
        }
      }

      return { full_name: name, linkedin_profile_url: url };
    })
    .filter(
      (r): r is { full_name: string | undefined; linkedin_profile_url: string } =>
        !!r.linkedin_profile_url
    );
}

async function parseFile(file: File): Promise<ParsedRow[]> {
  const isCsv = file.name.toLowerCase().endsWith(".csv");

  if (isCsv) {
    const text = await file.text();
    const result = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
    });
    return extractRows(result.data);
  }

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet, { defval: "" });
  return extractRows(rows);
}

export function Outreach() {
  const { currentOrgId } = useOrganization();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [activeFilters, setActiveFilters] = useState<Set<FilterType>>(
    new Set(["scraped", "engaged", "manual"])
  );
  const [mode, setMode] = useState<Mode>("bulk");
  const [bulkMessage, setBulkMessage] = useState("");
  const [personalMessages, setPersonalMessages] = useState<Record<string, string>>({});
  const [generatingKey, setGeneratingKey] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);

  // Same query keys used by the Scraped Leads (Contacts.tsx) and Engaged Leads
  // (Leads.tsx) pages — this is what keeps status changes in sync across the app.
  // Whichever page updates a lead invalidates ["contacts", orgId] or
  // ["dm-leads", orgId], and every page (including this one) re-fetches.
  const contactsQuery = useQuery({
    queryKey: ["contacts", currentOrgId],
    queryFn: async () => {
      if (!currentOrgId) return [];
      const { data, error } = await supabase
        .from("doc_contacts")
        .select(
          "id, user_id, org_id, linkedin_profile_url, full_name, headline, email, is_connected, status, source, last_contacted_at, created_at, updated_at"
        )
        .eq("org_id", currentOrgId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Contact[];
    },
    enabled: !!currentOrgId,
  });

  const dmLeadsQuery = useQuery({
    queryKey: ["dm-leads", currentOrgId],
    queryFn: async () => {
      if (!currentOrgId) return [];
      const { data, error } = await supabase
        .from("doc_dm_leads")
        .select("*")
        .eq("org_id", currentOrgId)
        .order("name");
      if (error) throw error;
      return data as DmLead[];
    },
    enabled: !!currentOrgId,
  });

  const isLoading = contactsQuery.isLoading || dmLeadsQuery.isLoading;

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
    }));
    return [...fromContacts, ...fromDmLeads];
  }, [contactsQuery.data, dmLeadsQuery.data]);

  const visibleLeads = useMemo(
    () => allLeads.filter((l) => activeFilters.has(l.filterType)),
    [allLeads, activeFilters]
  );

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

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-uploading the same file later
    if (!file || !currentOrgId) return;

    setIsUploading(true);
    try {
      const rows = await parseFile(file);

      if (rows.length === 0) {
        toast.error("No LinkedIn URLs found — check the column headers include something like 'LinkedIn URL' or 'Profile'.");
        return;
      }

      // Uploaded here (as opposed to scraped via the Scraped Leads page) — tag as
      // 'manual' so it shows under the Manual Added filter.
      const { data, error } = await supabase
        .from("doc_contacts")
        .upsert(
          rows.map((r) => ({
            org_id: currentOrgId,
            linkedin_profile_url: r.linkedin_profile_url,
            full_name: r.full_name || "Unknown",
            status: "pending" as const,
            source: "manual" as const,
          })),
          { onConflict: "org_id,linkedin_profile_url", ignoreDuplicates: false }
        )
        .select("id");

      if (error) throw error;

      await queryClient.invalidateQueries({ queryKey: ["contacts", currentOrgId] });

      setSelectedKeys((prev) => {
        const next = new Set(prev);
        for (const row of data ?? []) next.add(`contacts:${row.id}`);
        return next;
      });
      setActiveFilters((prev) => new Set(prev).add("manual"));

      toast.success(`${rows.length} leads imported and added to your queue`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import file");
    } finally {
      setIsUploading(false);
    }
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
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-sm font-medium">1. Choose your leads</h2>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={handleFileChange}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
              >
                {isUploading ? (
                  <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Importing...</>
                ) : (
                  <><Upload className="h-4 w-4 mr-1" /> Upload CSV / Excel</>
                )}
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">Filter:</span>
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

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading leads...</p>
          ) : allLeads.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No leads yet — upload a file above, or add leads from Scraped Leads / Engaged Leads first.
            </p>
          ) : visibleLeads.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No leads match the selected filters.
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
                        <Badge variant="outline" className="capitalize mb-1">
                          {lead.filterType}
                        </Badge>
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
