// Pure reorder for the &expand=<companyId> flow: the pin-card link opens
// /results in a new tab with the target company floated to the top of the
// list (rendered expanded as a de-facto profile) and the rest of the search
// results flowing underneath as comparables.

/**
 * @param {Array<object>} sorted - the page's sorted result list
 * @param {string} expandId - raw ?expand= param
 * @returns {{list: Array<object>, promotedId: string|null}} list === sorted on no-op
 */
export function promoteExpanded(sorted, expandId) {
  const list = Array.isArray(sorted) ? sorted : [];
  const target = String(expandId ?? "").trim();
  if (!target) return { list, promotedId: null };
  const idx = list.findIndex(
    (c) => String(c?.company_id ?? c?.id ?? "").trim() === target
  );
  if (idx < 0) return { list, promotedId: null };
  if (idx === 0) return { list, promotedId: target };
  return {
    list: [list[idx], ...list.slice(0, idx), ...list.slice(idx + 1)],
    promotedId: target,
  };
}
