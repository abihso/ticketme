export const maxCoverImageBytes = 20 * 1024 * 1024;

export const coverImageTypes = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export function isAllowedCoverImageType(
  contentType: string,
): contentType is keyof typeof coverImageTypes {
  return Object.hasOwn(coverImageTypes, contentType);
}

export function isOwnedCoverImageKey(key: string, userId: string): boolean {
  return (
    key.startsWith(`${userId}/`) &&
    /^[A-Za-z0-9_-]+\/[a-f0-9-]{36}\.(jpg|png|webp)$/i.test(key)
  );
}

export function matchesImageSignature(
  bytes: Uint8Array,
  contentType: string,
): boolean {
  if ((contentType === "image/jpeg" || contentType === "image/jpg"))
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png")
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  return (
    contentType === "image/webp" &&
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP"
  );
}
