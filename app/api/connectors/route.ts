import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth";
import { composioUserId, connectorCatalog, getComposio } from "@/lib/composio";
import { query } from "@/lib/db";

type ConnectorRow = {
  toolkit_slug: string;
  status: string;
  access_level: string;
  connected_account_id: string | null;
};

export async function GET() {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.preview) return NextResponse.json({ configured: false, connectors: connectorCatalog.map(item => ({ ...item, status: "available", accessLevel: "read" })) });

  const stored = await query<ConnectorRow>(
    "select toolkit_slug,status,access_level,connected_account_id from workspace_connectors where workspace_id=$1",
    [session.workspaceId],
  );
  const bySlug = new Map(stored.rows.map(row => [row.toolkit_slug, row]));

  if (process.env.COMPOSIO_API_KEY) {
    try {
      const accounts = await getComposio().connectedAccounts.list({ userIds: [composioUserId(session.workspaceId)], limit: 100 });
      for (const account of accounts.items) {
        const slug = account.toolkit?.slug?.toLowerCase();
        if (!slug) continue;
        const status = account.status === "ACTIVE" ? "connected" : account.status.toLowerCase();
        const catalogItem = connectorCatalog.find(item => item.slug === slug);
        await query(
          `insert into workspace_connectors(workspace_id,toolkit_slug,display_name,status,connected_account_id)
           values($1,$2,$3,$4,$5)
           on conflict(workspace_id,toolkit_slug) do update set status=excluded.status,connected_account_id=excluded.connected_account_id,updated_at=now()`,
          [session.workspaceId, slug, catalogItem?.name || slug, status, account.id],
        );
        bySlug.set(slug, { toolkit_slug: slug, status, access_level: bySlug.get(slug)?.access_level || "read", connected_account_id: account.id });
      }
    } catch (error) {
      console.error("connector_sync_failed", error);
    }
  }

  return NextResponse.json({
    configured: Boolean(process.env.COMPOSIO_API_KEY),
    connectors: connectorCatalog.map(item => {
      const saved = bySlug.get(item.slug);
      return { ...item, status: saved?.status || "available", accessLevel: saved?.access_level || "read" };
    }),
  });
}
