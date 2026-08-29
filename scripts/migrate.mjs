import fs from "node:fs/promises";
import pg from "pg";

const url = process.env.DIRECT_URL;
if (!url || url.includes("YOUR-PASSWORD") || url.includes("[PASSWORD]")) {
  console.error("DIRECT_URL is missing or still contains a password placeholder.");
  process.exit(1);
}
const sql = await fs.readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query(sql);
await client.end();
console.log("HalaCX database schema is ready.");
