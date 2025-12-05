// api/admin-recent-imports/index.js

module.exports = async function (context, req) {
  context.log("admin-recent-imports called");

  const takeRaw = (req.query && (req.query.take || req.query.top)) || "25";
  const take = Number.parseInt(takeRaw, 10) || 25;

  const body = {
    ok: true,
    name: "admin-recent-imports",
    take,
    imports: [] // fill with real imports later
  };

  context.res = {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body
  };
};
