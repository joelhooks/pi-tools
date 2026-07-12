import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import changeLedger from "./index.ts";
import { canonicalRemote } from "./lib.ts";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "change-ledger-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "remote", "add", "origin", "https://example.com/test/repo.git");
  await writeFile(join(root, "file.txt"), "before\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "base");
  return root;
}

function harness(cwd: string) {
  const handlers = new Map<string, Function[]>();
  const pi = {
    on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) || []), fn]); },
    registerCommand() {},
  } as any;
  changeLedger(pi);
  const ctx = { cwd, sessionManager: { getSessionId: () => "session-a", getSessionFile: () => undefined } };
  const emit = async (name: string, event: any = {}) => {
    for (const fn of handlers.get(name) || []) await fn(event, ctx);
  };
  return { emit };
}

async function records(path: string) {
  try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch { return []; }
}

describe.serial("Pi change ledger", () => {
  test("records pre/post hashes and keeps successful edits uncommitted", async () => {
    const root = await fixture();
    const state = join(root, "state");
    process.env.PI_CHANGE_LEDGER_STATE_DIR = state;
    const ledger = join(state, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const { emit } = harness(root);
    await emit("session_start");
    await emit("turn_start");
    await emit("tool_call", { toolName: "edit", toolCallId: "call-1", input: { path: "file.txt" } });
    await writeFile(join(root, "file.txt"), "after\n");
    await emit("tool_result", { toolName: "edit", toolCallId: "call-1", isError: false });
    const [record] = await records(ledger);
    expect(record.preBlobHash).toBe(git(root, "rev-parse", "HEAD:file.txt"));
    expect(record.postBlobHash).toBe(git(root, "hash-object", "file.txt"));
    expect(record.commitStatus).toBe("uncommitted");
    expect(record.runId).toBe("session-a");
    expect(record.path).toBe("file.txt");
  });

  test("does not record failed tool results", async () => {
    const root = await fixture();
    const state = join(root, "state");
    process.env.PI_CHANGE_LEDGER_STATE_DIR = state;
    const ledger = join(state, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const { emit } = harness(root);
    await emit("session_start"); await emit("turn_start");
    await emit("tool_call", { toolName: "write", toolCallId: "failed", input: { path: "file.txt" } });
    await emit("tool_result", { toolName: "write", toolCallId: "failed", isError: true });
    expect(await records(ledger)).toHaveLength(0);
  });

  test("commit attribution uses blob equality and rejects a second session's different blob", async () => {
    const root = await fixture();
    await writeFile(join(root, "file.txt"), "committed\n");
    const committedBlob = git(root, "hash-object", "file.txt");
    git(root, "add", "file.txt"); git(root, "commit", "-qm", "change");
    const sha = git(root, "rev-parse", "HEAD");
    const ledgerA = join(root, "a.jsonl");
    const ledgerB = join(root, "b.jsonl");
    const common = { schemaVersion: 1, runtime: "pi", event: "file-mutation", repo: { remote: "example.com/test/repo", worktreePath: root }, path: "file.txt" };
    await writeFile(ledgerA, JSON.stringify({ ...common, sessionId: "session-a", changeSetId: "set-a", postBlobHash: committedBlob }) + "\n");
    await writeFile(ledgerB, JSON.stringify({ ...common, sessionId: "session-b", changeSetId: "set-b", postBlobHash: "0000000000000000000000000000000000000000" }) + "\n");
    const output = join(root, "attribution.jsonl");
    execFileSync("bun", [join(import.meta.dir, "scripts/attribute-commit.ts"), root, sha, ledgerA, ledgerB, "--output", output]);
    const [event] = await records(output);
    expect(event.contributingSessionIds).toEqual(["session-a"]);
    expect(event.changeSetIds).toEqual(["set-a"]);
    expect(event.unattributedPaths).toEqual([]);
  });

  test("identical blobs from distinct sessions remain explicitly unattributed", async () => {
    const root = await fixture();
    await writeFile(join(root, "file.txt"), "same bytes\n");
    const blob = git(root, "hash-object", "file.txt");
    git(root, "add", "file.txt"); git(root, "commit", "-qm", "ambiguous");
    const common = { event: "file-mutation", repo: { remote: "example.com/test/repo" }, path: "file.txt", postBlobHash: blob };
    const a = join(root, "same-a.jsonl"); const b = join(root, "same-b.jsonl");
    await writeFile(a, JSON.stringify({ ...common, sessionId: "a", changeSetId: "a" }) + "\n");
    await writeFile(b, JSON.stringify({ ...common, sessionId: "b", changeSetId: "b" }) + "\n");
    const output = join(root, "ambiguous.jsonl");
    execFileSync("bun", [join(import.meta.dir, "scripts/attribute-commit.ts"), root, "HEAD", a, b, "--output", output]);
    const [event] = await records(output);
    expect(event.matchedPaths).toEqual([]);
    expect(event.contributingSessionIds).toEqual([]);
    expect(event.unattributedPaths[0].reason).toBe("ambiguous-identical-blob");
  });

  test("canonicalizes HTTPS and SCP remotes to one identity", () => {
    expect(canonicalRemote("https://github.com/owner/repo.git")).toBe("github.com/owner/repo");
    expect(canonicalRemote("git@github.com:owner/repo.git")).toBe("github.com/owner/repo");
  });
});
