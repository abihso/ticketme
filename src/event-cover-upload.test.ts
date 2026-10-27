import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, before, describe, it, mock } from "node:test";
import express from "express";
import { createCoverUploadRouter } from "./event-cover-upload.js";
import { maxCoverImageBytes } from "./event-covers.js";

describe("API cover upload", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=", "base64");
  const saved: { bytes: Buffer; contentType: string }[] = [];
  const app = express();
  // Match the production JSON parser, which must leave image bytes untouched.
  app.use(express.json({ limit: "32kb" }));
  app.use("/cover", createCoverUploadRouter({
    configured: true,
    save: async (_request, bytes, contentType) => {
      saved.push({ bytes, contentType });
      return "owner/123e4567-e89b-12d3-a456-426614174000.png";
    },
  }));
  app.use("/unconfigured", createCoverUploadRouter({
    configured: false,
    save: async () => { throw new Error("Must not save"); },
  }));
  app.use("/unavailable", createCoverUploadRouter({
    configured: true,
    save: async () => { throw new Error("Storage unavailable"); },
  }));
  const server = app.listen(0, "127.0.0.1");
  let base: string;
  before(async () => {
    if (!server.listening) await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  async function upload(body: Buffer | string, type = "image/png", path = "/cover") {
    return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : new Uint8Array(body) });
  }

  it("saves image bytes and returns an object key, without a browser storage URL", async () => {
    const response = await upload(png);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { key: "owner/123e4567-e89b-12d3-a456-426614174000.png" });
    assert.deepEqual(saved.at(-1), { bytes: png, contentType: "image/png" });
  });

  it("rejects unsupported, mislabeled, empty, and oversized files before storage", async () => {
    const count = saved.length;
    for (const [body, type, status] of [
      ["<svg />", "image/svg+xml", 415],
      [png, "image/jpeg", 400],
      [Buffer.alloc(0), "image/png", 400],
      [Buffer.alloc(maxCoverImageBytes + 1), "image/png", 413],
    ] as const) {
      const response = await upload(body, type);
      assert.equal(response.status, status);
      assert.equal(typeof (await response.json()).error, "string");
    }
    assert.equal(saved.length, count);
  });

  it("accepts an image exactly at the documented size limit", async () => {
    const bytes = Buffer.alloc(maxCoverImageBytes);
    png.copy(bytes);
    const response = await upload(bytes);
    assert.equal(response.status, 201);
    await response.json();
  });

  it("reports unavailable configuration and storage failures as JSON", async () => {
    const unconfigured = await upload(png, "image/png", "/unconfigured");
    assert.equal(unconfigured.status, 503);
    await unconfigured.json();
    const log = mock.method(console, "error", () => {});
    try {
      const failed = await upload(png, "image/png", "/unavailable");
      assert.equal(failed.status, 502);
      assert.match((await failed.json()).error, /Could not save the cover image/);
    } finally {
      log.mock.restore();
    }
  });
});
