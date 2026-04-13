import type { McpConfig } from "./types.mcp.js";
import type { SkillConfig } from "./types.skills.js";
import type { ToolPolicyConfig, ToolProfileId } from "./types.tools.js";

export type ClawifyCustomToolHttpTarget = {
  /** HTTP endpoint URL to invoke when the tool is called. */
  url: string;
  /** HTTP method (default: POST). */
  method?: "POST" | "PUT" | "PATCH";
  /** Additional headers to include in the request. */
  headers?: Record<string, string>;
  /** Authentication configuration for the endpoint. */
  auth?:
    | { type: "bearer"; token: string }
    | { type: "header"; name: string; value: string };
  /** Request timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
};

export type ClawifyCustomToolDefinition = {
  /** Tool name (must be unique within the instance). */
  name: string;
  /** Human-readable description shown to the agent. */
  description: string;
  /** JSON Schema object describing the tool's input parameters. */
  parameters: Record<string, unknown>;
  /** HTTP endpoint target for tool invocation. */
  target: ClawifyCustomToolHttpTarget;
  /** Whether the tool can be removed by user-level deny lists (default: true). */
  removable?: boolean;
};

export type ClawifyUserMutationPolicy = "none" | "allowlist-extend" | "replace";

export type ClawifyScopedToolsConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  profile?: ToolProfileId;
  byProvider?: Record<string, ToolPolicyConfig>;
};

export type ClawifyScopedSkillsConfig = {
  entries?: Record<string, SkillConfig>;
};

export type ClawifyScopedMcpConfig = McpConfig;

export type ClawifyUserConfig = {
  tools?: ClawifyScopedToolsConfig;
  skills?: ClawifyScopedSkillsConfig;
  mcp?: ClawifyScopedMcpConfig;
};

export type ClawifyUserPolicyConfig = {
  tools?: ClawifyUserMutationPolicy;
  skills?: ClawifyUserMutationPolicy;
  mcp?: ClawifyUserMutationPolicy;
};

export type ClawifyInstanceConfig = {
  tools?: ClawifyScopedToolsConfig;
  skills?: ClawifyScopedSkillsConfig;
  mcp?: ClawifyScopedMcpConfig;
  /** Custom tools registered at the instance level via the SDK. */
  customTools?: Record<string, ClawifyCustomToolDefinition>;
  userPolicy?: ClawifyUserPolicyConfig;
  users?: Record<string, ClawifyUserConfig>;
};

export type ClawifyConfig = {
  defaultInstanceId?: string;
  instances?: Record<string, ClawifyInstanceConfig>;
};
