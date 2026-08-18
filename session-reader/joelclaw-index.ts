import { execFile } from "node:child_process";
import { Context, Effect, Layer, Schema } from "effect";
import { compactText, redactSecrets, redactUnknown, SessionReaderError } from "./domain.ts";

const MAX_BUFFER = 4 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const DETAIL_LIMIT = 4_000;

export const JoelclawEnvelopeSchema = Schema.Struct({
  ok: Schema.Boolean,
  command: Schema.String,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
  next_actions: Schema.optional(Schema.Unknown),
});
export interface JoelclawEnvelope extends Schema.Schema.Type<typeof JoelclawEnvelopeSchema> {}

export interface JoelclawResult {
  readonly ok: boolean;
  readonly command: string;
  readonly exitCode: number | null;
  readonly json: unknown;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface Interface {
  readonly run: (
    args: readonly string[],
    cwd: string,
  ) => Effect.Effect<JoelclawResult, SessionReaderError>;
}

export class JoelclawIndex extends Context.Service<JoelclawIndex, Interface>()(
  "@pi-tools/session-reader/JoelclawIndex",
) {}

function bound(value: string | undefined): string {
  if (!value) return "";
  return compactText(redactSecrets(value).text, DETAIL_LIMIT) ?? "";
}

const run = Effect.fn("JoelclawIndex.run")((args: readonly string[], cwd: string) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<JoelclawResult>((resolve) => {
        const command = ["joelclaw", ...args].join(" ");
        execFile(
          "joelclaw",
          [...args],
          {
            cwd,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER,
            timeout: TIMEOUT_MS,
            signal,
          },
          (error, stdout, stderr) => {
            let json: unknown = null;
            let parseError: string | undefined;
            if (stdout.trim()) {
              try {
                json = redactUnknown(JSON.parse(stdout));
              } catch (cause) {
                parseError = cause instanceof Error ? cause.message : String(cause);
              }
            }
            const exitCode =
              error && typeof error.code === "number" ? error.code : error ? null : 0;
            resolve({
              ok: !error && !parseError,
              command: bound(command),
              exitCode,
              json,
              stdout: bound(stdout),
              stderr: bound(stderr),
              error: bound(error?.message ?? parseError),
            });
          },
        );
      }),
    catch: (cause) =>
      new SessionReaderError({
        operation: "JoelclawIndex.run",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(
    Effect.flatMap((result) => {
      if (result.json === null) return Effect.succeed(result);
      return Schema.decodeUnknownEffect(JoelclawEnvelopeSchema)(result.json).pipe(
        Effect.map((json) => ({ ...result, json })),
        Effect.mapError(
          (cause) =>
            new SessionReaderError({
              operation: "JoelclawIndex.decodeEnvelope",
              message: cause.message,
              cause,
            }),
        ),
      );
    }),
  ),
);

export const JoelclawIndexLive = Layer.succeed(JoelclawIndex, JoelclawIndex.of({ run }));
