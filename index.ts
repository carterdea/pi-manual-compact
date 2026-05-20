/**
 * Manual compact extension - generate a handoff, open a fresh session,
 * and pre-populate it for continuation.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);

const OUTPUT_TEMPLATE = `## Context

I'm continuing work on: [task description]
Branch: \`[branch-name]\`
Repo: [repo path]

## Planning Document

[path to planning doc, or "None created"]

## Completed

- [bulleted list of what was done]

## Remaining

- [ ] [unchecked items from plan or conversation]

## Key Decisions

- [assumptions, trade-offs, or choices made]

## Current State

[git status summary, any failing tests]

## Instructions

[Pipeline-aware instruction, e.g.:]
[- "Design doc complete. All implementation tasks unchecked -- start execution."]
[- "Execution paused at Phase 2, Task 3 (5/12 complete). Resume execution."]
[- "All implementation tasks checked. QA items remain -- run QA."]
[- "QA complete. Run de-slop, then code-simplifier, then pre-pr."]

## Suggested Next Step

Run: \`[copy-pastable command with args]\``;

const SYSTEM_PROMPT = `You are a context transfer assistant. Generate a continuation prompt so the next session can pick up where this one left off.

Follow this exact handoff template. Preserve the section headers, order, checklist style, concise tone, and pipeline-aware guidance. Do not invent a new format. Do not wrap the result in a fenced code block. Do not include preamble or explanation.

${OUTPUT_TEMPLATE}

Rules:
- Only reference real commits and changes from the provided conversation and git context; do not fabricate work.
- If no planning doc exists in the conversation, write "None created"; do not invent one.
- If no commits were made, note that work was exploratory/planning only.
- Include file paths so the next session can jump straight to relevant code.
- Suggested command must include all necessary args when known.
- Never suggest a pipeline step already completed unless it needs re-running.
- If the user provided a goal, use it as the continuation task. If no goal was provided, infer the next task from the conversation.`;

type GenerationResult =
	| { status: "ok"; prompt: string }
	| { status: "cancelled" }
	| { status: "failed"; message: string };

type ReplacementContextWithMaybeSend = {
	ui: {
		setEditorText(text: string): void;
		notify(message: string, level?: "info" | "success" | "warning" | "error"): void;
	};
	sendUserMessage?: (content: string) => Promise<void> | void;
};

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}

	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}

	return undefined;
}

function getManualCompactMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}

	if (compactionIndex < 0) {
		return branch.map(entryToMessage).filter((message) => message !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];

	return compactedBranch.map(entryToMessage).filter((message) => message !== undefined);
}

async function git(args: string[], cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd, timeout: 5000 });
		return stdout.trim() || "(none)";
	} catch {
		return "(unavailable)";
	}
}

async function getGitContext(cwd: string): Promise<string> {
	const branch = await git(["branch", "--show-current"], cwd);
	const status = await git(["status", "--short"], cwd);
	const log = await git(["log", "--oneline", "-20"], cwd);
	const diffBase = branch === "(unavailable)" || branch === "(none)" ? "main" : branch;
	const diffStat = await git(["diff", "--stat", `origin/${diffBase}...HEAD`], cwd);

	return `git branch --show-current
${branch}

git status --short
${status}

git log --oneline -20
${log}

git diff --stat origin/${diffBase}...HEAD
${diffStat}`;
}

function buildUserPrompt(conversationText: string, gitContext: string, goal: string, cwd: string): string {
	const goalText = goal || "No explicit goal provided. Infer the best next task from the conversation.";

	return `## Repo

${cwd}

## Conversation History

${conversationText}

## Git Context

${gitContext}

## User's Goal for New Session

${goalText}`;
}

async function submitOrStagePrompt(ctx: ReplacementContextWithMaybeSend, prompt: string): Promise<void> {
	if (typeof ctx.sendUserMessage === "function") {
		await ctx.sendUserMessage(prompt);
		ctx.ui.notify("Handoff submitted in new session", "success");
		return;
	}

	ctx.ui.setEditorText(prompt);
	ctx.ui.notify("Handoff ready. Press Enter to continue", "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("manual-compact", {
		description: "Generate a handoff, start a fresh session, and continue there",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("manual-compact requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			await ctx.waitForIdle();

			const goal = args.trim();
			const branch = ctx.sessionManager.getBranch();
			const messages = getManualCompactMessages(branch);

			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}

			const conversationText = serializeConversation(convertToLlm(messages));
			const currentSessionFile = ctx.sessionManager.getSessionFile();
			const cwd = ctx.cwd;
			const gitContext = await getGitContext(cwd);

			const result = await ctx.ui.custom<GenerationResult>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Generating manual compact handoff...");
				loader.onAbort = () => done({ status: "cancelled" });

				const generate = async (): Promise<GenerationResult> => {
					try {
						const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
						if (!auth.ok || !auth.apiKey) {
							return { status: "failed", message: auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error };
						}

						const userMessage: Message = {
							role: "user",
							content: [{ type: "text", text: buildUserPrompt(conversationText, gitContext, goal, cwd) }],
							timestamp: Date.now(),
						};

						const response = await complete(
							ctx.model!,
							{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
							{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
						);

						if (response.stopReason === "aborted") {
							return { status: "cancelled" };
						}

						const prompt = response.content
							.filter((content): content is { type: "text"; text: string } => content.type === "text")
							.map((content) => content.text)
							.join("\n")
							.trim();

						if (!prompt) {
							return { status: "failed", message: "Model returned an empty handoff" };
						}

						return { status: "ok", prompt };
					} catch (error) {
						return { status: "failed", message: error instanceof Error ? error.message : String(error) };
					}
				};

				generate().then(done);

				return loader;
			});

			if (result.status === "cancelled") {
				ctx.ui.notify("Manual compact cancelled during generation", "info");
				return;
			}

			if (result.status === "failed") {
				ctx.ui.notify(`Manual compact failed: ${result.message}`, "error");
				return;
			}

			const editedPrompt = await ctx.ui.editor("Edit manual compact handoff", result.prompt);
			if (editedPrompt === undefined) {
				ctx.ui.notify("Manual compact cancelled in editor", "info");
				return;
			}

			const finalPrompt = editedPrompt.trim();
			if (!finalPrompt) {
				ctx.ui.notify("Manual compact cancelled: empty handoff", "info");
				return;
			}

			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (replacementCtx) => {
					await submitOrStagePrompt(replacementCtx as ReplacementContextWithMaybeSend, finalPrompt);
				},
			});

			if (newSessionResult.cancelled) {
				ctx.ui.notify("Manual compact cancelled while starting new session", "info");
			}
		},
	});
}
