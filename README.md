# pi-manual-compact

Pi extension for generating handoff prompts and continuing in a fresh parent-linked session.

## What it does

Registers `/manual-compact [optional-goal]`.

The command:

1. Reads the current session branch.
2. Serializes the conversation and git context.
3. Asks the current pi model to generate a handoff using the same structure as my `/handoff` skill.
4. Opens the generated handoff in an editor for review.
5. Starts a fresh session with `parentSession` tracking.
6. Populates the new editor with the edited handoff.
7. Auto-submits when the replacement session exposes `sendUserMessage`; otherwise leaves the prompt ready and asks you to press Enter.

## Install

```bash
pi install git:git@github.com:carterdea/pi-manual-compact.git
```

Or test locally:

```bash
pi -e /path/to/pi-manual-compact
```

## Usage

```text
/manual-compact
/manual-compact finish wiring the Shopify product form QA fixes
```

No args means the model infers the next task from the conversation.

## Handoff format

The generated prompt preserves this section structure:

```markdown
## Context

## Planning Document

## Completed

## Remaining

## Key Decisions

## Current State

## Instructions

## Suggested Next Step
```

## Development

```bash
npm test
```
