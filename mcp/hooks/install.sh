#!/bin/bash
# Install Claude Code hooks for obsidian-plus session management.
# Merges SessionStart and Stop hooks into ~/.claude/settings.json.

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS_FILE="$HOME/.claude/settings.json"

# Verify dependencies
echo "Checking dependencies..."

if ! command -v op-tasks &>/dev/null; then
    echo "ERROR: op-tasks not found on PATH"
    echo "Install: https://github.com/atsepkov/op-tasks"
    exit 1
fi

if ! command -v obsidian-plus-cli &>/dev/null; then
    echo "ERROR: obsidian-plus-cli not found on PATH"
    echo "Build and link: cd mcp && npm run build && npm link"
    exit 1
fi

if ! command -v jq &>/dev/null; then
    echo "ERROR: jq not found on PATH"
    echo "Install: brew install jq"
    exit 1
fi

echo "All dependencies found."

# Make hook scripts executable
chmod +x "$HOOKS_DIR/session-start.sh"
chmod +x "$HOOKS_DIR/session-stop.sh"
chmod +x "$HOOKS_DIR/recover-sessions.sh"

# Ensure settings file exists
mkdir -p "$(dirname "$SETTINGS_FILE")"
if [ ! -f "$SETTINGS_FILE" ]; then
    echo '{}' > "$SETTINGS_FILE"
fi

# Read current settings
CURRENT=$(cat "$SETTINGS_FILE")

# Add hooks using jq
UPDATED=$(echo "$CURRENT" | jq \
  --arg start_cmd "bash $HOOKS_DIR/session-start.sh" \
  --arg stop_cmd "bash $HOOKS_DIR/session-stop.sh" \
  '
  .hooks //= {} |
  .hooks.SessionStart //= [] |
  .hooks.Stop //= [] |

  # Add session-start hook if not already present
  (if (.hooks.SessionStart | map(select(.command == $start_cmd)) | length) == 0
   then .hooks.SessionStart += [{"command": $start_cmd}]
   else . end) |

  # Add session-stop hook if not already present
  (if (.hooks.Stop | map(select(.command == $stop_cmd)) | length) == 0
   then .hooks.Stop += [{"command": $stop_cmd}]
   else . end)
  ')

echo "$UPDATED" > "$SETTINGS_FILE"

echo "Hooks installed successfully!"
echo ""
echo "SessionStart → $HOOKS_DIR/session-start.sh"
echo "Stop         → $HOOKS_DIR/session-stop.sh"
echo ""
echo "Settings updated: $SETTINGS_FILE"
echo ""
echo "To verify: cat $SETTINGS_FILE | jq '.hooks'"
