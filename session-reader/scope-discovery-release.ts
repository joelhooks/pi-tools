import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import * as z from "zod/v4";

export const SCOPE_DISCOVERY_RELEASE_MANIFEST_FILENAME =
  "flowing-memory-release.v2.json";
export const PINNED_SCOPE_DISCOVERY_MEMORY_COMMIT =
  "05d92eadb5091113c5fc648e95ced36eb5fb8f39";
export const PINNED_SCOPE_DISCOVERY_MANIFEST_SHA256 =
  "a5d2a737c7dd558ff3e3566646b85d43c2ce5514dee17c4bb09405b79ffcb998";
export const PINNED_SCOPE_DISCOVERY_MANIFEST_SIZE = 349;
export const PINNED_SCOPE_DISCOVERY_ARTIFACT_SHA256 =
  "62922264b9f27df3ad9c18c095dabf3dd55477859522739ee396b7de78b3b6cf";
export const PINNED_SCOPE_DISCOVERY_ARTIFACT_SIZE = 74_988_002;
export const PINNED_SCOPE_DISCOVERY_RELEASE_NAME = "20260827-05d92ead-scope-v1";
export const SCOPE_DISCOVERY_MAX_MANIFEST_BYTES = 4 * 1024;
export const SCOPE_DISCOVERY_MAX_ARTIFACT_BYTES =
  PINNED_SCOPE_DISCOVERY_ARTIFACT_SIZE;
export const SCOPE_DISCOVERY_TRUSTED_HIERARCHY_ANCHOR =
  "/Library/Application Support/JoelClaw";
export const SCOPE_DISCOVERY_TRUSTED_RELEASE_ROOT = join(
  SCOPE_DISCOVERY_TRUSTED_HIERARCHY_ANCHOR,
  "flowing-memory",
  "releases",
);
export const PINNED_SCOPE_DISCOVERY_EXECUTABLE = join(
  SCOPE_DISCOVERY_TRUSTED_RELEASE_ROOT,
  PINNED_SCOPE_DISCOVERY_RELEASE_NAME,
  "joelclaw-memory",
);

const TRUSTED_DIRECTORY_MODE = 0o555;
const TRUSTED_MANIFEST_MODE = 0o444;
const TRUSTED_ARTIFACT_MODE = 0o555;
const HASH_CHUNK_BYTES = 64 * 1024;

const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ArtifactPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !value.startsWith("~") &&
      !value.split(/[\\/]/u).includes(".."),
  );
const ReleaseArtifactSchema = z.strictObject({
  kind: z.enum(["standalone", "script", "library"]),
  path: ArtifactPathSchema,
  sha256: DigestSchema,
});
const ReleaseManifestSchema = z.strictObject({
  _tag: z.literal("FlowingMemoryReleaseManifestV2"),
  schemaVersion: z.literal(2),
  memoryCommit: CommitSchema,
  releasedAt: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)))
    .optional(),
  artifacts: z
    .array(ReleaseArtifactSchema)
    .min(1)
    .max(64)
    .refine(
      (artifacts) =>
        new Set(artifacts.map((artifact) => artifact.path)).size ===
        artifacts.length,
    ),
});

/**
 * Filesystem policy for one release. Custom values exist only so tests can use
 * an isolated anchor and their own uid; production always uses the constant
 * root-owned target below.
 */
export interface ScopeDiscoveryReleaseTarget {
  readonly hierarchyAnchor: string;
  readonly trustedRoot: string;
  readonly artifactPath: string;
  readonly expectedOwnerUid: number;
  readonly expectedMemoryCommit: string;
  readonly expectedManifestSha256: string;
  readonly expectedManifestSize: number;
  readonly expectedArtifactSha256: string;
  readonly expectedArtifactSize: number;
}

export const PRODUCTION_SCOPE_DISCOVERY_RELEASE: ScopeDiscoveryReleaseTarget =
  Object.freeze({
    hierarchyAnchor: SCOPE_DISCOVERY_TRUSTED_HIERARCHY_ANCHOR,
    trustedRoot: SCOPE_DISCOVERY_TRUSTED_RELEASE_ROOT,
    artifactPath: PINNED_SCOPE_DISCOVERY_EXECUTABLE,
    expectedOwnerUid: 0,
    expectedMemoryCommit: PINNED_SCOPE_DISCOVERY_MEMORY_COMMIT,
    expectedManifestSha256: PINNED_SCOPE_DISCOVERY_MANIFEST_SHA256,
    expectedManifestSize: PINNED_SCOPE_DISCOVERY_MANIFEST_SIZE,
    expectedArtifactSha256: PINNED_SCOPE_DISCOVERY_ARTIFACT_SHA256,
    expectedArtifactSize: PINNED_SCOPE_DISCOVERY_ARTIFACT_SIZE,
  });

export interface ScopeDiscoveryFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface ScopeDiscoveryManagedDirectory {
  readonly path: string;
  readonly identity: ScopeDiscoveryFileIdentity;
}

export interface ScopeDiscoveryReleaseBinding {
  readonly target: ScopeDiscoveryReleaseTarget;
  readonly releaseDir: string;
  readonly manifestPath: string;
  readonly artifactPath: string;
  readonly managedDirectories: readonly ScopeDiscoveryManagedDirectory[];
  readonly manifestIdentity: ScopeDiscoveryFileIdentity;
  readonly artifactIdentity: ScopeDiscoveryFileIdentity;
  readonly manifestSha256: string;
  readonly artifactSha256: string;
}

export type ScopeDiscoveryReleaseRejection =
  | "release-unavailable"
  | "release-outside-root"
  | "release-directory-invalid"
  | "release-directory-writable"
  | "release-owner-invalid"
  | "manifest-invalid"
  | "manifest-owner-invalid"
  | "manifest-mode-invalid"
  | "manifest-size-mismatch"
  | "manifest-digest-mismatch"
  | "manifest-replaced"
  | "artifact-invalid"
  | "artifact-owner-invalid"
  | "artifact-mode-invalid"
  | "artifact-size-mismatch"
  | "artifact-not-executable"
  | "artifact-unmanifested"
  | "artifact-wrong-kind"
  | "artifact-digest-mismatch"
  | "artifact-replaced";

export type ScopeDiscoveryReleaseVerification =
  | { readonly ok: true; readonly binding: ScopeDiscoveryReleaseBinding }
  | { readonly ok: false; readonly reason: ScopeDiscoveryReleaseRejection };

interface ExactFileStat {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly uid: number;
  isFile(): boolean;
}

interface OpenedFileRead {
  readonly digest: string;
  readonly bytes?: Buffer;
}

function identityOf(stat: {
  readonly dev: number;
  readonly ino: number;
}): ScopeDiscoveryFileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(
  left: ScopeDiscoveryFileIdentity,
  right: ScopeDiscoveryFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function permissionMode(mode: number): number {
  return mode & 0o7777;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function isCommit(value: string): boolean {
  return /^[a-f0-9]{40}$/u.test(value);
}

function isSafeExactSize(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function normalizeTarget(
  target: ScopeDiscoveryReleaseTarget,
): ScopeDiscoveryReleaseTarget | undefined {
  if (
    !isAbsolute(target.hierarchyAnchor) ||
    !isAbsolute(target.trustedRoot) ||
    !isAbsolute(target.artifactPath) ||
    resolve(target.hierarchyAnchor) !== target.hierarchyAnchor ||
    resolve(target.trustedRoot) !== target.trustedRoot ||
    resolve(target.artifactPath) !== target.artifactPath ||
    !Number.isSafeInteger(target.expectedOwnerUid) ||
    target.expectedOwnerUid < 0 ||
    !isCommit(target.expectedMemoryCommit) ||
    !isSha256(target.expectedManifestSha256) ||
    !isSafeExactSize(
      target.expectedManifestSize,
      SCOPE_DISCOVERY_MAX_MANIFEST_BYTES,
    ) ||
    !isSha256(target.expectedArtifactSha256) ||
    !isSafeExactSize(
      target.expectedArtifactSize,
      SCOPE_DISCOVERY_MAX_ARTIFACT_BYTES,
    )
  ) {
    return undefined;
  }

  return Object.freeze({ ...target });
}

function managedDirectoryPaths(
  target: ScopeDiscoveryReleaseTarget,
  releaseDir: string,
): readonly string[] | undefined {
  const rootRelative = relative(target.hierarchyAnchor, target.trustedRoot);
  const releaseRelative = relative(target.hierarchyAnchor, releaseDir);
  if (
    !rootRelative ||
    rootRelative.startsWith("..") ||
    isAbsolute(rootRelative) ||
    !releaseRelative ||
    releaseRelative.startsWith("..") ||
    isAbsolute(releaseRelative) ||
    dirname(releaseDir) !== target.trustedRoot
  ) {
    return undefined;
  }

  const components = releaseRelative.split(sep).filter(Boolean);
  const paths = [target.hierarchyAnchor];
  let current = target.hierarchyAnchor;
  for (const component of components) {
    current = join(current, component);
    paths.push(current);
  }
  return paths;
}

function verifyManagedDirectories(
  paths: readonly string[],
  expectedOwnerUid: number,
):
  | {
      readonly ok: true;
      readonly directories: ScopeDiscoveryManagedDirectory[];
    }
  | { readonly ok: false; readonly reason: ScopeDiscoveryReleaseRejection } {
  const directories: ScopeDiscoveryManagedDirectory[] = [];
  for (const path of paths) {
    try {
      const stat = lstatSync(path);
      // lstat plus isDirectory rejects symlinks at every managed component.
      if (!stat.isDirectory()) {
        return { ok: false, reason: "release-directory-invalid" };
      }
      if (stat.uid !== expectedOwnerUid) {
        return { ok: false, reason: "release-owner-invalid" };
      }
      if ((stat.mode & 0o222) !== 0) {
        return { ok: false, reason: "release-directory-writable" };
      }
      if (permissionMode(stat.mode) !== TRUSTED_DIRECTORY_MODE) {
        return { ok: false, reason: "release-directory-invalid" };
      }
      directories.push({ path, identity: identityOf(stat) });
    } catch {
      return { ok: false, reason: "release-directory-invalid" };
    }
  }
  return { ok: true, directories };
}

function validateExactFileStat(
  stat: ExactFileStat,
  options: {
    readonly expectedOwnerUid: number;
    readonly expectedMode: number;
    readonly expectedSize: number;
    readonly invalidReason: ScopeDiscoveryReleaseRejection;
    readonly ownerReason: ScopeDiscoveryReleaseRejection;
    readonly modeReason: ScopeDiscoveryReleaseRejection;
    readonly sizeReason: ScopeDiscoveryReleaseRejection;
  },
): ScopeDiscoveryReleaseRejection | undefined {
  if (!stat.isFile()) return options.invalidReason;
  if (stat.uid !== options.expectedOwnerUid) return options.ownerReason;
  if (permissionMode(stat.mode) !== options.expectedMode) {
    return options.modeReason;
  }
  if (stat.size !== options.expectedSize) return options.sizeReason;
  return undefined;
}

/**
 * Open without following a final symlink, prove the opened identity and exact
 * pre-read size, then hash through a fixed-size buffer. Only the small manifest
 * is allocated at its already-capped exact size.
 */
function readAndHashExactFile(
  path: string,
  lstat: ExactFileStat,
  options: {
    readonly captureBytes: boolean;
    readonly expectedOwnerUid: number;
    readonly expectedMode: number;
    readonly expectedSize: number;
  },
): OpenedFileRead | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      !sameIdentity(identityOf(opened), identityOf(lstat)) ||
      opened.uid !== options.expectedOwnerUid ||
      permissionMode(opened.mode) !== options.expectedMode ||
      opened.size !== options.expectedSize
    ) {
      return undefined;
    }

    const hash = createHash("sha256");
    const captured = options.captureBytes
      ? Buffer.alloc(options.expectedSize)
      : undefined;
    const chunk = captured ?? Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let offset = 0;
    while (offset < options.expectedSize) {
      const bytesRead = readSync(
        fd,
        chunk,
        captured === undefined ? 0 : offset,
        Math.min(
          captured === undefined
            ? chunk.byteLength
            : options.expectedSize - offset,
          options.expectedSize - offset,
        ),
        null,
      );
      if (bytesRead === 0) return undefined;
      hash.update(
        captured === undefined
          ? chunk.subarray(0, bytesRead)
          : captured.subarray(offset, offset + bytesRead),
      );
      offset += bytesRead;
    }

    const extra = Buffer.allocUnsafe(1);
    if (readSync(fd, extra, 0, 1, null) !== 0) return undefined;
    return {
      digest: hash.digest("hex"),
      ...(captured === undefined ? {} : { bytes: captured }),
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Verify the immutable hierarchy and every pinned release fact. The production
 * anchor is root-owned and caller-non-writable, so pathname resolution cannot
 * be changed by the credential-bearing caller between this proof and spawn.
 */
export function verifyScopeDiscoveryRelease(
  configuredTarget: ScopeDiscoveryReleaseTarget = PRODUCTION_SCOPE_DISCOVERY_RELEASE,
): ScopeDiscoveryReleaseVerification {
  const target = normalizeTarget(configuredTarget);
  if (!target) return { ok: false, reason: "release-outside-root" };

  const artifactPath = target.artifactPath;
  const releaseDir = dirname(artifactPath);
  const directoryPaths = managedDirectoryPaths(target, releaseDir);
  if (!directoryPaths) {
    return { ok: false, reason: "release-outside-root" };
  }

  const managed = verifyManagedDirectories(
    directoryPaths,
    target.expectedOwnerUid,
  );
  if (!managed.ok) return managed;

  const manifestPath = join(
    releaseDir,
    SCOPE_DISCOVERY_RELEASE_MANIFEST_FILENAME,
  );
  let manifestStat: ExactFileStat;
  try {
    manifestStat = lstatSync(manifestPath);
  } catch {
    return { ok: false, reason: "manifest-invalid" };
  }
  const manifestStatRejection = validateExactFileStat(manifestStat, {
    expectedOwnerUid: target.expectedOwnerUid,
    expectedMode: TRUSTED_MANIFEST_MODE,
    expectedSize: target.expectedManifestSize,
    invalidReason: "manifest-invalid",
    ownerReason: "manifest-owner-invalid",
    modeReason: "manifest-mode-invalid",
    sizeReason: "manifest-size-mismatch",
  });
  if (manifestStatRejection) {
    return { ok: false, reason: manifestStatRejection };
  }

  const manifestRead = readAndHashExactFile(manifestPath, manifestStat, {
    captureBytes: true,
    expectedOwnerUid: target.expectedOwnerUid,
    expectedMode: TRUSTED_MANIFEST_MODE,
    expectedSize: target.expectedManifestSize,
  });
  if (!manifestRead?.bytes) {
    return { ok: false, reason: "manifest-replaced" };
  }
  if (manifestRead.digest !== target.expectedManifestSha256) {
    return { ok: false, reason: "manifest-digest-mismatch" };
  }

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(manifestRead.bytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "manifest-invalid" };
  }
  const decodedManifest = ReleaseManifestSchema.safeParse(parsedManifest);
  if (
    !decodedManifest.success ||
    decodedManifest.data.memoryCommit !== target.expectedMemoryCommit
  ) {
    return { ok: false, reason: "manifest-invalid" };
  }

  let artifactStat: ExactFileStat;
  try {
    artifactStat = lstatSync(artifactPath);
  } catch {
    return { ok: false, reason: "artifact-invalid" };
  }
  const artifactStatRejection = validateExactFileStat(artifactStat, {
    expectedOwnerUid: target.expectedOwnerUid,
    expectedMode: TRUSTED_ARTIFACT_MODE,
    expectedSize: target.expectedArtifactSize,
    invalidReason: "artifact-invalid",
    ownerReason: "artifact-owner-invalid",
    modeReason: "artifact-mode-invalid",
    sizeReason: "artifact-size-mismatch",
  });
  if (artifactStatRejection) {
    return { ok: false, reason: artifactStatRejection };
  }
  if ((artifactStat.mode & 0o111) !== 0o111) {
    return { ok: false, reason: "artifact-not-executable" };
  }

  const manifestArtifact = decodedManifest.data.artifacts.find(
    (artifact) =>
      artifact.path.split(/[\\/]/u).join(sep) === basename(artifactPath),
  );
  if (!manifestArtifact) {
    return { ok: false, reason: "artifact-unmanifested" };
  }
  if (manifestArtifact.kind !== "standalone") {
    return { ok: false, reason: "artifact-wrong-kind" };
  }
  if (manifestArtifact.sha256 !== target.expectedArtifactSha256) {
    return { ok: false, reason: "artifact-digest-mismatch" };
  }

  const artifactRead = readAndHashExactFile(artifactPath, artifactStat, {
    captureBytes: false,
    expectedOwnerUid: target.expectedOwnerUid,
    expectedMode: TRUSTED_ARTIFACT_MODE,
    expectedSize: target.expectedArtifactSize,
  });
  if (!artifactRead) return { ok: false, reason: "artifact-replaced" };
  if (artifactRead.digest !== target.expectedArtifactSha256) {
    return { ok: false, reason: "artifact-digest-mismatch" };
  }

  return {
    ok: true,
    binding: {
      target,
      releaseDir,
      manifestPath,
      artifactPath,
      managedDirectories: managed.directories,
      manifestIdentity: identityOf(manifestStat),
      artifactIdentity: identityOf(artifactStat),
      manifestSha256: manifestRead.digest,
      artifactSha256: artifactRead.digest,
    },
  };
}

/** Re-prove hierarchy, identity, exact modes/sizes, source, and bytes. */
export function reverifyScopeDiscoveryRelease(
  binding: ScopeDiscoveryReleaseBinding,
): ScopeDiscoveryReleaseVerification {
  const current = verifyScopeDiscoveryRelease(binding.target);
  if (!current.ok) return current;

  if (
    current.binding.managedDirectories.length !==
    binding.managedDirectories.length
  ) {
    return { ok: false, reason: "release-directory-invalid" };
  }
  for (let index = 0; index < binding.managedDirectories.length; index += 1) {
    const expected = binding.managedDirectories[index];
    const actual = current.binding.managedDirectories[index];
    if (
      expected === undefined ||
      actual === undefined ||
      expected.path !== actual.path ||
      !sameIdentity(expected.identity, actual.identity)
    ) {
      return { ok: false, reason: "release-directory-invalid" };
    }
  }
  if (
    !sameIdentity(binding.manifestIdentity, current.binding.manifestIdentity) ||
    binding.manifestSha256 !== current.binding.manifestSha256
  ) {
    return { ok: false, reason: "manifest-replaced" };
  }
  if (
    !sameIdentity(binding.artifactIdentity, current.binding.artifactIdentity) ||
    binding.artifactSha256 !== current.binding.artifactSha256
  ) {
    return { ok: false, reason: "artifact-replaced" };
  }

  return { ok: true, binding };
}
