const endpoint = require("./index.js");

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

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
      "Access-Control-Expose-Headers": "x-request-id,x-correlation-id,x-session-id",
    },
    body: JSON.stringify(obj),
  };
}

function makeErrorId() {
  return `err_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

module.exports = async function importStartClassicWrapper(context, req) {
  const build_id = process.env.BUILD_ID || process.env.WEBSITE_COMMIT_HASH || null;

  safeLog(context, {
    stage: "import_start_wrapper",
    kind: "entry",
    method: String(req?.method || "").toUpperCase(),
    url: req?.url || null,
    build_id,
  });

  try {
    const handler = typeof endpoint?.handler === "function" ? endpoint.handler : null;

    if (!handler) {
      const error_id = makeErrorId();
      safeLog(context, {
        stage: "import_start_wrapper",
        kind: "missing_handler",
        error_id,
      });

      context.res = json(
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
      );
      return;
    }

    const result = await handler(req, context);

    context.res = {
      status: result?.status || 200,
      headers: result?.headers || { "Content-Type": "application/json" },
      body: result?.body,
    };

    safeLog(context, {
      stage: "import_start_wrapper",
      kind: "delegate_return",
      status: context.res.status,
    });
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

    context.res = json(
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
    );
  }
};
