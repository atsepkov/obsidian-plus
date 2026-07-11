#!/bin/bash
# Recovery script for claude sessions after reboot/crash.
# Checks op-tasks for in-progress claude sessions and marks dead ones as blocked.
# Run on machine startup or manually.

set -euo pipefail

# Find all in-progress claude sessions in op-tasks
SESSIONS=$(op-tasks list --label claude-session --status in_progress --json 2>/dev/null || echo "[]")

if [ "$SESSIONS" = "[]" ]; then
    echo "No in-progress claude sessions found"
    exit 0
fi

echo "$SESSIONS" | jq -c '.[]' | while read -r task; do
    TASK_ID=$(echo "$task" | jq -r '.id')
    TITLE=$(echo "$task" | jq -r '.title')
    DESC=$(echo "$task" | jq -r '.description // empty')
    SESSION_ID=$(echo "$DESC" | jq -r '.session_id // empty' 2>/dev/null || echo "")

    # Check if tmux window still exists
    TMUX_ALIVE=false
    if tmux has-session -t obsidian-plus 2>/dev/null; then
        WINDOW_NAME="claude-$(echo "$TITLE" | tr ' ' '-' | head -c 30)"
        if tmux list-windows -t obsidian-plus -F '#{window_name}' 2>/dev/null | grep -q "$WINDOW_NAME"; then
            TMUX_ALIVE=true
        fi
    fi

    if [ "$TMUX_ALIVE" = true ]; then
        echo "Session #${TASK_ID} (${TITLE}) still running in tmux"
    else
        echo "Session #${TASK_ID} (${TITLE}) died — marking as blocked"
        op-tasks status "$TASK_ID" blocked 2>/dev/null || true

        if [ -n "$SESSION_ID" ]; then
            obsidian-plus-cli status \
              --tag "#claude-sessions" \
              --query "$SESSION_ID" \
              --status "!" \
              --json > /dev/null 2>&1 || true
        fi
    fi
done
