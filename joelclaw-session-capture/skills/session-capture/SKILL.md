---
name: session-capture
description: Historical pointer for the retired Codex-to-Central capture plugin. Use only to inspect legacy state during migration; current capture belongs to the joelclaw flowing-memory host adapter.
---

# Retired Codex Central capture

Do not install or reactivate this plugin. Its writer, installer, and manifest are preserved in a private operator archive with metadata-only hash receipts; they are not published from this repository.

Current rules:

- Native Codex transcripts remain immutable evidence.
- The Effect/XState session reader owns local transcript discovery, not capture transport.
- Current semantic capture must use the single-owner `joelclaw` flowing-memory host release.
- If that hook is absent or unproved, report typed unavailability.
- Never advance offsets, replay an outbox, or move legacy files merely to make a doctor green.

The remaining doctor is read-only legacy diagnostics:

```bash
node joelclaw-session-capture/scripts/doctor-codex-session-capture.js
```
