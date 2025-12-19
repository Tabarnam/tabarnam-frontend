let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}

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

module.exports._test = {
  adminRefreshCompanyHandler,
  buildProposedCompanyFromXaiResult,
  buildPrompt,
  parseXaiCompaniesResponse,
  loadCompanyById,
  toNormalizedDomain,
};
