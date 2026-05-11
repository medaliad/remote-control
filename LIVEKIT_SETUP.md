# LiveKit voice setup

Voice (mic-to-mic between host and client) goes through a self-hosted LiveKit
SFU. Screen share + remote input still use the existing peer-to-peer WebRTC
path. This document is what you need to wire LiveKit up after pulling the
new code.

## What changed in the codebase

- **`server/src/livekit.ts`** - mints short-lived JWTs scoped to the session
  code. Reads `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
- **`server/src/app.ts`** - new route `POST /api/livekit/token`.
- **`web/src/lib/voice.ts`** - joins the LiveKit room, publishes mic on
  `openMic()`, subscribes to remote audio. Same shape as the old mic methods.
- **`web/src/lib/webrtc.ts`** - mic / openMic / closeMic removed. Screen
  share now strips audio tracks unconditionally.
- **`web/src/pages/Host.tsx`** and **`Client.tsx`** - use the `Voice` class.

## 1. Pick API key/secret

LiveKit auth uses an API key + secret pair. You generate them yourself:

```bash
# Pick anything that meets the length requirements.
LIVEKIT_API_KEY=$(openssl rand -hex 16)        # 32 hex chars (>=8 needed)
LIVEKIT_API_SECRET=$(openssl rand -hex 32)     # 64 hex chars (>=32 needed)
```

Save these somewhere safe. You will paste them into Render twice (once on
each service) - LiveKit signs tokens with the secret, the web app's token
endpoint signs with the same secret, and the browser only ever sees the
short-lived JWT.

## 2. Deploy on Render

The `render.yaml` in this repo defines both services. `render blueprint
launch` (or just pushing to main if the blueprint is already wired) will
create them.

After they're up, set env vars in the Render dashboard:

**Service `remote-access`:**

| Var | Value |
|---|---|
| `LIVEKIT_URL` | `wss://<your-livekit-service>.onrender.com` |
| `LIVEKIT_API_KEY` | the key you picked in step 1 |
| `LIVEKIT_API_SECRET` | the secret you picked in step 1 |

**Service `livekit`:**

| Var | Value |
|---|---|
| `LIVEKIT_KEYS` | `<LIVEKIT_API_KEY>: <LIVEKIT_API_SECRET>` (literal colon + space) |

Then redeploy both. The web app pulls `LIVEKIT_URL` from its server-side env
at token-mint time; the browser never reads any of these directly.

## 3. The Render UDP caveat

LiveKit normally uses UDP for RTP media. Render does not expose arbitrary
UDP ports. The blueprint therefore runs LiveKit in **TCP-only mode**: media
is tunneled through TURN/TLS over the same TCP port as signaling. This
works, but each media packet does an extra TURN-relay hop.

If you find voice latency too high under load, host LiveKit somewhere with
raw UDP - the easy options are:

- **LiveKit Cloud** (livekit.io) - free tier covers small usage, just point
  `LIVEKIT_URL` at their endpoint.
- **Fly.io** - LiveKit publishes a Fly-friendly Docker image. UDP works.
- **A VPS** with `docker run livekit/livekit-server` and the right
  firewall rules (50000-60000/udp).

Switching providers is a one-line change: update `LIVEKIT_URL` on the
`remote-access` service. The web code doesn't need to be redeployed.

## 4. Verify it works

1. Open the host page. Start a session, get the 6-char code.
2. Open the client page in another browser. Join with the code.
3. Once connected (screen sharing visible), click the Mic button on EITHER
   side. The other side should hear voice immediately.
4. If the Mic button shows an error, open DevTools console - the most
   common failure is `livekit-not-configured` (503 from the token endpoint),
   which means one of the env vars isn't set on the server.

## 5. Local development

Run a local LiveKit server in Docker:

```bash
docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
  -e LIVEKIT_KEYS="devkey: devsecretdevsecretdevsecretdevsecret" \
  livekit/livekit-server --dev
```

Then in your shell where you run the signaling server:

```bash
export LIVEKIT_URL=ws://localhost:7880
export LIVEKIT_API_KEY=devkey
export LIVEKIT_API_SECRET=devsecretdevsecretdevsecretdevsecret
npm run dev
```

The web dev server proxies `/api/*` to the signaling server, so the
browser's token request will reach the right place automatically.
