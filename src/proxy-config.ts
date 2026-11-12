import type { Express } from "express";

export function configureProxy(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  // Render terminates HTTPS before forwarding to the app. Trust the nearest
  // proxy only; direct local requests must not trust client-supplied headers.
  app.set("trust proxy", env.RENDER === "true" ? 1 : false);
}
