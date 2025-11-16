// api/app.js - Azure Functions v4 bootstrap file
// This file registers all HTTP-triggered functions with the Azure Functions runtime

const { app } = require('@azure/functions');

// Helper to wrap old-style context-based handlers for v4
function wrapContextHandler(handler) {
  return async (request, context) => {
    // Create context-like object for backward compatibility
    const ctxCompat = {
      log: console.log,
      res: null,
    };

    // Call the old handler
    await handler(ctxCompat, request);

    // Return the response
    if (ctxCompat.res) {
      const { status, headers, body } = ctxCompat.res;
      return {
        status: status || 200,
        headers: headers || {},
        body: typeof body === 'string' ? body : JSON.stringify(body),
      };
    }

    return { status: 500, body: 'No response' };
  };
}

// Register admin-companies endpoint
const adminCompaniesHandler = require('./admin-companies/index.js');
app.http('admin-companies', {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'admin/companies',
  handler: wrapContextHandler(adminCompaniesHandler),
});

// Register admin-star-config endpoint
const adminStarConfigHandler = require('./admin-star-config/index.js');
app.http('admin-star-config', {
  methods: ['GET', 'PUT', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'admin/star-config',
  handler: wrapContextHandler(adminStarConfigHandler),
});

// Register other endpoints
const proxyXaiHandler = require('./proxy-xai/index.js');
app.http('proxy-xai', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'proxy-xai',
  handler: wrapContextHandler(proxyXaiHandler),
});

const submitReviewHandler = require('./submit-review/index.js');
app.http('submit-review', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'submit-review',
  handler: wrapContextHandler(submitReviewHandler),
});

const getReviewsHandler = require('./get-reviews/index.js');
app.http('get-reviews', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'get-reviews',
  handler: wrapContextHandler(getReviewsHandler),
});

const adminReviewsHandler = require('./admin-reviews/index.js');
app.http('admin-reviews', {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'admin/reviews',
  handler: wrapContextHandler(adminReviewsHandler),
});

const adminUpdateLogosHandler = require('./admin-update-logos/index.js');
app.http('admin-update-logos', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'admin/update-logos',
  handler: wrapContextHandler(adminUpdateLogosHandler),
});

const searchCompaniesHandler = require('./search-companies/index.js');
app.http('search-companies', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'search-companies',
  handler: wrapContextHandler(searchCompaniesHandler),
});

const importStartHandler = require('./import-start/index.js');
app.http('import-start', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'import-start',
  handler: wrapContextHandler(importStartHandler),
});

const importStatusHandler = require('./import-status/index.js');
app.http('import-status', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'import-status',
  handler: wrapContextHandler(importStatusHandler),
});

const importProgressHandler = require('./import-progress/index.js');
app.http('import-progress', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'import-progress',
  handler: wrapContextHandler(importProgressHandler),
});

const pingHandler = require('./ping/index.js');
app.http('ping', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'ping',
  handler: wrapContextHandler(pingHandler),
});

const googleGeocodeHandler = require('./google/geocode/index.js');
app.http('google-geocode', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'google/geocode',
  handler: wrapContextHandler(googleGeocodeHandler),
});

const googleTranslateHandler = require('./google/translate/index.js');
app.http('google-translate', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'google/translate',
  handler: wrapContextHandler(googleTranslateHandler),
});

const adminUndoHistoryHandler = require('./admin-undo-history/index.js');
app.http('admin-undo-history', {
  methods: ['GET', 'POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'admin/undo-history',
  handler: wrapContextHandler(adminUndoHistoryHandler),
});

const adminNotesHandler = require('./admin-notes/index.js');
app.http('admin-notes', {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'admin/notes',
  handler: wrapContextHandler(adminNotesHandler),
});

const adminLoginHandler = require('./admin-login/index.js');
app.http('admin-login', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'admin/login',
  handler: wrapContextHandler(adminLoginHandler),
});
