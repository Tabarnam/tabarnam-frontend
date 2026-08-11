import { useEffect } from "react";

/**
 * Sets document title / meta / canonical / JSON-LD imperatively.
 *
 * Why not <Helmet>: react-helmet-async (2.0.5) is mounted app-wide but applies
 * NOTHING in this app — verified on production 2026-08-11: /about renders zero
 * [data-rh] elements, keeps the static index.html <title>, and has no canonical
 * or description tag. Since the /made-in pages exist purely to rank, their head
 * tags cannot depend on a library that is silently inert.
 *
 * Tags written here are marked data-dh so they can be cleaned up on unmount /
 * route change without disturbing the static tags in index.html.
 */
const OWNED = "data-dh";

function upsertMeta(attr, key, content) {
  if (!content) return;
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    el.setAttribute(OWNED, "1");
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function upsertLink(rel, href) {
  if (!href) return;
  let el = document.head.querySelector(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    el.setAttribute(OWNED, "1");
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.description]
 * @param {string} [opts.canonical] - absolute URL
 * @param {object} [opts.jsonLd] - schema.org object
 * @param {boolean} [opts.ready] - defer writing until data has loaded (so a
 *   crawler/user never sees a placeholder title); defaults to true
 */
export default function useDocumentHead({ title, description, canonical, jsonLd, ready = true }) {
  useEffect(() => {
    if (!ready) return undefined;

    const previousTitle = document.title;
    if (title) document.title = title;
    if (description) {
      upsertMeta("name", "description", description);
      upsertMeta("property", "og:description", description);
    }
    if (title) upsertMeta("property", "og:title", title);
    if (canonical) {
      upsertLink("canonical", canonical);
      upsertMeta("property", "og:url", canonical);
    }
    upsertMeta("property", "og:type", "website");

    let script = null;
    if (jsonLd) {
      script = document.createElement("script");
      script.type = "application/ld+json";
      script.setAttribute(OWNED, "1");
      script.textContent = JSON.stringify(jsonLd);
      document.head.appendChild(script);
    }

    return () => {
      document.title = previousTitle;
      if (script && script.parentNode) script.parentNode.removeChild(script);
      // Drop the canonical we added so the next route doesn't inherit it.
      const canonicalEl = document.head.querySelector(`link[rel="canonical"][${OWNED}]`);
      if (canonicalEl && canonicalEl.parentNode) canonicalEl.parentNode.removeChild(canonicalEl);
    };
  }, [title, description, canonical, jsonLd, ready]);
}
