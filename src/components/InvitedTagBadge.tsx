import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "../lib/supabaseClient";
import { Badge } from "./ui/badge";

interface Props {
  table: "doc_contacts" | "doc_dm_leads";
  recordId: string;
  tag: string | null;
  // Which React Query key to invalidate on save — matches whichever page's
  // query key owns this row (same convention as CustomFieldsDialog).
  queryKey: readonly [string, string | null];
}

// One-click "Mark Invited" / "✓ Invited" toggle, reused everywhere a lead is
// shown — Scraped Leads, Manual Added Leads, Engaged Leads, and Outreach —
// so tagging a lead as Invited (and un-tagging it) works the same way and
// stays in sync no matter which page you're on. Setting "Invited" overwrites
// any existing tag, since tag is a single freeform field per lead — the
// badge label shows the current tag when it's something other than
// "Invited" so that's visible before you overwrite it.
export function InvitedTagBadge({ table, recordId, tag, queryKey }: Props) {
  const queryClient = useQueryClient();
  const isInvited = tag === "Invited";

  const mutation = useMutation({
    mutationFn: async (nextTag: string | null) => {
      const { error } = await supabase.from(table).update({ tag: nextTag }).eq("id", recordId);
      if (error) throw error;
    },
    onSuccess: (_data, nextTag) => {
      queryClient.invalidateQueries({ queryKey });
      toast.success(nextTag ? `Tagged "${nextTag}"` : "Tag removed");
    },
    onError: () => toast.error("Failed to update tag"),
  });

  return (
    <Badge
      variant={isInvited ? "default" : "outline"}
      className="cursor-pointer select-none text-xs"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        mutation.mutate(isInvited ? null : "Invited");
      }}
      title={
        tag && !isInvited
          ? `Currently tagged "${tag}" — click to replace with Invited`
          : "Click to toggle the Invited tag"
      }
    >
      {isInvited ? "✓ Invited" : "Mark Invited"}
    </Badge>
  );
}
