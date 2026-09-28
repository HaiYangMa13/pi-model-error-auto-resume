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

export const USER_INTERRUPT_PATTERNS = [
	/\b(?:user\s+)?abort(?:ed|ing|s)?\b/i,
	/\babort\b/i,
	/\b(?:user\s+)?interrupt(?:ed|ing|s)?\b/i,
	/\b(?:user\s+)?cancel(?:led|ed|ing|s|lations?)?\b/i,
	/\bterminated\b/i,
	/\bclient\s+(?:closed|disconnected|aborted|cancelled|canceled)\b/i,
	/\b(?:closed|terminated|aborted)\s+by\s+(?:client|user)\b/i,
	/\b(?:sigint|sigterm)\b/i,
	/\bcontext\s+cancel(?:ed|led)\b/i,
];

interface PendingModelError {
	errorMessage: string;
	provider?: string;
	model?: string;
}

export function isUserInterruptError(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	const text = errorMessage.trim();
	if (!text) return false;
	return USER_INTERRUPT_PATTERNS.some((pattern) => pattern.test(text));
}

export function isTerminalInterruptKey(data: string): boolean {
	return (
		data === "\x1b" ||
		data === "\x03" ||
		data === "\x1b[27u" ||
		data === "\x1b[27;1;27~" ||
		/^\x1b\[(?:27(?:;\d+)?|1;1)u$/.test(data)
	);
}

export function isRecoverableModelError(message: AssistantMessage, contextWindow: number): boolean {
	if (message.stopReason !== "error") return false;
	if (isContextOverflow(message, contextWindow)) return false;

	const errorMessage = message.errorMessage?.trim();
	if (!errorMessage) return true;
	if (isUserInterruptError(errorMessage)) return false;
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
	let userInterrupted = false;
	let terminalInputUnsubscribe: (() => void) | undefined;
	let watchedSignal: AbortSignal | undefined;
	let signalAbortHandler: (() => void) | undefined;
	let continuationInFlight = false;

	const clearStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUS_ID, undefined);
	};

	const cleanupTerminalInput = () => {
		if (terminalInputUnsubscribe) {
			terminalInputUnsubscribe();
			terminalInputUnsubscribe = undefined;
		}
	};

	const cleanupSignalWatcher = () => {
		if (watchedSignal && signalAbortHandler) {
			watchedSignal.removeEventListener("abort", signalAbortHandler);
		}
		watchedSignal = undefined;
		signalAbortHandler = undefined;
	};

	const cancelScheduled = (ctx: ExtensionContext, clearPending = true) => {
		scheduleGeneration++;
		cleanupTerminalInput();
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
		userInterrupted = false;
	};

	const watchSignal = (ctx: ExtensionContext) => {
		const signal = ctx.signal;
		if (!signal) return;
		if (signal === watchedSignal) return;

		cleanupSignalWatcher();
		watchedSignal = signal;

		if (signal.aborted) {
			userInterrupted = true;
			cancelScheduled(ctx);
			resumeAttempts = 0;
			return;
		}

		signalAbortHandler = () => {
			userInterrupted = true;
			cancelScheduled(ctx);
			resumeAttempts = 0;
		};
		signal.addEventListener("abort", signalAbortHandler, { once: true });
	};

	pi.on("turn_start", (_event, ctx) => {
		if (!continuationInFlight) {
			cancelScheduled(ctx);
			userInterrupted = false;
		}
		continuationInFlight = false;
		watchSignal(ctx);
	});

	pi.on("message_start", (_event, ctx) => {
		watchSignal(ctx);
	});

	// message_end catches finalized assistant errors even when no useful content
	// or tool call was produced in that turn.
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const message: AssistantMessage = event.message;

		if (message.stopReason === "aborted") {
			userInterrupted = true;
			cancelScheduled(ctx);
			resumeAttempts = 0;
			return;
		}

		if (userInterrupted || ctx.signal?.aborted) {
			userInterrupted = true;
			cancelScheduled(ctx);
			resumeAttempts = 0;
			return;
		}

		if (message.stopReason !== "error") {
			resetAfterProgress(ctx);
			return;
		}

		if (isUserInterruptError(message.errorMessage)) {
			userInterrupted = true;
			cancelScheduled(ctx);
			resumeAttempts = 0;
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

	pi.on("turn_end", (event, ctx) => {
		if (
			ctx.signal?.aborted ||
			(event.message.role === "assistant" && event.message.stopReason === "aborted")
		) {
			userInterrupted = true;
			cancelScheduled(ctx);
			resumeAttempts = 0;
		}
	});

	pi.on("agent_end", (event, ctx) => {
		if (
			ctx.signal?.aborted ||
			event.messages.some(
				(m) =>
					m.role === "assistant" &&
					(m.stopReason === "aborted" || isUserInterruptError(m.errorMessage)),
			)
		) {
			userInterrupted = true;
			cancelScheduled(ctx);
			resumeAttempts = 0;
		}
	});

	// Pi emits agent_settled only after its own retry, compaction, and queued
	// continuation work has finished. Waiting for it prevents competing retries.
	pi.on("agent_settled", (_event, ctx) => {
		cleanupSignalWatcher();

		if (userInterrupted || ctx.signal?.aborted) {
			cancelScheduled(ctx);
			resumeAttempts = 0;
			userInterrupted = false;
			return;
		}

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

		// Cancel scheduled resume immediately if the user sends an interrupt key (Escape or Ctrl+C).
		cleanupTerminalInput();
		if (typeof ctx.ui?.onTerminalInput === "function") {
			terminalInputUnsubscribe = ctx.ui.onTerminalInput((data: string) => {
				if (isTerminalInterruptKey(data)) {
					userInterrupted = true;
					cancelScheduled(ctx);
					resumeAttempts = 0;
					ctx.ui.notify("Scheduled model resume cancelled", "info");
					return { consume: true };
				}
				return undefined;
			});
		}

		resumeTimer = setTimeout(() => {
			resumeTimer = undefined;
			cleanupTerminalInput();
			clearStatus(ctx);

			// Never inject a continuation into a branch that changed while waiting,
			// or if the turn was cancelled by user action.
			if (
				generation !== scheduleGeneration ||
				!enabled ||
				userInterrupted ||
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
			continuationInFlight = true;

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
			userInterrupted = true;
			cancelScheduled(ctx);
			resumeAttempts = 0;
			ctx.ui.notify("Model error auto resume disabled for this session", "info");
			return;
		}

		if (action === "cancel") {
			userInterrupted = true;
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
		if (event.source !== "extension") {
			userInterrupted = true;
			cancelScheduled(ctx);
			resumeAttempts = 0;
		}
	});

	pi.on("user_bash", (_event, ctx) => {
		userInterrupted = true;
		cancelScheduled(ctx);
		resumeAttempts = 0;
	});

	pi.on("model_select", (_event, ctx) => {
		cancelScheduled(ctx);
		resumeAttempts = 0;
	});

	pi.on("session_before_switch", (_event, ctx) => {
		cancelScheduled(ctx);
		resumeAttempts = 0;
	});

	pi.on("session_before_fork", (_event, ctx) => {
		cancelScheduled(ctx);
		resumeAttempts = 0;
	});

	pi.on("session_before_compact", (_event, ctx) => {
		cancelScheduled(ctx);
		resumeAttempts = 0;
	});

	pi.on("session_before_tree", (_event, ctx) => {
		cancelScheduled(ctx);
		resumeAttempts = 0;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		cleanupSignalWatcher();
		cleanupTerminalInput();
		cancelScheduled(ctx);
		resumeAttempts = 0;
	});
}
