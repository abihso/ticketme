"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configureProxy = configureProxy;
function configureProxy(app, env = process.env) {
    // Render terminates HTTPS before forwarding to the app. Trust the nearest
    // proxy only; direct local requests must not trust client-supplied headers.
    app.set("trust proxy", env.RENDER === "true" ? 1 : false);
}
