#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { appendRecord, baseRecord, ledgerPath, repoIdentity } from "../lib.ts";

function usage(): never {
  console.error("usage: attribute-commit.ts <repo> <commit-sha> [ledger.jsonl ...] [--output path]");
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length < 3) usage();
const repoPath = resolve(args.shift()!);
const requestedSha = args.shift()!;
let output = ledgerPath();
const outputIndex = args.indexOf("--output");
if (outputIndex >= 0) {
  output = resolve(args[outputIndex + 1] || usage());
  args.splice(outputIndex, 2);
}
const ledgerPaths = args.map((path) => resolve(path));
if (ledgerPaths.length === 0) usage();

function git(...gitArgs: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...gitArgs], { encoding: "utf8" }).trim();
}

const repo = await repoIdentity(repoPath);
if (!repo) throw new Error(`${repoPath} is not a git repository`);
const sha = git("rev-parse", `${requestedSha}^{commit}`);
const parent = (() => { try { return git("rev-parse", `${sha}^`); } catch { return null; } })();
const commitTimestamp = new Date(Number(git("show", "-s", "--format=%ct", sha)) * 1000).toISOString();
const changedPaths = git("diff-tree", "--root", "--no-commit-id", "--name-only", "-r", sha).split("\n").filter(Boolean);
const tree = new Map<string, string>();
for (const line of git("ls-tree", "-r", sha).split("\n").filter(Boolean)) {
  const match = line.match(/^\d+ blob ([0-9a-f]+)\t(.*)$/);
  if (match) tree.set(match[2], match[1]);
}

const records: any[] = [];
for (const path of ledgerPaths) {
  const text = await readFile(path, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.event === "file-mutation") records.push(record);
  }
}

const matchedPaths: Array<{ path: string; blobHash: string; changeSetIds: string[]; sessionIds: string[] }> = [];
const unattributedPaths: Array<{ path: string; blobHash: string | null; reason?: string; candidateCount?: number }> = [];
const allChangeSetIds = new Set<string>();
const allSessionIds = new Set<string>();

for (const path of changedPaths) {
  const blobHash = tree.get(path) ?? null;
  const matches = blobHash ? records.filter((record) =>
    record.repo?.remote === repo.remote && record.path === path && record.postBlobHash === blobHash
  ) : [];
  const identities = new Set(matches.map((record) => `${record.sessionId}\0${record.changeSetId}`));
  if (!matches.length || !blobHash || identities.size !== 1) {
    unattributedPaths.push({
      path,
      blobHash,
      ...(identities.size > 1 ? { reason: "ambiguous-identical-blob", candidateCount: identities.size } : {}),
    });
    continue;
  }
  const changeSetIds = [...new Set(matches.map((record) => String(record.changeSetId)))].sort();
  const sessionIds = [...new Set(matches.map((record) => String(record.sessionId)))].sort();
  changeSetIds.forEach((id) => allChangeSetIds.add(id));
  sessionIds.forEach((id) => allSessionIds.add(id));
  matchedPaths.push({ path, blobHash, changeSetIds, sessionIds });
}

const event = {
  ...baseRecord("commit-attributor", `commit:${sha}`),
  event: "commit-attribution",
  repo,
  sha,
  parent,
  commitTimestamp,
  changeSetIds: [...allChangeSetIds].sort(),
  contributingSessionIds: [...allSessionIds].sort(),
  matchedPaths,
  unattributedPaths,
  sourceLedgers: ledgerPaths,
};
await appendRecord(event, output);
console.log(JSON.stringify({ output, ...event }, null, 2));
