import { execFile } from "node:child_process";
import { appendFile, mkdir, realpath } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const exec = promisify(execFile);

export type RepoIdentity = {
  remote: string;
  worktreePath: string;
  head: string;
};

export type PendingMutation = {
  operation: "write" | "edit";
  toolCallId: string;
  absolutePath: string;
  path: string;
  repo: RepoIdentity;
  preBlobHash: string | null;
};

export function stateDirectory(): string {
  return process.env.PI_CHANGE_LEDGER_STATE_DIR || join(homedir(), ".local", "state", "joelclaw", "change-ledger");
}

export function ledgerPath(timestamp = new Date()): string {
  return join(stateDirectory(), `${timestamp.toISOString().slice(0, 10)}.jsonl`);
}

export async function appendRecord(record: Record<string, unknown>, path = ledgerPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

export function canonicalRemote(value: string): string {
  const trimmed = value.trim();
  const scp = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scp && !trimmed.includes("://")) {
    return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`;
  }
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    return `${url.hostname.toLowerCase()}/${path}`;
  } catch {
    return trimmed.replace(/\.git$/, "").replace(/\/$/, "");
  }
}

export async function repoIdentity(cwd: string): Promise<RepoIdentity | null> {
  try {
    const root = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
    let remote: string;
    try {
      remote = canonicalRemote(await git(root, ["remote", "get-url", "origin"]));
    } catch {
      remote = `file://${root}`;
    }
    let head = "UNBORN";
    try {
      head = await git(root, ["rev-parse", "HEAD"]);
    } catch {}
    return { remote, worktreePath: root, head };
  } catch {
    return null;
  }
}

export async function blobHash(repoRoot: string, path: string): Promise<string | null> {
  try {
    return await git(repoRoot, ["hash-object", "--", path]);
  } catch {
    return null;
  }
}

export async function prepareMutation(
  cwd: string,
  operation: "write" | "edit",
  toolCallId: string,
  suppliedPath: unknown,
): Promise<PendingMutation | null> {
  if (typeof suppliedPath !== "string" || !suppliedPath.trim()) return null;
  const unresolvedPath = resolve(cwd, suppliedPath);
  const absolutePath = await realpath(unresolvedPath).catch(async () =>
    join(await realpath(dirname(unresolvedPath)), basename(unresolvedPath))
  );
  const repo = await repoIdentity(absolutePath).catch(() => null) ?? await repoIdentity(dirname(absolutePath));
  if (!repo) return null;
  const canonicalPath = relative(repo.worktreePath, absolutePath).replaceAll("\\", "/");
  if (canonicalPath === ".." || canonicalPath.startsWith("../") || isAbsolute(canonicalPath)) return null;
  return {
    operation,
    toolCallId,
    absolutePath,
    path: canonicalPath || ".",
    repo,
    preBlobHash: await blobHash(repo.worktreePath, canonicalPath),
  };
}

export function newChangeSetId(now = Date.now()): string {
  return `${now.toString(36).padStart(10, "0")}${randomBytes(10).toString("hex")}`.toUpperCase();
}

export function baseRecord(sessionId: string, changeSetId: string, timestamp = new Date()): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runtime: "pi",
    sessionId,
    runId: sessionId,
    machineId: hostname(),
    changeSetId,
    timestamp: timestamp.toISOString(),
  };
}
