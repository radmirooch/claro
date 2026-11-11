# Contributing

Claro is an early, local-first prototype. Small changes backed by real conversations are welcome.

1. Use Node.js 22 or later. There are no npm runtime dependencies.
2. Run `npm test`; unit and API tests use local fixtures and do not need models or microphone access.
3. For manual tests, configure a local Whisper server and optionally Ollama as described in README.
4. Check microphone start/stop, language changes, failed/offline translation and a narrow screen.
5. Keep audio and conversation text out of logs, fixtures, screenshots and commits. Use synthetic examples.

Do not commit `.env`, model weights, runtime binaries or personal conversation exports. Avoid adding analytics or external API calls to the default path. Network/model downloads must remain explicit setup actions. A new cloud provider requires an explicit configuration and an honest privacy indicator.

Provider interfaces and client events are documented in `docs/architecture.md`. Extend the shared language catalog, not independent lists in each client. Preserve caption IDs when adding translations or exercises. Provider errors must not stop original captions. Label unsupported capabilities rather than simulating them.

Code is MIT-licensed. External models and engines have separate licenses; do not bundle weights in the repository. No claim is made about the availability of the Claro name as a trademark.
