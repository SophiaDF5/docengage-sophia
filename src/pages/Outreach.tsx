import { useRef, useState } from "react";
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
} from "lucide-react";
import type { Contact } from "../types/database";

type Mode = "bulk" | "personalized";

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

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode>("bulk");
  const [bulkMessage, setBulkMessage] = useState("");
  const [personalMessages, setPersonalMessages] = useState<Record<string, string>>({});
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const contactsQuery = useQuery({
    queryKey: ["contacts", currentOrgId],
    queryFn: async () => {
      if (!currentOrgId) return [];
      const { data, error } = await supabase
        .from("doc_contacts")
        .select("id, user_id, org_id, linkedin_profile_url, full_name, headline, email, is_connected, status, last_contacted_at, created_at, updated_at")
        .eq("org_id", currentOrgId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Contact[];
    },
    enabled: !!currentOrgId,
  });

  const contacts = contactsQuery.data ?? [];
  const queue = contacts.filter((c) => selectedIds.has(c.id));

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

      const { data, error } = await supabase
        .from("doc_contacts")
        .upsert(
          rows.map((r) => ({
            org_id: currentOrgId,
            linkedin_profile_url: r.linkedin_profile_url,
            full_name: r.full_name || "Unknown",
            status: "pending" as const,
          })),
          { onConflict: "org_id,linkedin_profile_url", ignoreDuplicates: false }
        )
        .select("id");

      if (error) throw error;

      await queryClient.invalidateQueries({ queryKey: ["contacts", currentOrgId] });

      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const row of data ?? []) next.add(row.id);
        return next;
      });

      toast.success(`${rows.length} leads imported and added to your queue`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import file");
    } finally {
      setIsUploading(false);
    }
  }

  const generateMutation = useMutation({
    mutationFn: async (contact: Contact) => {
      setGeneratingId(contact.id);
      return callEdgeFunction<{ data: { generated_content: string } }>("doc_generate_dm", {
        org_id: currentOrgId,
        lead_name: contact.full_name,
        lead_bio: contact.headline || undefined,
        new_topic:
          "Write a friendly opening LinkedIn message to start a genuine conversation with this healthcare professional.",
      });
    },
    onSuccess: (result, contact) => {
      setPersonalMessages((prev) => ({
        ...prev,
        [contact.id]: result.data.generated_content,
      }));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Draft generation failed");
    },
    onSettled: () => setGeneratingId(null),
  });

  const markSentMutation = useMutation({
    mutationFn: async ({ contact, message }: { contact: Contact; message: string }) => {
      const { error: logError } = await supabase.from("doc_outreach_messages").insert({
        org_id: currentOrgId,
        contact_id: contact.id,
        message_content: message,
      });
      if (logError) throw logError;

      const { error: updateError } = await supabase
        .from("doc_contacts")
        .update({ status: "messaged", last_contacted_at: new Date().toISOString() })
        .eq("id", contact.id);
      if (updateError) throw updateError;
    },
    onSuccess: () => {
      toast.success("Marked as sent");
      queryClient.invalidateQueries({ queryKey: ["contacts", currentOrgId] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    },
  });

  async function openAndCopy(contact: Contact, message: string) {
    if (!message.trim()) {
      toast.error("Write or generate a message first");
      return;
    }
    await navigator.clipboard.writeText(message);
    window.open(contact.linkedin_profile_url, "_blank", "noopener,noreferrer");
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
          <div className="flex items-center justify-between">
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

          {contactsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading contacts...</p>
          ) : contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No contacts yet — upload a file above or add leads from the Contacts page first.
            </p>
          ) : (
            <div className="max-h-64 overflow-y-auto border rounded-md divide-y">
              {contacts.map((c) => (
                <label
                  key={c.id}
                  className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(c.id)}
                    onChange={() => toggleSelect(c.id)}
                    className="h-4 w-4 rounded border-border"
                  />
                  <span className="flex-1 min-w-0 truncate">{c.full_name}</span>
                  {c.headline && (
                    <span className="text-xs text-muted-foreground truncate max-w-[200px] hidden sm:inline">
                      {c.headline}
                    </span>
                  )}
                  <Badge variant={c.status === "messaged" ? "default" : "outline"}>
                    {c.status}
                  </Badge>
                </label>
              ))}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {selectedIds.size} lead{selectedIds.size === 1 ? "" : "s"} selected
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
            <h2 className="text-sm font-medium">3. Review &amp; send</h2>
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
                {queue.map((contact) => {
                  const message =
                    mode === "bulk" ? bulkMessage : personalMessages[contact.id] ?? "";
                  const alreadySent = contact.status === "messaged";

                  return (
                    <TableRow key={contact.id}>
                      <TableCell className="align-top">
                        <p className="font-medium">{contact.full_name}</p>
                        <a
                          href={contact.linkedin_profile_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-500 hover:underline inline-flex items-center gap-1"
                        >
                          Profile <ExternalLink className="h-3 w-3" />
                        </a>
                      </TableCell>
                      <TableCell className="align-top min-w-[280px]">
                        {mode === "personalized" ? (
                          <div className="space-y-2">
                            <Textarea
                              value={message}
                              onChange={(e) =>
                                setPersonalMessages((prev) => ({
                                  ...prev,
                                  [contact.id]: e.target.value,
                                }))
                              }
                              rows={3}
                              className="text-sm"
                              placeholder="Write or generate a message..."
                            />
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => generateMutation.mutate(contact)}
                              disabled={generatingId === contact.id}
                            >
                              {generatingId === contact.id ? (
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
                            onClick={() => openAndCopy(contact, message)}
                          >
                            <Copy className="h-3.5 w-3.5 mr-1" /> Copy &amp; Open LinkedIn
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => markSentMutation.mutate({ contact, message })}
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
