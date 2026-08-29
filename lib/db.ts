import { Pool, type QueryResultRow } from "pg";

declare global {
  var halacxPool: Pool | undefined;
}

export const isDatabaseConfigured = Boolean(
  process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("YOUR-PASSWORD"),
);

function getPool() {
  if (!isDatabaseConfigured) return null;
  if (!global.halacxPool) {
    global.halacxPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
  }
  return global.halacxPool;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_NOT_CONFIGURED");
  return pool.query<T>(text, values);
}

export async function withTransaction<T>(work: (client: import("pg").PoolClient) => Promise<T>) {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_NOT_CONFIGURED");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
