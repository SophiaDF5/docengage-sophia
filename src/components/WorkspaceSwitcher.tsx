import { useState } from "react";
import { useOrganization } from "../hooks/useOrganization";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Building2, ChevronsUpDown, Check, Plus, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";

// Lets Reina switch between fully isolated "workspaces" under her one login
// (e.g. one per client) — see useOrganization.ts for why this needed no
// backend/RLS changes, just a way to fetch + switch + create org rows.
// Deliberately kept separate from Settings' "Account" card: this is the
// everyday switch-and-create surface; renaming or deleting a workspace
// stays in Settings, next to that workspace's other settings.
export function WorkspaceSwitcher() {
  const {
    organizations,
    currentOrg,
    currentOrgId,
    switchOrg,
    createOrg,
    isCreatingOrg,
    isLoading,
  } = useOrganization();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");

  if (isLoading) {
    return <div className="h-8 w-36 rounded-md bg-muted animate-pulse" />;
  }

  if (!currentOrg) {
    return null;
  }

  const handleCreate = async () => {
    if (!newName.trim() || isCreatingOrg) return;
    await createOrg(newName);
    setNewName("");
    setCreateOpen(false);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" className="gap-2 max-w-[180px] sm:max-w-[220px]" />}
        >
          <Building2 className="h-4 w-4 shrink-0" />
          <span className="truncate">{currentOrg.name}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[220px]">
          {/* DropdownMenuLabel renders base-ui's Menu.GroupLabel, which
              requires a MenuGroupContext from an enclosing Menu.Group —
              without this wrapper it throws Base UI error #31 at runtime. */}
          <DropdownMenuGroup>
            <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
            {organizations.map((org) => (
              <DropdownMenuItem key={org.id} onClick={() => switchOrg(org.id)}>
                <Check
                  className={cn(
                    "h-4 w-4 mr-2 shrink-0",
                    org.id === currentOrgId ? "opacity-100" : "opacity-0"
                  )}
                />
                <span className="truncate">{org.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a New Workspace</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label>Workspace Name</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Client A, Dr. Smith's Practice..."
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                }}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Starts completely empty — its own leads, comments, and messages, fully separate
                from your other workspaces.
              </p>
            </div>
            <Button className="w-full" onClick={handleCreate} disabled={!newName.trim() || isCreatingOrg}>
              {isCreatingOrg ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Creating...
                </>
              ) : (
                "Create Workspace"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
