const { app, hasRoute } = require("../_app");

const { adminRefreshReviewsHandler } = require("../_adminRefreshReviews");

app.http("xadminApiRefreshReviews", {
  route: "xadmin-api-refresh-reviews",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    return adminRefreshReviewsHandler(req, context);
  },
});

// Production safety: if a deployment accidentally omits admin-refresh-reviews,
// this alias keeps /api/admin-refresh-reviews available.
if (!hasRoute("admin-refresh-reviews")) {
  app.http("adminRefreshReviewsAlias", {
    route: "admin-refresh-reviews",
    methods: ["GET", "POST", "OPTIONS"],
    authLevel: "anonymous",
    handler: async (req, context) => {
      return adminRefreshReviewsHandler(req, context);
    },
  });
}

module.exports._test = {
  adminRefreshReviewsHandler,
};
