"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCoverUploadRouter = createCoverUploadRouter;
const express_1 = __importDefault(require("express"));
const event_covers_js_1 = require("./event-covers.js");
// Mount behind authentication and rate limiting. Receiving image bytes through
// the API avoids requiring browsers to make cross-origin requests to storage.
function createCoverUploadRouter(options) {
    const router = express_1.default.Router();
    router.post("/", (request, response, next) => {
        if (!options.configured) {
            response.status(503).json({ error: "Event image storage is not configured" });
            return;
        }
        if (!(0, event_covers_js_1.isAllowedCoverImageType)(request.get("content-type") ?? "")) {
            response.status(415).json({ error: "Choose a JPEG, PNG, or WebP image." });
            return;
        }
        next();
    }, express_1.default.raw({ type: () => true, limit: event_covers_js_1.maxCoverImageBytes, inflate: false }), async (request, response) => {
        const bytes = request.body;
        const contentType = request.get("content-type");
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
            response.status(400).json({ error: "Choose a non-empty cover image." });
            return;
        }
        if (!(0, event_covers_js_1.matchesImageSignature)(bytes, contentType)) {
            response.status(400).json({ error: "The file does not match its image type. Choose a JPEG, PNG, or WebP image." });
            return;
        }
        try {
            const key = await options.save(request, bytes, contentType);
            response.status(201).json({ key });
        }
        catch (error) {
            console.error("Event cover storage upload failed", error);
            response.status(502).json({ error: "Could not save the cover image. Try again, or remove the image to save your event without it." });
        }
    });
    const handleUploadError = (error, _request, response, next) => {
        if (error.type === "entity.too.large") {
            response.status(413).json({ error: "Cover image must be 5 MB or smaller." });
            return;
        }
        if (error.type === "encoding.unsupported") {
            response.status(415).json({ error: "Upload the image without request compression." });
            return;
        }
        next(error);
    };
    router.use(handleUploadError);
    return router;
}
