"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.coverImageTypes = exports.maxCoverImageBytes = void 0;
exports.isAllowedCoverImageType = isAllowedCoverImageType;
exports.isOwnedCoverImageKey = isOwnedCoverImageKey;
exports.matchesImageSignature = matchesImageSignature;
exports.maxCoverImageBytes = 20 * 1024 * 1024;
exports.coverImageTypes = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
};
function isAllowedCoverImageType(contentType) {
    return Object.hasOwn(exports.coverImageTypes, contentType);
}
function isOwnedCoverImageKey(key, userId) {
    return (key.startsWith(`${userId}/`) &&
        /^[A-Za-z0-9_-]+\/[a-f0-9-]{36}\.(jpg|png|webp)$/i.test(key));
}
function matchesImageSignature(bytes, contentType) {
    if ((contentType === "image/jpeg" || contentType === "image/jpg"))
        return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (contentType === "image/png")
        return (bytes.length >= 8 &&
            bytes[0] === 0x89 &&
            bytes[1] === 0x50 &&
            bytes[2] === 0x4e &&
            bytes[3] === 0x47 &&
            bytes[4] === 0x0d &&
            bytes[5] === 0x0a &&
            bytes[6] === 0x1a &&
            bytes[7] === 0x0a);
    return (contentType === "image/webp" &&
        bytes.length >= 12 &&
        Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" &&
        Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP");
}
