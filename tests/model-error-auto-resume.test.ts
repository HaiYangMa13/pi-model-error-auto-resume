import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import modelErrorAutoResume, {
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  MAX_RESUME_ATTEMPTS,
  MINIMUM_PI_VERSION,
  isRecoverableModelError,
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

test("accepts recoverable model errors", () => {
  assert.equal(isRecoverableModelError(assistantMessage("error"), 128_000), true);
  assert.equal(
    isRecoverableModelError(
      assistantMessage("error", "The upstream connection closed before the response completed"),
      128_000,
    ),
    true,
  );
});

test("rejects successful and user-actionable failures", () => {
  const rejected = [
    assistantMessage("stop"),
    assistantMessage("error", "Maximum context length exceeded"),
    assistantMessage("error", "Invalid API key"),
    assistantMessage("error", "HTTP status 401 unauthorized"),
    assistantMessage("error", "Permission denied (403)"),
    assistantMessage("error", "Insufficient quota; update billing"),
    assistantMessage("error", "The requested model was not found"),
    assistantMessage("error", "Invalid request, status code 400"),
    assistantMessage("error", "Request was blocked by the safety policy"),
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
    "message_end",
    "agent_settled",
    "input",
    "session_shutdown",
  ]);
  assert.deepEqual(commands, ["model-resume"]);
});
