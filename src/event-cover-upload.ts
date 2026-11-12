import express, { type ErrorRequestHandler, type Request } from "express";
import {
  isAllowedCoverImageType,
  matchesImageSignature,
  maxCoverImageBytes,
} from "./event-covers.js";

// Mount behind authentication and rate limiting. Receiving image bytes through
// the API avoids requiring browsers to make cross-origin requests to storage.
export function createCoverUploadRouter(options: {
  configured: boolean;
  save: (request: Request, bytes: Buffer, contentType: string) => Promise<string>;
}) {
  const router = express.Router();
  router.post(
    "/",
    (request, response, next) => {
      if (!options.configured) {
        response.status(503).json({ error: "Event image storage is not configured" });
        return;
      }
      if (!isAllowedCoverImageType(request.get("content-type") ?? "")) {
        response.status(415).json({ error: "Choose a JPG/JPEG, PNG, or WebP image." });
        return;
      }
      next();
    },
    express.raw({ type: () => true, limit: maxCoverImageBytes, inflate: false }),
    async (request, response) => {
      const bytes = request.body;
      const declaredType = request.get("content-type")!;
      const contentType = declaredType === "image/jpg" ? "image/jpeg" : declaredType;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        response.status(400).json({ error: "Choose a non-empty cover image." });
        return;
      }
      if (!matchesImageSignature(bytes, contentType)) {
        response.status(400).json({ error: "The file does not match its image type. Choose a JPG/JPEG, PNG, or WebP image." });
        return;
      }
      try {
        const key = await options.save(request, bytes, contentType);
        response.status(201).json({ key });
      } catch (error) {
        console.error("Event cover storage upload failed", error);
        response.status(502).json({ error: "Could not save the cover image. Try again, or remove the image to save your event without it." });
      }
    },
  );
  const handleUploadError: ErrorRequestHandler = (error, _request, response, next) => {
    if (error.type === "entity.too.large") {
      response.status(413).json({ error: "Cover image must be 20 MB or smaller." });
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
