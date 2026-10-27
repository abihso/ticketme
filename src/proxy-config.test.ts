import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { it, mock } from "node:test";
import express from "express";
import rateLimit from "express-rate-limit";
import { configureProxy } from "./proxy-config.js";

it("uses forwarded visitor IPs for separate rate limits and HTTPS on Render", async () => {
  const app = express();
  configureProxy(app, { RENDER: "true" });
  app.use(rateLimit({ windowMs: 60_000, limit: 1 }));
  app.get("/", (request, response) => response.json({ ip: request.ip, protocol: request.protocol }));
  const server = app.listen(0, "127.0.0.1");
  const errors = mock.method(console, "error", () => {});
  try {
    if (!server.listening) await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const visit = (ip: string) => fetch(url, {
      headers: { "X-Forwarded-For": ip, "X-Forwarded-Proto": "https" },
    });
    // Ignore an extra client-supplied address ahead of the nearest proxy's value.
    const first = await visit("198.51.100.99, 203.0.113.1");
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ip: "203.0.113.1", protocol: "https" });
    const repeated = await visit("198.51.100.98, 203.0.113.1");
    assert.equal(repeated.status, 429);
    await repeated.text();
    const second = await visit("203.0.113.2");
    assert.equal(second.status, 200);
    await second.json();
    assert.equal(errors.mock.callCount(), 0);
  } finally {
    errors.mock.restore();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it("keeps proxy trust disabled outside Render", () => {
  const app = express();
  configureProxy(app, {});
  assert.equal(app.get("trust proxy"), false);
});
