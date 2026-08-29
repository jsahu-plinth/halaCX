import { NextResponse } from "next/server";
import { z } from "zod";
import { readSession } from "@/lib/auth";
import { composioUserId, connectorCatalog, getComposio, isConnectorSlug } from "@/lib/composio";
import { query } from "@/lib/db";

const bodySchema = z.object({ toolkit: z.string().min(1) });

export async function POST(request: Request) {
  const session = await readSession();
  if (!session || session.preview) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !isConnectorSlug(parsed.data.toolkit)) return NextResponse.json({ error: "Unsupported connector" }, { status: 400 });

  try {
    const toolkit = connectorCatalog.find(item => item.slug === parsed.data.toolkit)!;
    const origin = process.env.APP_URL || new URL(request.url).origin;
    const connection = await getComposio().toolkits.authorize(composioUserId(session.workspaceId), toolkit.slug);
    await query(
      `insert into workspace_connectors(workspace_id,toolkit_slug,display_name,status)
       values($1,$2,$3,'pending')
       on conflict(workspace_id,toolkit_slug) do update set status='pending',updated_at=now()`,
      [session.workspaceId, toolkit.slug, toolkit.name],
    );
    const redirectUrl = connection.redirectUrl;
    if (!redirectUrl) throw new Error("No authorization URL returned");
    return NextResponse.json({ redirectUrl, callbackUrl: `${origin}/dashboard?connect=complete` });
  } catch (error) {
    if (error instanceof Error && error.message === "COMPOSIO_NOT_CONFIGURED") {
      return NextResponse.json({ error: "Connector service is not configured yet" }, { status: 503 });
    }
    console.error("connector_authorize_failed", error);
    return NextResponse.json({ error: "Could not start connection" }, { status: 502 });
  }
}
