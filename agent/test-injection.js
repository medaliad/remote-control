// test-injection.js -- standalone smoke test for the local agent.
//
// Run with: node test-injection.js
//
// Connects to the already-running agent on 127.0.0.1:8766, sends a few
// canned mouse events, and prints exactly what happened. If the cursor
// doesn't move while this runs, the agent isn't working AND the problem
// is NOT in the web app -- it's PowerShell / AV / UAC on the host.
//
// Start the agent first: `cd agent && npm start`

import { WebSocket } from "ws";

const url = "ws://127.0.0.1:8766";
const ws = new WebSocket(url, { origin: "http://localhost" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.on("open", async () => {
  console.log(`[test] connected to ${url}`);
  console.log("[test] watch your cursor -- it should trace a small square");

  // Trace a 200-pixel square roughly in the center of the screen.
  const pts = [
    [0.45, 0.45],
    [0.55, 0.45],
    [0.55, 0.55],
    [0.45, 0.55],
    [0.45, 0.45],
  ];
  for (const [x, y] of pts) {
    ws.send(JSON.stringify({ t: "mouse", x, y, kind: "move" }));
    await sleep(300);
  }

  // Then a left click right where the cursor is.
  await sleep(500);
  console.log("[test] sending left-click at 50%, 50%");
  ws.send(JSON.stringify({ t: "mouse", x: 0.5, y: 0.5, button: 0, kind: "down" }));
  await sleep(50);
  ws.send(JSON.stringify({ t: "mouse", x: 0.5, y: 0.5, button: 0, kind: "up" }));

  // Type "HELLO" to prove keyboard path works.
  await sleep(500);
  console.log("[test] typing 'HELLO' -- make sure some text field has focus");
  for (const c of "HELLO") {
    const code = "Key" + c;
    ws.send(JSON.stringify({ t: "key", key: c.toLowerCase(), code, kind: "down" }));
    await sleep(40);
    ws.send(JSON.stringify({ t: "key", key: c.toLowerCase(), code, kind: "up" }));
    await sleep(40);
  }

  await sleep(500);
  console.log("[test] done. closing.");
  ws.close();
});

ws.on("message", (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    console.log("[test] agent status:", msg);
  } catch { /* ignore */ }
});

ws.on("error", (err) => {
  console.error(`[test] connection error: ${err.message}`);
  console.error("[test] is the agent running? try: cd agent && npm start");
  process.exit(1);
});

ws.on("close", () => {
  console.log("[test] closed");
  process.exit(0);
});
