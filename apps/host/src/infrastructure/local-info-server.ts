import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface LocalHostInfo {
  deviceId:   string;
  deviceName: string;
  pin:        string;
  /** Relay the host agent is registered with — so the /host page can build
   *  a share link that actually works from outside this machine. */
  relayUrl:   string;
}

/**
 * Tiny HTTP server bound to localhost so that the `/host` page, when opened on
 * the same machine, can display this host's PIN. The PIN never leaves the box
 * because we only listen on 127.0.0.1.
 */
export function startLocalInfoServer(port: number, info: LocalHostInfo): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Open CORS so the Next.js dev server (different port on localhost) can read it.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      if (req.url === "/info" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" })
           .end(JSON.stringify(info));
        return;
      }
      res.writeHead(404).end();
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`[host] local info server listening on http://127.0.0.1:${port}/info`);
      resolve();
    });
  });
}
