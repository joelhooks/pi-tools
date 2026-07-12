import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendRecord, baseRecord, blobHash, ledgerPath, newChangeSetId, prepareMutation, type PendingMutation } from "./lib.ts";

export default function changeLedger(pi: ExtensionAPI) {
  const pending = new Map<string, PendingMutation>();
  let sessionId = "unknown";
  let changeSetId = newChangeSetId();
  let writeQueue = Promise.resolve();

  const enqueue = (record: Record<string, unknown>) => {
    writeQueue = writeQueue.then(() => appendRecord(record)).catch(() => {});
    return writeQueue;
  };

  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId() || ctx.sessionManager.getSessionFile() || "unknown";
  });

  pi.on("turn_start", () => {
    changeSetId = newChangeSetId();
    pending.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const mutation = await prepareMutation(ctx.cwd, event.toolName, event.toolCallId, event.input.path);
    if (mutation) pending.set(event.toolCallId, mutation);
  });

  pi.on("tool_result", async (event) => {
    if (event.isError) {
      pending.delete(event.toolCallId);
      return;
    }

    if (event.toolName === "bash") {
      await enqueue({
        ...baseRecord(sessionId, changeSetId),
        event: "bash-mutation-unattributed",
        operation: "bash",
        toolCallId: event.toolCallId,
        reason: "v1 does not parse command text or diff shell mutations",
      });
      return;
    }

    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const mutation = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (!mutation) return;

    const postBlobHash = await blobHash(mutation.repo.worktreePath, mutation.path);
    await enqueue({
      ...baseRecord(sessionId, changeSetId),
      event: "file-mutation",
      operation: mutation.operation,
      toolCallId: mutation.toolCallId,
      repo: mutation.repo,
      path: mutation.path,
      preBlobHash: mutation.preBlobHash,
      postBlobHash,
      commitStatus: "uncommitted",
    });
  });

  pi.registerCommand("change-ledger-path", {
    description: "Show today's append-only Pi change ledger path",
    handler: async (_args, ctx) => ctx.ui.notify(ledgerPath(), "info"),
  });
}
