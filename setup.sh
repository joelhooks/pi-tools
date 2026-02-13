#!/usr/bin/env bash
set -euo pipefail

echo "🔧 pi-tools setup"
echo ""

check() {
  if command -v "$1" &>/dev/null; then
    echo "  ✅ $1 $(command -v "$1")"
    return 0
  else
    echo "  ❌ $1 — not found"
    return 1
  fi
}

install_brew() {
  if command -v brew &>/dev/null; then
    echo "  📦 brew install $1..."
    brew install "$1" 2>&1 | tail -1
  else
    echo "  ⚠️  brew not found — install $1 manually"
    return 1
  fi
}

echo "Checking dependencies..."
echo ""

# Required
check rg    || install_brew ripgrep
check fd    || install_brew fd
check tree  || install_brew tree
check tokei || install_brew tokei
check ast-grep || install_brew ast-grep

echo ""

# Optional
echo "Optional (for specific extensions):"
if ! check tsgo; then
  echo "  📦 npm install -g @typescript/native-preview..."
  npm install -g @typescript/native-preview 2>&1 | tail -1
fi

if ! check codex; then
  echo "  ⚠️  codex not found — install from https://github.com/openai/codex"
  echo "     (needed for codex-exec and ralph-loop)"
fi

echo ""
echo "✅ Done. Run: pi install git:github.com/joelhooks/pi-tools"
