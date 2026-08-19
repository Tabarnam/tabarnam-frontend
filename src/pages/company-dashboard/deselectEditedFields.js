/**
 * A hand edit beats a pending suggestion.
 *
 * When a refresh or bulk paste proposes changes, each field gets a row in the
 * diff panel with a checkbox. On save, every SELECTED row overwrites the
 * editor draft — including any change the admin made by hand in the meantime.
 * That is silent and it loses real work: an admin deleted a stale HQ location
 * from Leacock's, saved, and watched it come back, because a proposal from an
 * earlier paste still had "HQ locations" ticked and won at write time.
 *
 * This decides which rows to untick. The rule: if the draft's value for a
 * field no longer matches what it was when the proposal arrived, the admin has
 * edited it, so that row is deselected. The conflict then shows up as a
 * checkbox clearing itself — visible, and reversible by re-ticking it — rather
 * than as work quietly disappearing at save.
 *
 * @param {object}   args
 * @param {Array<{key: string}>} args.fields   diff-panel rows
 * @param {object}   args.selection            { [key]: boolean } current ticks
 * @param {object}   args.draft                the live editor draft
 * @param {object}   args.baseline             draft snapshot from when the proposal arrived
 * @param {Function} [args.normalize]          (key, value) => comparable value
 * @returns {object|null} patch of keys to set false, or null when nothing changed
 */
export function deselectEditedFields({ fields, selection, draft, baseline, normalize }) {
  if (!Array.isArray(fields) || !draft || !baseline) return null;
  const sel = selection && typeof selection === "object" ? selection : {};
  const norm = typeof normalize === "function" ? normalize : (_k, v) => v;

  let patch = null;
  for (const f of fields) {
    const key = f && typeof f === "object" ? f.key : f;
    if (!key) continue;
    if (!sel[key]) continue; // already unticked — nothing to clear

    let now;
    let then;
    try {
      now = JSON.stringify(norm(key, draft[key]) ?? null);
      then = JSON.stringify(norm(key, baseline[key]) ?? null);
    } catch {
      continue; // unserializable value: leave the admin's tick alone
    }
    if (now !== then) {
      if (!patch) patch = {};
      patch[key] = false;
    }
  }
  return patch;
}

export default deselectEditedFields;
