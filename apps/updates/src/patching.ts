import { Context, Effect } from "effect";
import { StorageError } from "./errors.ts";

// A BSDIFF40 patch is a 32-byte header (magic, control length, diff length,
// size of the file it rebuilds) followed by three bzip2 streams.
const magic = [..."BSDIFF40"].map((char) => char.charCodeAt(0));
const header = 32;

// bsdiff writes lengths as sign-magnitude little-endian 64-bit integers.
const offtin = (bytes: Uint8Array, at: number): number => {
  let value = bytes[at + 7]! & 0x7f;
  for (let index = 6; index >= 0; index--) value = value * 256 + bytes[at + index]!;
  return bytes[at + 7]! & 0x80 ? -value : value;
};

const isBzip2 = (bytes: Uint8Array, at: number): boolean =>
  at + 4 <= bytes.length && bytes[at] === 0x42 && bytes[at + 1] === 0x5a && bytes[at + 2] === 0x68 && bytes[at + 3]! >= 0x31 && bytes[at + 3]! <= 0x39;

export interface PatchProblem {
  readonly code: "corrupt-patch" | "size-mismatch";
  readonly message: string;
}

// What the server can check without rebuilding the bundle. Rebuilding one holds
// the base, the decompressed blocks and the result in memory at once, which
// passes a Worker's 128 MB for bundles of about 20 MB. The CLI rebuilds each
// patch before uploading it, and the device checks the rebuilt bundle's hash
// and downloads the full bundle when it does not match.
export const patchProblem = (patch: Uint8Array, targetSize: number): PatchProblem | undefined => {
  if (patch.length < header || magic.some((byte, index) => patch[index] !== byte)) {
    return { code: "corrupt-patch", message: "The patch is not a BSDIFF40 patch." };
  }
  const controlLength = offtin(patch, 8);
  const diffLength = offtin(patch, 16);
  const size = offtin(patch, 24);
  if (controlLength < 0 || diffLength < 0 || controlLength + diffLength > patch.length - header) {
    return { code: "corrupt-patch", message: "The patch is truncated: its header announces more than it holds." };
  }
  if (![header, header + controlLength, header + controlLength + diffLength].every((at) => isBzip2(patch, at))) {
    return { code: "corrupt-patch", message: "The patch's blocks are not bzip2 streams." };
  }
  if (size !== targetSize) {
    return { code: "size-mismatch", message: `The patch rebuilds ${size} bytes; the target bundle has ${targetSize}.` };
  }
  return undefined;
};

export interface PatchPolicyShape {
  // A patch is stored only when it is at most this share of what the full
  // bundle costs over the wire. Above it the patch is not worth a second
  // request path.
  readonly maxRatio: number;
  // Bundles above this get no patches: a device rebuilds the bundle in memory.
  readonly maxBundleBytes: number;
}

export class PatchPolicy extends Context.Service<PatchPolicy, PatchPolicyShape>()("expo-ota/PatchPolicy") {
  static readonly defaults: PatchPolicyShape = { maxRatio: 0.3, maxBundleBytes: 32 * 1024 * 1024 };
}

export interface AssetSizes {
  readonly contentType: string;
  readonly size: number;
  readonly compressedSize: number | null;
}

// Cloudflare compresses these at the edge, so the device downloads the gzip
// size, not the raw one. Everything else goes out as stored.
export const isCompressible = (contentType: string): boolean =>
  /^(text\/|application\/(javascript|x-javascript|ecmascript|json|xml|ld\+json)|image\/svg\+xml)/i.test(contentType);

// What a device downloads when it takes the full asset.
export const wireSize = (asset: AssetSizes): number =>
  isCompressible(asset.contentType) && asset.compressedSize !== null ? asset.compressedSize : asset.size;

export type PatchDecision =
  | { readonly stored: true; readonly wireSize: number; readonly ratio: number }
  | { readonly stored: false; readonly reason: "bundle-too-large" | "too-large"; readonly wireSize: number; readonly ratio: number };

export const patchDecision = (
  policy: PatchPolicyShape,
  target: AssetSizes,
  base: AssetSizes,
  patchSize: number,
): PatchDecision => {
  const wire = wireSize(target);
  const ratio = wire === 0 ? Number.POSITIVE_INFINITY : patchSize / wire;
  if (target.size > policy.maxBundleBytes || base.size > policy.maxBundleBytes) {
    return { stored: false, reason: "bundle-too-large", wireSize: wire, ratio };
  }
  if (patchSize > policy.maxRatio * wire) {
    return { stored: false, reason: "too-large", wireSize: wire, ratio };
  }
  return { stored: true, wireSize: wire, ratio };
};

// Gzip is what the edge applies; the count is all that is kept.
export const gzipSize = Effect.fn("Patching.gzipSize")((body: ReadableStream<Uint8Array> | Uint8Array) =>
  Effect.tryPromise({
    try: async () => {
      const source = body instanceof Uint8Array ? new Blob([body as Uint8Array<ArrayBuffer>]).stream() : body;
      const reader = (source as ReadableStream<BufferSource>).pipeThrough(new CompressionStream("gzip")).getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return total;
        total += value.length;
      }
    },
    catch: (cause) => new StorageError({ message: "Could not measure the compressed size.", cause }),
  }),
);
