import { query } from "@/lib/db";

export async function hasWorkspaceRole(userId: string, workspaceId: string, roles: string[]) {
  if (!roles.length) return false;
  const result = await query<{ role: string }>(
    "select role from workspace_members where user_id=$1 and workspace_id=$2 and role=any($3::text[]) limit 1",
    [userId, workspaceId, roles],
  );
  return Boolean(result.rows[0]);
}
