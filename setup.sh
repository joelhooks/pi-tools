#!/usr/bin/env bash
set -euo pipefail

echo "🔧 pi-tools setup"
echo ""

check() {
  if command -v "$1" &>/dev/null; then
    echo "  ✅ $1"
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
echo "Optional:"

if ! check secrets; then
  echo "  📦 Installing agent-secrets..."
  curl -fsSL https://raw.githubusercontent.com/joelhooks/agent-secrets/main/install.sh | bash
fi

check codex || echo "  ⚠️  codex not found — install from https://github.com/openai/codex"

echo ""
echo "✅ Done. Run: pi install git:github.com/joelhooks/pi-tools"
