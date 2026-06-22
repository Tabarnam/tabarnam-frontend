import React, { memo, useState, lazy, Suspense } from "react";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { useBookmarks } from "@/hooks/useBookmarks";
import { toast } from "@/lib/toast";

const BookmarkListPicker = lazy(() => import("@/components/bookmarks/BookmarkListPicker"));

const DEFAULT_LIST_ID = "saved";

const BookmarkButton = memo(function BookmarkButton({ company }) {
  const { isBookmarked, addToList } = useBookmarks();
  const companyId = company.company_id || company.id;
  const bookmarked = isBookmarked(companyId);
  const [pickerOpen, setPickerOpen] = useState(false);

  const handleClick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (bookmarked) {
      setPickerOpen(true);
    } else {
      addToList(DEFAULT_LIST_ID, company);
      toast.success("Saved to Saved");
    }
  };

  const icon = bookmarked ? (
    <BookmarkCheck className="h-4 w-4 text-primary" />
  ) : (
    <Bookmark className="h-4 w-4 text-muted-foreground hover:text-foreground" />
  );

  if (bookmarked) {
    return (
      <Suspense fallback={null}>
        <BookmarkListPicker
          company={company}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
        >
          <button
            type="button"
            onClick={handleClick}
            className="bookmark-button-container inline-flex items-center justify-center w-7 h-7 min-w-0 min-h-0 rounded-md hover:bg-muted transition-colors"
            aria-label="Manage bookmark"
            title="Manage bookmark"
          >
            {icon}
          </button>
        </BookmarkListPicker>
      </Suspense>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="bookmark-button-container inline-flex items-center justify-center w-7 h-7 min-w-0 min-h-0 rounded-md hover:bg-muted transition-colors"
      aria-label="Save company"
      title="Save"
    >
      {icon}
    </button>
  );
});

export default BookmarkButton;
