import React from "react";
import { Bookmark } from "lucide-react";
import { useBookmarks } from "@/hooks/useBookmarks";

export default function BookmarkHeaderIcon() {
  const { totalBookmarked, setDrawerOpen } = useBookmarks();

  return (
    <button
      type="button"
      onClick={() => setDrawerOpen(true)}
      className="relative inline-flex items-center justify-center w-9 h-9 rounded-md hover:bg-muted transition-colors"
      aria-label="Open bookmarked companies"
      title="Bookmarked companies"
    >
      <Bookmark className="h-5 w-5 text-muted-foreground" />
      {totalBookmarked > 0 && (
        <span className="absolute -top-0.5 -right-0.5 bg-primary rounded-full w-2 h-2" />
      )}
    </button>
  );
}
