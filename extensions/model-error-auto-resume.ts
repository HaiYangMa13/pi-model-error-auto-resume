/**
 * Model Error Auto Resume
 *
 * When a model turn finishes with stopReason="error" and Pi has fully settled,
 * inject a hidden continuation message so the model can recover from partial
 * output, malformed tool use, provider-side generation failures, and similar
 * recoverable model errors.
 *
 * Commands:
 *   /model-resume             Show status
 *   /model-resume on          Enable for this session
 *   /model-resume off         Disable for this session
 *   /model-resume cancel      Cancel a scheduled continuation
 */

import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const EXTENSION_ID = "model-error-auto-resume";
const STATUS_ID = "model-error-auto-resume";

export const MINIMUM_PI_VERSION = "0.80.4";
export const MAX_RESUME_ATTEMPTS = 3;
export const BASE_DELAY_MS = 3_000;
export const MAX_DELAY_MS = 15_000;

const CONTINUATION_MESSAGE = [
	"The previous model turn ended with an error and may have left partial work.",
	"Recover autonomously and continue from the exact point of interruption.",
	"Before acting, inspect the current conversation, task state, and workspace when needed.",
	"Do not repeat work that is already complete.",
	"If the failure involved an unsupported action, malformed tool call, or invalid output shape, use a valid alternative approach.",
	"Do not mention this automatic recovery unless recovery still fails or user action is required.",
].join(" ");

// These failures normally require user/configuration changes. Re-sending a
// continuation message would only create a loop or hide an actionable error.
const NON_RECOVERABLE_ERROR_PATTERNS = [
	/(?:maximum|exceed(?:ed|s)?|too (?:many|long)).{0,40}(?:context|token)/i,
	/(?:context|prompt).{0,40}(?:length|window|limit|too long)/i,
	/(?:invalid|missing|expired|incorrect).{0,30}(?:api[ _-]?key|credential|access token|auth)/i,
	/(?:unauthorized|forbidden|authentication failed|permission denied|status(?: code)?\s*[:=]?\s*(?:401|403))/i,
	/(?:insufficient_quota|quota exceeded|usage limit|out of budget|billing|payment required|available balance)/i,
	/(?:model).{0,50}(?:not found|does not exist|not available|unsupported|has been retired|has been deprecated)/i,
	/(?:invalid_request_error|bad request|invalid request|status(?: code)?\s*[:=]?\s*400)/i,
	/(?:content policy|safety policy|safety filter|request was blocked|content was blocked)/i,
];

interface PendingModelError {
	errorMessage: string;
	provider?: string;
	model?: string;
}

export function isRecoverableModelError(message: AssistantMessage, contextWindow: number): boolean {
	if (message.stopReason !== "error") return false;
	if (isContextOverflow(message, contextWindow)) return false;

	const errorMessage = message.errorMessage?.trim();
	if (!errorMessage) return true;
	return !NON_RECOVERABLE_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

export function resumeDelayMs(attempt: number): number {
	return Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);
}

export function shortError(message: string): string {
	const oneLine = message.replace(/\s+/g, " ").trim();
	return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let resumeAttempts = 0;
	let pendingError: PendingModelError | undefined;
	let resumeTimer: ReturnType<typeof setTimeout> | undefined;
	let scheduledLeafId: string | null | undefined;
	let scheduleGeneration = 0;

	const clearStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUS_ID, undefined);
	};

	const cancelScheduled = (ctx: ExtensionContext, clearPending = true) => {
		scheduleGeneration++;
		if (resumeTimer) {
			clearTimeout(resumeTimer);
			resumeTimer = undefined;
		}
		scheduledLeafId = undefined;
		if (clearPending) pendingError = undefined;
		clearStatus(ctx);
	};

	const resetAfterProgress = (ctx: ExtensionContext) => {
		cancelScheduled(ctx);
		resumeAttempts = 0;
	};

	// message_end catches finalized assistant errors even when no useful content
	// or tool call was produced in that turn.
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const message: AssistantMessage = event.message;
		if (message.stopReason !== "error") {
			resetAfterProgress(ctx);
			return;
		}

		if (!isRecoverableModelError(message, ctx.model?.contextWindow ?? 0)) {
			cancelScheduled(ctx);
			resumeAttempts = 0;
			return;
		}

		pendingError = {
			errorMessage: message.errorMessage?.trim() || "Unknown model error",
			provider: message.provider,
			model: message.model,
		};
	});

	// Pi emits agent_settled only after its own retry, compaction, and queued
	// continuation work has finished. Waiting for it prevents competing retries.
	pi.on("agent_settled", (_event, ctx) => {
		if (!enabled || !pendingError || resumeTimer || !ctx.isIdle()) return;

		if (resumeAttempts >= MAX_RESUME_ATTEMPTS) {
			ctx.ui.notify(
				`Model auto resume stopped after ${resumeAttempts} attempts: ${shortError(pendingError.errorMessage)}`,
				"warning",
			);
			pendingError = undefined;
			clearStatus(ctx);
			return;
		}

		const failure = pendingError;
		const nextAttempt = resumeAttempts + 1;
		const delayMs = resumeDelayMs(nextAttempt);
		const generation = ++scheduleGeneration;
		scheduledLeafId = ctx.sessionManager.getLeafId();

		ctx.ui.setStatus(
			STATUS_ID,
			`model resume ${nextAttempt}/${MAX_RESUME_ATTEMPTS} in ${Math.ceil(delayMs / 1_000)}s`,
		);
		ctx.ui.notify(
			`Model turn failed; resuming ${nextAttempt}/${MAX_RESUME_ATTEMPTS} in ${Math.ceil(delayMs / 1_000)}s`,
			"warning",
		);

		resumeTimer = setTimeout(() => {
			resumeTimer = undefined;
			clearStatus(ctx);

			// Never inject a continuation into a branch that changed while waiting.
			if (
				generation !== scheduleGeneration ||
				!enabled ||
				!ctx.isIdle() ||
				ctx.sessionManager.getLeafId() !== scheduledLeafId
			) {
				pendingError = undefined;
				scheduledLeafId = undefined;
				return;
			}

			resumeAttempts = nextAttempt;
			pendingError = undefined;
			scheduledLeafId = undefined;

			pi.sendMessage(
				{
					customType: EXTENSION_ID,
					content: CONTINUATION_MESSAGE,
					display: false,
					details: {
						attempt: nextAttempt,
						provider: failure.provider,
						model: failure.model,
						errorMessage: failure.errorMessage,
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}, delayMs);
	});

	const handleCommand = async (args: string, ctx: ExtensionCommandContext) => {
		const action = args.trim().toLowerCase() || "status";

		if (action === "on") {
			enabled = true;
			ctx.ui.notify("Model error auto resume enabled for this session", "info");
			return;
		}

		if (action === "off") {
			enabled = false;
			cancelScheduled(ctx);
			resumeAttempts = 0;
			ctx.ui.notify("Model error auto resume disabled for this session", "info");
			return;
		}

		if (action === "cancel") {
			cancelScheduled(ctx);
			resumeAttempts = 0;
			ctx.ui.notify("Scheduled model resume cancelled", "info");
			return;
		}

		if (action !== "status") {
			ctx.ui.notify("Usage: /model-resume [status|on|off|cancel]", "warning");
			return;
		}

		const scheduled = resumeTimer
			? `; attempt ${resumeAttempts + 1}/${MAX_RESUME_ATTEMPTS} scheduled`
			: "";
		ctx.ui.notify(
			`Model error auto resume is ${enabled ? "on" : "off"}; completed resumes: ${resumeAttempts}/${MAX_RESUME_ATTEMPTS}${scheduled}`,
			"info",
		);
	};

	pi.registerCommand("model-resume", {
		description: "Show, enable, disable, or cancel model error auto resume",
		handler: handleCommand,
	});

	// A real user prompt always wins over a delayed automatic continuation.
	pi.on("input", (event, ctx) => {
		if (event.source !== "extension" && (resumeTimer || pendingError)) {
			cancelScheduled(ctx);
			resumeAttempts = 0;
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		cancelScheduled(ctx);
	});
}
