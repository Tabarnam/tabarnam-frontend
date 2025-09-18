import type {
  StarBundle,
  StarOverrideMode,
  StarOverrides,
  StarSignals
} from "../../pages/types/stars";
import { clamp } from "../../pages/types/stars";

function resolveOverride(value: StarOverrideMode | undefined | null): StarOverrideMode {
  return value === "suppress" || value === "force" ? value : null;
}

function boolToPoint(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function applyOverride(base: boolean, mode: StarOverrideMode): 0 | 1 {
  if (mode === "suppress") return 0;
  if (mode === "force") return 1;
  return boolToPoint(base);
}

/**
 * Calculates Tabarnam stars according to the confirmed product rules:
 * - Auto subtotal up to 3 points: HQ (0/1), Manufacturing (0/1), Review (0/1)
 * - Admin overrides can force/suppress each auto point without deleting data
 * - Any stars above 3 are manually awarded (manualExtra 0..2)
 * - Final score is capped at 5
 */
export function calcStars(signals: StarSignals): StarBundle {
  const {
    hqEligible,
    manufacturingEligible,
    approvedUserReviews,
    approvedEditorialReviews = 0,
    overrides: rawOverrides = null,
    manualExtra: rawManualExtra = 0,
    notes = []
  } = signals;

  // Normalize overrides with defaults
  const resolvedOverrides: StarOverrides = {
    hq: resolveOverride(rawOverrides?.hq ?? null),
    manufacturing: resolveOverride(rawOverrides?.manufacturing ?? null),
    review: resolveOverride(rawOverrides?.review ?? null),
  };

  // Review eligibility: approved user + trusted editorial >= 1
  const reviewEligible =
    (approvedUserReviews || 0) + (approvedEditorialReviews || 0) >= 1;

  // Apply overrides to each lane
  const hqPoint = applyOverride(!!hqEligible, resolvedOverrides.hq);
  const manufacturingPoint = applyOverride(
    !!manufacturingEligible,
    resolvedOverrides.manufacturing
  );
  const reviewPoint = applyOverride(!!reviewEligible, resolvedOverrides.review);

  const autoSubtotal = clamp(hqPoint + manufacturingPoint + reviewPoint, 0, 3);

  // Manual extra (admin): 0..2
  const manualExtra = clamp(Number(rawManualExtra ?? 0), 0, 2);

  // Final score capped at 5
  const final = clamp(autoSubtotal + manualExtra, 0, 5);

  // Reasons: include lanes that contributed a point + any admin reasons from notes
  const reasons: string[] = [];
  if (hqPoint === 1) reasons.push("hq");
  if (manufacturingPoint === 1) reasons.push("manufacturing");
  if (reviewPoint === 1) reasons.push("review");
  // Add "admin: …" entries derived from any notes (public or private) to star_reasons array
  for (const n of notes || []) {
    if (n && typeof n.text === "string" && n.text.trim().length > 0) {
      reasons.push(`admin: ${n.text.trim()}`);
    }
  }

  return {
    autoSubtotal,
    manualExtra,
    final,
    reasons,
    overrides: resolvedOverrides,
  };
}

// Helper: derive a compact tooltip model from StarBundle + notes
export function buildTooltipLines(
  bundle: StarBundle,
  notes: StarSignals["notes"] = []
): string[] {
  const lines: string[] = [];
  const awarded = new Set(
    bundle.reasons.filter(
      (r: string) => r === "hq" || r === "manufacturing" || r === "review"
    )
  );
  lines.push(`${awarded.has("hq") ? "✓" : "✗"} HQ`);
  lines.push(`${awarded.has("manufacturing") ? "✓" : "✗"} Manufacturing`);
  lines.push(`${awarded.has("review") ? "✓" : "✗"} Reviews`);
  // Only include public notes in tooltip (policy)
  for (const n of notes || []) {
    if (n?.public && n.text?.trim()) {
      lines.push(n.text.trim());
    }
  }
  return lines;
}
