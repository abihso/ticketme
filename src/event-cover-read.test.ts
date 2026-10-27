import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import express from "express";
import { createCoverReadRouter, publicCoverImageUrl } from "./event-cover-read.js";

describe("public event covers", () => {
  const key = "owner/123e4567-e89b-12d3-a456-426614174000.jpg";
  const bytes = Buffer.from([0xff, 0xd8, 0xff]);
  let reads = 0;
  const app = express();
  app.use("/api/event-covers", createCoverReadRouter({
    configured: true,
    isSaved: async (candidate) => candidate === key,
    load: async () => {
      reads++;
      return { body: Readable.from([bytes]), contentType: "image/jpg", contentLength: bytes.length };
    },
  }));
  app.use("/missing", createCoverReadRouter({
    configured: true,
    isSaved: async () => true,
    load: async () => { throw Object.assign(new Error("Missing"), { name: "NoSuchKey" }); },
  }));
  const server = app.listen(0, "127.0.0.1");
  let base: string;
  before(async () => {
    if (!server.listening) await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  it("serves the same permanent URL repeatedly without login or signing parameters", async () => {
    const url = publicCoverImageUrl(`${base}/`, key);
    assert.equal(url, `${base}/api/event-covers/${key}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/jpeg");
      assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
  });

  it("does not expose arbitrary bucket objects or unattached uploads", async () => {
    const before = reads;
    for (const path of ["owner/private.txt", "someone-else/123e4567-e89b-12d3-a456-426614174000.jpg"]) {
      const response = await fetch(`${base}/api/event-covers/${path}`);
      assert.equal(response.status, 404);
      await response.text();
    }
    assert.equal(reads, before);
  });

  it("returns 404 when a saved image no longer exists in storage", async () => {
    const response = await fetch(`${base}/missing/${key}`);
    assert.equal(response.status, 404);
    await response.text();
  });
});
