import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, X, Plus, MoreHorizontal, Pencil, Trash2, Copy, ClipboardPaste, Share } from "lucide-react";
import { useBookmarks } from "@/hooks/useBookmarks";
import { toast } from "@/lib/toast";

const DEFAULT_LIST_ID = "saved";

function ListSection({ list, items, onRemove, onNavigate, onDragStart, onDragEnd, dropTargetId, onDrop, onDragOverList, onDragLeaveList, disableDrag }) {
  const [expanded, setExpanded] = useState(list.id === DEFAULT_LIST_ID);
  const [confirmingRemove, setConfirmingRemove] = useState(null);
  const isDropTarget = dropTargetId === list.id;

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    onDragOverList(list.id);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    onDrop(list.id);
  };

  return (
    <div
      className={`border-b border-border last:border-b-0 transition-colors ${isDropTarget ? "bg-primary/10 ring-1 ring-primary/30 rounded-md" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={() => onDragLeaveList(list.id)}
      onDrop={handleDrop}
    >
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
            <p className="text-xs text-muted-foreground px-6 py-1.5">No companies bookmarked</p>
          ) : (
            items.map((item) => (
              <div
                key={item.company_id}
                draggable={!disableDrag && confirmingRemove !== item.company_id}
                onDragStart={disableDrag ? undefined : (e) => onDragStart(e, list.id, item)}
                onDragEnd={disableDrag ? undefined : onDragEnd}
                className={`flex items-center gap-1 px-6 py-1 group ${disableDrag ? "" : "cursor-grab active:cursor-grabbing"}`}
              >
                {confirmingRemove === item.company_id ? (
                  <div className="flex items-center gap-1.5 w-full">
                    <span className="text-xs text-muted-foreground truncate flex-1">Remove {item.name}?</span>
                    <button
                      type="button"
                      onClick={() => { onRemove(list.id, item.company_id, item.name, list.name); setConfirmingRemove(null); }}
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-white bg-destructive hover:bg-destructive/90 transition-colors"
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingRemove(null)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium hover:bg-accent transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
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
                      onClick={() => setConfirmingRemove(item.company_id)}
                      className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 rounded hover:bg-destructive/10 transition-opacity"
                      aria-label={`Remove ${item.name} from ${list.name}`}
                    >
                      <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

async function copyToClipboard(text) {
  const value = (text || "").toString();
  if (!value.trim()) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = value;
      el.setAttribute("readonly", "");
      el.style.position = "absolute";
      el.style.left = "-9999px";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

function ListHeader({ list, onRename, onDelete, onCopy, onPaste, onShare, hasClipboard, itemCount }) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState(list.name);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) {
      setConfirmingDelete(false);
      return;
    }
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
          <button
            type="button"
            onClick={() => { onCopy(list.id); setMenuOpen(false); }}
            className="flex items-center w-full rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Copy className="h-3.5 w-3.5 mr-2" />
            Copy
          </button>
          <button
            type="button"
            onClick={() => { onShare(list.id); setMenuOpen(false); }}
            className="flex items-center w-full rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Share className="h-3.5 w-3.5 mr-2" />
            Share
          </button>
          {hasClipboard && (
            <button
              type="button"
              onClick={() => { onPaste(list.id); setMenuOpen(false); }}
              className="flex items-center w-full rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <ClipboardPaste className="h-3.5 w-3.5 mr-2" />
              Paste
            </button>
          )}
          {list.id !== DEFAULT_LIST_ID && !confirmingDelete && (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="flex items-center w-full rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              Delete
            </button>
          )}
          {confirmingDelete && (
            <div className="px-2 py-1.5 space-y-1.5">
              <p className="text-xs text-muted-foreground">
                Delete "{list.name}"{itemCount > 0 ? ` and ${itemCount} bookmark${itemCount > 1 ? "s" : ""}` : ""}?
              </p>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => { onDelete(list.id, list.name); setMenuOpen(false); setConfirmingDelete(false); }}
                  className="flex-1 rounded-sm px-2 py-1 text-xs font-medium text-white bg-destructive hover:bg-destructive/90 transition-colors"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="flex-1 rounded-sm px-2 py-1 text-xs font-medium hover:bg-accent transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
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
    removeFromAllLists,
    moveToList,
    copyItemsToList,
    createList,
    renameList,
    deleteList,
    totalBookmarked,
  } = useBookmarks();
  const navigate = useNavigate();

  const [creatingList, setCreatingList] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [clipboard, setClipboard] = useState(null);

  // Drag state
  const dragRef = useRef(null);
  const [dropTargetId, setDropTargetId] = useState(null);

  const itemsByList = useMemo(() => {
    const map = {};
    for (const list of lists) {
      if (list.id === DEFAULT_LIST_ID) {
        const seen = new Set();
        const all = [];
        for (const item of items) {
          if (!seen.has(item.company_id)) {
            seen.add(item.company_id);
            all.push(item);
          }
        }
        map[DEFAULT_LIST_ID] = all;
      } else {
        map[list.id] = items.filter((i) => i.list_id === list.id);
      }
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
    if (listId === DEFAULT_LIST_ID) {
      removeFromAllLists(companyId);
      toast(`Removed ${companyName} from all lists`);
    } else {
      removeFromList(listId, companyId);
      toast(`Removed ${companyName} from ${listName}`);
    }
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

  // Drag and drop
  const handleDragStart = useCallback((e, listId, item) => {
    dragRef.current = { listId, item };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", item.name);
    e.currentTarget.style.opacity = "0.4";
  }, []);

  const handleDragEnd = useCallback((e) => {
    e.currentTarget.style.opacity = "";
    dragRef.current = null;
    setDropTargetId(null);
  }, []);

  const handleDragOverList = useCallback((listId) => {
    if (!dragRef.current || dragRef.current.listId === listId) {
      setDropTargetId(null);
      return;
    }
    setDropTargetId(listId);
  }, []);

  const handleDragLeaveList = useCallback((listId) => {
    setDropTargetId((prev) => (prev === listId ? null : prev));
  }, []);

  const handleDrop = useCallback((targetListId) => {
    const drag = dragRef.current;
    if (!drag || drag.listId === targetListId) {
      setDropTargetId(null);
      return;
    }
    const targetList = lists.find((l) => l.id === targetListId);
    if (drag.listId === DEFAULT_LIST_ID) {
      copyItemsToList(targetListId, [drag.item]);
      toast.success(`Copied ${drag.item.name} to ${targetList?.name || "list"}`);
    } else {
      moveToList(drag.listId, drag.item.company_id, targetListId);
      toast.success(`Moved ${drag.item.name} to ${targetList?.name || "list"}`);
    }
    dragRef.current = null;
    setDropTargetId(null);
  }, [lists, moveToList, copyItemsToList]);

  // Copy / paste
  const handleCopy = useCallback((listId) => {
    const listItems = itemsByList[listId] || [];
    if (listItems.length === 0) {
      toast("Nothing to copy");
      return;
    }
    const listName = lists.find((l) => l.id === listId)?.name || "list";
    setClipboard({ listName, items: listItems });
    toast.success(`Copied ${listItems.length} item${listItems.length > 1 ? "s" : ""} from ${listName}`);
  }, [itemsByList, lists]);

  const handlePaste = useCallback((targetListId) => {
    if (!clipboard) return;
    const targetList = lists.find((l) => l.id === targetListId);
    copyItemsToList(targetListId, clipboard.items);
    toast.success(`Pasted into ${targetList?.name || "list"}`);
  }, [clipboard, lists, copyItemsToList]);

  const handleShare = useCallback(async (listId) => {
    const list = lists.find((l) => l.id === listId);
    const listItems = itemsByList[listId] || [];
    if (listItems.length === 0) {
      toast("Nothing to share — list is empty");
      return;
    }
    const payload = {
      n: list?.name || "Bookmarks",
      c: listItems.map((i) => ({ i: i.company_id, n: i.name, d: i.normalized_domain || "" })),
    };
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    const shareUrl = `${window.location.origin}/?bookmarks=${encoded}`;
    const shareTitle = `Check out my Tabarnam list "${payload.n}"`;

    if (navigator.share) {
      try {
        await navigator.share({ title: shareTitle, text: shareTitle, url: shareUrl });
        return;
      } catch (error) {
        if (error.name === "AbortError") return;
      }
    }
    const ok = await copyToClipboard(shareUrl);
    if (ok) {
      toast.success("Share link copied to clipboard");
    } else {
      toast.error("Failed to copy");
    }
  }, [lists, itemsByList]);

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
        aria-label="Bookmarked Companies"
        className={`fixed inset-y-0 right-0 z-[100] w-80 sm:w-96 bg-card border-l border-border shadow-lg flex flex-col transition-transform duration-300 ease-in-out ${
          drawerOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-3 border-b border-border shrink-0">
          <h2 className="text-lg font-semibold text-foreground">Bookmarked Companies</h2>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="rounded-sm opacity-70 hover:opacity-100 transition-opacity"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* New List */}
        <div className="shrink-0 border-b border-border px-4 py-2.5">
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

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {totalBookmarked === 0 && lists.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <p className="text-sm text-muted-foreground">No bookmarks yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Click the bookmark icon on any company to add it here
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
                      onDragStart={handleDragStart}
                      onDragEnd={handleDragEnd}
                      dropTargetId={dropTargetId}
                      onDrop={handleDrop}
                      onDragOverList={handleDragOverList}
                      onDragLeaveList={handleDragLeaveList}
                      disableDrag={false}
                    />
                  </div>
                  <ListHeader
                    list={list}
                    onRename={renameList}
                    onDelete={handleDeleteList}
                    onCopy={handleCopy}
                    onPaste={handlePaste}
                    onShare={handleShare}
                    hasClipboard={!!clipboard}
                    itemCount={(itemsByList[list.id] || []).length}
                  />
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
