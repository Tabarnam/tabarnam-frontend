let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getQueryValue(req, key) {
  if (req?.query && typeof req.query.get === "function") {
    return req.query.get(key);
  }
  return req?.query?.[key] || "";
}

async function shareCompanyHandler(req) {
  const company = String(getQueryValue(req, "company") || "").trim().slice(0, 160);
  const displayName = company || "A company";
  const title = `${displayName} on Tabarnam`;
  const description = `See where ${displayName} manufactures and is headquartered on Tabarnam.`;
  const resultsUrl = `https://tabarnam.com/results?q=${encodeURIComponent(displayName)}`;
  const canonicalUrl = `https://tabarnam.com/share?company=${encodeURIComponent(displayName)}`;
  const imageUrl = "https://tabarnam.com/tabarnam.png";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta property="og:site_name" content="Tabarnam" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
    <meta property="og:image" content="${escapeHtml(imageUrl)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
    <meta name="robots" content="noindex,follow" />
    <meta http-equiv="refresh" content="1;url=${escapeHtml(resultsUrl)}" />
  </head>
  <body>
    <p>Opening <a href="${escapeHtml(resultsUrl)}">${escapeHtml(displayName)} on Tabarnam</a>...</p>
    <script>window.location.replace(${JSON.stringify(resultsUrl)});</script>
  </body>
</html>`;

  return {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
    body: html,
  };
}

app.http("share-company", {
  route: "share-company",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: shareCompanyHandler,
});

module.exports = { handler: shareCompanyHandler };
