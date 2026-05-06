import type { AddressInfo } from "node:net";
import { createApp, type AppConfig } from "../../app.js";

export interface TestServer {
  url: string;
  wsUrl: string;
  close(): Promise<void>;
}

/**
 * Starts the full HTTP + WebSocket server on a random OS-assigned port.
 * Call `close()` in afterAll/afterEach to release the port.
 */
export async function startTestServer(config?: AppConfig): Promise<TestServer> {
  const { httpServer, close } = createApp({
    pingIntervalMs: 60_000, // avoid rapid ping teardown during tests
    ...config,
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });

  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    close,
  };
}
