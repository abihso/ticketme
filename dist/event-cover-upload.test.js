"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_events_1 = require("node:events");
const node_test_1 = require("node:test");
const express_1 = __importDefault(require("express"));
const event_cover_upload_js_1 = require("./event-cover-upload.js");
const event_covers_js_1 = require("./event-covers.js");
(0, node_test_1.describe)("API cover upload", () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=", "base64");
    const saved = [];
    const app = (0, express_1.default)();
    // Match the production JSON parser, which must leave image bytes untouched.
    app.use(express_1.default.json({ limit: "32kb" }));
    app.use("/cover", (0, event_cover_upload_js_1.createCoverUploadRouter)({
        configured: true,
        save: async (_request, bytes, contentType) => {
            saved.push({ bytes, contentType });
            return "owner/123e4567-e89b-12d3-a456-426614174000.png";
        },
    }));
    app.use("/unconfigured", (0, event_cover_upload_js_1.createCoverUploadRouter)({
        configured: false,
        save: async () => { throw new Error("Must not save"); },
    }));
    app.use("/unavailable", (0, event_cover_upload_js_1.createCoverUploadRouter)({
        configured: true,
        save: async () => { throw new Error("Storage unavailable"); },
    }));
    const server = app.listen(0, "127.0.0.1");
    let base;
    (0, node_test_1.before)(async () => {
        if (!server.listening)
            await (0, node_events_1.once)(server, "listening");
        base = `http://127.0.0.1:${server.address().port}`;
    });
    (0, node_test_1.after)(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    async function upload(body, type = "image/png", path = "/cover") {
        return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : new Uint8Array(body) });
    }
    (0, node_test_1.it)("saves image bytes and returns an object key, without a browser storage URL", async () => {
        const response = await upload(png);
        strict_1.default.equal(response.status, 201);
        strict_1.default.deepEqual(await response.json(), { key: "owner/123e4567-e89b-12d3-a456-426614174000.png" });
        strict_1.default.deepEqual(saved.at(-1), { bytes: png, contentType: "image/png" });
    });
    (0, node_test_1.it)("rejects unsupported, mislabeled, empty, and oversized files before storage", async () => {
        const count = saved.length;
        for (const [body, type, status] of [
            ["<svg />", "image/svg+xml", 415],
            [png, "image/jpeg", 400],
            [Buffer.alloc(0), "image/png", 400],
            [Buffer.alloc(event_covers_js_1.maxCoverImageBytes + 1), "image/png", 413],
        ]) {
            const response = await upload(body, type);
            strict_1.default.equal(response.status, status);
            strict_1.default.equal(typeof (await response.json()).error, "string");
        }
        strict_1.default.equal(saved.length, count);
    });
    (0, node_test_1.it)("accepts an image exactly at the documented size limit", async () => {
        const bytes = Buffer.alloc(event_covers_js_1.maxCoverImageBytes);
        png.copy(bytes);
        const response = await upload(bytes);
        strict_1.default.equal(response.status, 201);
        await response.json();
    });
    (0, node_test_1.it)("reports unavailable configuration and storage failures as JSON", async () => {
        const unconfigured = await upload(png, "image/png", "/unconfigured");
        strict_1.default.equal(unconfigured.status, 503);
        await unconfigured.json();
        const log = node_test_1.mock.method(console, "error", () => { });
        try {
            const failed = await upload(png, "image/png", "/unavailable");
            strict_1.default.equal(failed.status, 502);
            strict_1.default.match((await failed.json()).error, /Could not save the cover image/);
        }
        finally {
            log.mock.restore();
        }
    });
});
