const { extractJsonFromText, asString } = require("./_curatedReviewsXai");

function toNumberOrNull(value) {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function isAzureWebsitesUrl(rawUrl) {
  const raw = asString(rawUrl).trim().toLowerCase();
  if (!raw) return false;
  return raw.includes(".azurewebsites.net");
}

function buildXaiHeaders(xaiUrl, xaiKey) {
  const headers = { "Content-Type": "application/json" };
  if (isAzureWebsitesUrl(xaiUrl)) headers["x-functions-key"] = asString(xaiKey).trim();
  else headers["Authorization"] = `Bearer ${asString(xaiKey).trim()}`;
  return headers;
}

function normalizeTagline(value) {
  const raw = asString(value).trim();
  if (!raw) return "";
  const cleaned = raw
    .replace(/^['"“”]+/, "")
    .replace(/['"“”]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";
  if (cleaned.length > 180) return cleaned.slice(0, 180).trim();

  // avoid obvious junk placeholders
  const lower = cleaned.toLowerCase();
  if (lower === "unknown" || lower === "n/a" || lower === "na" || lower === "none") return "";

  return cleaned;
}

async function callXaiJsonObject({ axiosPost, xaiUrl, xaiKey, timeoutMs, model, messages }) {
  if (!axiosPost) throw new Error("Missing axiosPost");

  const resp = await axiosPost(
    xaiUrl,
    {
      model,
      messages,
      temperature: 0.1,
      stream: false,
    },
    {
      headers: buildXaiHeaders(xaiUrl, xaiKey),
      timeout: Math.max(5000, Math.min(120000, Math.trunc(Number(timeoutMs) || 20000))),
      validateStatus: () => true,
    }
  );

  const status = Number(resp?.status) || 0;
  const responseText =
    resp?.data?.choices?.[0]?.message?.content ||
    resp?.data?.choices?.[0]?.text ||
    resp?.data?.output_text ||
    resp?.data?.text ||
    (typeof resp?.data === "string" ? resp.data : resp?.data ? JSON.stringify(resp.data) : "");

  if (!(status >= 200 && status < 300)) {
    const err = new Error(`Upstream HTTP ${status}`);
    err.status = status;
    err.response_text_preview = asString(responseText).slice(0, 500);
    throw err;
  }

  const parsed = extractJsonFromText(responseText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const err = new Error("Failed to parse tagline JSON");
    err.status = status;
    err.response_text_preview = asString(responseText).slice(0, 500);
    throw err;
  }

  return { status, obj: parsed, response_text_preview: asString(responseText).slice(0, 500) };
}

async function fetchConfirmedCompanyTagline({ axiosPost, xaiUrl, xaiKey, companyName, websiteUrl, timeoutMs = 20000 }) {
  const inputName = asString(companyName).trim();
  const inputUrl = asString(websiteUrl).trim();

  const model = "grok-4-latest";

  const system = {
    role: "system",
    content: "Return valid JSON only. No markdown, no prose, no backticks.",
  };

  const confirmUser = {
    role: "user",
    content: `Confirm the official company name for the entity described below.\n\nInput company_name: ${inputName}\nWebsite: ${inputUrl}\n\nReturn EXACTLY this JSON object:\n{\n  \"confirmed_company_name\": \"...\",\n  \"confidence\": 0.0,\n  \"reason\": \"...\"\n}\n\nRules:\n- confirmed_company_name should be the official brand/company name as used publicly.\n- If the input looks correct, repeat it.\n- confidence is 0..1.\n- If unsure, keep confidence low and return the input name.`,
  };

  const confirm = await callXaiJsonObject({
    axiosPost,
    xaiUrl,
    xaiKey,
    timeoutMs: Math.min(20000, timeoutMs),
    model,
    messages: [system, confirmUser],
  });

  const confirmed_company_name =
    asString(confirm.obj?.confirmed_company_name || confirm.obj?.company_name || confirm.obj?.name).trim() || inputName;

  const confirm_confidence = toNumberOrNull(confirm.obj?.confidence);
  const confirm_reason = asString(confirm.obj?.reason).trim();

  const taglineUser = {
    role: "user",
    content: `Return the official tagline/slogan for the company below.\n\nCompany: ${confirmed_company_name}\nWebsite: ${inputUrl}\n\nReturn EXACTLY this JSON object:\n{\n  \"tagline\": \"...\",\n  \"confidence\": 0.0,\n  \"reason\": \"...\"\n}\n\nRules:\n- tagline must be a short official phrase (max ~120 chars).\n- If there is no known official tagline, return an empty string.\n- Do NOT invent or paraphrase.\n- confidence is 0..1.`,
  };

  const taglineResp = await callXaiJsonObject({
    axiosPost,
    xaiUrl,
    xaiKey,
    timeoutMs: Math.min(25000, Math.max(7000, timeoutMs)),
    model,
    messages: [system, taglineUser],
  });

  const tagline = normalizeTagline(taglineResp.obj?.tagline);
  const tagline_confidence = toNumberOrNull(taglineResp.obj?.confidence);
  const tagline_reason = asString(taglineResp.obj?.reason).trim();

  return {
    confirmed_company_name,
    confirm_confidence,
    confirm_reason,
    tagline,
    tagline_confidence,
    tagline_reason,
  };
}

module.exports = {
  fetchConfirmedCompanyTagline,
  _internals: {
    isAzureWebsitesUrl,
    buildXaiHeaders,
    normalizeTagline,
  },
};
