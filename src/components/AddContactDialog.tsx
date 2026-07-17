import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "../lib/supabaseClient";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Loader2, Plus } from "lucide-react";

// Used by the Manual Added Leads page to add a single lead by hand — inserts
// into doc_contacts with source: 'manual'. Kept as its own component so the
// insert shape can't drift if it's ever wired into another page too.
export function AddContactDialog({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [headline, setHeadline] = useState("");
  const [tag, setTag] = useState("");
  const queryClient = useQueryClient();

  const addMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("doc_contacts").insert({
        org_id: orgId,
        full_name: fullName.trim(),
        linkedin_profile_url: linkedinUrl.trim(),
        headline: headline.trim() || null,
        tag: tag.trim() || null,
        source: "manual",
        status: "pending",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Lead added");
      setOpen(false);
      setFullName("");
      setLinkedinUrl("");
      setHeadline("");
      setTag("");
      queryClient.invalidateQueries({ queryKey: ["contacts", orgId] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to add lead");
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Plus className="h-4 w-4 mr-1" />
        Add Lead
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a Lead Manually</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Dr. Jane Smith"
            />
          </div>
          <div className="space-y-2">
            <Label>LinkedIn Profile URL</Label>
            <Input
              value={linkedinUrl}
              onChange={(e) => setLinkedinUrl(e.target.value)}
              placeholder="https://linkedin.com/in/..."
              type="url"
            />
          </div>
          <div className="space-y-2">
            <Label>Headline (optional)</Label>
            <Input
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              placeholder="Cardiologist at..."
            />
          </div>
          <div className="space-y-2">
            <Label>Tag (optional)</Label>
            <Input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="e.g. YouTube, Conference 2026..."
            />
          </div>
          <Button
            className="w-full"
            onClick={() => addMutation.mutate()}
            disabled={!fullName.trim() || !linkedinUrl.trim() || addMutation.isPending}
          >
            {addMutation.isPending ? (
              <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Adding...</>
            ) : (
              "Add Lead"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
