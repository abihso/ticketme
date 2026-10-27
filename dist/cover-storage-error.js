"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoverStorageError = void 0;
exports.storageErrorDetails = storageErrorDetails;
exports.coverVerificationFailure = coverVerificationFailure;
class CoverStorageError extends Error {
    accessDenied;
    status = 502;
    constructor(accessDenied) {
        super(accessDenied
            ? "Image storage access was denied. Ask the administrator to check the API's S3 read permissions, then try saving again."
            : "Image storage is temporarily unavailable. Try saving again shortly.");
        this.accessDenied = accessDenied;
    }
}
exports.CoverStorageError = CoverStorageError;
function storageErrorDetails(error) {
    const failure = error;
    return {
        name: failure?.name,
        status: failure?.$metadata?.httpStatusCode,
        requestId: failure?.$metadata?.requestId,
    };
}
// A missing object can be re-uploaded. Permission failures and outages must
// never be presented as invalid image files or trigger deletion of the upload.
function coverVerificationFailure(error) {
    const details = storageErrorDetails(error);
    if (details.name === "NoSuchKey" || details.name === "NotFound" || details.status === 404)
        return false;
    console.error("Event cover verification could not read storage", details);
    throw new CoverStorageError(details.name === "AccessDenied" || details.status === 403);
}
