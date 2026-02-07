/**
 * Bulk Import Queue Service
 *
 * Uses Azure Storage Queue to queue company URLs for sequential import processing.
 * Pattern based on _enrichmentQueue.js
 */

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
  const directConn = asString(process.env.BULK_IMPORT_QUEUE_CONNECTION_STRING).trim();
  const webJobsConn = asString(process.env.AzureWebJobsStorage).trim();
  const legacyConn = asString(process.env.AZURE_STORAGE_CONNECTION_STRING).trim();

  const queueNameRaw = asString(process.env.BULK_IMPORT_QUEUE_NAME).trim() || "bulk-import-jobs";
  const queueName = queueNameRaw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 63);

  const connectionString = directConn || webJobsConn || legacyConn || null;
  const connection_source = directConn
    ? "BULK_IMPORT_QUEUE_CONNECTION_STRING"
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
    binding_connection_setting_name: asString(process.env.BULK_IMPORT_QUEUE_CONNECTION_SETTING).trim() || "AzureWebJobsStorage",
  };
}

function logQueueConfigOnce(cfg) {
  if (didLogConfig) return;
  didLogConfig = true;

  try {
    console.info(`[bulk-import-queue-config] queue=${cfg?.queueName} source_env=${cfg?.connection_source} trigger_connection_setting=${cfg?.binding_connection_setting_name}`);
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
  // Azure max visibility timeout is 7 days
  return Math.max(0, Math.min(7 * 24 * 60 * 60, Math.round(n / 1000)));
}

/**
 * Queue message schema:
 * {
 *   job_id: string,
 *   url: string,
 *   position: number,
 *   batch_id: string,
 *   enqueued_at: ISO string,
 *   requested_by: string
 * }
 */
async function enqueueBulkImportJob({
  job_id,
  url,
  position,
  batch_id,
  requested_by,
  enqueued_at,
  run_after_ms,
} = {}) {
  const jobId = asString(job_id).trim();
  if (!jobId) return { ok: false, error: "missing_job_id" };

  const urlStr = asString(url).trim();
  if (!urlStr) return { ok: false, error: "missing_url" };

  const batchId = asString(batch_id).trim();
  if (!batchId) return { ok: false, error: "missing_batch_id" };

  const qc = await getQueueClient();
  if (!qc.ok) {
    return {
      ok: false,
      error: qc.error || "queue_unavailable",
      queue: qc.config ? { provider: qc.config.provider, name: qc.config.queueName } : null,
    };
  }

  const payload = {
    job_id: jobId,
    url: urlStr,
    position: Number.isFinite(Number(position)) ? Math.max(0, Math.trunc(Number(position))) : 0,
    batch_id: batchId,
    requested_by: asString(requested_by).trim() || "system",
    enqueued_at: asString(enqueued_at).trim() || nowIso(),
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
  enqueueBulkImportJob,
  resolveQueueConfig,
  logQueueConfigOnce,
};
