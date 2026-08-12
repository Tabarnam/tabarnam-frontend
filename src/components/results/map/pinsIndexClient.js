// Client for GET /api/map-pins — the precomputed whole-catalog pins index.
// Module-cached: one fetch per session (the endpoint is HTTP-cached anyway);
// consumers share the decoded Map. Lives in the lazy map chunk.
import { API_BASE } from "@/lib/api";
import { decodePinsPayload } from "./markerData";

// Payload schema this client understands. It rides in the request URL so a
// schema bump can never be answered from an HTTP/CDN cache holding the old
// shape — a stale v1 body would leave the made-in pages silently empty (seen
// in production 2026-08-11). Bump this whenever PAYLOAD_VERSION in
// api/_pinsIndex.js changes.
export const PINS_PAYLOAD_VERSION = 5;

let _promise = null;

export function fetchPinsIndex() {
  if (_promise) return _promise;
  _promise = fetch(`${API_BASE}/map-pins?v=${PINS_PAYLOAD_VERSION}`, {
    headers: { accept: "application/json" },
  })
    .then((r) => {
      if (!r.ok) throw new Error(`map-pins ${r.status}`);
      return r.json();
    })
    .then((payload) => decodePinsPayload(payload))
    .catch((err) => {
      // Allow a later retry instead of caching the failure forever.
      _promise = null;
      throw err;
    });
  return _promise;
}
