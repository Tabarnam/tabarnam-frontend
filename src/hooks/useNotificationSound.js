import { useCallback, useEffect, useRef, useState } from "react";

// Phase 4.19 — persistent mute toggle (localStorage-backed).
// Stored as a JSON boolean. Default unmuted on first visit.
const MUTE_STORAGE_KEY = "tabarnam.import.notification_muted";

// Playback order preference. Default stays "shuffle" so nothing changes for
// anyone who never opens the settings panel.
const ORDER_STORAGE_KEY = "tabarnam.import.sound_order";
const MODE_STORAGE_KEY = "tabarnam.import.sound_mode";
const CURSOR_STORAGE_KEY = "tabarnam.import.sound_cursor";

function readJson(key, fallback) {
  try {
    if (typeof window === "undefined" || !window.localStorage) return fallback;
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — silently ignore */
  }
}

export function readSoundMode() {
  const m = readJson(MODE_STORAGE_KEY, "shuffle");
  return m === "ordered" ? "ordered" : "shuffle";
}

export function writeSoundMode(mode) {
  writeJson(MODE_STORAGE_KEY, mode === "ordered" ? "ordered" : "shuffle");
}

export function readSoundOrder() {
  const v = readJson(ORDER_STORAGE_KEY, null);
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : null;
}

export function writeSoundOrder(order) {
  writeJson(ORDER_STORAGE_KEY, Array.isArray(order) ? order : []);
}

/**
 * Merge a saved order with the live manifest so the preference survives clips
 * being added or removed: saved entries that still exist keep their position,
 * anything new is appended in manifest order.
 */
export function mergeOrderWithManifest(saved, manifest) {
  const files = Array.isArray(manifest) ? manifest : [];
  if (!Array.isArray(saved) || saved.length === 0) return [...files];
  const present = new Set(files);
  const kept = saved.filter((f) => present.has(f));
  const keptSet = new Set(kept);
  return [...kept, ...files.filter((f) => !keptSet.has(f))];
}

function readMutedFromStorage() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    const raw = window.localStorage.getItem(MUTE_STORAGE_KEY);
    if (raw === null || raw === undefined) return false;
    return raw === "true" || raw === "1";
  } catch {
    return false;
  }
}

function writeMutedToStorage(muted) {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(MUTE_STORAGE_KEY, muted ? "true" : "false");
  } catch {
    /* storage unavailable — silently ignore */
  }
}

/**
 * Hook that plays a random notification sound from /sounds/notifications/.
 *
 * Audio files (.mp3, .ogg, .wav, .m4a, .webm) are discovered via a manifest
 * that the Vite build plugin generates automatically from the contents of
 * `public/sounds/notifications/`.  Just drop new clips in that folder and
 * they'll be included on the next build/dev-server start.
 *
 * Usage:
 *   const { play, replay } = useNotificationSound();
 *   // on completion — picks a random clip:
 *   play();
 *   // replay button — re-plays the same clip that just played:
 *   replay();
 */

export const MANIFEST_URL = "/sounds/notifications/manifest.json";
export const SOUNDS_BASE = "/sounds/notifications/";

// Module-level cache so we only fetch the manifest once across all hook instances.
let manifestPromise = null;
let manifestCache = null;

// Module-level last-played file so replay works across all hook instances.
let lastPlayedFile = null;

export function fetchSoundManifest() {
  return fetchManifest();
}

// Settings-panel preview playback. Kept separate from playFile() (used by the
// import notification itself) because a preview must be interruptible: only
// one clip previews at a time and the row's button toggles play/pause.
let previewAudio = null;

export function stopPreview() {
  if (!previewAudio) return;
  try {
    previewAudio.pause();
    previewAudio.currentTime = 0;
  } catch {
    /* already torn down */
  }
  previewAudio = null;
}

/**
 * Start previewing a clip, replacing any preview already playing.
 * `onEnded` fires when the clip finishes, errors, or is superseded, so the
 * caller can reset its button back to "play".
 */
export function previewSound(file, { onEnded } = {}) {
  stopPreview();

  const url = `${SOUNDS_BASE}${encodeURIComponent(file)}`;
  const audio = new Audio(url);
  audio.volume = 0.7;
  previewAudio = audio;

  const finish = () => {
    if (previewAudio === audio) previewAudio = null;
    if (typeof onEnded === "function") onEnded();
  };
  audio.addEventListener("ended", finish);
  audio.addEventListener("error", finish);
  audio.play().catch((err) => {
    console.warn("[notification-sound] preview blocked:", err?.message || err);
    finish();
  });

  return audio;
}

function fetchManifest() {
  if (manifestCache && manifestCache.length > 0) return Promise.resolve(manifestCache);
  if (manifestPromise) return manifestPromise;

  manifestPromise = fetch(MANIFEST_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`Sound manifest fetch failed (HTTP ${res.status})`);

      // Guard against SWA navigation fallback returning HTML instead of JSON
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        throw new Error("Sound manifest returned HTML (likely SWA fallback) — check staticwebapp.config.json exclude list");
      }

      return res.json();
    })
    .then((list) => {
      if (!Array.isArray(list) || list.length === 0) {
        console.warn("[notification-sound] manifest is empty — no sound files found");
        manifestPromise = null; // allow retry
        return [];
      }
      console.log(`[notification-sound] loaded ${list.length} sound(s)`);
      manifestCache = list;
      return manifestCache;
    })
    .catch((err) => {
      console.warn("[notification-sound] could not load manifest:", err.message || err);
      manifestPromise = null; // allow retry on next call
      return [];
    });

  return manifestPromise;
}

function pickRandom(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Choose the next clip. In "ordered" mode this walks the admin's saved order
 * one clip per import and wraps at the end, persisting the cursor so the
 * sequence continues across page loads and browser sessions.
 */
function pickNext(files) {
  if (!files || files.length === 0) return null;
  if (readSoundMode() !== "ordered") return pickRandom(files);

  const order = mergeOrderWithManifest(readSoundOrder(), files);
  if (order.length === 0) return null;

  const raw = Number(readJson(CURSOR_STORAGE_KEY, 0));
  const idx = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) % order.length : 0;
  writeJson(CURSOR_STORAGE_KEY, (idx + 1) % order.length);
  return order[idx];
}

function playFile(file) {
  const url = `${SOUNDS_BASE}${encodeURIComponent(file)}`;
  console.log(`[notification-sound] playing: ${file}`);

  const audio = new Audio(url);
  audio.volume = 0.7;

  const done = new Promise((resolve) => {
    audio.addEventListener("ended", resolve);
    audio.addEventListener("error", (e) => {
      console.warn("[notification-sound] audio error:", e?.target?.error?.message || "unknown error", "url:", url);
      resolve();
    });
  });

  const started = audio.play().catch((err) => {
    console.warn("[notification-sound] playback blocked:", err.message || err);
  });

  return Promise.all([started, done]);
}

export default function useNotificationSound() {
  // Guard against overlapping plays within a very short window.
  const playingRef = useRef(false);
  const [lastPlayed, setLastPlayed] = useState(null);

  // Phase 4.19 — persistent mute toggle. Initial value from localStorage so
  // the preference survives reloads. `mutedRef` mirrors state so the play /
  // replay callbacks can read the latest value without being recreated.
  const [muted, setMutedState] = useState(readMutedFromStorage);
  const mutedRef = useRef(muted);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  const setMuted = useCallback((next) => {
    const resolved = typeof next === "function" ? next(mutedRef.current) : Boolean(next);
    mutedRef.current = resolved;
    writeMutedToStorage(resolved);
    setMutedState(resolved);
  }, []);

  const toggleMuted = useCallback(() => {
    setMuted((prev) => !prev);
  }, [setMuted]);

  const play = useCallback(async () => {
    if (playingRef.current) return;
    if (mutedRef.current) return; // Phase 4.19 — short-circuit when muted

    try {
      const files = await fetchManifest();
      const file = pickNext(files);
      if (!file) {
        console.warn("[notification-sound] no file selected (manifest empty or not loaded)");
        return;
      }

      playingRef.current = true;
      lastPlayedFile = file;
      setLastPlayed(file);

      await playFile(file);
    } catch (err) {
      console.warn("[notification-sound] play error:", err.message || err);
    } finally {
      playingRef.current = false;
    }
  }, []);

  const replay = useCallback(async () => {
    if (playingRef.current) return;
    if (mutedRef.current) return; // Phase 4.19 — replay is silent when muted
    if (!lastPlayedFile) {
      console.warn("[notification-sound] nothing to replay yet");
      return;
    }

    try {
      playingRef.current = true;
      console.log(`[notification-sound] replaying: ${lastPlayedFile}`);
      await playFile(lastPlayedFile);
    } catch (err) {
      console.warn("[notification-sound] replay error:", err.message || err);
    } finally {
      playingRef.current = false;
    }
  }, []);

  return { play, replay, lastPlayed, muted, setMuted, toggleMuted };
}
