function safeLog(context, payload) {
  try {
    const line = JSON.stringify(payload);
    if (typeof context?.log === "function") {
      context.log(line);
    } else {
      console.log(line);
    }
  } catch {
    // ignore
  }
}

function json(obj, status = 200, extraHeaders = {}) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
      "Access-Control-Expose-Headers": "x-request-id,x-correlation-id,x-session-id",
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    },
    body: JSON.stringify(obj),
  };
}

function makeErrorId() {
  return `err_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function readHeader(headers, key) {
  if (!headers || typeof headers !== "object") return "";
  const wanted = String(key || "").toLowerCase();
  if (!wanted) return "";

  for (const [k, v] of Object.entries(headers)) {
    if (String(k || "").toLowerCase() === wanted) return String(v || "");
  }
  return "";
}

function truncateText(value, max = 2000) {
  const text = typeof value === "string" ? value : "";
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function splitArgs(arg1, arg2) {
  const a = arg1 && typeof arg1 === "object" ? arg1 : null;
  const b = arg2 && typeof arg2 === "object" ? arg2 : null;

  // Old model: (context, req)
  const looksLikeContext = (x) => Boolean(x && typeof x === "object" && (typeof x.log === "function" || typeof x.log === "object"));
  const looksLikeReq = (x) => Boolean(x && typeof x === "object" && (typeof x.method === "string" || typeof x.url === "string"));

  if (looksLikeContext(a) && looksLikeReq(b)) return { context: a, req: b, model: "old" };
  if (looksLikeReq(a) && looksLikeContext(b)) return { context: b, req: a, model: "new" };

  // Best effort: default to new model signature.
  return { context: b, req: a, model: "new" };
}

module.exports = async function importStartSwaWrapper(arg1, arg2) {
  const { context, req, model } = splitArgs(arg1, arg2);
  const isOldModel = model === "old";

  const send = (response) => {
    if (isOldModel) {
      if (context) context.res = response;
      return;
    }
    return response;
  };

  const build_id = process.env.BUILD_ID || process.env.WEBSITE_COMMIT_HASH || null;

  safeLog(context, {
    stage: "import_start_wrapper",
    kind: "entry",
    model,
    method: String(req?.method || "").toUpperCase(),
    url: req?.url || null,
    build_id,
  });

  let endpoint = null;
  try {
    // Important: require inside the handler so module-load errors don't escape and get masked by SWA.
    endpoint = require("./import-start/index.js");
  } catch (e) {
    const error_id = makeErrorId();
    const message = e?.message || String(e);
    const stack_first_line = typeof e?.stack === "string" ? e.stack.split("\n")[0] : null;

    safeLog(context, {
      stage: "import_start_wrapper",
      kind: "require_failed",
      error_id,
      message,
      stack_first_line,
    });

    return send(
      json(
        {
          ok: false,
          stage: "import_start_wrapper",
          stage_beacon: "require_failed",
          root_cause: "server_exception",
          retryable: true,
          http_status: 500,
          error_id,
          build_id,
          error_message: "Import start module load failed",
        },
        200
      )
    );
  }

  try {
    const handler = typeof endpoint?.handler === "function" ? endpoint.handler : null;

    if (!handler) {
      const error_id = makeErrorId();
      safeLog(context, {
        stage: "import_start_wrapper",
        kind: "missing_handler",
        error_id,
      });

      return send(
        json(
          {
            ok: false,
            stage: "import_start_wrapper",
            stage_beacon: "missing_handler",
            root_cause: "server_exception",
            retryable: true,
            http_status: 500,
            error_id,
            build_id,
            error_message: "Import start handler not found",
          },
          200
        )
      );
    }

    const result = await handler(req, context);

    // Some handlers might write context.res and return nothing.
    if (result == null) {
      if (isOldModel && context?.res && typeof context.res === "object") {
        safeLog(context, {
          stage: "import_start_wrapper",
          kind: "delegate_set_context_res",
        });
        return;
      }

      const error_id = makeErrorId();
      safeLog(context, {
        stage: "import_start_wrapper",
        kind: "empty_delegate_response",
        error_id,
      });

      return send(
        json(
          {
            ok: false,
            stage: "import_start_wrapper",
            stage_beacon: "empty_delegate_response",
            root_cause: "server_exception",
            retryable: true,
            http_status: 500,
            error_id,
            build_id,
            error_message: "Import start handler returned no response",
          },
          200
        )
      );
    }

    // Safety: never return 5xx from the wrapper itself (SWA can mask).
    const delegatedStatus = Number(result?.status || 200) || 200;
    const shouldNormalize = delegatedStatus >= 500;

    if (shouldNormalize) {
      const error_id = makeErrorId();

      const delegatedHeaders = result?.headers && typeof result.headers === "object" ? result.headers : {};
      const delegatedSessionIdHeader = readHeader(delegatedHeaders, "x-session-id").trim();
      const delegatedRequestIdHeader = readHeader(delegatedHeaders, "x-request-id").trim();

      const rawBody = result?.body;
      const rawText = typeof rawBody === "string" ? rawBody : "";

      const delegatedJson = (() => {
        if (rawBody && typeof rawBody === "object") return rawBody;
        if (!rawText) return null;
        try {
          return JSON.parse(rawText);
        } catch {
          return null;
        }
      })();

      const delegatedSessionIdBody =
        delegatedJson && typeof delegatedJson === "object" && typeof delegatedJson.session_id === "string"
          ? delegatedJson.session_id.trim()
          : "";

      const delegatedStageBeacon =
        delegatedJson && typeof delegatedJson === "object"
          ? String(
              delegatedJson.stage_beacon || delegatedJson.stageBeacon || delegatedJson.stage || delegatedJson.step || ""
            ).trim()
          : "";

      const delegatedRequestIdBody =
        delegatedJson && typeof delegatedJson === "object"
          ? String(
              delegatedJson.request_id ||
                delegatedJson.requestId ||
                (delegatedJson.error && typeof delegatedJson.error === "object" ? delegatedJson.error.request_id : "") ||
                ""
            ).trim()
          : "";

      const session_id = delegatedSessionIdHeader || delegatedSessionIdBody || "";
      const request_id = delegatedRequestIdHeader || delegatedRequestIdBody || "";

      const extraHeaders = {
        ...(session_id ? { "x-session-id": session_id } : {}),
        ...(request_id ? { "x-request-id": request_id } : {}),
      };

      safeLog(context, {
        stage: "import_start_wrapper",
        kind: "normalized_delegate_5xx",
        error_id,
        delegatedStatus,
        has_session_id: Boolean(session_id),
        delegated_stage_beacon: delegatedStageBeacon || null,
      });

      const delegatedTextPreview = truncateText(rawText);
      const delegatedTextTruncated = typeof rawText === "string" && rawText.length > 2000;

      return send(
        json(
          {
            ok: false,
            stage: "import_start_wrapper",
            stage_beacon: delegatedStageBeacon || "normalized_delegate_5xx",
            root_cause: "server_exception",
            retryable: true,
            http_status: delegatedStatus,
            error_id,
            build_id,
            session_id: session_id || undefined,
            request_id: request_id || undefined,
            error_message: "Import start returned a 5xx response (normalized)",
            delegated_stage_beacon: delegatedStageBeacon || undefined,
            delegated_text_preview: delegatedTextPreview,
            delegated_text_truncated: delegatedTextTruncated,
          },
          200,
          extraHeaders
        )
      );
    }

    const response = {
      status: delegatedStatus,
      headers: result?.headers || { "Content-Type": "application/json" },
      body: result?.body,
    };

    safeLog(context, {
      stage: "import_start_wrapper",
      kind: "delegate_return",
      status: response.status,
    });

    return send(response);
  } catch (e) {
    const error_id = makeErrorId();
    const message = e?.message || String(e);
    const stack_first_line = typeof e?.stack === "string" ? e.stack.split("\n")[0] : null;

    safeLog(context, {
      stage: "import_start_wrapper",
      kind: "wrapper_error",
      error_id,
      message,
      stack_first_line,
    });

    return send(
      json(
        {
          ok: false,
          stage: "import_start_wrapper",
          stage_beacon: "wrapper_error",
          root_cause: "server_exception",
          retryable: true,
          http_status: 500,
          error_id,
          build_id,
          error_message: "Import start wrapper error",
        },
        200
      )
    );
  }
};
