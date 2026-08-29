import { Composio } from "@composio/core";

export const connectorCatalog = [
  { slug: "notion", name: "Notion", description: "Search pages, policies and team knowledge." },
  { slug: "googledrive", name: "Google Drive", description: "Find approved documents and shared files." },
  { slug: "googlecalendar", name: "Google Calendar", description: "Check calendars and appointment availability." },
  { slug: "gmail", name: "Gmail", description: "Find customer and team email context." },
  { slug: "googlesheets", name: "Google Sheets", description: "Look up operational and customer records." },
] as const;

export type ConnectorSlug = (typeof connectorCatalog)[number]["slug"];

export function composioUserId(workspaceId: string) {
  return `halacx_workspace_${workspaceId}`;
}

export function getComposio() {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_NOT_CONFIGURED");
  return new Composio({ apiKey });
}

export function isConnectorSlug(value: string): value is ConnectorSlug {
  return connectorCatalog.some((connector) => connector.slug === value);
}
