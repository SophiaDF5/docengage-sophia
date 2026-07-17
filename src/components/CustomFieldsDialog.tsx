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
import { Loader2, Pencil, Plus, X } from "lucide-react";
import type { CustomFields } from "../types/database";

interface Props {
  table: "doc_contacts" | "doc_dm_leads";
  recordId: string;
  leadName: string;
  customFields: CustomFields;
  // Which React Query key to invalidate on save — "contacts" or "dm-leads",
  // matching whichever page's query key owns this row (see the "Status
  // sync" note in claude.md — same principle applies here).
  queryKey: readonly [string, string | null];
}

interface FieldRow {
  key: string;
  value: string;
}

function fieldsToRows(fields: CustomFields): FieldRow[] {
  const rows = Object.entries(fields).map(([key, value]) => ({ key, value }));
  return rows.length > 0 ? rows : [{ key: "", value: "" }];
}

export function CustomFieldsDialog({ table, recordId, leadName, customFields, queryKey }: Props) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<FieldRow[]>(() => fieldsToRows(customFields));
  const queryClient = useQueryClient();

  function handleOpenChange(next: boolean) {
    if (next) setRows(fieldsToRows(customFields)); // reset to latest saved values each time it opens
    setOpen(next);
  }

  function updateRow(index: number, patch: Partial<FieldRow>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function addRow() {
    setRows((prev) => [...prev, { key: "", value: "" }]);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const next: CustomFields = {};
      for (const row of rows) {
        const key = row.key.trim();
        if (!key) continue;
        next[key] = row.value.trim();
      }
      const { error } = await supabase.from(table).update({ custom_fields: next }).eq("id", recordId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Details saved");
      setOpen(false);
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to save details");
    },
  });

  const filledCount = Object.keys(customFields).length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={<Button variant="ghost" size="sm" className="h-7 gap-1 px-2" />}
      >
        <Pencil className="h-3.5 w-3.5" />
        {filledCount > 0 ? `Details (${filledCount})` : "Add details"}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{leadName} — custom details</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <p className="text-xs text-muted-foreground">
            Add whatever info you want to track about this lead — job title, company, specialty,
            phone, anything. Field names are up to you.
          </p>
          {rows.map((row, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                {i === 0 && <Label className="text-xs">Field</Label>}
                <Input
                  value={row.key}
                  onChange={(e) => updateRow(i, { key: e.target.value })}
                  placeholder="e.g. Title"
                />
              </div>
              <div className="flex-1 space-y-1">
                {i === 0 && <Label className="text-xs">Value</Label>}
                <Input
                  value={row.value}
                  onChange={(e) => updateRow(i, { value: e.target.value })}
                  placeholder="e.g. Cardiologist"
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0 shrink-0"
                onClick={() => removeRow(i)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addRow}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add field
          </Button>
          <Button
            className="w-full"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? (
              <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Saving...</>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
