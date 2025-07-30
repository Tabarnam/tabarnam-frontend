// scripts/rollback.ts

interface VercelDeployment {
  uid: string;
}

interface VercelRollbackResponse {
  message: string;
  result: any;
}

export default async function rollback(): Promise<VercelRollbackResponse> {
  const { VERCEL_TOKEN, VERCEL_PROJECT_ID } = process.env;

  if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) {
    console.error('Missing VERCEL_TOKEN or VERCEL_PROJECT_ID in environment variables');
    return { message: 'Missing environment variables', result: null };
  }

  try {
    const response = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT_ID}&limit=1&state=ERROR`,
      {
        headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch deployments: ${response.statusText}`);
    }

    const data = await response.json();
    const failedDeploy = (data.deployments as VercelDeployment[] | undefined)?.[0]?.uid;

    if (!failedDeploy) {
      console.log("No failed deployment to rollback.");
      return { message: "No failed deployment to rollback.", result: null };
    }

    const rollbackResponse = await fetch(
      `https://api.vercel.com/v13/deployments/${failedDeploy}/rollback`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
      }
    );

    if (!rollbackResponse.ok) {
      throw new Error(`Rollback failed: ${rollbackResponse.statusText}`);
    }

    const result = await rollbackResponse.json();
    console.log("Rollback triggered", result);
    return { message: "Rollback triggered", result };
  } catch (error) {
    console.error('Rollback error:', error.message);
    return { message: `Rollback failed: ${error.message}`, result: null };
  }
}

// To run locally: npm run rollback
if (require.main === module) {
  rollback().catch(console.error);
}