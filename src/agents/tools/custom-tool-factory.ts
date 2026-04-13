import { Type } from "@sinclair/typebox";
import type { ClawifyCustomToolDefinition } from "../../config/types.clawify.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AnyAgentTool } from "./common.js";
import { textResult } from "./common.js";

const DEFAULT_TIMEOUT_MS = 30_000;

function buildHeaders(def: ClawifyCustomToolDefinition): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(def.target.headers ?? {}),
  };
  const auth = def.target.auth;
  if (auth) {
    if (auth.type === "bearer") {
      headers["authorization"] = `Bearer ${auth.token}`;
    } else if (auth.type === "header") {
      headers[auth.name] = auth.value;
    }
  }
  return headers;
}

/**
 * Create an AnyAgentTool from a custom tool definition.
 * The tool calls the configured HTTP endpoint when invoked.
 */
export function createCustomToolFromDefinition(def: ClawifyCustomToolDefinition): AnyAgentTool {
  const method = def.target.method ?? "POST";
  const timeoutMs = def.target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = buildHeaders(def);

  return {
    label: def.name,
    name: def.name,
    description: def.description,
    parameters: Type.Unsafe(def.parameters),
    execute: async (_toolCallId, args) => {
      let response: Response;
      try {
        response = await fetch(def.target.url, {
          method,
          headers,
          body: JSON.stringify(args ?? {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const message =
          err instanceof Error && err.name === "TimeoutError"
            ? `custom tool "${def.name}" timed out after ${timeoutMs}ms`
            : `custom tool "${def.name}" request failed: ${err instanceof Error ? err.message : String(err)}`;
        return textResult(message, { status: "failed" as const });
      }

      let body: string;
      try {
        body = await response.text();
      } catch {
        body = "";
      }

      if (!response.ok) {
        const excerpt = body.length > 500 ? `${body.slice(0, 500)}...` : body;
        return textResult(
          `custom tool "${def.name}" returned HTTP ${response.status}: ${excerpt}`,
          { status: "failed" as const },
        );
      }

      return textResult(body || "(empty response)", { status: "ok" as const });
    },
  };
}

export type ResolvedCustomTools = {
  tools: AnyAgentTool[];
  nonRemovableNames: Set<string>;
};

/**
 * Resolve custom tools from the config for a given instance.
 * Returns the tool instances and a set of non-removable tool names.
 */
export function resolveCustomToolsFromConfig(
  cfg: OpenClawConfig,
  instanceId: string | undefined,
): ResolvedCustomTools {
  const empty: ResolvedCustomTools = { tools: [], nonRemovableNames: new Set() };
  if (!instanceId) {
    return empty;
  }
  const customTools = cfg.clawify?.instances?.[instanceId]?.customTools;
  if (!customTools || typeof customTools !== "object") {
    return empty;
  }

  const tools: AnyAgentTool[] = [];
  const nonRemovableNames = new Set<string>();

  for (const [_key, def] of Object.entries(customTools)) {
    if (!def || typeof def !== "object" || !def.name || !def.target?.url) {
      continue;
    }
    tools.push(createCustomToolFromDefinition(def));
    if (def.removable === false) {
      nonRemovableNames.add(def.name);
    }
  }

  return { tools, nonRemovableNames };
}
