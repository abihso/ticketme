"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_events_1 = require("node:events");
const node_test_1 = require("node:test");
const express_1 = __importDefault(require("express"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const proxy_config_js_1 = require("./proxy-config.js");
(0, node_test_1.it)("uses forwarded visitor IPs for separate rate limits and HTTPS on Render", async () => {
    const app = (0, express_1.default)();
    (0, proxy_config_js_1.configureProxy)(app, { RENDER: "true" });
    app.use((0, express_rate_limit_1.default)({ windowMs: 60_000, limit: 1 }));
    app.get("/", (request, response) => response.json({ ip: request.ip, protocol: request.protocol }));
    const server = app.listen(0, "127.0.0.1");
    const errors = node_test_1.mock.method(console, "error", () => { });
    try {
        if (!server.listening)
            await (0, node_events_1.once)(server, "listening");
        const url = `http://127.0.0.1:${server.address().port}`;
        const visit = (ip) => fetch(url, {
            headers: { "X-Forwarded-For": ip, "X-Forwarded-Proto": "https" },
        });
        // Ignore an extra client-supplied address ahead of the nearest proxy's value.
        const first = await visit("198.51.100.99, 203.0.113.1");
        strict_1.default.equal(first.status, 200);
        strict_1.default.deepEqual(await first.json(), { ip: "203.0.113.1", protocol: "https" });
        const repeated = await visit("198.51.100.98, 203.0.113.1");
        strict_1.default.equal(repeated.status, 429);
        await repeated.text();
        const second = await visit("203.0.113.2");
        strict_1.default.equal(second.status, 200);
        await second.json();
        strict_1.default.equal(errors.mock.callCount(), 0);
    }
    finally {
        errors.mock.restore();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
(0, node_test_1.it)("keeps proxy trust disabled outside Render", () => {
    const app = (0, express_1.default)();
    (0, proxy_config_js_1.configureProxy)(app, {});
    strict_1.default.equal(app.get("trust proxy"), false);
});
