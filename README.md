# dsh-codex-portal

Host your locally installed **Codex CLI** (`codex app-server`) natively inside **DeepSeek Harness (DSH)** as an isolated Mode (**Codex Portal**, `codex-portal`) and a pluggable `ExternalCliEngine` for **DeepDuet**.

## Key Principles

- **Real Local CLI Execution**: Runs against your local `codex` binary and existing `codex login` session via `codex app-server` JSON-RPC over stdio. No credential reading, token export, or OAuth proxying.
- **Strict Mode-Model Isolation**: `codex-portal` sessions only accept models discovered from your local Codex CLI (`model/list`) and their supported reasoning efforts. Native DSH modes (`standard`, `deepduet`) cannot route to `codex-portal` models.
- **Native DSH Surface Integration**: Streams reasoning & text responses, persists tool executions (`codex_command`, `codex_file_change`, `codex_mcp_tool`, `codex_web_search`) cleanly in V4 session logs, bridges approvals (`ctx.approval`) and questions (`ctx.userQuestions`), and supports cold resume via `thread/resume`.
- **Decoupled Engine Contract**: Exposes `ctx.externalCliEngines` so `dsh-plugin-deepduet` can schedule `codex-portal` Workers or run Duet Master on `codex-portal` without a hard dependency.

## Build & Test

```sh
npm install
npm run typecheck && npm test
```
