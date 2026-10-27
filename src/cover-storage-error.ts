export class CoverStorageError extends Error {
  readonly status = 502;
  constructor(readonly accessDenied: boolean) {
    super(accessDenied
      ? "Image storage access was denied. Ask the administrator to check the API's S3 read permissions, then try saving again."
      : "Image storage is temporarily unavailable. Try saving again shortly.");
  }
}

export function storageErrorDetails(error: unknown) {
  const failure = error as { name?: string; $metadata?: { httpStatusCode?: number; requestId?: string } } | null;
  return {
    name: failure?.name,
    status: failure?.$metadata?.httpStatusCode,
    requestId: failure?.$metadata?.requestId,
  };
}

// A missing object can be re-uploaded. Permission failures and outages must
// never be presented as invalid image files or trigger deletion of the upload.
export function coverVerificationFailure(error: unknown): false {
  const details = storageErrorDetails(error);
  if (details.name === "NoSuchKey" || details.name === "NotFound" || details.status === 404) return false;
  console.error("Event cover verification could not read storage", details);
  throw new CoverStorageError(details.name === "AccessDenied" || details.status === 403);
}
