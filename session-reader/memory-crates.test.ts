import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSessionRecallMcpServer } from "./mcp-server.ts";
import { createMemoryCrateRunner, MemoryCrateInputSchema } from "./memory-crates.ts";

const now = new Date("2026-09-08T12:00:00.000Z");
function fixture(run: (path: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "memory-crates-"));
  const path = join(root, "curated.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE metadata(key TEXT, value TEXT);
    INSERT INTO metadata VALUES ('schema_version','2'),('built_at','2026-09-05T12:00:00.000Z'),('coverage_gaps_json','[]');
    CREATE TABLE documents(stable_id TEXT, collection TEXT, type TEXT, title TEXT, content TEXT,
      source TEXT, path TEXT, privacy TEXT, source_updated_at INTEGER, created_at INTEGER, payload_json TEXT);`);
  const insert = db.prepare("INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const add = (id: string, overrides: { collection?: string; privacy?: string; date?: string | null; project?: string; content?: string } = {}) => {
    const source = `/fixture/.brain/projects/${overrides.project ?? id}/brief.svx`;
    insert.run(id, overrides.collection ?? "brain_pages", "project", `Idea ${id}`,
      overrides.content ?? `A useful fact about ${id}.`, source, source, overrides.privacy ?? "private",
      overrides.date === null ? null : now.getTime() / 1000, null,
      overrides.date === null ? "{}" : JSON.stringify({ created_at: overrides.date ?? "2026-05-01", status: "active" }));
  };
  add("old-a", { project: "busy", content: "A prototype. API_TOKEN=private-fixture-token" });
  add("old-b", { project: "busy" });
  add("recent", { date: "2026-09-08", privacy: "public" });
  add("yesterday", { date: "2026-09-07" });
  add("undated", { date: null });
  add("sensitive", { privacy: "sensitive" });
  add("unknown-privacy", { privacy: "" });
  add("raw", { collection: "sessions" });
  add("observation", { collection: "observations" });
  add("future", { date: "2027-01-01" });
  db.close();
  return run(path).finally(() => rmSync(root, { recursive: true, force: true }));
}
const signal = () => new AbortController().signal;
function input(value: Record<string, unknown> = {}) { return MemoryCrateInputSchema.parse(value); }
type Details = { items: Array<{id: string; title: string; excerpt: string; group: string; dateBasis: string; documentDate: string | null}>;
  nextExcludeIds: string[]; seed: string; hasMore: boolean; projection: {status: string}; window: {since: string}; };

test("crates enforce curated collections and privacy before selecting; reads leave DB unchanged", async () => fixture(async (path) => {
  const runner = createMemoryCrateRunner({ dbPath: path, now: () => now });
  const result = await runner(input({ limit: 20, seed: "test" }), signal());
  assert.equal(result.details.ok, true);
  const details = result.details as unknown as Details;
  assert.equal(details.items.length, 5);
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-token|Idea sensitive|Idea raw|Idea observation|Idea unknown-privacy|Idea future/);
  assert.equal(details.projection.status, "stale");
  assert.ok(details.items.some((i) => i.excerpt.includes("[REDACTED]")));
  assert.ok(details.items.find((i) => i.title === "Idea old-a")?.dateBasis === "frontmatter.created_at");
  const publicResult = await runner(input({ allowedPrivacy: ["public"] }), signal());
  assert.deepEqual((publicResult.details as unknown as Details).items.map((i) => i.title), ["Idea recent"]);
  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal(check.prepare("SELECT count(*) AS count FROM documents").get()?.count, 10);
  check.close();
}));

test("rolling and absolute windows filter actual document dates and reject invalid windows", async () => fixture(async (path) => {
  const runner = createMemoryCrateRunner({ dbPath: path, now: () => now });
  const recent = await runner(input({ mode: "recent", since: "24h" }), signal());
  assert.deepEqual((recent.details as unknown as Details).items.map((i) => i.title), ["Idea recent"]);
  assert.equal((recent.details as unknown as Details).window.since, "2026-09-07T12:00:00.000Z");
  const older = await runner(input({ mode: "older", olderThanDays: 90 }), signal());
  assert.equal((older.details as unknown as Details).items.length, 2);
  const absolute = await runner(input({ since: "2026-09-07", until: "2026-09-08" }), signal());
  assert.equal((absolute.details as unknown as Details).items.length, 2);
  assert.equal((await runner(input({ since: "2026-09-08", until: "2026-09-07" }), signal())).isError, true);
  assert.equal(MemoryCrateInputSchema.safeParse({ since: "last week" }).success, false);
  assert.equal(MemoryCrateInputSchema.safeParse({ since: "2026-02-30" }).success, false);
}));

test("seed and exclusions support distinct crates with project diversity", async () => fixture(async (path) => {
  const runner = createMemoryCrateRunner({ dbPath: path, now: () => now });
  const first = (await runner(input({ limit: 3, seed: "test" }), signal())).details as unknown as Details;
  const again = (await runner(input({ limit: 3, seed: "test" }), signal())).details as unknown as Details;
  assert.deepEqual(first.items, again.items);
  assert.equal(new Set(first.items.map((i) => i.group)).size, 3);
  const second = (await runner(input({ limit: 3, seed: first.seed, excludeIds: first.nextExcludeIds }), signal())).details as unknown as Details;
  assert.equal(second.items.length, 2);
  assert.equal(second.hasMore, false);
  assert.ok(second.items.every((i) => !first.items.some((j) => i.id === j.id)));
}));

test("missing source and cancellation fail closed with no local path or request echo", async () => {
  const runner = createMemoryCrateRunner({ dbPath: "/private-missing-fixture/curated.db" });
  const failed = await runner(input({ topic: "private-query" }), signal());
  assert.equal(failed.isError, true);
  assert.doesNotMatch(JSON.stringify(failed), /private-missing-fixture|private-query/);
  const abort = new AbortController(); abort.abort();
  assert.equal((await runner(input(), abort.signal)).details.code, "cancelled");
});

test("MCP discovers and executes browsing without recall, raw operations, or an evidence receipt", async () => fixture(async (path) => {
  const server = createSessionRecallMcpServer({ profile: "cloud",
    memoryCrateRunner: createMemoryCrateRunner({ dbPath: path, now: () => now }),
    runner: async () => { throw new Error("must not enter raw/recall runner"); },
  });
  const client = new Client({ name: "crate-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const listed = await client.listTools();
    assert.ok(listed.tools.find((t) => t.name === "browse_memory")?.annotations?.readOnlyHint);
    const result = await client.callTool({ name: "browse_memory", arguments: { since: "1w", limit: 2 } });
    assert.equal(result.isError, undefined);
    assert.doesNotMatch(JSON.stringify(result), /evidenceDrilldownReceipt/);
    const rejected = await client.callTool({ name: "browse_memory", arguments: { allowedPrivacy: ["sensitive"] } });
    assert.equal(rejected.isError, true);
  } finally { await client.close(); await server.close(); }
}));
