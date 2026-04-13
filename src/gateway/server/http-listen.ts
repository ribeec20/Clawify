import type { Server as HttpServer } from "node:http";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { sleep } from "../../utils.js";

const EADDRINUSE_MAX_RETRIES = 4;
const EADDRINUSE_RETRY_INTERVAL_MS = 500;
const HTTP_LISTEN_TIMEOUT_MS = 10_000;

async function closeServerQuietly(httpServer: HttpServer): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      httpServer.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

export async function listenGatewayHttpServer(params: {
  httpServer: HttpServer;
  bindHost: string;
  port: number;
}) {
  const { httpServer, bindHost, port } = params;

  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const onError = (err: NodeJS.ErrnoException) => {
          cleanup();
          reject(err);
        };
        const onListening = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          httpServer.off("error", onError);
          httpServer.off("listening", onListening);
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        timeoutId = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              `gateway http listen timed out after ${HTTP_LISTEN_TIMEOUT_MS}ms (${bindHost}:${port})`,
            ),
          );
        }, HTTP_LISTEN_TIMEOUT_MS);
        timeoutId.unref?.();
        try {
          httpServer.listen(port, bindHost);
        } catch (err) {
          cleanup();
          reject(err);
        }
      });
      return; // bound successfully
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" && attempt < EADDRINUSE_MAX_RETRIES) {
        // Port may still be in TIME_WAIT after a recent process exit; retry.
        await closeServerQuietly(httpServer);
        await sleep(EADDRINUSE_RETRY_INTERVAL_MS);
        continue;
      }
      if (code === "EADDRINUSE") {
        throw new GatewayLockError(
          `another gateway instance is already listening on ws://${bindHost}:${port}`,
          err,
        );
      }
      throw new GatewayLockError(
        `failed to bind gateway socket on ws://${bindHost}:${port}: ${String(err)}`,
        err,
      );
    }
  }
}
