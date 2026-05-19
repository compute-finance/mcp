#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

command -v node >/dev/null || { echo "node required (>=20)"; exit 1; }
command -v claude >/dev/null || { echo "claude (Claude Code) required"; exit 1; }

echo "Building MCP..."
cd "$ROOT/mcp"
npm install --silent
npm run build

echo "Registering MCP (user scope)..."
claude mcp remove compute-finance 2>/dev/null || true
claude mcp add --scope user compute-finance node "$ROOT/mcp/dist/index.js"

echo ""
echo "Compute Finance MCP — install which skill?"
echo "  1) cf-session-management   (post-session cost + history + insights)"
echo "  2) cf-session-consumption  (per-turn token breakdown with visual)"
echo "  3) cf-active-sessions      (multi-session overview across projects)"
echo "  4) all"
read -r -p "Choose [4]: " CHOICE
CHOICE="${CHOICE:-4}"

mkdir -p "$HOME/.claude/skills"
install_skill() {
  local name="$1"
  rm -rf "$HOME/.claude/skills/$name"
  cp -r "$ROOT/skills/$name" "$HOME/.claude/skills/$name"
  echo "  installed: $name"
}

case "$CHOICE" in
  1) install_skill cf-session-management ;;
  2) install_skill cf-session-consumption ;;
  3) install_skill cf-active-sessions ;;
  4)
    install_skill cf-session-management
    install_skill cf-session-consumption
    install_skill cf-active-sessions
    ;;
  *) echo "Invalid choice: $CHOICE"; exit 1 ;;
esac

echo ""
echo "Done. Restart Claude Code, then invoke the skill(s) by name."
echo "Local data: ~/.compute-finance-mcp/{sessions,turns}.jsonl (never uploaded)."
