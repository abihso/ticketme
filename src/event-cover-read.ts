import express from "express";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isAllowedCoverImageType, isOwnedCoverImageKey } from "./event-covers.js";
import { storageErrorDetails } from "./cover-storage-error.js";

export function publicCoverImageUrl(origin: string, key: string): string {
  return `${origin.replace(/\/$/, "")}/api/event-covers/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function createCoverReadRouter(options: {
  configured: boolean;
  isSaved: (key: string) => Promise<boolean>;
  load: (key: string) => Promise<{ body: Readable; contentType: string; contentLength?: number }>;
}) {
  const router = express.Router();
  router.get("/:owner/:file", async (request, response, next) => {
    const { owner, file } = request.params;
    const key = `${owner}/${file}`;
    if (!isOwnedCoverImageKey(key, owner)) {
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
      if (!isAllowedCoverImageType(image.contentType)) {
        image.body.destroy();
        response.sendStatus(404);
        return;
      }
      response.set({
        "Content-Type": image.contentType === "image/jpg" ? "image/jpeg" : image.contentType,
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      });
      if (image.contentLength !== undefined) response.set("Content-Length", String(image.contentLength));
      await pipeline(image.body, response);
    } catch (error) {
      if (response.headersSent) return next(error);
      const storageError = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (storageError.name === "NoSuchKey" || storageError.$metadata?.httpStatusCode === 404) {
        response.sendStatus(404);
        return;
      }
      console.error("Event cover storage read failed", storageErrorDetails(error));
      response.status(502).json({ error: "Could not load the cover image. Try again." });
    }
  });
  return router;
}
