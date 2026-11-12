"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicCoverImageUrl = publicCoverImageUrl;
exports.createCoverReadRouter = createCoverReadRouter;
const express_1 = __importDefault(require("express"));
const promises_1 = require("node:stream/promises");
const event_covers_js_1 = require("./event-covers.js");
const cover_storage_error_js_1 = require("./cover-storage-error.js");
function publicCoverImageUrl(origin, key) {
    return `${origin.replace(/\/$/, "")}/api/event-covers/${key.split("/").map(encodeURIComponent).join("/")}`;
}
function createCoverReadRouter(options) {
    const router = express_1.default.Router();
    router.get("/:owner/:file", async (request, response, next) => {
        const { owner, file } = request.params;
        const key = `${owner}/${file}`;
        if (!(0, event_covers_js_1.isOwnedCoverImageKey)(key, owner)) {
            response.sendStatus(404);
            return;
        }
        if (!options.configured) {
            response.status(503).json({ error: "Event image storage is not configured" });
            return;
        }
        try {
            if (!(await options.isSaved(key))) {
                response.sendStatus(404);
                return;
            }
            const image = await options.load(key);
            if (!(0, event_covers_js_1.isAllowedCoverImageType)(image.contentType)) {
                image.body.destroy();
                response.sendStatus(404);
                return;
            }
            response.set({
                "Content-Type": image.contentType === "image/jpg" ? "image/jpeg" : image.contentType,
                "Cache-Control": "public, max-age=3600",
                "X-Content-Type-Options": "nosniff",
            });
            if (image.contentLength !== undefined)
                response.set("Content-Length", String(image.contentLength));
            await (0, promises_1.pipeline)(image.body, response);
        }
        catch (error) {
            if (response.headersSent)
                return next(error);
            const storageError = error;
            if (storageError.name === "NoSuchKey" || storageError.$metadata?.httpStatusCode === 404) {
                response.sendStatus(404);
                return;
            }
            console.error("Event cover storage read failed", (0, cover_storage_error_js_1.storageErrorDetails)(error));
            response.status(502).json({ error: "Could not load the cover image. Try again." });
        }
    });
    return router;
}
