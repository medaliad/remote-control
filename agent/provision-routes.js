// provision-routes.js
//
// Drop these three routes into your Express app on Render.
// They give the desktop installer a way to receive a username from the
// browser without you having to hand-type it on every PC.
//
// Usage in your main server file:
//
//     const express = require('express');
//     const app = express();
//     app.use(express.json());           // <-- needed
//     require('./provision-routes')(app);
//
// or as ES module:
//
//     import installProvisionRoutes from './provision-routes.js';
//     installProvisionRoutes(app);
//
// Wire-protocol summary:
//
//   Installer  -> POST /api/provision/claim   {code}             -> {ok}
//   Browser    -> POST /api/provision/assign  {code, username}   -> {ok}
//   Installer  -> GET  /api/provision/poll?code=XXXXXXXX         -> {ok, username|null}
//
// Codes live for 15 minutes in memory. After a username is assigned we
// keep the entry around for another minute so the polling installer can
// pick it up, then drop it. Restarting the server forgets all in-flight
// codes - that's fine, the installer simply expires and prompts for a
// retry.

'use strict';

const TTL_MS         = 15 * 60 * 1000;  // 15 minutes
const POST_PICK_MS   = 60 * 1000;       // 1 minute grace after assign
const CLEANUP_EVERY  = 60 * 1000;
const CODE_REGEX     = /^[A-Z2-9]{8}$/i;

const codes = new Map(); // code -> { username, claimedAt, assignedAt, expiresAt }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of codes) {
    const dead = v.expiresAt < now ||
                 (v.assignedAt && v.assignedAt + POST_PICK_MS < now);
    if (dead) codes.delete(k);
  }
}, CLEANUP_EVERY);

function clean(s) {
  return String(s || '').trim();
}

module.exports = function installProvisionRoutes(app) {
  // 1) Installer claims a code on launch.
  app.post('/api/provision/claim', (req, res) => {
    const code = clean(req.body && req.body.code).toUpperCase();
    if (!CODE_REGEX.test(code)) {
      return res.status(400).json({ ok: false, error: 'bad code format' });
    }
    codes.set(code, {
      username: null,
      claimedAt: Date.now(),
      assignedAt: null,
      expiresAt: Date.now() + TTL_MS,
    });
    res.json({ ok: true });
  });

  // 2) Browser pushes the username down.
  app.post('/api/provision/assign', (req, res) => {
    const code = clean(req.body && req.body.code).toUpperCase();
    const username = clean(req.body && req.body.username);
    if (!CODE_REGEX.test(code)) {
      return res.status(400).json({ ok: false, error: 'bad code' });
    }
    if (!username || username.length > 64) {
      return res.status(400).json({ ok: false, error: 'bad username' });
    }
    const entry = codes.get(code);
    if (!entry) {
      return res.status(404).json({ ok: false, error: 'unknown or expired code' });
    }
    entry.username = username;
    entry.assignedAt = Date.now();
    res.json({ ok: true });
  });

  // 3) Installer polls every few seconds.
  app.get('/api/provision/poll', (req, res) => {
    const code = clean(req.query.code).toUpperCase();
    if (!CODE_REGEX.test(code)) {
      return res.status(400).json({ ok: false, error: 'bad code' });
    }
    const entry = codes.get(code);
    if (!entry) {
      return res.status(404).json({ ok: false });
    }
    res.json({ ok: true, username: entry.username || null });
  });
};
