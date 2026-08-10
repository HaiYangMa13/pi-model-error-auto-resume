# pi-model-error-auto-resume

A small [Pi](https://pi.dev) extension that automatically continues work after a recoverable model turn failure.

Pi already performs its own provider retries and context-overflow recovery. This extension waits for Pi's agent loop to become fully settled, then sends one hidden continuation message only when the final assistant message still ended with `stopReason: "error"`.

## Why

Provider streams can fail after the model has produced partial text or partially planned a tool call. Retyping “continue” is repetitive and can cause the next turn to redo completed work. This extension adds a bounded, delayed recovery turn with instructions to inspect the session and workspace before continuing.

## Features

- Waits for Pi's built-in retries, compaction, and queued follow-ups to finish.
- Retries only recoverable model errors.
- Skips context overflow, authentication, permission, quota, billing, invalid request, unavailable model, and safety-policy errors.
- Uses bounded exponential delays: 3s, 6s, and 12s.
- Stops after three automatic resume attempts.
- Cancels a scheduled resume when the user sends a real prompt.
- Cancels timers when the session shuts down or switches.
- Adds `/model-resume` controls and a temporary footer status.
- Has no runtime dependencies beyond Pi's bundled extension APIs.

## Requirements

- Pi `>= 0.80.4` (`agent_settled` was introduced in Pi 0.80.4)
- Node.js `>= 20`

## Install

From npm:

```bash
pi install npm:pi-model-error-auto-resume
```

Try it for one run without installing:

```bash
pi -e npm:pi-model-error-auto-resume
```

From GitHub:

```bash
pi install git:github.com/HaiYangMa13/pi-model-error-auto-resume
```

## Commands

```text
/model-resume                 Show status
/model-resume status          Show status
/model-resume on              Enable for the current extension session
/model-resume off             Disable and cancel pending recovery
/model-resume cancel          Cancel the scheduled recovery attempt
```

The extension is enabled by default when loaded.

## Behavior

When a finalized assistant message ends with a recoverable error, the extension waits until Pi emits `agent_settled`. It then schedules a hidden follow-up message:

> The previous model turn ended with an error and may have left partial work. Recover autonomously and continue from the exact point of interruption. Before acting, inspect the current conversation, task state, and workspace when needed. Do not repeat work that is already complete.

The hidden message is stored in the Pi session and participates in model context. Its details include the attempt number, provider, model, and original error message for diagnostics.

A normal successful assistant response resets the attempt counter. Repeated failed recovery turns stop after three attempts.

## Errors that are not resumed

The classifier intentionally avoids errors that usually need user action or configuration changes, including:

- context or prompt length overflow
- invalid, missing, or expired credentials
- HTTP 401/403 authentication and permission failures
- quota, billing, payment, budget, or balance failures
- unavailable, unsupported, retired, or missing models
- invalid requests and HTTP 400 responses
- content-policy and safety-filter blocks

Classification is heuristic because provider error messages are not standardized. Please report false positives or false negatives with a redacted error message.

## Cost and safety notice

Each automatic resume is an additional model request and may incur API charges. The extension allows at most three automatic resume attempts per failure sequence.

The extension does not execute shell commands, access files, or make network requests by itself. Like every Pi extension, it runs with the permissions of the Pi process; review the source before installing.

## Development

```bash
git clone https://github.com/HaiYangMa13/pi-model-error-auto-resume.git
cd pi-model-error-auto-resume
npm install
npm run verify
```

Load the local package without other discovered extensions:

```bash
pi --no-extensions -e ./extensions/model-error-auto-resume.ts
```

## License

MIT
