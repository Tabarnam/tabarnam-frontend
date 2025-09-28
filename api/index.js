/**
 * api/index.js — minimal ESM bootstrap for Azure Functions v4
 * Register functions synchronously at startup via static imports.
 * Only import functions that actually exist on disk.
 */

import "./proxy-xai/index.js"; // <-- keep only this until others exist