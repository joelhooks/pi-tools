---
name: shortlink-qr
description: Create joel.dev shortlinks and QR assets. Use when Joel asks for a QR code, stage/demo shortlink, joel.dev redirect, link label that looks good in phone camera UI, or a copyable QR asset.
---

# shortlink-qr

Use when Joel asks for a QR code, stage/demo shortlink, joel.dev redirect, link label that looks good in phone camera UI, or a copyable QR asset.

## Default workflow

Prefer the Pi tool when available:

```ts
shortlink_qr({
  slug: "cascadia-example",
  url: "https://example.com/source",
  title: "Example source",
  push: true,
  background: "transparent"
})
```

The tool should:

1. Add/update `/<slug>  <target-url>` in `/Users/joel/Code/joelhooks/joel-dev-link-shortener/_redirects`.
2. Generate native HiDPI QR assets from vector source, not by upscaling a tiny PNG.
3. Default to a 1500×1500 PNG plus matching SVG in `resources/qr/`.
4. Copy the PNG to the macOS clipboard unless `clipboard: false`.
5. With `push: true`, commit the shortener change as `shitratgit[bot]`, then fetch/reset the shortener checkout to `origin/master`.
6. Add/update `.brain/resources/shortlinks.svx` as the local project Brain resource list.
7. Return the shortlink, target URL, QR paths, commit URL, Brain file path, and local Brain URL when available through portless/pi-notes.

## Background variants

Use `background` intentionally:

- `transparent` — default for slides and design tools.
- `white` — black QR on white background when transparency renders poorly.
- `black` — white QR on black background for dark slides.

Example:

```ts
shortlink_qr({
  slug: "cascadia-dark-demo",
  url: "https://example.com",
  push: true,
  background: "black"
})
```

## Why shortlinks

Phone camera UIs usually show the encoded URL/domain, not a custom QR label. Encode a friendly `https://joel.dev/<slug>` URL so the scanner display is readable.

## Brain resource rule

Every generated shortlink belongs in the local project Brain as a resource list entry at:

```text
.brain/resources/shortlinks.svx
```

This gives Joel a local pi-notes/portless review page for easy copy/paste of:

- short URL
- target URL
- PNG path
- SVG path
- background style

When a local Document Host is running, include the clickable Brain URL in the final answer. The extension tries `portless get pi-notes` and maps the note to:

```text
<pi-notes-url>/notes/resources/shortlinks
```

## Fallbacks

If Netlify deploy is stale or shortlink routing is suspect, generate a direct raw-URL QR for stage safety and say so. Do not silently hand Joel a QR that depends on an unverified redirect.

If ShitRat cannot access the shortener repo, do not push with Joel's identity. Return the local file changes and ask for the missing ShitRat/auth step.
