import { type ChildProcessWithoutNullStreams, execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

const GATEWAY_START_TIMEOUT_MS = 60_000;
const GATEWAY_STOP_TIMEOUT_MS = 3_000;
const OLLAMA_PREFLIGHT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const getFreePort = async (): Promise<number> => {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  if (!addr || typeof addr === "string") {
    srv.close();
    throw new Error("failed to bind ephemeral port");
  }
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return addr.port;
};

async function waitForGatewayReady(
  proc: ChildProcessWithoutNullStreams,
  chunksOut: string[],
  chunksErr: string[],
  port: number,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (proc.exitCode !== null) {
      const stdout = chunksOut.join("");
      const stderr = chunksErr.join("");
      throw new Error(
        `gateway exited before listening (code=${String(proc.exitCode)} signal=${String(proc.signalCode)})\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    // Wait for stdout to contain "ready" — the gateway logs this when fully initialized.
    const combined = chunksOut.join("");
    if (combined.includes("ready")) return;

    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }

  const stdout = chunksOut.join("");
  const stderr = chunksErr.join("");
  throw new Error(
    `timeout waiting for gateway ready on port ${port}\n` +
      `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type OllamaModel = {
  id: string;
  name: string;
  contextWindow: number;
};

/**
 * Query the local Ollama instance and return the first available model,
 * or null if Ollama is unreachable or has no models pulled.
 */
export async function discoverOllamaModel(
  baseUrl = OLLAMA_BASE_URL,
): Promise<OllamaModel | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_PREFLIGHT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return null;

    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const models = data.models ?? [];
    if (models.length === 0) return null;

    const picked = models[0]!;

    // Try to get context window from /api/show
    let contextWindow = 32768;
    try {
      const showController = new AbortController();
      const showTimer = setTimeout(() => showController.abort(), OLLAMA_PREFLIGHT_TIMEOUT_MS);
      try {
        const showRes = await fetch(`${baseUrl}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: picked.name }),
          signal: showController.signal,
        });
        if (showRes.ok) {
          const showData = (await showRes.json()) as {
            model_info?: Record<string, unknown>;
          };
          const ctxLen = showData.model_info?.["*.context_length"];
          if (typeof ctxLen === "number" && ctxLen > 0) {
            contextWindow = ctxLen;
          }
        }
      } finally {
        clearTimeout(showTimer);
      }
    } catch {
      // fall back to default
    }

    return { id: picked.name, name: picked.name, contextWindow };
  } catch {
    return null;
  }
}

export type OllamaGatewayInstance = {
  port: number;
  gatewayToken: string;
  homeDir: string;
  stateDir: string;
  configPath: string;
  workspaceDir: string;
  model: OllamaModel;
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
};

/**
 * Spawn a real gateway child process configured to use a local Ollama provider.
 * The caller must pass a discovered model from `discoverOllamaModel()`.
 * Waits until the gateway TCP port is open before resolving.
 * Cleans up on failure.
 */
export async function spawnOllamaGatewayInstance(model: OllamaModel): Promise<OllamaGatewayInstance> {
  const port = await getFreePort();
  const gatewayToken = `ollama-gateway-${randomUUID()}`;

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ollama-e2e-"));
  const configDir = path.join(homeDir, ".openclaw");
  const stateDir = path.join(homeDir, "state");
  const workspaceDir = path.join(homeDir, "workspace");

  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });

  const configPath = path.join(configDir, "openclaw.json");

  const config = {
    gateway: {
      port,
      auth: { mode: "none" },
      controlUi: { enabled: false },
    },
    agents: {
      defaults: {
        model: { primary: `ollama/${model.id}` },
        workspace: workspaceDir,
      },
    },
    models: {
      providers: {
        ollama: {
          baseUrl: OLLAMA_BASE_URL,
          api: "ollama",
          apiKey: "ollama-local",
          models: [
            {
              id: model.id,
              name: model.name,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: model.contextWindow,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  };

  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const stdout: string[] = [];
  const stderr: string[] = [];
  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    child = spawn(
      "node",
      [
        "dist/index.js",
        "gateway",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          // NOTE: OPENCLAW_SKIP_PROVIDERS is intentionally NOT set so the
          // Ollama provider remains active for these integration tests.
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          OPENCLAW_GATEWAY_MANAGEMENT_API: "1",
          // Override test-env flags that vitest setup injects — these suppress
          // plugin loading and provider discovery in the child gateway process.
          OPENCLAW_TEST_FAST: "",
          OPENCLAW_STRICT_FAST_REPLY_CONFIG: "",
          OPENCLAW_SKIP_PROVIDERS: "",
          VITEST: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: unknown) => stdout.push(String(d)));
    child.stderr?.on("data", (d: unknown) => stderr.push(String(d)));

    await waitForGatewayReady(child, stdout, stderr, port, GATEWAY_START_TIMEOUT_MS);

    return {
      port,
      gatewayToken,
      homeDir,
      stateDir,
      configPath,
      workspaceDir,
      model,
      child,
      stdout,
      stderr,
    };
  } catch (err) {
    if (child && child.exitCode === null && !child.killed) {
      try {
        if (process.platform === "win32" && child.pid) {
          execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // ignore
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
    try {
      await fs.rm(homeDir, { recursive: true, force: true });
    } catch {
      // ignore — files may still be locked on Windows
    }
    throw err;
  }
}

/**
 * Gracefully stop an Ollama gateway instance and remove its temp directory.
 */
export async function stopOllamaGatewayInstance(inst: OllamaGatewayInstance): Promise<void> {
  const pid = inst.child.pid;

  if (inst.child.exitCode === null && !inst.child.killed) {
    // On Windows, SIGTERM/SIGKILL don't work reliably. Use taskkill to
    // force-terminate the process tree so file locks are released.
    if (process.platform === "win32" && pid) {
      try {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
      } catch {
        // ignore — process may already be gone
      }
    } else {
      try {
        inst.child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }

  // Wait for the process to actually exit
  await Promise.race([
    new Promise<void>((resolve) => {
      if (inst.child.exitCode !== null) return resolve();
      inst.child.once("exit", () => resolve());
    }),
    new Promise<void>((resolve) => setTimeout(resolve, GATEWAY_STOP_TIMEOUT_MS)),
  ]);

  // Force kill if still alive (non-Windows fallback)
  if (inst.child.exitCode === null && !inst.child.killed) {
    try {
      inst.child.kill("SIGKILL");
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  try {
    await fs.rm(inst.homeDir, { recursive: true, force: true });
  } catch {
    // On Windows, files may still be locked briefly after process exit
  }
}

/**
 * POST JSON to the management API of a running gateway instance.
 */
export async function managementPost(
  inst: OllamaGatewayInstance,
  urlPath: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${inst.port}${urlPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  let json: unknown = null;
  const text = await res.text();
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }

  return { status: res.status, json };
}

/**
 * Poll the session transcript JSONL file until a final assistant message appears.
 * Returns the assistant message text content.
 *
 * The transcript is a newline-delimited JSON file where each line is one of:
 *   { type: "session", ... }
 *   { message: { role: "user"|"assistant", content: ... } }
 *   { type: "usage", ... }
 */
export async function waitForAssistantReply(
  sessionFile: string,
  timeoutMs = 120_000,
): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const raw = await fs.readFile(sessionFile, "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean);

      // Walk backwards to find the last assistant message.
      // The run is complete when there's an assistant message after the user message.
      let foundUser = false;
      let lastAssistantText = "";

      for (const line of lines) {
        let entry: { message?: { role?: string; content?: unknown }; type?: string };
        try {
          entry = JSON.parse(line) as typeof entry;
        } catch {
          continue;
        }

        if (entry.message?.role === "user") {
          foundUser = true;
          lastAssistantText = "";
        }
        if (entry.message?.role === "assistant" && foundUser) {
          const content = entry.message.content;
          if (typeof content === "string") {
            lastAssistantText = content;
          } else if (Array.isArray(content)) {
            lastAssistantText = (content as Array<{ type?: string; text?: string }>)
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text!)
              .join("\n");
          }
        }
      }

      if (foundUser && lastAssistantText.length > 0) {
        return lastAssistantText;
      }
    } catch {
      // File may not exist yet or be partially written
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`timeout (${timeoutMs}ms) waiting for assistant reply in ${sessionFile}`);
}
