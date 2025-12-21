const { getBuildInfo } = require("./_buildInfo");

function shortBuildId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "unknown";

  const safe = raw.replace(/[^a-z0-9_-]+/gi, "");
  if (!safe) return "unknown";

  return safe.length > 12 ? safe.slice(0, 12) : safe;
}

function getImportStartHandlerVersion(buildInfo) {
  const short = shortBuildId(buildInfo?.build_id);
  return `ded-import-start-${short}`;
}

function getHandlerVersions(buildInfo = getBuildInfo()) {
  return {
    import_start: getImportStartHandlerVersion(buildInfo),
  };
}

module.exports = {
  getHandlerVersions,
  getImportStartHandlerVersion,
};
