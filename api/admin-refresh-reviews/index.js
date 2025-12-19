const { app } = require("../_app");

const { adminRefreshReviewsHandler } = require("../_adminRefreshReviews");

app.http("adminRefreshReviews", {
  route: "admin-refresh-reviews",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    return adminRefreshReviewsHandler(req, context);
  },
});

module.exports._test = {
  adminRefreshReviewsHandler,
};
