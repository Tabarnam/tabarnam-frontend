import React, { useEffect, useMemo } from "react";

/**
 * Drop-in replacement for react-helmet-async's <Helmet>.
 *
 * Why: the real library is mounted app-wide but applies NOTHING in this app —
 * verified on production 2026-08-11, /about shipped zero [data-rh] elements,
 * no canonical, no description, and kept the static index.html <title>. Every
 * <Helmet> block on the site was silently inert, so the whole site had no
 * per-page metadata.
 *
 * This accepts the same children (<title>, <meta>, <link>, <script>) and
 * applies them to document.head directly, cleaning up on unmount. Keeping the
 * component name and shape means pages migrate by changing one import line
 * rather than rewriting their markup.
 *
 * Deliberately minimal — no SSR, no nesting/priority rules, no dedupe across
 * simultaneously-mounted Helmets. This app renders one page at a time, which
 * is the only case that needs to work.
 */

const OWNED = "data-dh";

function textOf(children) {
  if (children == null || children === false) return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

/** Collect a spec from JSX children so the effect can depend on plain data. */
function specFrom(children) {
  const spec = { title: null, metas: [], links: [], scripts: [] };
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const { type, props } = child;
    if (type === "title") spec.title = textOf(props.children);
    else if (type === "meta") spec.metas.push(props);
    else if (type === "link") spec.links.push(props);
    else if (type === "script") spec.scripts.push({ type: props.type, body: textOf(props.children) });
  });
  return spec;
}

function metaSelector(props) {
  if (props.name) return `meta[name="${props.name}"]`;
  if (props.property) return `meta[property="${props.property}"]`;
  if (props.httpEquiv) return `meta[http-equiv="${props.httpEquiv}"]`;
  return null;
}

export function Helmet({ children }) {
  // Serialised so the effect re-runs on content change, not on every render.
  const spec = useMemo(() => specFrom(children), [children]);
  const key = JSON.stringify(spec);

  useEffect(() => {
    const previousTitle = document.title;
    const created = [];
    const patched = [];

    if (spec.title) document.title = spec.title;

    for (const props of spec.metas) {
      const selector = metaSelector(props);
      if (!selector || props.content == null) continue;
      let el = document.head.querySelector(selector);
      if (el) {
        patched.push([el, el.getAttribute("content")]);
      } else {
        el = document.createElement("meta");
        if (props.name) el.setAttribute("name", props.name);
        if (props.property) el.setAttribute("property", props.property);
        if (props.httpEquiv) el.setAttribute("http-equiv", props.httpEquiv);
        el.setAttribute(OWNED, "1");
        document.head.appendChild(el);
        created.push(el);
      }
      el.setAttribute("content", String(props.content));
    }

    for (const props of spec.links) {
      if (!props.rel || !props.href) continue;
      let el = document.head.querySelector(`link[rel="${props.rel}"]`);
      if (el) {
        patched.push([el, el.getAttribute("href")]);
        el.setAttribute("href", props.href);
      } else {
        el = document.createElement("link");
        el.setAttribute("rel", props.rel);
        el.setAttribute("href", props.href);
        el.setAttribute(OWNED, "1");
        document.head.appendChild(el);
        created.push(el);
      }
    }

    for (const s of spec.scripts) {
      if (!s.body) continue;
      const el = document.createElement("script");
      el.type = s.type || "application/ld+json";
      el.setAttribute(OWNED, "1");
      el.textContent = s.body;
      document.head.appendChild(el);
      created.push(el);
    }

    return () => {
      document.title = previousTitle;
      for (const el of created) el.parentNode?.removeChild(el);
      // Restore values on tags that already existed (index.html's own OG tags)
      // so leaving a page doesn't leave its metadata behind.
      for (const [el, prev] of patched) {
        const attr = el.tagName === "LINK" ? "href" : "content";
        if (prev == null) el.removeAttribute(attr);
        else el.setAttribute(attr, prev);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return null;
}

/**
 * Pass-through so App.jsx keeps its existing provider wrapper. Nothing here
 * needs context — each Helmet applies itself.
 */
export function HelmetProvider({ children }) {
  return <>{children}</>;
}

export default Helmet;
