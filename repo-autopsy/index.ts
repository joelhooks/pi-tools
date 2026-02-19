import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AUTOPSY_DIR = join(homedir(), ".repo-autopsy");
const CACHE_TTL_MS = 5 * 60 * 1000;
const lastFetchTime = new Map<string, number>();

function parseRepoUrl(input: string): { owner: string; repo: string; httpsUrl: string; sshUrl: string } | null {
  let owner: string, repo: string;
  if (input.includes("git@")) {
    const match = input.match(/git@github\.com:([^\/]+)\/(.+?)(?:\.git)?$/);
    if (!match) return null;
    [, owner, repo] = match;
  } else {
    const match = input.match(/(?:(?:https?:\/\/)?github\.com\/)?([^\/]+)\/([^\/\s]+)/i);
    if (!match) return null;
    [, owner, repo] = match;
    repo = repo.replace(/\.git$/, "");
  }
  return {
    owner,
    repo,
    httpsUrl: `https://github.com/${owner}/${repo}.git`,
    sshUrl: `git@github.com:${owner}/${repo}.git`,
  };
}

function sh(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch (e: any) {
    return e.stdout?.trim() || e.message || "command failed";
  }
}

function gitClone(url: string, dest: string): boolean {
  const out = sh(`git clone --depth 100 ${url} ${dest}`);
  return existsSync(join(dest, ".git"));
}

function ensureRepo(repoInput: string, forceRefresh = false): { path: string; owner: string; repo: string; cached: boolean } | string {
  const parsed = parseRepoUrl(repoInput);
  if (!parsed) return "Invalid repo format. Use: owner/repo or GitHub URL";
  const { owner, repo, httpsUrl, sshUrl } = parsed;
  const repoPath = join(AUTOPSY_DIR, owner, repo);
  const cacheKey = `${owner}/${repo}`;

  sh(`mkdir -p ${join(AUTOPSY_DIR, owner)}`);

  if (existsSync(repoPath)) {
    const lastFetch = lastFetchTime.get(cacheKey) || 0;
    if (!forceRefresh && Date.now() - lastFetch < CACHE_TTL_MS) {
      return { path: repoPath, owner, repo, cached: true };
    }
    sh(`git fetch --all --prune`, repoPath);
    sh(`git reset --hard origin/HEAD`, repoPath);
    lastFetchTime.set(cacheKey, Date.now());
  } else {
    // Try HTTPS first (works for public repos without auth), fall back to SSH
    if (!gitClone(httpsUrl, repoPath)) {
      sh(`rm -rf ${repoPath}`);
      if (!gitClone(sshUrl, repoPath)) {
        sh(`rm -rf ${repoPath}`);
        return `Failed to clone ${owner}/${repo} via HTTPS or SSH`;
      }
    }
    lastFetchTime.set(cacheKey, Date.now());
  }
  return { path: repoPath, owner, repo, cached: false };
}

function truncate(s: string, max = 50000): string {
  return s.length > max ? s.slice(0, max) + "\n\n... (truncated)" : s;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }], details: {} };
}

export default function (pi: ExtensionAPI) {
  // Clone / update a repo
  pi.registerTool({
    name: "repo_clone",
    label: "Repo: Clone",
    description: "Clone/update a GitHub repo locally for deep analysis. Returns local path and basic stats.",
    parameters: Type.Object({
      repo: Type.String({ description: "GitHub repo (owner/repo or full URL)" }),
      refresh: Type.Optional(Type.Boolean({ description: "Force refresh even if cached" })),
    }),
    async execute(_id, params) {
      const result = ensureRepo(params.repo, params.refresh);
      if (typeof result === "string") return text(result);
      const status = result.cached ? "📦 cached" : "🔄 fetched";
      const fileCount = sh(`find ${result.path} -type f -not -path '*/.git/*' | wc -l`);
      const langs = sh(`find ${result.path} -type f -not -path '*/.git/*' | sed 's/.*\\.//' | sort | uniq -c | sort -rn | head -10`);
      return text(`✓ ${result.owner}/${result.repo} ready at: ${result.path} (${status})\n\nFiles: ${fileCount}\n\nTop extensions:\n${langs}\n\nUse repo_structure, repo_search, repo_deps, repo_hotspots, repo_file, repo_ast, repo_blame, repo_stats, repo_exports, repo_find`);
    },
  });

  // Directory structure
  pi.registerTool({
    name: "repo_structure",
    label: "Repo: Structure",
    description: "Get directory tree of a cloned repo",
    parameters: Type.Object({
      repo: Type.String({ description: "GitHub repo (owner/repo or URL)" }),
      path: Type.Optional(Type.String({ description: "Subpath to explore" })),
      depth: Type.Optional(Type.Number({ description: "Max depth (default: 4)" })),
    }),
    async execute(_id, params) {
      const result = ensureRepo(params.repo);
      if (typeof result === "string") return text(result);
      const target = params.path ? join(result.path, params.path) : result.path;
      const d = params.depth || 4;
      const out = sh(`tree -L ${d} --dirsfirst -I '.git|node_modules|__pycache__|.venv|dist|build|.next' ${target} 2>/dev/null || find ${target} -maxdepth ${d} -not -path '*/.git/*' -not -path '*/node_modules/*' | head -200`);
      return text(out);
    },
  });

  // Ripgrep search
  pi.registerTool({
    name: "repo_search",
    label: "Repo: Search",
    description: "Ripgrep search in a cloned repo — full regex power",
    parameters: Type.Object({
      repo: Type.String({ description: "GitHub repo (owner/repo or URL)" }),
      pattern: Type.String({ description: "Regex pattern to search" }),
      glob: Type.Optional(Type.String({ description: "File glob filter (e.g., '*.ts')" })),
      context: Type.Optional(Type.Number({ description: "Lines of context (default: 2)" })),
      max: Type.Optional(Type.Number({ description: "Max results (default: 50)" })),
    }),
    async execute(_id, params) {
      const result = ensureRepo(params.repo);
      if (typeof result === "string") return text(result);
      const g = params.glob ? `--glob '${params.glob}'` : "";
      const c = params.context ?? 2;
      const m = params.max ?? 50;
      const out = sh(`rg '${params.pattern}' ${result.path} -C ${c} ${g} --max-count ${m} -n --color never 2>/dev/null | head -500`);
      return text(truncate(out || "No matches found"));
    },
  });

  // AST-grep
  pi.registerTool({
    name: "repo_ast",
    label: "Repo: AST Search",
    description: "AST-grep structural code search in a cloned repo",
    parameters: Type.Object({
      repo: Type.String({ description: "GitHub repo (owner/repo or URL)" }),
      pattern: Type.String({ description: "ast-grep pattern (e.g., 'function $NAME($$$ARGS) { $$$BODY }')" }),
      lang: Type.Optional(Type.String({ description: "Language: ts, tsx, js, py, go, rust" })),
    }),
    async execute(_id, params) {
      const result = ensureRepo(params.repo);
      if (typeof result === "string") return text(result);
      const l = params.lang ? `--lang ${params.lang}` : "";
      const out = sh(`ast-grep --pattern '${params.pattern}' ${l} ${result.path} 2>/dev/null | head -200`);
      return text(truncate(out || "No matches found"));
    },
  });

  // Dependency analysis
  pi.registerTool({
    name: "repo_deps",
    label: "Repo: Dependencies",
    description: "Analyze dependencies (package.json, requirements.txt, go.mod, Cargo.toml)",
    parameters: Type.Object({
      repo: Type.String({ description: "GitHub repo (owner/repo or URL)" }),
    }),
    async execute(_id, params) {
      const result = ensureRepo(params.repo);
      if (typeof result === "string") return text(result);
      const outputs: string[] = [];

      const pkgPath = join(result.path, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(sh(`cat ${pkgPath}`));
          const deps = Object.keys(pkg.dependencies || {});
          const dev = Object.keys(pkg.devDependencies || {});
          outputs.push(`## Node.js (package.json)\nDependencies (${deps.length}): ${deps.slice(0, 25).join(", ")}${deps.length > 25 ? " ..." : ""}\nDevDependencies (${dev.length}): ${dev.slice(0, 20).join(", ")}${dev.length > 20 ? " ..." : ""}`);
        } catch {}
      }
      for (const [file, label] of [["requirements.txt", "Python"], ["go.mod", "Go"], ["Cargo.toml", "Rust"], ["pyproject.toml", "Python"]]) {
        const p = join(result.path, file);
        if (existsSync(p)) outputs.push(`## ${label} (${file})\n${sh(`head -60 ${p}`)}`);
      }
      return text(outputs.join("\n\n") || "No dependency files found");
    },
  });

  // Hotspots
  pi.registerTool({
    name: "repo_hotspots",
    label: "Repo: Hotspots",
    description: "Find code hotspots — most changed files, largest files, TODOs, recent commits",
    parameters: Type.Object({
      repo: Type.String({ description: "GitHub repo (owner/repo or URL)" }),
    }),
    async execute(_id, params) {
      const result = ensureRepo(params.repo);
      if (typeof result === "string") return text(result);
      const churn = sh(`git -C ${result.path} log --oneline --name-only --pretty=format: | sort | uniq -c | sort -rn | grep -v '^$' | head -15`);
      const largest = sh(`find ${result.path} -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -exec wc -l {} + 2>/dev/null | sort -rn | head -15`);
      const todos = sh(`rg -c 'TODO|FIXME|HACK|XXX' ${result.path} --glob '!.git' 2>/dev/null | sort -t: -k2 -rn | head -10`);
      const recent = sh(`git -C ${result.path} log --oneline -20`);
      const parts: string[] = [];
      if (churn) parts.push(`## Most Changed Files\n${churn}`);
      if (largest) parts.push(`## Largest Files\n${largest}`);
      if (todos) parts.push(`## TODOs/FIXMEs\n${todos}`);
      if (recent) parts.push(`## Recent Commits\n${recent}`);
      return text(truncate(parts.join("\n\n")));
    },
  });

  // Read file
  pi.registerTool({
    name: "repo_file",
    label: "Repo: Read File",
    description: "Read a file from a cloned repo with optional line range",
    parameters: Type.Object({
      repo: Type.String({ description: "GitHub repo (owner/repo or URL)" }),
      path: Type.String({ description: "File path within repo" }),
      start: Type.Optional(Type.Number({ description: "Start line (1-indexed)" })),
      end: Type.Optional(Type.Number({ description: "End line" })),
    }),
    async execute(_id, params) {
      const result = ensureRepo(params.repo);
      if (typeof result === "string") return text(result);
      const filePath = join(result.path, params.path);
      if (!existsSync(filePath)) return text(`File not found: ${params.path}`);
      if (params.start || params.end) {
        const s = params.start || 1;
        const e = params.end || 99999;
        return text(sh(`sed -n '${s},${e}p' ${filePath}`));
      }
      return text(truncate(sh(`cat ${filePath}`)));
    },
  });

  // Git blame
  pi.registerTool({
    name: "repo_blame",
    label: "Repo: Blame",
    description: "Git blame for a file — who wrote what",
    parameters: Type.Object({
      repo: Type.String({ description: "GitHub repo (owner/repo or URL)" }),
      path: Type.String({ description: "File path within repo" }),
      start: Type.Optional(Type.Number({ description: "Start line" })),
      end: Type.Optional(Type.Number({ description: "End line" })),
    }),
    async execute(_id, params) {
      const result = ensureRepo(params.repo);
      if (typeof result === "string") return text(result);
      const range = params.start && params.end ? `-L ${params.start},${params.end}` : "";
      return text(sh(`git -C ${result.path} blame ${range} --date=short ${params.path} 2>/dev/null | head -100`));
    },
  });

  // Code stats (tokei)
  pi.registerTool({
    name: "repo_stats",
    label: "Repo: Stats",
    description: "Code statistics — lines of code, languages, file counts (uses tokei)",
    parameters: Type.Object({
      repo: Type.String({ description: "GitHub repo (owner/repo or URL)" }),
    }),
    async execute(_id, params) {
      const result = ensureRepo(params.repo);
      if (typeof result === "string") return text(result);
      return text(sh(`tokei ${result.path} --exclude .git --exclude node_modules --exclude vendor --exclude __pycache__ 2>/dev/null`));
    },
  });

  // Export map
  pi.registerTool({
    name: "repo_exports",
    label: "Repo: Exports",
    description: "Map public API — all exports from a repo",
    parameters: Type.Object({
      repo: Type.String({ description: "GitHub repo (owner/repo or URL)" }),
    }),
    async execute(_id, params) {
      const result = ensureRepo(params.repo);
      if (typeof result === "string") return text(result);
      const named = sh(`rg "^export (const|function|class|type|interface|enum) " ${result.path} --glob '*.ts' --glob '*.tsx' --glob '*.js' -o -N 2>/dev/null | sort | uniq -c | sort -rn | head -30`);
      const defaults = sh(`rg "^export default" ${result.path} --glob '*.ts' --glob '*.tsx' --glob '*.js' -l 2>/dev/null | head -20`);
      const reexports = sh(`rg "^export \\* from|^export \\{[^}]+\\} from" ${result.path} --glob '*.ts' --glob '*.tsx' --glob '*.js' 2>/dev/null | head -30`);
      const parts: string[] = [];
      if (named) parts.push(`## Named Exports\n${named}`);
      if (defaults) parts.push(`## Default Exports\n${defaults}`);
      if (reexports) parts.push(`## Re-exports\n${reexports}`);
      return text(truncate(parts.join("\n\n") || "No exports found"));
    },
  });

  // File find (fd)
  pi.registerTool({
    name: "repo_find",
    label: "Repo: Find Files",
    description: "Fast file finding with fd in a cloned repo",
    parameters: Type.Object({
      repo: Type.String({ description: "GitHub repo (owner/repo or URL)" }),
      pattern: Type.String({ description: "File name pattern (regex)" }),
      extension: Type.Optional(Type.String({ description: "Filter by extension (e.g., 'ts')" })),
    }),
    async execute(_id, params) {
      const result = ensureRepo(params.repo);
      if (typeof result === "string") return text(result);
      const ext = params.extension ? `-e ${params.extension}` : "";
      return text(sh(`fd '${params.pattern}' ${result.path} ${ext} -E .git -E node_modules 2>/dev/null | head -50`) || "No matches");
    },
  });

  // Cleanup
  pi.registerTool({
    name: "repo_cleanup",
    label: "Repo: Cleanup",
    description: "Remove a cloned repo from the autopsy cache, or 'all' to clear everything",
    parameters: Type.Object({
      repo: Type.String({ description: "GitHub repo (owner/repo or URL), or 'all'" }),
    }),
    async execute(_id, params) {
      if (params.repo === "all") {
        sh(`rm -rf ${AUTOPSY_DIR}`);
        return text(`Cleared all repos from ${AUTOPSY_DIR}`);
      }
      const parsed = parseRepoUrl(params.repo);
      if (!parsed) return text("Invalid repo format");
      const p = join(AUTOPSY_DIR, parsed.owner, parsed.repo);
      if (existsSync(p)) { sh(`rm -rf ${p}`); return text(`Removed: ${p}`); }
      return text("Repo not in cache");
    },
  });
}
