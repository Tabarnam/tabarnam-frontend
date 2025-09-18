// Production-ready types for Tabarnam star logic

export type StarOverrideMode = "suppress" | "force" | null;

export interface StarOverrides {
  hq: StarOverrideMode;
  manufacturing: StarOverrideMode;
  review: StarOverrideMode;
}

export interface StarNote {
  text: string;         // markdown/plaintext
  public: boolean;      // show in tooltip if true
  by: string;           // email or user id
  at: string;           // ISO timestamp (UTC)
}

export interface StarSignals {
  // Eligibility inputs detected/derived from data layer
  hqEligible: boolean;                    // HQ star eligible (e.g., verified HQ present)
  manufacturingEligible: boolean;         // Manufacturing star eligible (e.g., verified facility present)
  approvedUserReviews: number;            // count of approved user reviews
  approvedEditorialReviews?: number;      // count of trusted external editorial reviews (approved by rules)

  // Admin-controlled inputs
  overrides?: Partial<StarOverrides> | null; // optional; missing keys default to null
  manualExtra?: number | null;               // admin-awarded extra stars above auto subtotal (0..2)
  notes?: StarNote[] | null;                 // admin notes (some may be public)
}

export interface StarBundle {
  autoSubtotal: number;        // 0..3 (HQ + Manufacturing + Review after overrides)
  manualExtra: number;         // 0..2 (admin)
  final: number;               // 0..5 (capped)
  reasons: string[];           // ["hq","manufacturing","review", ...admin reason strings]
  overrides: StarOverrides;    // resolved overrides actually applied (no undefined keys)
}

// Convenience guard
export function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}
