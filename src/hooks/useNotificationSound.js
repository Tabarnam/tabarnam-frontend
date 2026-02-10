import { useCallback, useRef } from "react";

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

const MANIFEST_URL = "/sounds/notifications/manifest.json";
const SOUNDS_BASE = "/sounds/notifications/";

// Module-level cache so we only fetch the manifest once across all hook instances.
let manifestPromise = null;
let manifestCache = null;

// Module-level last-played file so replay works across all hook instances.
let lastPlayedFile = null;

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

  const play = useCallback(async () => {
    if (playingRef.current) return;

    try {
      const files = await fetchManifest();
      const file = pickRandom(files);
      if (!file) {
        console.warn("[notification-sound] no file selected (manifest empty or not loaded)");
        return;
      }

      playingRef.current = true;
      lastPlayedFile = file;

      await playFile(file);
    } catch (err) {
      console.warn("[notification-sound] play error:", err.message || err);
    } finally {
      playingRef.current = false;
    }
  }, []);

  const replay = useCallback(async () => {
    if (playingRef.current) return;
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

  return { play, replay };
}
