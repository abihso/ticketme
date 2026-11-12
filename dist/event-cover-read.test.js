"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_events_1 = require("node:events");
const node_stream_1 = require("node:stream");
const node_test_1 = require("node:test");
const express_1 = __importDefault(require("express"));
const event_cover_read_js_1 = require("./event-cover-read.js");
(0, node_test_1.describe)("public event covers", () => {
    const key = "owner/123e4567-e89b-12d3-a456-426614174000.jpg";
    const bytes = Buffer.from([0xff, 0xd8, 0xff]);
    let reads = 0;
    const app = (0, express_1.default)();
    app.use("/api/event-covers", (0, event_cover_read_js_1.createCoverReadRouter)({
        configured: true,
        isSaved: async (candidate) => candidate === key,
        load: async () => {
            reads++;
            return { body: node_stream_1.Readable.from([bytes]), contentType: "image/jpg", contentLength: bytes.length };
        },
    }));
    app.use("/missing", (0, event_cover_read_js_1.createCoverReadRouter)({
        configured: true,
        isSaved: async () => true,
        load: async () => { throw Object.assign(new Error("Missing"), { name: "NoSuchKey" }); },
    }));
    const server = app.listen(0, "127.0.0.1");
    let base;
    (0, node_test_1.before)(async () => {
        if (!server.listening)
            await (0, node_events_1.once)(server, "listening");
        base = `http://127.0.0.1:${server.address().port}`;
    });
    (0, node_test_1.after)(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    (0, node_test_1.it)("serves the same permanent URL repeatedly without login or signing parameters", async () => {
        const url = (0, event_cover_read_js_1.publicCoverImageUrl)(`${base}/`, key);
        strict_1.default.equal(url, `${base}/api/event-covers/${key}`);
        for (let attempt = 0; attempt < 2; attempt++) {
            const response = await fetch(url);
            strict_1.default.equal(response.status, 200);
            strict_1.default.equal(response.headers.get("content-type"), "image/jpeg");
            strict_1.default.equal(response.headers.get("cache-control"), "public, max-age=3600");
            strict_1.default.equal(response.headers.get("x-content-type-options"), "nosniff");
            strict_1.default.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
        }
    });
    (0, node_test_1.it)("does not expose arbitrary bucket objects or unattached uploads", async () => {
        const before = reads;
        for (const path of ["owner/private.txt", "someone-else/123e4567-e89b-12d3-a456-426614174000.jpg"]) {
            const response = await fetch(`${base}/api/event-covers/${path}`);
            strict_1.default.equal(response.status, 404);
            await response.text();
        }
        strict_1.default.equal(reads, before);
    });
    (0, node_test_1.it)("returns 404 when a saved image no longer exists in storage", async () => {
        const response = await fetch(`${base}/missing/${key}`);
        strict_1.default.equal(response.status, 404);
        await response.text();
    });
});
