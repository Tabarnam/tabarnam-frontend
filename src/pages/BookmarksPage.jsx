import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import {
  ArrowLeft, LayoutGrid, List, Building2, MoreHorizontal,
  X, ExternalLink, Pencil, Trash2, Share, ArrowDownAZ, ArrowUpZA,
  ImagePlus, ChevronRight, Loader2,
} from "lucide-react";
import { useBookmarks } from "@/hooks/useBookmarks";
import { getCompanyLogoUrl } from "@/lib/logoUrl";
import { searchCompanies } from "@/lib/searchCompanies";
import ExpandableCompanyRow from "@/components/results/ExpandableCompanyRow";
import { toast } from "@/lib/toast";

const DEFAULT_LIST_ID = "saved";

function LogoCell({ item }) {
  const url = item.logo_url ? getCompanyLogoUrl({ logo_url: item.logo_url }, "light") : null;
  if (url) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-gray-700 overflow-hidden">
        <img src={url} alt="" className="w-full h-full object-contain" loading="lazy" />
      </div>
    );
  }
  return (
    <div className="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-gray-700">
      <Building2 className="w-5 h-5 text-muted-foreground/40" />
    </div>
  );
}

function FolderCard({ list, items, isOpen, onClick }) {
  const top4 = items.slice(-4);
  const hasCover = list.cover_image && list.cover_image.value;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group text-left w-full rounded-xl overflow-hidden transition-all ${
        isOpen ? "ring-2 ring-primary" : "hover:ring-1 hover:ring-border"
      }`}
    >
      <div className="aspect-square bg-muted relative overflow-hidden rounded-xl">
        {hasCover ? (
          <img
            src={list.cover_image.type === "base64" ? list.cover_image.value : list.cover_image.value}
            alt={list.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="grid grid-cols-2 grid-rows-2 w-full h-full gap-px bg-border">
            {[0, 1, 2, 3].map((i) => (
              <LogoCell key={i} item={top4[i] || {}} />
            ))}
          </div>
        )}
      </div>
      <div className="px-1 pt-2 pb-1">
        <p className="text-sm font-medium text-foreground truncate">{list.name}</p>
        <p className="text-xs text-muted-foreground">{items.length}</p>
      </div>
    </button>
  );
}

function ExpandedFolder({
  list, items, onClose, onSort, onShare, onDelete, onRename,
  onSetCover, navigate,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(list.name);
  const menuRef = useRef(null);
  const containerRef = useRef(null);
  const [openProfiles, setOpenProfiles] = useState(new Set());
  const [profileData, setProfileData] = useState(new Map());
  const [loadingProfiles, setLoadingProfiles] = useState(new Set());

  const toggleProfile = useCallback(async (item) => {
    const cid = item.company_id;
    if (openProfiles.has(cid)) {
      setOpenProfiles((prev) => { const next = new Set(prev); next.delete(cid); return next; });
      return;
    }
    if (profileData.has(cid)) {
      setOpenProfiles((prev) => new Set(prev).add(cid));
      return;
    }
    setLoadingProfiles((prev) => new Set(prev).add(cid));
    try {
      const res = await searchCompanies({ q: item.name, take: 1, quick: true });
      const companies = Array.isArray(res) ? res : res?.companies || res?.items || [];
      if (companies.length > 0) {
        setProfileData((prev) => new Map(prev).set(cid, companies[0]));
        setOpenProfiles((prev) => new Set(prev).add(cid));
      } else {
        toast("Company not found");
      }
    } catch {
      toast.error("Failed to load company");
    } finally {
      setLoadingProfiles((prev) => { const next = new Set(prev); next.delete(cid); return next; });
    }
  }, [openProfiles, profileData]);

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menuOpen]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== list.name) onRename(list.id, trimmed);
    else setName(list.name);
    setEditing(false);
  };

  return (
    <div
      ref={containerRef}
      className="col-span-full bg-card border border-border rounded-xl p-4 space-y-3"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={handleSubmit}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
                if (e.key === "Escape") { setName(list.name); setEditing(false); }
              }}
              className="text-base font-semibold bg-transparent border-b border-primary outline-none flex-1 px-1"
            />
          ) : (
            <h3 className="text-base font-semibold text-foreground truncate">{list.name}</h3>
          )}
          <span className="text-xs text-muted-foreground shrink-0">{items.length} compan{items.length === 1 ? "y" : "ies"}</span>
        </div>
        <div className="flex items-center gap-1">
          {/* View All in Results */}
          <button
            type="button"
            onClick={() => navigate(`/results?list=${list.id}`)}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 px-2 py-1 rounded-md hover:bg-muted transition-colors"
            title="View all in results"
          >
            View All
            <ChevronRight className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => window.open(`/results?list=${list.id}`, "_blank")}
            className="p-1 rounded hover:bg-muted transition-colors"
            title="View all in results (new tab)"
          >
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          {/* Menu */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen(!menuOpen)}
              className="p-1 rounded hover:bg-muted transition-colors"
            >
              <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-40 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
                <button
                  type="button"
                  onClick={() => { setEditing(true); setMenuOpen(false); }}
                  className="flex items-center w-full rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
                >
                  <Pencil className="h-3.5 w-3.5 mr-2" /> Rename
                </button>
                {items.length > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={() => { onSort(list.id, "asc"); setMenuOpen(false); }}
                      className="flex items-center w-full rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
                    >
                      <ArrowDownAZ className="h-3.5 w-3.5 mr-2" /> Sort A→Z
                    </button>
                    <button
                      type="button"
                      onClick={() => { onSort(list.id, "desc"); setMenuOpen(false); }}
                      className="flex items-center w-full rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
                    >
                      <ArrowUpZA className="h-3.5 w-3.5 mr-2" /> Sort Z→A
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => { onShare(list.id); setMenuOpen(false); }}
                  className="flex items-center w-full rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
                >
                  <Share className="h-3.5 w-3.5 mr-2" /> Share
                </button>
                <button
                  type="button"
                  onClick={() => { onSetCover(list.id); setMenuOpen(false); }}
                  className="flex items-center w-full rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
                >
                  <ImagePlus className="h-3.5 w-3.5 mr-2" /> Set Cover
                </button>
                {list.id !== DEFAULT_LIST_ID && (
                  <button
                    type="button"
                    onClick={() => { onDelete(list.id, list.name); setMenuOpen(false); }}
                    className="flex items-center w-full rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                  </button>
                )}
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-muted transition-colors">
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Company list */}
      <div className="divide-y divide-border">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No companies in this list</p>
        ) : (
          items.map((item) => {
            const logoUrl = item.logo_url ? getCompanyLogoUrl({ logo_url: item.logo_url }, "light") : null;
            const isOpen = openProfiles.has(item.company_id);
            const isLoading = loadingProfiles.has(item.company_id);
            return (
              <div key={item.company_id}>
                <div
                  className={`flex items-center gap-3 py-2 group cursor-pointer rounded-md px-1 transition-colors ${isOpen ? "bg-muted/50" : "hover:bg-muted/30"}`}
                  onClick={() => toggleProfile(item)}
                >
                  <div className="w-8 h-8 rounded-md overflow-hidden shrink-0 bg-gray-100 dark:bg-gray-700 flex items-center justify-center">
                    {isLoading ? (
                      <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                    ) : logoUrl ? (
                      <img src={logoUrl} alt="" className="w-6 h-6 object-contain" />
                    ) : (
                      <Building2 className="w-4 h-4 text-muted-foreground/40" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-foreground truncate block">{item.name}</span>
                    {item.tagline && (
                      <p className="text-xs text-muted-foreground truncate">{item.tagline}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      window.open(`/results?q=${encodeURIComponent(item.name)}`, "_blank");
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-muted transition-opacity shrink-0"
                    title="Open in new tab"
                  >
                    <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </div>
                {isOpen && profileData.has(item.company_id) && (
                  <div className="mt-1 mb-2">
                    <ExpandableCompanyRow
                      company={profileData.get(item.company_id)}
                      unit="mi"
                      onKeywordSearch={(kw) => navigate(`/results?q=${encodeURIComponent(kw)}`)}
                      rightColsOrder={["stars", "manu", "hq"]}
                      sortBy="stars"
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function FolderCoverEditorDialog({ listId, currentCover, onSave, onClose }) {
  const [tab, setTab] = useState("upload");
  const [url, setUrl] = useState(currentCover?.type === "url" ? currentCover.value : "");
  const [preview, setPreview] = useState(currentCover?.value || null);
  const [previewType, setPreviewType] = useState(currentCover?.type || null);
  const fileRef = useRef(null);

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 200 * 1024) {
      toast.error("Image must be under 200 KB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPreview(reader.result);
      setPreviewType("base64");
    };
    reader.readAsDataURL(file);
  };

  const handleUrlPreview = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setPreview(trimmed);
    setPreviewType("url");
  };

  const handleSave = () => {
    if (!preview || !previewType) return;
    onSave(listId, { type: previewType, value: preview });
    onClose();
  };

  const handleRemove = () => {
    onSave(listId, null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-xl shadow-lg w-full max-w-sm mx-4 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-foreground">Set Cover Image</h3>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-muted"><X className="h-4 w-4" /></button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-muted rounded-lg p-0.5">
          <button
            type="button"
            onClick={() => setTab("upload")}
            className={`flex-1 text-sm py-1.5 rounded-md transition-colors ${tab === "upload" ? "bg-card shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
          >
            Upload
          </button>
          <button
            type="button"
            onClick={() => setTab("url")}
            className={`flex-1 text-sm py-1.5 rounded-md transition-colors ${tab === "url" ? "bg-card shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
          >
            URL
          </button>
        </div>

        {tab === "upload" ? (
          <div>
            <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} className="hidden" />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full border-2 border-dashed border-border rounded-lg py-6 text-sm text-muted-foreground hover:border-primary hover:text-foreground transition-colors"
            >
              Click to upload (max 200 KB)
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              className="flex-1 text-sm bg-transparent border border-border rounded-md px-2 py-1.5 outline-none focus:ring-1 focus:ring-primary"
              onKeyDown={(e) => { if (e.key === "Enter") handleUrlPreview(); }}
            />
            <button
              type="button"
              onClick={handleUrlPreview}
              className="text-sm px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Preview
            </button>
          </div>
        )}

        {preview && (
          <div className="rounded-lg overflow-hidden border border-border aspect-square bg-muted">
            <img src={preview} alt="Preview" className="w-full h-full object-cover" />
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={!preview}
            className="flex-1 text-sm py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            Save
          </button>
          {currentCover && (
            <button
              type="button"
              onClick={handleRemove}
              className="text-sm py-2 px-3 rounded-md text-destructive hover:bg-destructive/10 transition-colors"
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function BookmarksPage() {
  const {
    lists, items, setDrawerOpen, renameList, deleteList,
    sortListItems, setListCoverImage, allOrder,
  } = useBookmarks();
  const navigate = useNavigate();
  const [openFolderId, setOpenFolderId] = useState(null);
  const [coverEditorListId, setCoverEditorListId] = useState(null);

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
        if (allOrder.length > 0) {
          const byId = new Map(all.map((i) => [i.company_id, i]));
          const ordered = allOrder.map((cid) => byId.get(cid)).filter(Boolean);
          const rest = all.filter((i) => !allOrder.includes(i.company_id));
          map[DEFAULT_LIST_ID] = [...ordered, ...rest];
        } else {
          map[DEFAULT_LIST_ID] = all;
        }
      } else {
        map[list.id] = items.filter((i) => i.list_id === list.id);
      }
    }
    return map;
  }, [lists, items, allOrder]);

  const handleShare = useCallback(async (listId) => {
    const list = lists.find((l) => l.id === listId);
    const listItems = itemsByList[listId] || [];
    if (listItems.length === 0) { toast("Nothing to share"); return; }
    const payload = { n: list?.name || "Bookmarks", c: listItems.map((i) => [i.name, i.normalized_domain || ""]) };
    const json = JSON.stringify(payload);
    let encoded;
    try {
      const blob = new Blob([json]);
      const stream = blob.stream().pipeThrough(new CompressionStream("deflate-raw"));
      const buf = await new Response(stream).arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      encoded = "z:" + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } catch { encoded = btoa(unescape(encodeURIComponent(json))); }
    const shareUrl = `${window.location.origin}/?bookmarks=${encodeURIComponent(encoded)}`;
    const shareTitle = `Check out my "${payload.n}" bookmark list on Tabarnam`;
    const shareText = `${shareTitle}\n\n${shareUrl}`;
    if (navigator.share) {
      try { await navigator.share({ title: shareTitle, text: shareText, url: shareUrl }); return; }
      catch (err) { if (err.name === "AbortError") return; }
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Share link copied to clipboard");
    } catch { toast.error("Failed to copy"); }
  }, [lists, itemsByList]);

  const handleDelete = useCallback((listId, listName) => {
    deleteList(listId);
    toast(`Deleted list "${listName}"`);
    if (openFolderId === listId) setOpenFolderId(null);
  }, [deleteList, openFolderId]);

  // Build grid rows with expansion points
  const gridItems = useMemo(() => {
    const result = [];
    for (const list of lists) {
      result.push({ type: "card", list, items: itemsByList[list.id] || [] });
      if (openFolderId === list.id) {
        result.push({ type: "expansion", list, items: itemsByList[list.id] || [] });
      }
    }
    return result;
  }, [lists, itemsByList, openFolderId]);

  const coverEditorList = coverEditorListId ? lists.find((l) => l.id === coverEditorListId) : null;

  return (
    <>
      <Helmet><title>Bookmarks — Tabarnam</title></Helmet>
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="p-1.5 rounded-md hover:bg-muted transition-colors"
              aria-label="Go back"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <h1 className="text-xl font-semibold text-foreground">Bookmarked Companies</h1>
          </div>
          <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
            <button
              type="button"
              className="p-1.5 rounded-md bg-card shadow-sm"
              title="Folder view"
              disabled
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => { setDrawerOpen(true); navigate(-1); }}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors"
              title="List view"
            >
              <List className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Folder grid */}
        {lists.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="text-muted-foreground">No bookmarks yet</p>
            <p className="text-sm text-muted-foreground mt-1">Click the bookmark icon on any company to get started</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {gridItems.map((entry) =>
              entry.type === "card" ? (
                <FolderCard
                  key={entry.list.id}
                  list={entry.list}
                  items={entry.items}
                  isOpen={openFolderId === entry.list.id}
                  onClick={() => setOpenFolderId(openFolderId === entry.list.id ? null : entry.list.id)}
                />
              ) : (
                <ExpandedFolder
                  key={`expand-${entry.list.id}`}
                  list={entry.list}
                  items={entry.items}
                  onClose={() => setOpenFolderId(null)}
                  onSort={sortListItems}
                  onShare={handleShare}
                  onDelete={handleDelete}
                  onRename={renameList}
                  onSetCover={(id) => setCoverEditorListId(id)}
                  navigate={navigate}
                />
              )
            )}
          </div>
        )}
      </div>

      {/* Cover image editor dialog */}
      {coverEditorList && (
        <FolderCoverEditorDialog
          listId={coverEditorList.id}
          currentCover={coverEditorList.cover_image || null}
          onSave={setListCoverImage}
          onClose={() => setCoverEditorListId(null)}
        />
      )}
    </>
  );
}
