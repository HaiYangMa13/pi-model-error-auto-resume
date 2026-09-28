import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import modelErrorAutoResume, {
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  MAX_RESUME_ATTEMPTS,
  MINIMUM_PI_VERSION,
  isRecoverableModelError,
  isTerminalInterruptKey,
  isUserInterruptError,
  resumeDelayMs,
  shortError,
} from "../extensions/model-error-auto-resume.js";

function assistantMessage(
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    stopReason,
    errorMessage,
  } as unknown as AssistantMessage;
}

test("exports the documented retry policy", () => {
  assert.equal(MINIMUM_PI_VERSION, "0.80.4");
  assert.equal(MAX_RESUME_ATTEMPTS, 3);
  assert.equal(BASE_DELAY_MS, 3_000);
  assert.equal(MAX_DELAY_MS, 15_000);
});

test("uses bounded exponential resume delays", () => {
  assert.equal(resumeDelayMs(1), 3_000);
  assert.equal(resumeDelayMs(2), 6_000);
  assert.equal(resumeDelayMs(3), 12_000);
  assert.equal(resumeDelayMs(4), 15_000);
  assert.equal(resumeDelayMs(99), 15_000);
});

test("identifies user interruption error patterns", () => {
  const interruptMessages = [
    "Operation aborted",
    "Request was aborted",
    "Request aborted by user",
    "The operation was aborted",
    "This operation was aborted",
    "The user aborted a request",
    "AbortError: The operation was aborted",
    "terminated",
    "Stream terminated",
    "User interrupted",
    "Operation interrupted",
    "Operation cancelled",
    "Operation canceled",
    "context canceled",
    "context cancelled",
    "Connection closed by client",
    "Client disconnected",
    "terminated by user",
    "SIGINT",
    "SIGTERM",
  ];

  for (const msg of interruptMessages) {
    assert.equal(isUserInterruptError(msg), true, `Expected "${msg}" to be user interrupt error`);
  }

  const normalErrors = [
    "The upstream connection closed before the response completed",
    "Connection error",
    "unexpected EOF",
    "OpenAI API error (502): Bad Gateway",
    "Rate limit reached",
    undefined,
    "",
  ];

  for (const msg of normalErrors) {
    assert.equal(isUserInterruptError(msg), false, `Expected "${msg}" NOT to be user interrupt error`);
  }
});

test("identifies terminal interrupt keys", () => {
  assert.equal(isTerminalInterruptKey("\x1b"), true); // Escape
  assert.equal(isTerminalInterruptKey("\x03"), true); // Ctrl+C
  assert.equal(isTerminalInterruptKey("\x1b[27u"), true); // Kitty Escape
  assert.equal(isTerminalInterruptKey("\x1b[27;1;27~"), true); // modifyOtherKeys Escape

  assert.equal(isTerminalInterruptKey("a"), false);
  assert.equal(isTerminalInterruptKey("\r"), false);
  assert.equal(isTerminalInterruptKey("\n"), false);
  assert.equal(isTerminalInterruptKey("\t"), false);
});

test("accepts recoverable model errors", () => {
  assert.equal(isRecoverableModelError(assistantMessage("error"), 128_000), true);
  assert.equal(
    isRecoverableModelError(
      assistantMessage("error", "The upstream connection closed before the response completed"),
      128_000,
    ),
    true,
  );
  assert.equal(
    isRecoverableModelError(assistantMessage("error", "Connection error"), 128_000),
    true,
  );
});

test("rejects successful and user-actionable failures", () => {
  const rejected = [
    assistantMessage("stop"),
    assistantMessage("aborted"),
    assistantMessage("error", "Maximum context length exceeded"),
    assistantMessage("error", "Invalid API key"),
    assistantMessage("error", "HTTP status 401 unauthorized"),
    assistantMessage("error", "Permission denied (403)"),
    assistantMessage("error", "Insufficient quota; update billing"),
    assistantMessage("error", "The requested model was not found"),
    assistantMessage("error", "Invalid request, status code 400"),
    assistantMessage("error", "Request was blocked by the safety policy"),
    // User interrupt / abort patterns
    assistantMessage("error", "Operation aborted"),
    assistantMessage("error", "Request was aborted"),
    assistantMessage("error", "terminated"),
    assistantMessage("error", "User interrupted"),
    assistantMessage("error", "Operation cancelled"),
    assistantMessage("error", "context canceled"),
  ];

  for (const message of rejected) {
    assert.equal(
      isRecoverableModelError(message, 128_000),
      false,
      message.errorMessage ?? message.stopReason,
    );
  }
});

test("formats long errors for notifications", () => {
  assert.equal(shortError("  one\n two   three "), "one two three");

  const shortened = shortError("x".repeat(200));
  assert.equal(shortened.length, 160);
  assert.match(shortened, /\.\.\.$/);
});

test("registers the expected Pi events and command", () => {
  const events: string[] = [];
  const commands: string[] = [];

  const pi = {
    on(name: string) {
      events.push(name);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
  } as unknown as ExtensionAPI;

  modelErrorAutoResume(pi);

  assert.deepEqual(events, [
    "turn_start",
    "message_start",
    "message_end",
    "turn_end",
    "agent_end",
    "agent_settled",
    "input",
    "user_bash",
    "model_select",
    "session_before_switch",
    "session_before_fork",
    "session_before_compact",
    "session_before_tree",
    "session_shutdown",
  ]);
  assert.deepEqual(commands, ["model-resume"]);
});

test("does not resume when the model turn is interrupted by user", () => {
  const handlers: Record<string, (event: any, ctx: any) => void> = {};
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: Array<{ id: string; text?: string }> = [];

  const pi = {
    on(name: string, handler: any) {
      handlers[name] = handler;
    },
    registerCommand() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;

  modelErrorAutoResume(pi);

  const mockCtx = (signalAborted = false) =>
    ({
      isIdle: () => true,
      signal: { aborted: signalAborted, addEventListener() {}, removeEventListener() {} },
      ui: {
        setStatus(id: string, text?: string) {
          statuses.push({ id, text });
        },
        notify(message: string, level?: string) {
          notifications.push({ message, level });
        },
        onTerminalInput() {
          return () => {};
        },
      },
      sessionManager: {
        getLeafId: () => "leaf-1",
      },
    }) as unknown as ExtensionContext;

  const activeStatuses = () => statuses.filter((s) => s.text !== undefined);

  // Case 1: stopReason === "aborted"
  handlers.turn_start({}, mockCtx());
  handlers.message_end({ message: assistantMessage("aborted", "Operation aborted") }, mockCtx());
  handlers.agent_settled({}, mockCtx());
  assert.equal(activeStatuses().length, 0, "Should not set active status when aborted");
  assert.equal(notifications.length, 0, "Should not notify when aborted");

  // Case 2: stopReason === "error" but errorMessage is "terminated"
  handlers.turn_start({}, mockCtx());
  handlers.message_end({ message: assistantMessage("error", "terminated") }, mockCtx());
  handlers.agent_settled({}, mockCtx());
  assert.equal(activeStatuses().length, 0, "Should not set active status when terminated");
  assert.equal(notifications.length, 0, "Should not notify when terminated");

  // Case 3: signal was aborted during turn
  handlers.turn_start({}, mockCtx(true));
  handlers.message_end({ message: assistantMessage("error", "Stream closed") }, mockCtx(true));
  handlers.agent_settled({}, mockCtx(true));
  assert.equal(activeStatuses().length, 0, "Should not set active status when signal aborted");
  assert.equal(notifications.length, 0, "Should not notify when signal aborted");

  // Case 4: turn_end reports aborted
  handlers.turn_start({}, mockCtx());
  handlers.message_end({ message: assistantMessage("error", "Internal network glitch") }, mockCtx());
  handlers.turn_end({ message: assistantMessage("aborted") }, mockCtx());
  handlers.agent_settled({}, mockCtx());
  assert.equal(activeStatuses().length, 0, "Should not set active status when turn_end reported aborted");
  assert.equal(notifications.length, 0, "Should not notify when turn_end reported aborted");
});

test("schedules resume for genuine recoverable errors, but cancels on Escape key", (t, done) => {
  const handlers: Record<string, (event: any, ctx: any) => void> = {};
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: Array<{ id: string; text?: string }> = [];
  let terminalInputHandler: ((data: string) => any) | undefined;

  const pi = {
    on(name: string, handler: any) {
      handlers[name] = handler;
    },
    registerCommand() {},
    sendMessage() {
      assert.fail("Should not send continuation message after user cancellation");
    },
  } as unknown as ExtensionAPI;

  modelErrorAutoResume(pi);

  const mockCtx = () =>
    ({
      isIdle: () => true,
      signal: { aborted: false, addEventListener() {}, removeEventListener() {} },
      ui: {
        setStatus(id: string, text?: string) {
          statuses.push({ id, text });
        },
        notify(message: string, level?: string) {
          notifications.push({ message, level });
        },
        onTerminalInput(fn: any) {
          terminalInputHandler = fn;
          return () => {
            terminalInputHandler = undefined;
          };
        },
      },
      sessionManager: {
        getLeafId: () => "leaf-1",
      },
    }) as unknown as ExtensionContext;

  // Genuine recoverable error
  handlers.turn_start({}, mockCtx());
  handlers.message_end(
    { message: assistantMessage("error", "The upstream connection closed before the response completed") },
    mockCtx(),
  );
  handlers.agent_settled({}, mockCtx());

  // Verify that it scheduled resume
  assert.equal(statuses.some((s) => s.text?.includes("model resume 1/3")), true);
  assert.equal(notifications.some((n) => n.message.includes("Model turn failed; resuming 1/3")), true);
  assert.ok(terminalInputHandler, "Terminal input handler should be registered while timer is active");

  // User presses Escape!
  const result = terminalInputHandler("\x1b");
  assert.deepEqual(result, { consume: true });

  // Verify cancelled notification and status cleared
  assert.equal(
    notifications.some((n) => n.message === "Scheduled model resume cancelled"),
    true,
  );
  assert.equal(statuses[statuses.length - 1]?.text, undefined, "Status should be cleared");
  assert.equal(terminalInputHandler, undefined, "Terminal input handler should be unsubscribed");

  done();
});
