const { app } = require("@azure/functions");
const {
  getCompaniesContainer,
  getReviewsContainer,
  findCompanyByIdOrName,
  getReviewCountsForCompany,
  setCompanyReviewCounts,
} = require("../_reviewCounts");

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

app.http("admin-recalc-review-counts", {
  route: "admin-recalc-review-counts",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    if (String(req.method || "").toUpperCase() === "OPTIONS") return json({}, 204);

    const companiesContainer = getCompaniesContainer();
    const reviewsContainer = getReviewsContainer();
    if (!companiesContainer || !reviewsContainer) {
      return json({ ok: false, error: "Cosmos DB not configured" }, 503);
    }

    let body = {};
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    } catch {
      try {
        body = await req.json();
      } catch {
        body = {};
      }
    }

    const companyId = String(body.company_id || body.companyId || body.id || "").trim();
    const companyName = String(body.company_name || body.company || "").trim();
    const dryRun = body.dry_run === true;

    if (!companyId && !companyName) {
      return json({ ok: false, error: "company_id or company_name required" }, 400);
    }

    try {
      const companyDoc = await findCompanyByIdOrName(companiesContainer, {
        companyId,
        companyName,
      });

      if (!companyDoc) {
        return json({ ok: false, error: "Company not found" }, 404);
      }

      const counts = await getReviewCountsForCompany(reviewsContainer, {
        companyId: companyDoc.id || companyDoc.company_id || companyId,
        companyName: companyDoc.company_name || companyName,
      });

      if (dryRun) {
        return json(
          {
            ok: true,
            dry_run: true,
            company: {
              id: companyDoc.id,
              company_name: companyDoc.company_name || companyDoc.name || null,
              normalized_domain: companyDoc.normalized_domain || null,
            },
            counts,
          },
          200
        );
      }

      const result = await setCompanyReviewCounts(companiesContainer, companyDoc, counts);
      if (!result.ok) {
        return json({ ok: false, error: result.error || "Failed to update company" }, 500);
      }

      return json(
        {
          ok: true,
          company: {
            id: companyDoc.id,
            company_name: companyDoc.company_name || companyDoc.name || null,
            normalized_domain: companyDoc.normalized_domain || null,
          },
          counts: result.counts || counts,
        },
        200
      );
    } catch (e) {
      context?.log?.("admin-recalc-review-counts error", e?.message || e);
      return json({ ok: false, error: e?.message || "Internal error" }, 500);
    }
  },
});
