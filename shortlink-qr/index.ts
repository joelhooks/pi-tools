import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const QRCode = require("qrcode");

const DEFAULT_SHORTENER_DIR = "/Users/joel/Code/joelhooks/joel-dev-link-shortener";
const DEFAULT_REPO = "joelhooks/joel-dev-link-shortener";
const DEFAULT_BRANCH = "master";
const DEFAULT_BASE_URL = "https://joel.dev";

type Background = "transparent" | "white" | "black";

function text(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details };
}

function run(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: options.timeout ?? 30_000, cwd: options.cwd }).trim();
}

function runInherit(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) {
  const result = spawnSync(command, args, { stdio: "pipe", encoding: "utf8", timeout: options.timeout ?? 120_000, cwd: options.cwd });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout}`.trim());
  }
  return (result.stdout || "").trim();
}

function normalizeSlug(input: string) {
  const slug = input.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!/^[a-z0-9][a-z0-9\-/]*[a-z0-9]$/i.test(slug)) {
    throw new Error("slug must use letters, numbers, dashes, and optional slashes");
  }
  return slug;
}

function assertUrl(input: string) {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("url must start with http:// or https://");
  return url.toString();
}

function ensureShortenerRepo(dir: string, repo: string, branch: string, pull: boolean) {
  if (!pull) return;
  if (fs.existsSync(path.join(dir, ".git"))) {
    runInherit("git", ["pull", "--ff-only", "origin", branch], { cwd: dir, timeout: 120_000 });
    return;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  runInherit("git", ["clone", `https://github.com/${repo}`, dir], { timeout: 120_000 });
}

function upsertRedirect(shortenerDir: string, slug: string, targetUrl: string) {
  const redirectsPath = path.join(shortenerDir, "_redirects");
  const existing = fs.existsSync(redirectsPath) ? fs.readFileSync(redirectsPath, "utf8") : "/* https://joelhooks.com\n";
  const line = `/${slug}  ${targetUrl}`;
  const lines = existing.split("\n");
  const existingIndex = lines.findIndex((entry) => entry.trimStart().startsWith(`/${slug} `));
  if (existingIndex >= 0) lines[existingIndex] = line;
  else {
    const wildcardIndex = lines.findIndex((entry) => entry.trimStart().startsWith("/* "));
    lines.splice(wildcardIndex >= 0 ? wildcardIndex : lines.length, 0, line);
  }
  fs.writeFileSync(redirectsPath, lines.join("\n"));
  return redirectsPath;
}

function rectPath(x: number, y: number, w: number, h: number) {
  return `M${x.toFixed(3)} ${y.toFixed(3)}h${w.toFixed(3)}v${h.toFixed(3)}h${(-w).toFixed(3)}z`;
}

function rr(x: number, y: number, w: number, h: number, r: number, fill: string) {
  return `<rect x="${x.toFixed(3)}" y="${y.toFixed(3)}" width="${w.toFixed(3)}" height="${h.toFixed(3)}" rx="${r.toFixed(3)}" ry="${r.toFixed(3)}" fill="${fill}"/>`;
}

function writeRoundedSvg(url: string, outputSvg: string, size: number, background: Background) {
  const qr = QRCode.create(url, { errorCorrectionLevel: "H" });
  const moduleCount = qr.modules.size as number;
  const data = qr.modules.data as boolean[];
  const quiet = 2;
  const cell = size / (moduleCount + quiet * 2);
  const dark = background === "black" ? "#fff" : "#000";
  const bg = background === "transparent" ? "none" : background === "black" ? "#000" : "#fff";
  const finderZones = [[0, 0], [moduleCount - 7, 0], [0, moduleCount - 7]];
  const isDark = (x: number, y: number) => data[y * moduleCount + x];
  const inFinder = (x: number, y: number) => finderZones.some(([fx, fy]) => x >= fx - 1 && x <= fx + 7 && y >= fy - 1 && y <= fy + 7);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`, `<rect width="${size}" height="${size}" fill="${bg}"/>`];
  const inset = cell * 0.08;
  const moduleSize = cell - inset * 2;
  const moduleRadius = cell * 0.32;
  for (let y = 0; y < moduleCount; y++) for (let x = 0; x < moduleCount; x++) {
    if (isDark(x, y) && !inFinder(x, y)) parts.push(rr((x + quiet) * cell + inset, (y + quiet) * cell + inset, moduleSize, moduleSize, moduleRadius, dark));
  }
  for (const [fx, fy] of finderZones) {
    const x = (fx + quiet) * cell;
    const y = (fy + quiet) * cell;
    parts.push(`<path fill="${dark}" fill-rule="evenodd" d="${rectPath(x, y, cell * 7, cell * 7)} ${rectPath(x + cell, y + cell, cell * 5, cell * 5)}"/>`);
    parts.push(rr(x + cell * 2, y + cell * 2, cell * 3, cell * 3, cell * 0.08, dark));
  }
  parts.push("</svg>\n");
  fs.mkdirSync(path.dirname(outputSvg), { recursive: true });
  fs.writeFileSync(outputSvg, parts.join("\n"));
}

function renderPng(svgPath: string, pngPath: string) {
  runInherit("magick", ["-background", "none", svgPath, "-define", "png:color-type=6", pngPath], { timeout: 120_000 });
}

function copyPngToClipboard(pngPath: string) {
  runInherit("osascript", ["-e", `set the clipboard to (read (POSIX file "${path.resolve(pngPath)}") as «class PNGf»)`]);
}

function getBrainBaseUrl() {
  if (process.env.SHORTLINK_BRAIN_BASE_URL) return process.env.SHORTLINK_BRAIN_BASE_URL.replace(/\/$/, "");
  try {
    const url = run("portless", ["get", "pi-notes"], { timeout: 5_000 });
    if (url) return url.replace(/\/$/, "");
  } catch {}
  return undefined;
}

function updateBrainResource(cwd: string, entry: { slug: string; shortUrl: string; targetUrl: string; png: string; svg: string; background: Background; title?: string }) {
  const brainDir = path.join(cwd, ".brain", "resources");
  fs.mkdirSync(brainDir, { recursive: true });
  const notePath = path.join(brainDir, "shortlinks.svx");
  const now = new Date().toISOString().slice(0, 10);
  const title = entry.title ?? entry.slug;
  const block = `\n## ${title}\n\n- Date: ${now}\n- Slug: \`/${entry.slug}\`\n- Shortlink: [${entry.shortUrl}](${entry.shortUrl})\n- Target: [${entry.targetUrl}](${entry.targetUrl})\n- QR PNG (${entry.background}): \`${entry.png}\`\n- QR SVG: \`${entry.svg}\`\n`;
  if (!fs.existsSync(notePath)) {
    fs.writeFileSync(notePath, `# Shortlinks\n\nReusable shortlinks and QR codes generated for this project.\n\nUse this as the canonical local resource list for talk/demo links.\n${block}`);
  } else {
    const current = fs.readFileSync(notePath, "utf8");
    const marker = `- Slug: \`/${entry.slug}\``;
    if (current.includes(marker)) {
      const lines = current.split("\n");
      const idx = lines.findIndex((line) => line === marker);
      let start = idx;
      while (start > 0 && !lines[start].startsWith("## ")) start--;
      let end = idx + 1;
      while (end < lines.length && !lines[end].startsWith("## ")) end++;
      lines.splice(start, end - start, ...block.trimStart().trimEnd().split("\n"));
      fs.writeFileSync(notePath, lines.join("\n") + "\n");
    } else fs.appendFileSync(notePath, block);
  }
  const base = getBrainBaseUrl();
  return { notePath, noteUrl: base ? `${base}/notes/resources/shortlinks` : undefined };
}

async function createShortlinkQr(params: {
  slug: string;
  url: string;
  title?: string;
  size?: number;
  background?: Background;
  out_dir?: string;
  shortener_dir?: string;
  repo?: string;
  branch?: string;
  pull?: boolean;
  push?: boolean;
  clipboard?: boolean;
  update_brain?: boolean;
}, cwd: string) {
  const slug = normalizeSlug(params.slug);
  const targetUrl = assertUrl(params.url);
  const size = params.size ?? 1500;
  const background = params.background ?? "transparent";
  const outDir = path.resolve(cwd, params.out_dir ?? "resources/qr");
  const repo = params.repo ?? DEFAULT_REPO;
  const branch = params.branch ?? DEFAULT_BRANCH;
  const shortenerDir = params.shortener_dir ?? DEFAULT_SHORTENER_DIR;
  const shortUrl = `${DEFAULT_BASE_URL}/${slug}`;
  const label = `joel-dev-${slug.replace(/\//g, "-")}-rounded-${size}-${background}`;
  const svg = path.join(outDir, `${label}.svg`);
  const png = path.join(outDir, `${label}.png`);

  ensureShortenerRepo(shortenerDir, repo, branch, params.pull ?? true);
  const redirectsPath = upsertRedirect(shortenerDir, slug, targetUrl);
  writeRoundedSvg(shortUrl, svg, size, background);
  renderPng(svg, png);
  if (params.clipboard ?? true) copyPngToClipboard(png);

  let commitUrl: string | undefined;
  if (params.push ?? false) {
    const output = runInherit("shitrat", ["commit-file", repo, "--branch", branch, "--message", `Add ${slug} shortlink`, "--file", redirectsPath], { cwd: shortenerDir, timeout: 120_000 });
    const match = output.match(/"html_url":\s*"([^"]+)"/);
    commitUrl = match?.[1];
    runInherit("git", ["fetch", "origin", branch], { cwd: shortenerDir });
    runInherit("git", ["reset", "--hard", `origin/${branch}`], { cwd: shortenerDir });
  }

  let brain: { notePath: string; noteUrl?: string } | undefined;
  if (params.update_brain ?? true) {
    brain = updateBrainResource(cwd, {
      slug,
      shortUrl,
      targetUrl,
      png: path.relative(cwd, png),
      svg: path.relative(cwd, svg),
      background,
      title: params.title,
    });
  }

  return { slug, shortUrl, targetUrl, png, svg, background, size, copiedToClipboard: params.clipboard ?? true, pushed: params.push ?? false, commitUrl, brain };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "shortlink_qr",
    label: "Shortlink QR",
    description: "Create/update a joel.dev shortlink, generate a native HiDPI QR PNG/SVG, copy it to clipboard, push via ShitRat, and record it in the local Brain shortlinks resource list.",
    parameters: Type.Object({
      slug: Type.String({ description: "Readable joel.dev slug without leading slash, e.g. cascadia-viv" }),
      url: Type.String({ description: "Target URL to redirect to" }),
      title: Type.Optional(Type.String({ description: "Human title for the Brain resource list" })),
      size: Type.Optional(Type.Number({ description: "PNG/SVG size in pixels. Default 1500" })),
      background: Type.Optional(Type.Union([Type.Literal("transparent"), Type.Literal("white"), Type.Literal("black")], { description: "QR background. black produces white code. Default transparent" })),
      out_dir: Type.Optional(Type.String({ description: "Output directory relative to cwd. Default resources/qr" })),
      push: Type.Optional(Type.Boolean({ description: "Commit _redirects to GitHub as shitratgit[bot]. Default false" })),
      clipboard: Type.Optional(Type.Boolean({ description: "Copy PNG to macOS clipboard. Default true" })),
      update_brain: Type.Optional(Type.Boolean({ description: "Append/update .brain/resources/shortlinks.svx. Default true" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await createShortlinkQr(params, process.cwd());
        const lines = [
          `Shortlink: ${result.shortUrl}`,
          `Target: ${result.targetUrl}`,
          `PNG: ${path.relative(process.cwd(), result.png)}`,
          `SVG: ${path.relative(process.cwd(), result.svg)}`,
          `Background: ${result.background}`,
          `Copied to clipboard: ${result.copiedToClipboard ? "yes" : "no"}`,
          `Pushed: ${result.pushed ? "yes" : "no"}`,
        ];
        if (result.commitUrl) lines.push(`Commit: ${result.commitUrl}`);
        if (result.brain) {
          lines.push(`Brain resource: ${path.relative(process.cwd(), result.brain.notePath)}`);
          if (result.brain.noteUrl) lines.push(`Brain URL: ${result.brain.noteUrl}`);
        }
        return text(lines.join("\n"), result);
      } catch (error: any) {
        return text(`shortlink_qr failed: ${error.message ?? String(error)}`);
      }
    },
  });

  pi.registerCommand("shortlink-qr", {
    description: "Create a joel.dev shortlink QR. Usage: /shortlink-qr <slug> <url>",
    handler: async (args, ctx) => {
      const [slug, url] = String(args).trim().split(/\s+/, 2);
      if (!slug || !url) {
        ctx.ui.notify("Usage: /shortlink-qr <slug> <url>", "warning");
        return;
      }
      try {
        const result = await createShortlinkQr({ slug, url, push: true, clipboard: true }, process.cwd());
        ctx.ui.notify(`Copied QR for ${result.shortUrl}`, "info");
      } catch (error: any) {
        ctx.ui.notify(`shortlink-qr failed: ${error.message ?? String(error)}`, "error");
      }
    },
  });
}
