const { app } = require("../_app");

const {
  adminRefreshCompanyHandler,
  buildProposedCompanyFromXaiResult,
  buildPrompt,
  parseXaiCompaniesResponse,
  loadCompanyById,
  toNormalizedDomain,
} = require("../_adminRefreshCompany");

app.http("adminRefreshCompany", {
  route: "admin-refresh-company",
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
