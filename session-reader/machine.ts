import { Effect } from "effect";
import { assign, createActor, fromPromise, setup, toPromise, type SnapshotFrom } from "xstate";
import { operationProgram, type SessionOperation } from "./engine.ts";
import type { ToolPayload } from "./presenter.ts";

interface MachineInput {
  readonly operation: SessionOperation;
}

interface MachineContext {
  readonly input: MachineInput;
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
  readonly result?: ToolPayload;
  readonly error?: unknown;
}

type MachineEvent = { readonly type: "CANCEL" };

export type MachineOutcome =
  | { readonly status: "succeeded"; readonly result: ToolPayload }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "cancelled" };

const effectOperation = fromPromise<ToolPayload, MachineInput>(({ input, signal }) =>
  Effect.runPromise(operationProgram(input.operation), { signal }),
);

const machineSetup = setup({
  types: {} as {
    readonly context: MachineContext;
    readonly input: MachineInput;
    readonly events: MachineEvent;
    readonly output: MachineOutcome;
  },
  actors: { effectOperation },
  guards: {
    isRecall: ({ context }) => context.input.operation._tag === "Recall",
    isSearch: ({ context }) => context.input.operation._tag === "Search",
    isInspect: ({ context }) => context.input.operation._tag === "Inspect",
    isExtract: ({ context }) => context.input.operation._tag === "Extract",
    isExpand: ({ context }) => context.input.operation._tag === "Expand",
    isChunks: ({ context }) => context.input.operation._tag === "Chunks",
    isCapture: ({ context }) => context.input.operation._tag === "Capture",
  },
});

export const sessionReaderMachine = machineSetup.createMachine({
  id: "sessionReader",
  initial: "dispatching",
  context: ({ input }) => ({ input, status: "running" }),
  states: {
    dispatching: {
      always: [
        { guard: "isRecall", target: "recalling" },
        { guard: "isSearch", target: "searching" },
        { guard: "isInspect", target: "inspecting" },
        { guard: "isExtract", target: "extracting" },
        { guard: "isExpand", target: "expanding" },
        { guard: "isChunks", target: "chunking" },
        { guard: "isCapture", target: "checkingCapture" },
        {
          target: "failed",
          actions: assign({
            status: () => "failed" as const,
            error: () => new Error("Unknown session reader operation"),
          }),
        },
      ],
      on: {
        CANCEL: {
          target: "cancelled",
          actions: assign({ status: () => "cancelled" as const }),
        },
      },
    },
    recalling: {
      invoke: {
        src: "effectOperation",
        input: ({ context }) => context.input,
        onDone: {
          target: "succeeded",
          actions: assign({
            status: () => "succeeded" as const,
            result: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({ status: () => "failed" as const, error: ({ event }) => event.error }),
        },
      },
      on: {
        CANCEL: { target: "cancelled", actions: assign({ status: () => "cancelled" as const }) },
      },
    },
    searching: {
      invoke: {
        src: "effectOperation",
        input: ({ context }) => context.input,
        onDone: {
          target: "succeeded",
          actions: assign({
            status: () => "succeeded" as const,
            result: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({ status: () => "failed" as const, error: ({ event }) => event.error }),
        },
      },
      on: {
        CANCEL: { target: "cancelled", actions: assign({ status: () => "cancelled" as const }) },
      },
    },
    inspecting: {
      invoke: {
        src: "effectOperation",
        input: ({ context }) => context.input,
        onDone: {
          target: "succeeded",
          actions: assign({
            status: () => "succeeded" as const,
            result: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({ status: () => "failed" as const, error: ({ event }) => event.error }),
        },
      },
      on: {
        CANCEL: { target: "cancelled", actions: assign({ status: () => "cancelled" as const }) },
      },
    },
    extracting: {
      invoke: {
        src: "effectOperation",
        input: ({ context }) => context.input,
        onDone: {
          target: "succeeded",
          actions: assign({
            status: () => "succeeded" as const,
            result: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({ status: () => "failed" as const, error: ({ event }) => event.error }),
        },
      },
      on: {
        CANCEL: { target: "cancelled", actions: assign({ status: () => "cancelled" as const }) },
      },
    },
    expanding: {
      invoke: {
        src: "effectOperation",
        input: ({ context }) => context.input,
        onDone: {
          target: "succeeded",
          actions: assign({
            status: () => "succeeded" as const,
            result: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({ status: () => "failed" as const, error: ({ event }) => event.error }),
        },
      },
      on: {
        CANCEL: { target: "cancelled", actions: assign({ status: () => "cancelled" as const }) },
      },
    },
    chunking: {
      invoke: {
        src: "effectOperation",
        input: ({ context }) => context.input,
        onDone: {
          target: "succeeded",
          actions: assign({
            status: () => "succeeded" as const,
            result: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({ status: () => "failed" as const, error: ({ event }) => event.error }),
        },
      },
      on: {
        CANCEL: { target: "cancelled", actions: assign({ status: () => "cancelled" as const }) },
      },
    },
    checkingCapture: {
      invoke: {
        src: "effectOperation",
        input: ({ context }) => context.input,
        onDone: {
          target: "succeeded",
          actions: assign({
            status: () => "succeeded" as const,
            result: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({ status: () => "failed" as const, error: ({ event }) => event.error }),
        },
      },
      on: {
        CANCEL: { target: "cancelled", actions: assign({ status: () => "cancelled" as const }) },
      },
    },
    succeeded: { type: "final" },
    failed: { type: "final" },
    cancelled: { type: "final" },
  },
  output: ({ context }): MachineOutcome => {
    if (context.status === "succeeded" && context.result) {
      return { status: "succeeded", result: context.result };
    }
    if (context.status === "cancelled") return { status: "cancelled" };
    return { status: "failed", error: context.error };
  },
});

export type SessionReaderSnapshot = SnapshotFrom<typeof sessionReaderMachine>;

export async function runSessionActor(
  operation: SessionOperation,
  signal: AbortSignal,
  onSnapshot?: (snapshot: SessionReaderSnapshot) => void,
): Promise<MachineOutcome> {
  const actor = createActor(sessionReaderMachine, { input: { operation } });
  const subscription = actor.subscribe((snapshot) => onSnapshot?.(snapshot));
  const cancel = () => actor.send({ type: "CANCEL" });
  signal.addEventListener("abort", cancel, { once: true });

  try {
    actor.start();
    if (signal.aborted) actor.send({ type: "CANCEL" });
    return await toPromise(actor);
  } finally {
    signal.removeEventListener("abort", cancel);
    subscription.unsubscribe();
    actor.stop();
  }
}
