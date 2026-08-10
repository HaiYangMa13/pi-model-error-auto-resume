# Changelog

## 0.1.0 - 2026-08-10

- Add bounded automatic continuation for recoverable failed model turns.
- Wait for Pi's `agent_settled` lifecycle event before scheduling recovery.
- Skip context, authentication, quota, billing, model, request, and safety errors that require user action.
- Add `/model-resume` status, enable, disable, and cancel controls.
- Cancel pending recovery on user input and session shutdown.
