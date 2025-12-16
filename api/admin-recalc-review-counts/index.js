const { app } = require("@azure/functions");
const {
  getCompaniesContainer,
  getReviewsContainer,
  findCompanyByIdOrName,
  getReviewCountsForCompany,
  setCompanyReviewCounts,
  buildReviewMatchQuerySpec,
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

app.http("xadminApiRecalcReviewCounts", {
  route: "xadmin-api-recalc-review-counts",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    if (String(req.method || "").toUpperCase() === "OPTIONS") return json({}, 200);

    const companiesContainer = getCompaniesContainer();
    const reviewsContainer = getReviewsContainer();
    if (!companiesContainer || !reviewsContainer) {
      return json({ ok: false, error: "Cosmos DB not configured" }, 503);
    }

    let body = {};
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
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
    const debug = body.debug === true || body.include_matched_review_ids === true;

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

      const countsFromReviews = await getReviewCountsForCompany(reviewsContainer, {
        companyId: companyDoc.id || companyDoc.company_id || companyId,
        companyName: companyDoc.company_name || companyName,
        normalizedDomain: companyDoc.normalized_domain || null,
      });

      const curatedArr = Array.isArray(companyDoc.curated_reviews) ? companyDoc.curated_reviews : [];
      const curatedTotal = curatedArr.length;
      const curatedPublic = curatedTotal;
      const curatedPrivate = 0;

      const counts = {
        review_count: (countsFromReviews.review_count || 0) + curatedTotal,
        public_review_count: (countsFromReviews.public_review_count || 0) + curatedPublic,
        private_review_count: (countsFromReviews.private_review_count || 0) + curatedPrivate,
        total: (countsFromReviews.review_count || 0) + curatedTotal,
        public: (countsFromReviews.public_review_count || 0) + curatedPublic,
        private: (countsFromReviews.private_review_count || 0) + curatedPrivate,
        sources: {
          reviews_container: {
            total: countsFromReviews.review_count || 0,
            public: countsFromReviews.public_review_count || 0,
            private: countsFromReviews.private_review_count || 0,
          },
          curated_reviews: { total: curatedTotal, public: curatedPublic, private: curatedPrivate },
        },
      };

      let matched_review_ids = undefined;
      let matched_review_samples = undefined;
      let curated_review_ids = undefined;

      if (debug) {
        curated_review_ids = curatedArr.map((r) => r?.id).filter(Boolean).slice(0, 10);

        const { where, parameters } = buildReviewMatchQuerySpec({
          companyId: companyDoc.id || companyDoc.company_id || companyId,
          companyName: companyDoc.company_name || companyName,
          normalizedDomain: companyDoc.normalized_domain || null,
        });

        if (where) {
          const sql =
            "SELECT TOP 10 c.id, c.company_id, c.companyId, c.companyID, c.company_name, c.company, c.normalized_domain, c.domain, c.is_public, c.isPublic, c.public, c.visible_to_users, c.show_to_users FROM c WHERE " +
            where +
            " ORDER BY c._ts DESC";

          const { resources } = await reviewsContainer.items
            .query({ query: sql, parameters }, { enableCrossPartitionQuery: true })
            .fetchAll();

          const rows = Array.isArray(resources) ? resources : [];
          matched_review_ids = rows.map((r) => r?.id).filter(Boolean);
          matched_review_samples = rows.slice(0, 3);
        } else {
          matched_review_ids = [];
          matched_review_samples = [];
        }
      }

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
            ...(debug ? { matched_review_ids, matched_review_samples, curated_review_ids } : {}),
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
          ...(debug
            ? { matched_review_ids, matched_review_samples, curated_review_ids, update_meta: result.meta || null }
            : {}),
        },
        200
      );
    } catch (e) {
      context?.log?.("xadmin-api-recalc-review-counts error", e?.message || e);
      return json({ ok: false, error: e?.message || "Internal error" }, 500);
    }
  },
});
