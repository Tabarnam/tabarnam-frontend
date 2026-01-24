let QueueClient;
try {
  ({ QueueClient } = require("@azure/storage-queue"));
} catch {
  QueueClient = null;
}

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function nowIso() {
  return new Date().toISOString();
}

let didLogConfig = false;

function resolveQueueConfig() {
  const directConn = asString(process.env.ENRICHMENT_QUEUE_CONNECTION_STRING).trim();
  const webJobsConn = asString(process.env.AzureWebJobsStorage).trim();
  const legacyConn = asString(process.env.AZURE_STORAGE_CONNECTION_STRING).trim();

  const queueNameRaw = asString(process.env.ENRICHMENT_QUEUE_NAME).trim() || "import-resume-worker";
  const queueName = queueNameRaw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 63);

  const connectionString = directConn || webJobsConn || legacyConn || null;
  const connection_source = directConn
    ? "ENRICHMENT_QUEUE_CONNECTION_STRING"
    : webJobsConn
      ? "AzureWebJobsStorage"
      : legacyConn
        ? "AZURE_STORAGE_CONNECTION_STRING"
        : null;

  return {
    provider: "azure_storage_queue",
    connectionString,
    connection_source,
    queueName,
    // For Azure Functions triggers (bindings), this is the *setting name* that holds the connection string.
    binding_connection_setting_name: asString(process.env.ENRICHMENT_QUEUE_CONNECTION_SETTING).trim() || "AzureWebJobsStorage",
  };
}

function logQueueConfigOnce(cfg) {
  if (didLogConfig) return;
  didLogConfig = true;

  try {
    console.info(`[enrichment-queue-config] queue=${cfg?.queueName} source_env=${cfg?.connection_source} trigger_connection_setting=${cfg?.binding_connection_setting_name}`);
  } catch {
    // Ignore logging failures.
  }
}

let cachedQueueClient = null;
let cachedQueueKey = null;

async function getQueueClient() {
  const cfg = resolveQueueConfig();
  logQueueConfigOnce(cfg);
  if (!cfg.connectionString) return { ok: false, error: "missing_queue_connection" };
  if (!QueueClient) return { ok: false, error: "storage_queue_sdk_unavailable" };

  const key = `${cfg.connectionString}::${cfg.queueName}`;
  if (cachedQueueClient && cachedQueueKey === key) {
    return { ok: true, client: cachedQueueClient, config: cfg };
  }

  const client = new QueueClient(cfg.connectionString, cfg.queueName);
  try {
    await client.createIfNotExists();
  } catch (e) {
    return { ok: false, error: e?.message || String(e || "queue_create_failed"), config: cfg };
  }

  cachedQueueClient = client;
  cachedQueueKey = key;

  return { ok: true, client, config: cfg };
}

function normalizeDelaySeconds(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  return Math.max(0, Math.min(7 * 24 * 60 * 60, Math.round(n / 1000)));
}

/**
 * Queue message schema:
 * { session_id, company_ids?:[], reason, requested_by, enqueue_at, cycle_count?, run_id? }
 *
 * Idempotency key suggestion: session_id + cycle_count (or session_id + run_id)
 */
async function enqueueResumeRun({
  session_id,
  company_ids,
  reason,
  requested_by,
  enqueue_at,
  run_after_ms,
  cycle_count,
  run_id,
} = {}) {
  const sessionId = asString(session_id).trim();
  if (!sessionId) return { ok: false, error: "missing_session_id" };

  const qc = await getQueueClient();
  if (!qc.ok) {
    return {
      ok: false,
      error: qc.error || "queue_unavailable",
      queue: qc.config ? { provider: qc.config.provider, name: qc.config.queueName } : null,
    };
  }

  const payload = {
    session_id: sessionId,
    ...(Array.isArray(company_ids) && company_ids.length > 0
      ? {
          company_ids: Array.from(
            new Set(company_ids.map((v) => asString(v).trim()).filter(Boolean))
          ).slice(0, 50),
        }
      : {}),
    reason: asString(reason).trim() || "unspecified",
    requested_by: asString(requested_by).trim() || "system",
    enqueue_at: asString(enqueue_at).trim() || nowIso(),
    ...(Number.isFinite(Number(cycle_count)) ? { cycle_count: Math.max(0, Math.trunc(Number(cycle_count))) } : {}),
    ...(asString(run_id).trim() ? { run_id: asString(run_id).trim() } : {}),
  };

  const visibilityTimeout = normalizeDelaySeconds(run_after_ms);

  try {
    const result = await qc.client.sendMessage(JSON.stringify(payload), {
      visibilityTimeout,
    });

    return {
      ok: true,
      message_id: result.messageId,
      pop_receipt: result.popReceipt,
      inserted_on: result.insertedOn ? result.insertedOn.toISOString() : null,
      expires_on: result.expiresOn ? result.expiresOn.toISOString() : null,
      next_visible_on: result.nextVisibleOn ? result.nextVisibleOn.toISOString() : null,
      queue: { provider: qc.config.provider, name: qc.config.queueName },
      payload,
    };
  } catch (e) {
    return {
      ok: false,
      error: e?.message || String(e || "queue_send_failed"),
      queue: { provider: qc.config.provider, name: qc.config.queueName },
      payload,
    };
  }
}

module.exports = {
  enqueueResumeRun,
  resolveQueueConfig,
};
