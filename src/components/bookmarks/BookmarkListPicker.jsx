import React, { useState } from "react";
import { Plus } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { useBookmarks } from "@/hooks/useBookmarks";
import { toast } from "@/lib/toast";

export default function BookmarkListPicker({ company, children, open, onOpenChange }) {
  const { lists, getListsForCompany, addToList, removeFromList, createList } = useBookmarks();
  const companyId = company.company_id || company.id;
  const companyListIds = getListsForCompany(companyId);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const handleToggle = (listId, listName, checked) => {
    if (checked) {
      addToList(listId, company);
      toast.success(`Added to ${listName}`);
    } else {
      removeFromList(listId, companyId);
      toast(`Removed from ${listName}`);
    }
  };

  const handleCreate = () => {
    const trimmed = newName.trim();
    if (!trimmed) {
      setCreating(false);
      return;
    }
    const id = createList(trimmed);
    addToList(id, company);
    toast.success(`Added to "${trimmed}"`);
    setNewName("");
    setCreating(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-56 p-3"
        style={{ zoom: 1.1111111 }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-medium mb-2">Save to list</p>
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {lists.map((list) => {
            const checked = companyListIds.includes(list.id);
            return (
              <label
                key={list.id}
                className="flex items-center gap-2 cursor-pointer rounded px-1 py-0.5 hover:bg-muted/50"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(val) => handleToggle(list.id, list.name, val)}
                  className="h-4 w-4"
                />
                <span className="text-sm truncate">{list.name}</span>
              </label>
            );
          })}
        </div>
        <div className="border-t border-border mt-2 pt-2">
          {creating ? (
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") {
                  setNewName("");
                  setCreating(false);
                }
              }}
              onBlur={handleCreate}
              placeholder="List name..."
              className="w-full text-sm bg-transparent border-b border-primary outline-none px-1 py-0.5"
            />
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              New list
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
