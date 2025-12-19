const { app, hasRoute } = require("../_app");

const {
  adminRefreshCompanyHandler,
  buildProposedCompanyFromXaiResult,
  buildPrompt,
  parseXaiCompaniesResponse,
  loadCompanyById,
  toNormalizedDomain,
} = require("../_adminRefreshCompany");

app.http("xadminApiRefreshCompany", {
  route: "xadmin-api-refresh-company",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    return adminRefreshCompanyHandler(req, context);
  },
});

// Production safety: if a deployment accidentally omits the admin-refresh-company module,
// this alias keeps /api/admin-refresh-company available.
if (!hasRoute("admin-refresh-company")) {
  app.http("adminRefreshCompanyAlias", {
    route: "admin-refresh-company",
    methods: ["GET", "POST", "OPTIONS"],
    authLevel: "anonymous",
    handler: async (req, context) => {
      return adminRefreshCompanyHandler(req, context);
    },
  });
}

module.exports._test = {
  adminRefreshCompanyHandler,
  buildProposedCompanyFromXaiResult,
  buildPrompt,
  parseXaiCompaniesResponse,
  loadCompanyById,
  toNormalizedDomain,
};
