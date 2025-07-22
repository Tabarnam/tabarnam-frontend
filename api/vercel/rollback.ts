export default async function handler(req, res) {
  const { VERCEL_TOKEN, VERCEL_PROJECT_ID } = process.env;

  const response = await fetch(
    `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT_ID}&limit=1&state=ERROR`,
    {
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
    }
  );
  const data = await response.json();
  const failedDeploy = data.deployments?.[0]?.uid;

  if (!failedDeploy) {
    return res.status(200).json({ message: "No failed deployment to rollback." });
  }

  const rollback = await fetch(
    `https://api.vercel.com/v13/deployments/${failedDeploy}/rollback`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
    }
  );

  const result = await rollback.json();
  res.status(200).json({ message: "Rollback triggered", result });
}
