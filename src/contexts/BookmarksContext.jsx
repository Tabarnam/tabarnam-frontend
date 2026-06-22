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
  if (lists.some((l) => l.id === DEFAULT_LIST_ID)) return lists;
  return [
    { id: DEFAULT_LIST_ID, name: "Bookmarked", created_at: Date.now(), position: 0 },
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
  const [lists, setLists] = useState(() => loadFromStorage().lists);
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

  const value = useMemo(
    () => ({
      lists: sortedLists,
      items,
      isBookmarked,
      getListsForCompany,
      totalBookmarked,
      addToList,
      removeFromList,
      createList,
      renameList,
      deleteList,
      reorderLists,
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
      createList,
      renameList,
      deleteList,
      reorderLists,
      drawerOpen,
    ]
  );

  return (
    <BookmarksContext.Provider value={value}>
      {children}
    </BookmarksContext.Provider>
  );
}
