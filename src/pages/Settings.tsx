import { useState, useRef, Fragment } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "../lib/supabaseClient";
import { callEdgeFunction } from "../lib/apiClient";
import { useOrganization } from "../hooks/useOrganization";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Separator } from "../components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { Upload, Loader2, Copy, Check } from "lucide-react";
import type { ToneSample } from "../types/database";

export function Settings() {
  const { currentOrg, currentOrgId, organizations, isLoading } = useOrganization();

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  if (!currentOrg || !currentOrgId) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No workspace found.
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Settings for the "{currentOrg.name}" workspace. Switch workspaces from the picker in the
          header — each one has its own settings, leads, and history.
        </p>
      </div>

      {/* key={currentOrgId} forces this to remount (and reset its local
          input state) whenever the workspace switcher changes workspace —
          without it, the Name field would keep showing whatever was typed
          for the PREVIOUS workspace until a manual page reload. */}
      <AccountSettingsCard key={currentOrgId} orgId={currentOrgId} orgName={currentOrg.name} />

      <Separator />

      <ToneSection orgId={currentOrgId} systemPrompt={currentOrg.ai_system_prompt} />

      <Separator />

      <DangerZoneCard orgId={currentOrgId} orgName={currentOrg.name} canDelete={organizations.length > 1} />
    </div>
  );
}

function AccountSettingsCard({
  orgId,
  orgName,
}: {
  orgId: string;
  orgName: string;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(orgName);

  const updateMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("doc_organizations")
        .update({ name })
        .eq("id", orgId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Workspace name saved");
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: () => {
      toast.error("Failed to save settings");
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace Name</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="org-name">Name</Label>
          <Input
            id="org-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button
          onClick={() => updateMutation.mutate()}
          disabled={updateMutation.isPending}
        >
          {updateMutation.isPending ? "Saving..." : "Save Changes"}
        </Button>
      </CardContent>
    </Card>
  );
}

function ToneSection({
  orgId,
  systemPrompt,
}: {
  orgId: string;
  systemPrompt: string | null;
}) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [expandedSampleId, setExpandedSampleId] = useState<string | null>(null);
  const [copiedSampleId, setCopiedSampleId] = useState<string | null>(null);

  const copyTranscript = async (sampleId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedSampleId(sampleId);
      setTimeout(() => setCopiedSampleId((current) => (current === sampleId ? null : current)), 2000);
    } catch {
      toast.error("Couldn't copy — select and copy the text manually");
    }
  };

  const samplesQuery = useQuery({
    queryKey: ["tone_samples", orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("doc_tone_samples")
        .select("id, user_id, org_id, file_path, extracted_text, processing_status, created_at, updated_at")
        .eq("org_id", orgId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as ToneSample[];
    },
  });

  const processMutation = useMutation({
    mutationFn: async (sampleId: string) => {
      await callEdgeFunction("doc_process_tone", { sample_id: sampleId });
    },
    onSuccess: () => {
      toast.success("Tone sample processed");
      queryClient.invalidateQueries({ queryKey: ["tone_samples", orgId] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: () => {
      toast.error("Failed to process tone sample");
    },
  });

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const ext = file.name.split(".").pop() ?? "bin";
      const filePath = `${orgId}/${crypto.randomUUID()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from("doc_tone_uploads")
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      const { data: sample, error: insertError } = await supabase
        .from("doc_tone_samples")
        .insert({ org_id: orgId, file_path: filePath })
        .select("id")
        .single();

      if (insertError) throw insertError;

      toast.success("File uploaded. Processing...");
      queryClient.invalidateQueries({ queryKey: ["tone_samples", orgId] });

      // Trigger processing
      processMutation.mutate(sample.id);
    } catch {
      toast.error("Failed to upload tone sample");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const processingStatusBadge: Record<string, "outline" | "default" | "destructive"> = {
    pending: "outline",
    completed: "default",
    failed: "destructive",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">Tone & Voice</h2>
          <p className="text-sm text-muted-foreground">
            Comments and DMs always write in Atiba's voice, the same for every account —
            it's built into the app rather than set per account. Upload a sample here only
            if you want to pull a raw transcript to refine that voice with.
          </p>
        </div>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.ogg,.txt"
            className="hidden"
            onChange={handleUpload}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 mr-1" />
            )}
            Upload Sample
          </Button>
        </div>
      </div>

      {/* This summary is generated from an uploaded sample but no longer feeds
          Comment or DM generation (see the note above) — kept only as a
          reference in case it's useful. */}
      {systemPrompt && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tone Summary From Your Last Sample (reference only — not used by Comments or DMs)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{systemPrompt}</p>
          </CardContent>
        </Card>
      )}

      {/* Samples list */}
      {samplesQuery.data && samplesQuery.data.length > 0 && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Uploaded</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {samplesQuery.data.map((sample) => (
                <Fragment key={sample.id}>
                  <TableRow>
                    <TableCell className="font-mono text-sm">
                      {sample.file_path.split("/").pop()}
                    </TableCell>
                    <TableCell>
                      <Badge variant={processingStatusBadge[sample.processing_status]}>
                        {sample.processing_status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(sample.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      {sample.processing_status === "failed" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => processMutation.mutate(sample.id)}
                          disabled={processMutation.isPending}
                        >
                          Retry
                        </Button>
                      )}
                      {sample.processing_status === "completed" && sample.extracted_text && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setExpandedSampleId((current) => (current === sample.id ? null : sample.id))
                          }
                        >
                          {expandedSampleId === sample.id ? "Hide" : "View"} Transcript
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                  {expandedSampleId === sample.id && sample.extracted_text && (
                    <TableRow>
                      <TableCell colSpan={4} className="bg-muted/50">
                        <div className="space-y-2 py-1">
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-medium text-muted-foreground">
                              Raw transcript (this is what Whisper transcribed word-for-word)
                            </p>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => copyTranscript(sample.id, sample.extracted_text!)}
                            >
                              {copiedSampleId === sample.id ? (
                                <>
                                  <Check className="h-3.5 w-3.5 mr-1" /> Copied
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3.5 w-3.5 mr-1" /> Copy
                                </>
                              )}
                            </Button>
                          </div>
                          <p className="text-sm whitespace-pre-wrap">{sample.extracted_text}</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function DangerZoneCard({
  orgId,
  orgName,
  canDelete,
}: {
  orgId: string;
  orgName: string;
  canDelete: boolean;
}) {
  const { deleteOrg, isDeletingOrg } = useOrganization();
  const [confirmText, setConfirmText] = useState("");

  const handleDelete = async () => {
    if (confirmText.trim() !== orgName) return;
    await deleteOrg(orgId);
    setConfirmText("");
  };

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="text-destructive">Danger Zone</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!canDelete ? (
          <p className="text-sm text-muted-foreground">
            This is your only workspace, so it can't be deleted. Create another workspace first if
            you want to delete this one.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Deleting the "{orgName}" workspace permanently erases every lead, comment, DM, and
              outreach message in it. This cannot be undone, and there is no automatic backup on
              the free plan. Type the workspace name below to confirm.
            </p>
            <div className="space-y-2">
              <Label htmlFor="confirm-delete">
                Type <span className="font-mono font-medium">{orgName}</span> to confirm
              </Label>
              <Input
                id="confirm-delete"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={orgName}
              />
            </div>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={confirmText.trim() !== orgName || isDeletingOrg}
            >
              {isDeletingOrg ? "Deleting..." : "Delete This Workspace"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
