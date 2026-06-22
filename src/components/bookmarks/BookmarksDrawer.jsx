import React, { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, X, Plus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useBookmarks } from "@/hooks/useBookmarks";
import { toast } from "@/lib/toast";

const DEFAULT_LIST_ID = "saved";

function ListSection({ list, items, onRemove, onNavigate }) {
  const [expanded, setExpanded] = useState(list.id === DEFAULT_LIST_ID);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center w-full px-1 py-2.5 text-sm font-medium text-foreground hover:bg-muted/50 rounded-md transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 mr-1.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 mr-1.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{list.name}</span>
        <span className="ml-auto text-xs text-muted-foreground pr-1">
          {items.length}
        </span>
      </button>
      {expanded && (
        <div className="pb-2">
          {items.length === 0 ? (
            <p className="text-xs text-muted-foreground px-6 py-1.5">No companies saved</p>
          ) : (
            items.map((item) => (
              <div
                key={item.company_id}
                className="flex items-center gap-1 px-6 py-1 group"
              >
                <button
                  type="button"
                  onClick={() => onNavigate(item.name)}
                  className="text-sm text-foreground hover:text-primary hover:underline truncate text-left flex-1"
                  title={item.name}
                >
                  {item.name}
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(list.id, item.company_id, item.name, list.name)}
                  className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 rounded hover:bg-destructive/10 transition-opacity"
                  aria-label={`Remove ${item.name} from ${list.name}`}
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ListHeader({ list, onRename, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [name, setName] = useState(list.name);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== list.name) {
      onRename(list.id, trimmed);
    } else {
      setName(list.name);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={handleSubmit}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
          if (e.key === "Escape") {
            setName(list.name);
            setEditing(false);
          }
        }}
        className="text-sm font-medium bg-transparent border-b border-primary outline-none w-full px-1 py-0.5"
      />
    );
  }

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        onClick={() => setMenuOpen(!menuOpen)}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label={`Options for ${list.name}`}
      >
        <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
      </button>
      {menuOpen && (
        <div className="absolute right-0 top-full mt-1 z-50 w-36 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          <button
            type="button"
            onClick={() => { setEditing(true); setMenuOpen(false); }}
            className="flex items-center w-full rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Pencil className="h-3.5 w-3.5 mr-2" />
            Rename
          </button>
          {list.id !== DEFAULT_LIST_ID && (
            <button
              type="button"
              onClick={() => { onDelete(list.id, list.name); setMenuOpen(false); }}
              className="flex items-center w-full rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function BookmarksDrawer() {
  const {
    lists,
    items,
    drawerOpen,
    setDrawerOpen,
    removeFromList,
    createList,
    renameList,
    deleteList,
    totalBookmarked,
  } = useBookmarks();
  const navigate = useNavigate();

  const [creatingList, setCreatingList] = useState(false);
  const [newListName, setNewListName] = useState("");

  const itemsByList = useMemo(() => {
    const map = {};
    for (const list of lists) {
      map[list.id] = items.filter((i) => i.list_id === list.id);
    }
    return map;
  }, [lists, items]);

  useEffect(() => {
    if (!drawerOpen) return;
    const handleEsc = (e) => { if (e.key === "Escape") setDrawerOpen(false); };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [drawerOpen, setDrawerOpen]);

  const handleNavigate = (companyName) => {
    setDrawerOpen(false);
    navigate(`/results?q=${encodeURIComponent(companyName)}`);
  };

  const handleRemove = (listId, companyId, companyName, listName) => {
    removeFromList(listId, companyId);
    toast(`Removed ${companyName} from ${listName}`);
  };

  const handleCreateList = () => {
    const trimmed = newListName.trim();
    if (!trimmed) {
      setCreatingList(false);
      return;
    }
    createList(trimmed);
    toast.success(`Created list "${trimmed}"`);
    setNewListName("");
    setCreatingList(false);
  };

  const handleDeleteList = (listId, listName) => {
    deleteList(listId);
    toast(`Deleted list "${listName}"`);
  };

  return (
    <>
      {/* Overlay */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-[90] bg-black/80 transition-opacity"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      {/* Panel */}
      <div
        role="dialog"
        aria-label="Saved Companies"
        className={`fixed inset-y-0 right-0 z-[100] w-80 sm:w-96 bg-card border-l border-border shadow-lg flex flex-col transition-transform duration-300 ease-in-out ${
          drawerOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-3 border-b border-border shrink-0">
          <h2 className="text-lg font-semibold text-foreground">Saved Companies</h2>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="rounded-sm opacity-70 hover:opacity-100 transition-opacity"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {totalBookmarked === 0 && lists.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <p className="text-sm text-muted-foreground">No bookmarks yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Click the bookmark icon on any company to save it here
              </p>
            </div>
          ) : (
            lists.map((list) => (
              <div key={list.id} className="relative">
                <div className="flex items-center">
                  <div className="flex-1 min-w-0">
                    <ListSection
                      list={list}
                      items={itemsByList[list.id] || []}
                      onRemove={handleRemove}
                      onNavigate={handleNavigate}
                    />
                  </div>
                  <ListHeader
                    list={list}
                    onRename={renameList}
                    onDelete={handleDeleteList}
                  />
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-border px-4 py-3">
          {creatingList ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={newListName}
                onChange={(e) => setNewListName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateList();
                  if (e.key === "Escape") {
                    setNewListName("");
                    setCreatingList(false);
                  }
                }}
                onBlur={handleCreateList}
                placeholder="List name..."
                className="flex-1 text-sm bg-transparent border-b border-primary outline-none px-1 py-0.5"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreatingList(true)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="h-4 w-4" />
              New List
            </button>
          )}
        </div>
      </div>
    </>
  );
}
