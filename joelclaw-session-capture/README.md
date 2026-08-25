# Retired Codex Central capture plugin

This package is a compatibility and archive surface for the retired Codex Stop-hook that posted transcript deltas directly to Central.

It is **not** the current capture owner and must not be installed. Current Codex capture belongs to the same `joelclaw` flowing-memory host release family used by the other runtime adapters. Until that hook is installed and canaried, operators must report Codex capture as unavailable rather than activating this second path.

## Preserved evidence

The old writer, installer, and plugin manifest were moved to a private operator archive with a metadata-only hash manifest. They are not published from this repository and must not be executed against live configuration.

The non-mutating doctor remains at:

```bash
node joelclaw-session-capture/scripts/doctor-codex-session-capture.js
```

Its output describes **legacy Central capture diagnostics**, not current flowing-memory delivery or native transcript adapter health. Native transcripts remain immutable evidence and are read through the Effect/XState session reader.
