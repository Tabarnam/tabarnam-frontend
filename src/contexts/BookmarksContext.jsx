import React, { createContext, useState, useCallback, useMemo, useEffect } from "react";
import { toast } from "@/lib/toast";

const STORAGE_KEY = "tabarnam_bookmarks_v1";
const DEFAULT_LIST_ID = "saved";

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { lists: [], items: [] };
    const data = JSON.parse(raw);
    if (!Array.isArray(data.lists) || !Array.isArray(data.items)) {
      return { lists: [], items: [] };
    }
    return data;
  } catch {
    return { lists: [], items: [] };
  }
}

function persist(lists, items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ lists, items }));
  } catch {
    toast.error("Storage full — could not save bookmark");
  }
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function ensureDefaultList(lists) {
  const existing = lists.find((l) => l.id === DEFAULT_LIST_ID);
  if (existing) {
    if (existing.name === "Bookmarked" || existing.name === "Saved") {
      return lists.map((l) => l.id === DEFAULT_LIST_ID ? { ...l, name: "All Bookmarks" } : l);
    }
    return lists;
  }
  return [
    { id: DEFAULT_LIST_ID, name: "All Bookmarks", created_at: Date.now(), position: 0 },
    ...lists.map((l) => ({ ...l, position: l.position + 1 })),
  ];
}

function buildIndex(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.company_id)) map.set(item.company_id, new Set());
    map.get(item.company_id).add(item.list_id);
  }
  return map;
}

export const BookmarksContext = createContext(null);

export function BookmarksProvider({ children }) {
  const [lists, setLists] = useState(() => ensureDefaultList(loadFromStorage().lists));
  const [items, setItems] = useState(() => loadFromStorage().items);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const companyIndex = useMemo(() => buildIndex(items), [items]);
  const totalBookmarked = companyIndex.size;

  const sortedLists = useMemo(
    () => [...lists].sort((a, b) => a.position - b.position),
    [lists]
  );

  const isBookmarked = useCallback(
    (companyId) => companyIndex.has(companyId),
    [companyIndex]
  );

  const getListsForCompany = useCallback(
    (companyId) => {
      const set = companyIndex.get(companyId);
      return set ? [...set] : [];
    },
    [companyIndex]
  );

  const addToList = useCallback(
    (listId, company) => {
      const cid = company.company_id || company.id;
      setLists((prev) => {
        const updated = listId === DEFAULT_LIST_ID ? ensureDefaultList(prev) : prev;
        setItems((prevItems) => {
          if (prevItems.some((i) => i.company_id === cid && i.list_id === listId)) {
            return prevItems;
          }
          const next = [
            ...prevItems,
            {
              company_id: cid,
              name: company.name || company.display_name || company.company_name || "",
              normalized_domain: company.normalized_domain || "",
              list_id: listId,
              added_at: Date.now(),
            },
          ];
          persist(updated, next);
          return next;
        });
        return updated;
      });
    },
    []
  );

  const removeFromList = useCallback((listId, companyId) => {
    setItems((prev) => {
      const next = prev.filter(
        (i) => !(i.company_id === companyId && i.list_id === listId)
      );
      setLists((currentLists) => {
        persist(currentLists, next);
        return currentLists;
      });
      return next;
    });
  }, []);

  const createList = useCallback((name) => {
    const id = makeId();
    setLists((prev) => {
      const maxPos = prev.reduce((m, l) => Math.max(m, l.position), -1);
      const next = [...prev, { id, name, created_at: Date.now(), position: maxPos + 1 }];
      setItems((currentItems) => {
        persist(next, currentItems);
        return currentItems;
      });
      return next;
    });
    return id;
  }, []);

  const renameList = useCallback((listId, name) => {
    setLists((prev) => {
      const next = prev.map((l) => (l.id === listId ? { ...l, name } : l));
      setItems((currentItems) => {
        persist(next, currentItems);
        return currentItems;
      });
      return next;
    });
  }, []);

  const deleteList = useCallback((listId) => {
    if (listId === DEFAULT_LIST_ID) return;
    setLists((prev) => {
      const next = prev.filter((l) => l.id !== listId);
      setItems((prevItems) => {
        const nextItems = prevItems.filter((i) => i.list_id !== listId);
        persist(next, nextItems);
        return nextItems;
      });
      return next;
    });
  }, []);

  const moveToList = useCallback((fromListId, companyId, toListId) => {
    setItems((prev) => {
      const item = prev.find((i) => i.company_id === companyId && i.list_id === fromListId);
      if (!item) return prev;
      if (prev.some((i) => i.company_id === companyId && i.list_id === toListId)) {
        const next = prev.filter((i) => !(i.company_id === companyId && i.list_id === fromListId));
        setLists((cl) => { persist(cl, next); return cl; });
        return next;
      }
      const next = prev
        .filter((i) => !(i.company_id === companyId && i.list_id === fromListId))
        .concat({ ...item, list_id: toListId, added_at: Date.now() });
      setLists((cl) => { persist(cl, next); return cl; });
      return next;
    });
  }, []);

  const copyItemsToList = useCallback((targetListId, sourceItems) => {
    setItems((prev) => {
      let next = prev;
      let added = 0;
      for (const src of sourceItems) {
        if (next.some((i) => i.company_id === src.company_id && i.list_id === targetListId)) continue;
        next = [...next, { ...src, list_id: targetListId, added_at: Date.now() }];
        added++;
      }
      if (added === 0) return prev;
      setLists((cl) => { persist(cl, next); return cl; });
      return next;
    });
  }, []);

  const removeFromAllLists = useCallback((companyId) => {
    setItems((prev) => {
      const next = prev.filter((i) => i.company_id !== companyId);
      if (next.length === prev.length) return prev;
      setLists((cl) => { persist(cl, next); return cl; });
      return next;
    });
  }, []);

  const reorderItems = useCallback((listId, orderedCompanyIds) => {
    setItems((prev) => {
      const inList = prev.filter((i) => i.list_id === listId);
      const rest = prev.filter((i) => i.list_id !== listId);
      const sorted = orderedCompanyIds
        .map((cid) => inList.find((i) => i.company_id === cid))
        .filter(Boolean);
      const missing = inList.filter((i) => !orderedCompanyIds.includes(i.company_id));
      const next = [...rest, ...sorted, ...missing];
      setLists((cl) => { persist(cl, next); return cl; });
      return next;
    });
  }, []);

  const sortListItems = useCallback((listId, direction) => {
    setItems((prev) => {
      const inList = prev.filter((i) => i.list_id === listId);
      const rest = prev.filter((i) => i.list_id !== listId);
      const sorted = [...inList].sort((a, b) => {
        const cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        return direction === "asc" ? cmp : -cmp;
      });
      const next = [...rest, ...sorted];
      setLists((cl) => { persist(cl, next); return cl; });
      return next;
    });
  }, []);

  const reorderLists = useCallback((orderedIds) => {
    setLists((prev) => {
      const next = orderedIds.map((id, i) => {
        const list = prev.find((l) => l.id === id);
        return list ? { ...list, position: i } : null;
      }).filter(Boolean);
      setItems((currentItems) => {
        persist(next, currentItems);
        return currentItems;
      });
      return next;
    });
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const encoded = params.get("bookmarks");
    if (!encoded) return;
    (async () => {
      try {
        let json;
        if (encoded.startsWith("z:")) {
          const b64 = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
          json = await new Response(stream).text();
        } else {
          json = decodeURIComponent(escape(atob(encoded)));
        }
        const data = JSON.parse(json);
        if (!data.n || !Array.isArray(data.c) || data.c.length === 0) return;
        const listId = makeId();
        const isCompressed = Array.isArray(data.c[0]);
        setLists((prev) => {
          const maxPos = prev.reduce((m, l) => Math.max(m, l.position), -1);
          const next = [...prev, { id: listId, name: data.n, created_at: Date.now(), position: maxPos + 1 }];
          setItems((prevItems) => {
            let nextItems = prevItems;
            for (const c of data.c) {
              const name = isCompressed ? c[0] : c.n;
              const domain = isCompressed ? (c[1] || "") : (c.d || "");
              const companyId = domain || name;
              if (nextItems.some((i) => i.company_id === companyId && i.list_id === listId)) continue;
              nextItems = [...nextItems, {
                company_id: companyId,
                name,
                normalized_domain: domain,
                list_id: listId,
                added_at: Date.now(),
              }];
            }
            persist(next, nextItems);
            return nextItems;
          });
          return next;
        });
        toast.success(`Imported list "${data.n}" with ${data.c.length} compan${data.c.length === 1 ? "y" : "ies"}`);
        setDrawerOpen(true);
      } catch { /* ignore malformed data */ }
      const url = new URL(window.location.href);
      url.searchParams.delete("bookmarks");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    })();
  }, []);

  const value = useMemo(
    () => ({
      lists: sortedLists,
      items,
      isBookmarked,
      getListsForCompany,
      totalBookmarked,
      addToList,
      removeFromList,
      removeFromAllLists,
      moveToList,
      copyItemsToList,
      createList,
      renameList,
      deleteList,
      reorderLists,
      reorderItems,
      sortListItems,
      drawerOpen,
      setDrawerOpen,
    }),
    [
      sortedLists,
      items,
      isBookmarked,
      getListsForCompany,
      totalBookmarked,
      addToList,
      removeFromList,
      removeFromAllLists,
      moveToList,
      copyItemsToList,
      createList,
      renameList,
      deleteList,
      reorderLists,
      reorderItems,
      sortListItems,
      drawerOpen,
    ]
  );

  return (
    <BookmarksContext.Provider value={value}>
      {children}
    </BookmarksContext.Provider>
  );
}
