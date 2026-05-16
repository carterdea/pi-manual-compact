#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION="$ROOT/index.ts"
PACKAGE_JSON="$ROOT/package.json"

assert_contains() {
    local file="$1"
    local expected="$2"
    if ! grep -Fq "$expected" "$file"; then
        echo "Expected $file to contain: $expected" >&2
        exit 1
    fi
}

assert_line_order() {
    local file="$1"
    local before="$2"
    local after="$3"
    local before_line
    local after_line

    before_line="$(grep -Fn "$before" "$file" | head -1 | cut -d: -f1)"
    after_line="$(grep -Fn "$after" "$file" | head -1 | cut -d: -f1)"

    if [[ -z "$before_line" || -z "$after_line" || "$before_line" -ge "$after_line" ]]; then
        echo "Expected '$before' to appear before '$after' in $file" >&2
        exit 1
    fi
}

assert_contains "$PACKAGE_JSON" '"pi-package"'
assert_contains "$PACKAGE_JSON" '"extensions"'
assert_contains "$PACKAGE_JSON" '"./index.ts"'

assert_contains "$EXTENSION" 'pi.registerCommand("manual-compact"'
assert_contains "$EXTENSION" 'ctx.sessionManager.getBranch()'
assert_contains "$EXTENSION" 'serializeConversation(convertToLlm(messages))'
assert_contains "$EXTENSION" 'ctx.ui.editor("Edit manual compact handoff", result.prompt)'
assert_contains "$EXTENSION" 'ctx.newSession({'
assert_contains "$EXTENSION" 'parentSession: currentSessionFile'
assert_contains "$EXTENSION" 'withSession: async (replacementCtx)'
assert_contains "$EXTENSION" 'ctx.ui.setEditorText(prompt)'
assert_contains "$EXTENSION" 'typeof ctx.sendUserMessage === "function"'
assert_contains "$EXTENSION" 'Press Enter to continue'
assert_line_order "$EXTENSION" 'typeof ctx.sendUserMessage === "function"' 'ctx.ui.setEditorText(prompt)'

for heading in \
    '## Context' \
    '## Planning Document' \
    '## Completed' \
    '## Remaining' \
    '## Key Decisions' \
    '## Current State' \
    '## Instructions' \
    '## Suggested Next Step'
do
    assert_contains "$EXTENSION" "$heading"
done

echo "All tests passed"
