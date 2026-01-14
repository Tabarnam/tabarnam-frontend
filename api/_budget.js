"use strict";

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.max(min, Math.min(max, i));
}

/**
 * startBudget
 *
 * Implements a simple deadline-based budget for Azure Static Web Apps gateway constraints.
 *
 * - hardCapMs: absolute max the server should spend in this request
 * - clientDeadlineMs: optional caller-provided budget; clamped to hardCapMs
 */
function startBudget({ hardCapMs = 25_000, clientDeadlineMs = null, startedAtMs = Date.now() } = {}) {
  const hardCap = clampInt(hardCapMs, { min: 5_000, max: 120_000, fallback: 25_000 });
  const requested = clientDeadlineMs == null ? null : clampInt(clientDeadlineMs, { min: 5_000, max: hardCap, fallback: hardCap });

  const totalMs = requested == null ? hardCap : requested;
  const deadlineMs = startedAtMs + totalMs;

  const getRemainingMs = () => Math.max(0, deadlineMs - Date.now());
  const getElapsedMs = () => Math.max(0, Date.now() - startedAtMs);
  const isExpired = () => Date.now() >= deadlineMs;

  const shouldDeferStage = (minRemainingMs = 3_500) => {
    const min = clampInt(minRemainingMs, { min: 500, max: hardCap, fallback: 3_500 });
    return getRemainingMs() < min;
  };

  const clampStageTimeoutMs = ({
    remainingMs,
    minMs = 2_500,
    maxMs = 8_000,
    safetyMarginMs = 1_200,
  } = {}) => {
    const rem = Number.isFinite(Number(remainingMs)) ? Number(remainingMs) : getRemainingMs();
    const min = clampInt(minMs, { min: 250, max: 60_000, fallback: 2_500 });
    const max = clampInt(maxMs, { min, max: 60_000, fallback: 8_000 });
    const safety = clampInt(safetyMarginMs, { min: 0, max: 20_000, fallback: 1_200 });

    const raw = Math.max(0, Math.trunc(rem - safety));
    return Math.max(min, Math.min(max, raw));
  };

  return {
    hardCapMs: hardCap,
    requestedMs: requested,
    totalMs,
    startedAtMs,
    deadlineMs,
    getRemainingMs,
    getElapsedMs,
    isExpired,
    shouldDeferStage,
    clampStageTimeoutMs,
  };
}

module.exports = {
  startBudget,
};
