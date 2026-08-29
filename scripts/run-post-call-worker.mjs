const appUrl = process.env.APP_URL?.replace(/\/$/, "");
const secret = process.env.INTERNAL_JOB_SECRET;
const once = process.argv.includes("--once");
if (!appUrl || !secret) throw new Error("APP_URL and INTERNAL_JOB_SECRET are required");

async function invoke(path) {
  const response = await fetch(`${appUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(310_000) });
  if (!response.ok) throw new Error(`${path} failed (${response.status})`);
  return response.json();
}

do {
  try {
    const swept = await invoke("/api/internal/jobs/sweep");
    const processed = await invoke("/api/internal/jobs/post-call");
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), swept: swept.recovered, claimed: processed.claimed }));
    if (!once && processed.claimed === 0) await new Promise(resolve => setTimeout(resolve, 2_000));
  } catch (error) {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), event: "post_call_worker_error", message: error.message }));
    if (once) process.exitCode = 1;
    else await new Promise(resolve => setTimeout(resolve, 10_000));
  }
} while (!once);
