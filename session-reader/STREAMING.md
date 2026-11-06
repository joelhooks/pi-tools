# Bounded JSONL readers

Evidence tools fully decode JSONL records up to **2 MiB**, including ordinary compaction summaries and large reads. Larger records remain searchable through a **256 KiB raw prefix**. They are not dropped wholesale.

## Two tiers

| Constant | Default | Environment override |
| --- | ---: | --- |
| `MAX_JSONL_LINE_BYTES` | 2 MiB | `SESSION_READER_JSONL_DECODE_BYTES` |
| `JSONL_PREFIX_BYTES` | 256 KiB | `SESSION_READER_JSONL_PREFIX_BYTES` |

Overrides are positive safe integer byte counts up to 64 MiB, read at module load. The prefix must not exceed the decode cap. If only the decode cap is lowered, the default prefix shrinks to fit it. Invalid values or an invalid pair produce one warning per module load, without echoing the values, and restore both defaults. They do not prevent the tools from loading. Restart the reader to apply changes. RSS measurements below use the defaults.

`jsonl.ts` scans 64 KiB chunks with one reusable read buffer and one decode-cap buffer. Reusing the read buffer avoids accumulating external chunk allocations between garbage collections. It records byte offsets and physical line numbers. When a line exceeds the decode cap, the scanner discards its remainder but retains its first prefix-cap bytes. The same limits apply to unterminated final lines.

`jsonl-entry.ts` decodes complete and partial JSON string values from that prefix, including JSON escapes. It keeps existing children of incomplete containers, ignores unfinished keys, and trims incomplete trailing string escapes. It does not invent missing transcript text. Prefix parsing has a 64-level nesting bound and redacts sensitive keys before flattening, including unfinished secret values inside serialized tool-result strings. Primitives that touch the prefix edge are dropped because they may be incomplete; delimited primitives survive. If JSON prefix parsing fails, plain text or malformed JSON falls back to its redacted raw prefix, with complete-value and unfinished-secret redaction applied before flattening.

**Matches past the retained prefix may be missed.** Such records carry `truncated: true` on their evidence items and a visible `[truncated prefix]` marker. The overall result also reports truncation. Its notice states the retained prefix and full-decode cap and warns that later matches may be missed; it does not call the whole file unreadable or claim all oversized records were skipped. Search includes a scanned-file truncation count even when no file matches. A search that stops early cannot report truncation in unvisited lines.

Compaction `summary` text fields now participate in flattening; native boolean summary metadata does not become transcript text. This intentionally corrects another evidence gap: the old recognized-field list could select `type` without including its sibling summary.

## Retained state

- **Inspect/chunks:** the first eight matching windows. The before-window ring holds only detached 600-character evidence previews, never full line texts. Internal windows cap each side at 200 entries; the existing tool limits remain 50 before and 200 after. Matching uses the full decoded line or retained prefix, not the preview.
- **Context:** four preceding full flattened texts, a ten-entry look-ahead counter, capped category evidence lists, and at most 80 file references. At the default cap, the four preceding texts retain at most roughly 8 MiB of UTF-8 content; UTF-16 string storage can be larger. The no-hit fallback classifies only the first 80 entries.
- **Search:** matched query terms and at most three detached 320-character snippets per file. It stops once its maximum score and three snippets are available. Prefix snippets include their physical line number and truncation marker. Files at or below 64 MiB run in groups of up to eight. Larger files and unknown-size/native locators run alone, never alongside a small-file group. This preserves parallel small-store latency without multiplying decode-heavy retention across eight files.
- **Expansion:** one requested page plus a backward tail, each capped at 40 previews. Entry-index cursors still reach the end of large transcripts. Page readers convert entries to evidence once; the engine does not apply `evidence()` again.

Preview, snippet, and file-reference strings are copied so V8 sliced strings cannot pin multi-MiB parents. Parsed object prefixes pass directly to flattening instead of being serialized and parsed again. Prefix redaction reuses unchanged subtrees and reports changes by identity, without serializing both versions for comparison. Flattening joins leaf text once instead of copying a payload at every object level. Already-normalized ASCII spaces avoid a replacement allocation per word. Search reuses one case-folded string for scoring and direct matching, and already-lowercase ASCII text avoids case-conversion allocation entirely. These changes preserve whitespace and UTF-16 preview semantics, including surrogate boundaries.

Inspection collects bounded windows during one scan rather than retaining a file-sized hit index or seeking back into changing files. Inspect/context continue through EOF for redaction, late evidence, and truncation reporting. Raw parsed JSON objects are discarded. XState still owns lifecycle; Effect passes cancellation to the scanner's AbortSignal. Early return, errors, and cancellation close the file descriptor. Cancellation is checked before and after each bounded read; an in-flight filesystem read finishes before the descriptor closes.

## Semantics and routing

For fully decoded LF/CRLF records, matching, ordering, eight-match limits, overlapping windows, blank-line handling, category caps, redaction, and physical line numbers retain their existing meanings. Tests compare streamed results with the domain functions using Pi, Claude, and Codex shapes, including large compaction summaries and matches beyond 256 KiB. Expansion tests compare both preview text and actor-rendered pages with the original slice-and-evidence path.

Oversized prefix records remain entries: they count toward before/after windows, extraction `lineCount`, and expansion cursors. Blank lines do not. Surviving records always keep their original physical line numbers. LF is the delimiter, with an optional trailing CR stripped; bare CR is not a JSONL delimiter.

Streaming routing requires a `.jsonl` path and excludes native Cursor/OpenCode locators. Grok's JSONL files use the scanner; Grok non-JSONL files and unknown non-JSONL paths keep the previous adapter/fallback path. Isolated-home tests cover both Grok and unknown fallback routing.

Cursor behavior is unchanged from before this work: all blobs remain eligible, exporter `maxBuffer` is 128 MiB, and metadata uses its previous read path. Cursor is not covered by the JSONL RSS guarantee. `readRedactedTail` honors its caller's `maxBytes`; capture-health callers still request 64 KiB, but that is not a new hard ceiling.

## Legacy reads and caller audit

`readJsonlTranscript` aliases `readBoundedJsonl`. Its legacy return is limited to 2 MiB of flattened text or 2,000 entries. It carries `truncated: true` plus an explicit `truncationReason` when that prefix limit is reached. Per-record prefix truncation is also reported.

All remaining production call paths are:

1. `jsonlAdapter.read` calls `readJsonlTranscript`; `readSessionFile` also calls it for an unknown adapter. Both return the truncation fields intact.
2. `SessionStore.readTranscript` calls `readSessionFile` and validates the full transcript schema, including those fields. No engine operation calls this whole-transcript service method anymore.
3. Non-JSONL `SessionStore.inspect` / `extract` fall back through `readSessionFile`; the domain results propagate truncation and its reason into rendered text/details.
4. Non-JSONL `SessionStore.readPage` falls back through `readSessionFile`, retains the flags/reason, and returns previews. Expansion renders the notice and exposes the flag/reason in details.
5. Non-JSONL `scanSessionFile` calls `adapter.read`; it reports truncation in hit snippets/flags and increments the scanned-file truncation count even for no-hit files.

Proven JSONL inspect, context, chunks, search, and expansion use streaming paths instead of the legacy prefix. External callers of the adapter transcript API must honor its truncation fields. Tests explicitly cover direct legacy reads and the fallback tools, so a bounded prefix cannot appear as a complete result.

## Checks and measurements

```sh
npm run typecheck
npm --prefix session-reader test

# Both fixtures are synthetic and removed after the run.
SESSION_READER_LARGE_TEST=1 node --test session-reader/streaming.test.ts

# Optional unbounded readline/entry-array control, using the current parser.
# Allow about 9 GiB free RAM for its 2 GiB fixture.
SESSION_READER_LARGE_TEST=1 SESSION_READER_BENCH_BASELINE=1 \
  node --test session-reader/streaming.test.ts
```

Set `SESSION_READER_TEST_TMPDIR` to an existing disposable disk directory when the OS temp directory is memory-backed. Each fixture directory is created and removed by its owning test. No real session stores are read.

Round 3 measurements use fresh Node 24.22.1 processes on macOS at `nice -n 10`. The worker's 12 GiB V8 heap ceiling is unchanged between modes; it is not the RSS limit. `process.resourceUsage().maxRSS` is recorded in KiB and includes startup/imports. Wall and process CPU times exclude fixture generation and process startup. Inspect uses the normal 20-before/80-after defaults; expansion reads one backward page of ten entries. Context is the extraction path. Hit assertions inspect actual results, not a query echoed in a header. All new modes assert RSS under 300 MiB and answer size under 24,000 bytes. Measurement assertions run after all operations for a fixture so one failure does not hide later results.

- **Eight small files:** 1,229,592 bytes total, 256 ordinary records per file plus a final searchable record. Each implementation runs five times in one worker; reported wall time is the median. The before control uses eight-way readline search with the current parser and discovery. The after measurement runs the full Search actor, including discovery, validation, and presentation, so this is not an isolated IO comparison.
- **Eight heavy files:** 570,380,440 bytes total. Each file exceeds 64 MiB and has 34 mixed-case near-cap records plus a final searchable record. The full Search actor must find all eight hits.
- **Decode-heavy fixture:** 269,847,791 bytes: 128 mixed-case records just under the 2 MiB decode cap, four 350 KiB compaction summaries, and a final searchable record. JSON.parse, flattening, and redaction run on the complete records. No records are prefix-truncated.
- **Oversized fixture:** 2,149,619,329 bytes: 205 records with 10 MiB payloads, small interleaved records, and a final searchable record. Each large record contributes its searchable prefix.

| Fixture | Operation | Peak RSS | Wall time | Process CPU | Answer |
| --- | --- | ---: | ---: | ---: | ---: |
| Eight small files | Before, eight-way readline | 156.6 MiB (160,384 KiB) | 0.028 s median | 0.037 s/run | 1,742 bytes |
| Eight small files | After, Search actor | 161.3 MiB (165,136 KiB) | 0.030 s median | 0.043 s/run | 1,867 bytes |
| Eight heavy files | Search actor | 267.5 MiB (273,952 KiB) | 10.412 s | 10.670 s | 1,867 bytes |
| Decode-heavy | Inspect | 258.7 MiB (264,912 KiB) | 4.884 s | 4.972 s | 7,975 bytes |
| Decode-heavy | Search | 280.9 MiB (287,616 KiB) | 4.989 s | 5.034 s | 235 bytes |
| Decode-heavy | Context | 265.0 MiB (271,328 KiB) | 8.205 s | 8.343 s | 3,088 bytes |
| Decode-heavy | Expand, one page | 267.8 MiB (274,224 KiB) | 4.695 s | 4.831 s | 5,963 bytes |
| 2 GiB oversized | Inspect | 160.0 MiB (163,888 KiB) | 2.749 s | 2.806 s | 5,040 bytes |
| 2 GiB oversized | Search | 159.5 MiB (163,360 KiB) | 2.810 s | 2.874 s | 408 bytes |
| 2 GiB oversized | Context | 166.6 MiB (170,624 KiB) | 3.177 s | 3.259 s | 2,181 bytes |
| 2 GiB oversized | Expand, one page | 159.5 MiB (163,296 KiB) | 2.776 s | 2.813 s | 3,399 bytes |

Small-store medians differ by 2 ms, or about 7%, with the after path including full actor overhead. Both retain eight-way parallelism. Samples were 37/29/28/26/27 ms before and 41/30/33/30/29 ms after. This is a small absolute difference, not evidence of identical latency.

The first round 3 macOS opt-in run failed three RSS assertions: heavy-file Search reached 334,592 KiB (326.8 MiB), near-cap inspect reached 332,400 KiB (324.6 MiB), and oversized search reached 311,376 KiB (304.1 MiB). Its fail-fast assertions prevented the remaining modes from running. Reusing the scanner's read buffer and removing prefix serialization addressed the allocation churn. Final verification ran every benchmark mode against retained synthetic fixtures with the same hit, truncation, answer-size, and unchanged 300 MiB RSS assertions; all 11 measurements passed. Every measured mode found the final searchable record, and the heavy Search actor found all eight. Decode-heavy results report no prefix truncation; oversized results report it. All generated fixtures were removed after verification. CPU can exceed wall time because process CPU includes concurrent runtime/GC threads.

For historical comparison, the original unbounded reader's earlier Linux run used the same 2 GiB fixture shape: inspect peaked at 8,430,328 KiB in 49.185 s; search peaked at 802,136 KiB in 50.894 s. These are historical results on a different OS, not a matched macOS before/after comparison. The optional control worker uses the optimized current parser while reproducing the old unbounded IO/retention algorithm, so its timings need not match that history. A separate initial baseline with a single uninterrupted 10 MiB token was stopped in the old redaction regexes; fixtures use word-delimited payloads to measure reader behavior instead.

Real-transcript measurements remain a separate read-only check by the source owner. No real transcripts are copied, rewritten, trimmed, or included in tests.
