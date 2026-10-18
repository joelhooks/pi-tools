import { StringDecoder } from "node:string_decoder";

// Each pipe retains raw overlap AND its masks. This catches overlapping matches
// without letting masking destroy a later match or deletion join secret pieces.
export function secretPatterns(values: string[]): Buffer[] {
  const patterns = new Set<string>();
  for (const value of values) {
    const url = encodeURIComponent(value);
    for (const variant of [value, url, url.replace(/%[0-9A-F]{2}/g, (s) => s.toLowerCase()),
      url.replace(/%20/g, "+"), new URLSearchParams({ v: value }).toString().slice(2),
      JSON.stringify(value).slice(1, -1), Buffer.from(value).toString("base64"),
      Buffer.from(value).toString("base64").replace(/=+$/, ""), Buffer.from(value).toString("base64url")]) {
      if (variant) patterns.add(variant);
    }
  }
  return [...patterns].map((value) => Buffer.from(value));
}

export function redactingPipe(patterns: Buffer[], emit: (output: string) => void) {
  const overlap = patterns.reduce((longest, pattern) => Math.max(longest, pattern.length), 1) - 1;
  let pending = Buffer.alloc(0);
  let masks = Buffer.alloc(0);
  const decoder = new StringDecoder("utf8");
  function flush(chunk: Buffer, final: boolean) {
    const raw = Buffer.concat([pending, chunk]);
    const marked = Buffer.concat([masks, Buffer.alloc(chunk.length)]);
    for (const pattern of patterns) {
      let start = raw.indexOf(pattern);
      while (start !== -1) {
        marked.fill(1, start, start + pattern.length);
        start = raw.indexOf(pattern, start + 1);
      }
    }
    const end = final ? raw.length : Math.max(0, raw.length - overlap);
    const safe = Buffer.from(raw.subarray(0, end));
    for (let i = 0; i < end; i++) if (marked[i]) safe[i] = 42; // equal-length '*'
    emit(decoder.write(safe));
    pending = Buffer.from(raw.subarray(end));
    masks = Buffer.from(marked.subarray(end));
    if (final) emit(decoder.end());
  }
  return { write: (chunk: Buffer) => flush(chunk, false), end: () => flush(Buffer.alloc(0), true) };
}
