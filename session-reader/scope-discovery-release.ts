import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
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
export const PINNED_SCOPE_DISCOVERY_ARTIFACT_SHA256 =
  "62922264b9f27df3ad9c18c095dabf3dd55477859522739ee396b7de78b3b6cf";
export const PINNED_SCOPE_DISCOVERY_RELEASE_NAME = "20260827-05d92ead-scope-v1";
export const SCOPE_DISCOVERY_TRUSTED_RELEASE_ROOT = join(
  homedir(),
  ".joelclaw",
  "flowing-memory",
  "releases",
);
export const PINNED_SCOPE_DISCOVERY_EXECUTABLE = join(
  SCOPE_DISCOVERY_TRUSTED_RELEASE_ROOT,
  PINNED_SCOPE_DISCOVERY_RELEASE_NAME,
  "joelclaw-memory",
);

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

export interface ScopeDiscoveryReleaseTarget {
  readonly trustedRoot: string;
  readonly artifactPath: string;
  readonly expectedMemoryCommit: string;
  readonly expectedArtifactSha256: string;
}

export const PRODUCTION_SCOPE_DISCOVERY_RELEASE: ScopeDiscoveryReleaseTarget = {
  trustedRoot: SCOPE_DISCOVERY_TRUSTED_RELEASE_ROOT,
  artifactPath: PINNED_SCOPE_DISCOVERY_EXECUTABLE,
  expectedMemoryCommit: PINNED_SCOPE_DISCOVERY_MEMORY_COMMIT,
  expectedArtifactSha256: PINNED_SCOPE_DISCOVERY_ARTIFACT_SHA256,
};

export interface ScopeDiscoveryFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface ScopeDiscoveryReleaseBinding {
  readonly releaseDir: string;
  readonly manifestPath: string;
  readonly artifactPath: string;
  readonly releaseDirIdentity: ScopeDiscoveryFileIdentity;
  readonly manifestIdentity: ScopeDiscoveryFileIdentity;
  readonly artifactIdentity: ScopeDiscoveryFileIdentity;
  readonly manifestSha256: string;
  readonly sha256: string;
  readonly expectedSha256: string;
}

export type ScopeDiscoveryReleaseRejection =
  | "release-unavailable"
  | "release-outside-root"
  | "release-directory-invalid"
  | "release-directory-writable"
  | "manifest-invalid"
  | "manifest-writable"
  | "manifest-replaced"
  | "artifact-invalid"
  | "artifact-writable"
  | "artifact-not-executable"
  | "artifact-unmanifested"
  | "artifact-wrong-kind"
  | "artifact-digest-mismatch"
  | "artifact-replaced";

export type ScopeDiscoveryReleaseVerification =
  | { readonly ok: true; readonly binding: ScopeDiscoveryReleaseBinding }
  | { readonly ok: false; readonly reason: ScopeDiscoveryReleaseRejection };

function identityOf(stat: { readonly dev: number; readonly ino: number }) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(
  left: ScopeDiscoveryFileIdentity,
  right: ScopeDiscoveryFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isWritable(mode: number): boolean {
  return (mode & 0o222) !== 0;
}

function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Bind the one production path to its sealed directory, strict v2 manifest,
 * pinned semantic source commit, and consumer-anchored standalone digest.
 */
export function verifyScopeDiscoveryRelease(
  target: ScopeDiscoveryReleaseTarget = PRODUCTION_SCOPE_DISCOVERY_RELEASE,
): ScopeDiscoveryReleaseVerification {
  let root: string;
  let artifactPath: string;
  try {
    root = realpathSync(target.trustedRoot);
    artifactPath = realpathSync(target.artifactPath);
  } catch {
    return { ok: false, reason: "release-unavailable" };
  }

  // Production names the exact release. Permit a platform-level realpath for
  // the trusted root (macOS maps /var to /private/var), but refuse a release or
  // artifact path that resolves somewhere other than the same relative name
  // beneath that root.
  const configuredRoot = resolve(target.trustedRoot);
  const configuredArtifact = resolve(target.artifactPath);
  const configuredRelative = relative(configuredRoot, configuredArtifact);
  if (
    !configuredRelative ||
    configuredRelative.startsWith("..") ||
    isAbsolute(configuredRelative) ||
    artifactPath !== resolve(root, configuredRelative)
  ) {
    return { ok: false, reason: "release-outside-root" };
  }

  const artifactRelative = relative(root, artifactPath);
  if (
    !artifactRelative ||
    artifactRelative.startsWith("..") ||
    isAbsolute(artifactRelative)
  ) {
    return { ok: false, reason: "release-outside-root" };
  }

  const releaseDir = dirname(artifactPath);
  if (dirname(releaseDir) !== root) {
    return { ok: false, reason: "release-outside-root" };
  }

  let releaseDirIdentity: ScopeDiscoveryFileIdentity;
  try {
    const stat = lstatSync(releaseDir);
    if (!stat.isDirectory()) {
      return { ok: false, reason: "release-directory-invalid" };
    }
    if (isWritable(stat.mode)) {
      return { ok: false, reason: "release-directory-writable" };
    }
    releaseDirIdentity = identityOf(stat);
  } catch {
    return { ok: false, reason: "release-directory-invalid" };
  }

  const manifestPath = join(
    releaseDir,
    SCOPE_DISCOVERY_RELEASE_MANIFEST_FILENAME,
  );
  let manifestIdentity: ScopeDiscoveryFileIdentity;
  let manifestSha256: string;
  let parsedManifest: unknown;
  try {
    const stat = lstatSync(manifestPath);
    if (!stat.isFile()) return { ok: false, reason: "manifest-invalid" };
    if (isWritable(stat.mode)) {
      return { ok: false, reason: "manifest-writable" };
    }
    manifestIdentity = identityOf(stat);
    const manifestBytes = readFileSync(manifestPath);
    manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    parsedManifest = JSON.parse(manifestBytes.toString("utf8"));
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

  let artifactIdentity: ScopeDiscoveryFileIdentity;
  try {
    const stat = lstatSync(artifactPath);
    if (!stat.isFile()) return { ok: false, reason: "artifact-invalid" };
    if (isWritable(stat.mode)) {
      return { ok: false, reason: "artifact-writable" };
    }
    if (!isExecutable(stat.mode)) {
      return { ok: false, reason: "artifact-not-executable" };
    }
    artifactIdentity = identityOf(stat);
  } catch {
    return { ok: false, reason: "artifact-invalid" };
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

  let digest: string;
  try {
    digest = sha256File(artifactPath);
  } catch {
    return { ok: false, reason: "artifact-invalid" };
  }
  if (
    digest !== manifestArtifact.sha256 ||
    digest !== target.expectedArtifactSha256
  ) {
    return { ok: false, reason: "artifact-digest-mismatch" };
  }

  return {
    ok: true,
    binding: {
      releaseDir,
      manifestPath,
      artifactPath,
      releaseDirIdentity,
      manifestIdentity,
      artifactIdentity,
      manifestSha256,
      sha256: digest,
      expectedSha256: target.expectedArtifactSha256,
    },
  };
}

/** Re-prove identity, mode, kind, and anchored bytes before a privileged step. */
export function reverifyScopeDiscoveryRelease(
  binding: ScopeDiscoveryReleaseBinding,
): ScopeDiscoveryReleaseVerification {
  const targets = [
    {
      path: binding.releaseDir,
      identity: binding.releaseDirIdentity,
      directory: true,
      writableReason: "release-directory-writable" as const,
      replacedReason: "release-directory-invalid" as const,
    },
    {
      path: binding.manifestPath,
      identity: binding.manifestIdentity,
      directory: false,
      writableReason: "manifest-writable" as const,
      replacedReason: "manifest-replaced" as const,
    },
    {
      path: binding.artifactPath,
      identity: binding.artifactIdentity,
      directory: false,
      writableReason: "artifact-writable" as const,
      replacedReason: "artifact-replaced" as const,
    },
  ];

  for (const target of targets) {
    try {
      const stat = lstatSync(target.path);
      const rightKind = target.directory ? stat.isDirectory() : stat.isFile();
      if (!rightKind || !sameIdentity(identityOf(stat), target.identity)) {
        return { ok: false, reason: target.replacedReason };
      }
      if (isWritable(stat.mode)) {
        return { ok: false, reason: target.writableReason };
      }
      if (target.path === binding.artifactPath && !isExecutable(stat.mode)) {
        return { ok: false, reason: "artifact-not-executable" };
      }
    } catch {
      return { ok: false, reason: target.replacedReason };
    }
  }

  try {
    if (sha256File(binding.manifestPath) !== binding.manifestSha256) {
      return { ok: false, reason: "manifest-replaced" };
    }
    const digest = sha256File(binding.artifactPath);
    if (digest !== binding.sha256 || digest !== binding.expectedSha256) {
      return { ok: false, reason: "artifact-digest-mismatch" };
    }
  } catch {
    return { ok: false, reason: "artifact-invalid" };
  }

  return { ok: true, binding };
}
