// Entry point for Azure Functions v4 (new programming model)
// Importing each module registers its HTTP handlers via app.http().

import "./proxy-xai/index.js";
import "./submit-review/index.js";
import "./get-reviews/index.js";
import "./admin-reviews/index.js";
import "./admin-update-logos/index.js";
import "./search-companies/index.js";
import "./import-start/index.js";
import "./import-status/index.js";
import "./import-progress/index.js";
import "./ping/index.js";
import "./google/geocode/index.js";
import "./google/translate/index.js";
import "./admin-companies/index.js";
import "./admin-star-config/index.js";
import "./admin-undo-history/index.js";
import "./admin-notes/index.js";
import "./admin-login/index.js";
