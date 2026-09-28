# Changelog

## 0.2.0 - 2026-09-28

- Prevent automatic resuming when the model turn is interrupted or cancelled by the user.
- Track active `AbortSignal` across the turn lifecycle to immediately disarm recovery upon user abort.
- Classify abort/cancel/interrupt/termination errors (e.g. `Operation aborted`, `terminated`, `User interrupted`, `context canceled`) as non-recoverable.
- Cancel scheduled recovery immediately if the user presses Escape or Ctrl+C during the countdown.
- Cancel scheduled recovery on user bash execution (`!`), model switching, and session branch navigation.

## 0.1.0 - 2026-08-10

- Add bounded automatic continuation for recoverable failed model turns.
- Wait for Pi's `agent_settled` lifecycle event before scheduling recovery.
- Skip context, authentication, quota, billing, model, request, and safety errors that require user action.
- Add `/model-resume` status, enable, disable, and cancel controls.
- Cancel pending recovery on user input and session shutdown.
