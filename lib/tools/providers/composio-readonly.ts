import type {
  JsonValue,
  ProviderExecution,
  ToolExecutionContext,
  ToolProvider,
} from "../foundation";

export type ComposioReadOnlySession = {
  execute(toolSlug: string, arguments_: Record<string, JsonValue>): Promise<unknown>;
};

export type ComposioReadOnlySessionFactory = {
  getSession(workspaceId: string, enabledToolkits: readonly string[]): Promise<ComposioReadOnlySession>;
};

type ComposioClientLike = {
  sessions: {
    create(
      userId: string,
      options: {
        toolkits: { enable: readonly string[] };
        tags: { enable: readonly ["readOnlyHint"] };
        manageConnections: false;
      },
    ): Promise<ComposioReadOnlySession>;
  };
};

export function createComposioReadOnlySessionFactory(client: ComposioClientLike): ComposioReadOnlySessionFactory {
  return {
    getSession(workspaceId, enabledToolkits) {
      return client.sessions.create(`halacx_workspace_${workspaceId}`, {
        toolkits: { enable: [...enabledToolkits] },
        tags: { enable: ["readOnlyHint"] },
        manageConnections: false,
      });
    },
  };
}

export class ComposioReadOnlyProvider implements ToolProvider {
  readonly key = "composio";
  private readonly sessions: ComposioReadOnlySessionFactory;

  constructor(sessions: ComposioReadOnlySessionFactory) {
    this.sessions = sessions;
  }

  async execute(arguments_: Record<string, JsonValue>, context: ToolExecutionContext): Promise<ProviderExecution> {
    if (context.capability.providerKey !== this.key || context.capability.risk !== "read") {
      throw new Error("COMPOSIO_READONLY_BOUNDARY_REJECTED");
    }
    if (context.signal.aborted) throw context.signal.reason;
    const session = await this.sessions.getSession(context.workspaceId, [context.capability.toolkit]);
    if (context.signal.aborted) throw context.signal.reason;
    const data = await session.execute(context.capability.providerToolId, arguments_);
    return { data: toJsonValue(data) };
  }
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value as JsonValue;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJsonValue(item)]));
  }
  return String(value);
}
