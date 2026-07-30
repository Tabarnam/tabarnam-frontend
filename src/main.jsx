import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App'; // ✅ path from src
import './index.css';    // ✅ load Tailwind and custom styles
import "./styles/tokens.css";
import "./styles/shepherd-tabarnam.css";

// ── Canonical host ────────────────────────────────────────────────────────────
// Both tabarnam.com and www.tabarnam.com serve this app, and auth sessions are
// host-scoped: signing in on one host looks signed-out on the other, which
// produced confusing "not authorized" / re-login behaviour in the admin.
// Collapse to the apex so there is exactly one host and one session.
//
// NEVER redirect /.auth/* — those are the Azure auth endpoints, and the session
// cookie belongs to whichever host completed the flow. Rewriting a callback
// mid-flight would break sign-in.
(function canonicalizeHost() {
  try {
    const { hostname, pathname, search, hash } = window.location;
    if (hostname !== 'www.tabarnam.com') return;
    if (pathname.startsWith('/.auth/')) return; // auth flow in progress — leave it alone
    window.location.replace(`https://tabarnam.com${pathname}${search}${hash}`);
  } catch {
    // never let this block app start-up
  }
})();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ("serviceWorker" in navigator && (import.meta.env.PROD || window.location.hostname === "localhost")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch((error) => {
      console.warn("Service worker registration failed:", error);
    });
  });
}
