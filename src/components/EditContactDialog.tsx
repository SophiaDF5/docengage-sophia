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
import { Loader2, Pencil } from "lucide-react";
import type { Contact } from "../types/database";

interface Props {
  contact: Contact;
  // ["contacts", orgId] on every page that reads doc_contacts, so whichever
  // page you're editing from, every other page picks up the fix too.
  queryKey: readonly [string, string | null];
}

// Fixes typos or wrong info on an existing doc_contacts row — name, LinkedIn
// URL, headline, email, tag. Separate from CustomFieldsDialog (which only
// manages the freeform custom_fields jsonb) and from the status/connected
// dropdowns already on the row — this dialog is specifically for "I got the
// core details wrong, let me correct them."
export function EditContactDialog({ contact, queryKey }: Props) {
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState(contact.full_name);
  const [linkedinUrl, setLinkedinUrl] = useState(contact.linkedin_profile_url);
  const [headline, setHeadline] = useState(contact.headline ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [tag, setTag] = useState(contact.tag ?? "");
  const queryClient = useQueryClient();

  function handleOpenChange(next: boolean) {
    if (next) {
      // Reset to the latest saved values each time it opens, in case another
      // page updated this row since the dialog was last used.
      setFullName(contact.full_name);
      setLinkedinUrl(contact.linkedin_profile_url);
      setHeadline(contact.headline ?? "");
      setEmail(contact.email ?? "");
      setTag(contact.tag ?? "");
    }
    setOpen(next);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("doc_contacts")
        .update({
          full_name: fullName.trim(),
          linkedin_profile_url: linkedinUrl.trim(),
          headline: headline.trim() || null,
          email: email.trim() || null,
          tag: tag.trim() || null,
        })
        .eq("id", contact.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Lead updated");
      setOpen(false);
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to update lead");
    },
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button variant="ghost" size="sm" className="h-7 w-7 p-0" />}>
        <Pencil className="h-3.5 w-3.5" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Lead</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>LinkedIn Profile URL</Label>
            <Input
              value={linkedinUrl}
              onChange={(e) => setLinkedinUrl(e.target.value)}
              type="url"
            />
          </div>
          <div className="space-y-2">
            <Label>Headline</Label>
            <Input value={headline} onChange={(e) => setHeadline(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
          </div>
          <div className="space-y-2">
            <Label>Tag</Label>
            <Input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="e.g. YouTube, Conference 2026..."
            />
          </div>
          <Button
            className="w-full"
            onClick={() => saveMutation.mutate()}
            disabled={!fullName.trim() || !linkedinUrl.trim() || saveMutation.isPending}
          >
            {saveMutation.isPending ? (
              <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Saving...</>
            ) : (
              "Save Changes"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
