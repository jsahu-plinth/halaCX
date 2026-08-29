import pg from "pg";

const baseUrl = process.env.VERIFY_BASE_URL || "http://localhost:3000";
const email = `halacx-e2e-${Date.now()}@example.com`;
const password = "SafeTestPass1234";
let cookie = "";

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...options.headers },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

const client = new pg.Client({ connectionString: process.env.DIRECT_URL, ssl: { rejectUnauthorized: false } });
const results = {};

try {
  results.register = (await request("/api/auth/register", { method: "POST", body: JSON.stringify({ name: "Backend Test", company: "Backend Test Workspace", email, password }) })).status;
  results.dashboard = (await request("/api/dashboard")).status;
  const knowledge = await request("/api/knowledge", { method: "POST", body: JSON.stringify({ title: "E2E knowledge", content: "This temporary source verifies Supabase persistence end to end." }) });
  results.knowledgeCreate = knowledge.status;
  results.knowledgeDelete = (await request(`/api/knowledge/${knowledge.body.source?.id}`, { method: "DELETE" })).status;
  results.agentUpdate = (await request("/api/agent", { method: "PATCH", body: JSON.stringify({ instructions: "Answer only from approved workspace knowledge and escalate uncertain requests to a human." }) })).status;
  results.workspace = (await request("/api/workspace")).status;
  results.logout = (await request("/api/auth/logout", { method: "POST" })).status;
  cookie = "";
  results.login = (await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) })).status;

  const failed = Object.entries(results).filter(([, status]) => status < 200 || status >= 300);
  console.log(Object.entries(results).map(([name, status]) => `${name}=${status}`).join(" "));
  if (failed.length) process.exitCode = 1;
} finally {
  await client.connect();
  await client.query("begin");
  await client.query("delete from workspaces where id in (select wm.workspace_id from workspace_members wm join users u on u.id=wm.user_id where u.email=$1)", [email]);
  await client.query("delete from users where email=$1", [email]);
  await client.query("commit");
  await client.end();
}
