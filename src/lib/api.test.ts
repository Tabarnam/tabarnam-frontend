import { describe, test, expect } from "vitest";
import { readJsonOrText } from "./api";

// Phase 4.4 — readJsonOrText should detect HTML responses (typically
// 502/503/504 gateway pages from Azure Front Door or App Service when
// the backend Function App is restarting/scaling) and return a soft
// gateway-error object instead of dumping raw HTML into a `text` field.
//
// Bug observed 2026-05-12: an upstream 502 returned during a Phase 4.3
// deploy. The UI "Saved — enrichment running in background…" panel
// rendered the raw 502 HTML body verbatim because readJsonOrText was
// returning { text: "<!DOCTYPE html>..." } and the caller used `.text`
// as the status message.

function makeRes(body: string, status: number, contentType: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

describe("Phase 4.4 — readJsonOrText handles HTML gateway responses", () => {
  test("parses application/json bodies normally", async () => {
    const res = makeRes('{"ok":true,"foo":"bar"}', 200, "application/json");
    const result = await readJsonOrText(res);
    expect(result).toEqual({ ok: true, foo: "bar" });
  });

  test("returns { text } for valid plain-text bodies", async () => {
    const res = makeRes("hello world", 200, "text/plain");
    const result = await readJsonOrText(res);
    expect(result).toEqual({ text: "hello world" });
  });

  test("502 HTML response returns gateway_html_response — NOT raw HTML in .text", async () => {
    const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN">
<html><body><h1>Server Error</h1><h2>502 - Web server received an invalid response while acting as a gateway or proxy server.</h2></body></html>`;
    const res = makeRes(html, 502, "text/html; charset=iso-8859-1");
    const result = (await readJsonOrText(res)) as Record<string, unknown>;
    expect(result.error).toBe("gateway_html_response");
    expect(result.status).toBe(502);
    expect(typeof result.message).toBe("string");
    expect(result.message).toMatch(/Backend temporarily unavailable/);
    // Anti-regression: raw HTML must NOT appear in the result
    expect(JSON.stringify(result)).not.toContain("<!DOCTYPE");
    expect(JSON.stringify(result)).not.toContain("<html");
  });

  test("503 HTML response also returns gateway_html_response", async () => {
    const html = "<html><body>Service Unavailable</body></html>";
    const res = makeRes(html, 503, "text/html");
    const result = (await readJsonOrText(res)) as Record<string, unknown>;
    expect(result.error).toBe("gateway_html_response");
    expect(result.status).toBe(503);
  });

  test("HTML detected via body sniff when content-type is missing/wrong", async () => {
    // Some misconfigured proxies return HTML without setting content-type.
    // The body-sniff regex catches <!doctype / <html / <head / <body.
    const html = "<!doctype html><html><body>error</body></html>";
    const res = makeRes(html, 502, "application/octet-stream");
    const result = (await readJsonOrText(res)) as Record<string, unknown>;
    expect(result.error).toBe("gateway_html_response");
    expect(result.status).toBe(502);
  });

  test("200-status HTML returns a non-5xx gateway message", async () => {
    // Edge case: HTML body with 200 status (unusual but possible during a
    // misrouted request). Still get a soft message, not raw HTML.
    const html = "<html><body>oops</body></html>";
    const res = makeRes(html, 200, "text/html");
    const result = (await readJsonOrText(res)) as Record<string, unknown>;
    expect(result.error).toBe("gateway_html_response");
    expect(result.status).toBe(200);
    expect(result.message).toMatch(/Unexpected HTML response/);
  });

  test("invalid JSON body with application/json content-type returns { error, text }", async () => {
    const res = makeRes("{not json", 200, "application/json");
    const result = (await readJsonOrText(res)) as Record<string, unknown>;
    expect(result.error).toBe("Invalid JSON");
    expect(result.text).toBe("{not json");
  });

  test("empty body returns empty object", async () => {
    const res = makeRes("", 200, "text/plain");
    const result = await readJsonOrText(res);
    expect(result).toEqual({});
  });
});
