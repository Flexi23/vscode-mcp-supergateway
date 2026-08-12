# Development Plan: vscode-mcp-supergateway

## 1. Project Overview & Current State Audit

### Project Goal
`vscode-mcp-supergateway` is a Visual Studio Code extension and centralized Model Context Protocol (MCP) gateway hub. It orchestrates, routes, and offloads context between IDE clients (VS Code, Copilot, Cursor), local LLM workers (LM Studio, Ollama), and local or remote MCP server endpoints.

### Current Repository Trunk State
- **LM Studio Client (`src/services/lmstudio.ts`)**: REST API client connected to `http://localhost:1234/v1` for model discovery and completion generation. *Missing:* Resilience layer with timeout guards and prompt truncation.
- **Server Infrastructure (`src/server.ts`)**: Express-based server mounting `registerLMStudioTools`. *Missing:* Incomplete tool handlers need restoration, Zod validation, and strict typing.
- **Process Control (`vscode/supergateway.ps1` & `supergateway.js`)**: Script-based execution managing public (8080) and admin (3100) ports and upstreams (`codebase-memory`). *Planned:* Porting to a native Node.js child process manager.
- **Knowledge Vault & Task System (`vault/` & `templates/`)**: Vault contract (`contract.md`) and sub-agent task templates (`mcp-loopback.md`) established.

---

## 2. Milestone Roadmap

```
[Phase 0: Gemma Cleanup & Codebase Audit]
       │
       ▼
[Phase 1: LM Studio Loopback & Resilience Layer]
       │
       ▼
[Phase 2: Node.js Process Manager & Core Engine]
       │
       ▼
[Phase 3: Vault Integration & Loopback Workflows]
       │
       ▼
[Phase 4: VS Code Extension UI & Status Bar Integration]
       │
       ▼
[Phase 5: Automated Testing, Documentation & Marketplace Release]
```

---

## 3. Detailed Action Items

### Phase 0: Gemma Cleanup & Codebase Audit
- [ ] **Type Checking & Build Verification**:
  - Run `npm run build` / `nsc` in the root directory to uncover all remaining TypeScript compilation errors resulting from the incomplete Gemma commit.
  - Remove dangling placeholders and enforce strict typing without implicit `any` usages.
- [ ] **Interface & Module Audit**:
  - Review all exports in `src/tools/lmstudioLoopback.ts` and align Zod schemas with MCP standard specifications.

---

### Phase 1: LM Studio Loopback & Resilience Layer
- [ ] **Enhance `LMStudioClient` (`src/services/lmstudio.ts`)**:
  - Implement a 30-second timeout guard using `AbortController` / `Promise.race` to prevent GPU deadlocks during local inference.
  - Add prompt truncation (`truncatePrompt` for prompts exceeding 8,000 tokens) to protect local VRAM when running smaller models (Qwen2.5 / Gemma).
- [ ] **Complete MCP Tool Registrations (`src/tools/lmstudioLoopback.ts`)**:
  - `lmstudio_complete`: Execute direct raw completions on the active local model.
  - `lmstudio_summarize_diff`: Parse Git diffs and generate concise change summaries or ADR drafts.
  - `lmstudio_update_vault_task`: Update YAML frontmatter and task markdown files within the vault.
- [ ] **Error Handling & Graceful Degradation**:
  - Return structured MCP error payloads when LM Studio on port 1234 is offline or unreachable, preventing gateway server crashes.

---

### Phase 2: Node.js Process Manager & Core Engine
- [ ] **Native Child Process Spawning (`src/processManager.ts`)**:
  - Replace the PowerShell script `supergateway.ps1` with a cross-platform Node.js module using `child_process`.
  - Handle lifecycle management (start/stop) for `supergateway` instances (`npx -y supergateway`) with automated port availability checks.
- [ ] **Configuration Management**:
  - Dynamically load and parse `vscode/supergateway.config.json` to configure upstreams (e.g., `codebase-memory`, stdio/sse forwarders).

---

### Phase 3: Vault Integration & Loopback Workflows
- [ ] **Contract Management (`vault/meta/contract.md`)**:
  - Connect read and write handlers for the vault contract to drive context routing automatically.
- [ ] **Task Execution Engine**:
  - Process structured tasks from `templates/mcp-loopback.md` using the local worker model.

---

### Phase 4: VS Code Extension UI
- [ ] **Status Bar Integration**:
  - Display gateway status (e.g., `$(radio-tower) Supergateway: Active (8080)`) with Quick Pick actions for Start, Stop, View Logs, and Edit Config.
- [ ] **Dedicated Output Channel**:
  - Implement structured logging for all gateway and subprocess events in a dedicated VS Code Output Panel (`MCP Supergateway`) with configurable log levels.

---

### Phase 5: Automated Testing, Documentation & Release
- [ ] **Test Coverage**:
  - Write unit tests for Process Manager and LM Studio REST client.
  - Conduct E2E integration tests using the MCP Inspector and VS Code Extension Host.
- [ ] **Documentation & Packaging**:
  - Update `README.md` with step-by-step setup guides for Qwen2.5-Coder and Gemma in LM Studio.
  - Package the extension into a `.vsix` bundle using `vsce package`.

---

## 4. Component Status Matrix

| Component | File Path | Status & Objective |
| :--- | :--- | :--- |
| **LM Studio Client** | `src/services/lmstudio.ts` | In Progress: REST API client connected to port 1234. Requires 30s timeout guard and prompt truncation. |
| **MCP Tool Registry** | `src/tools/lmstudioLoopback.ts` | Pending: Zod schemas & handlers for `complete`, `summarize_diff`, and `update_vault_task`. |
| **Gateway Server Engine** | `src/server.ts` | Infrastructure Ready: Express server mounts tool registration. TypeScript errors need fixing. |
| **Process Manager Module** | `src/processManager.ts` | Planned: Port PowerShell logic from `vscode/supergateway.ps1` into a cross-platform TypeScript module. |
| **Knowledge Vault & Tasks** | `vault/meta/contract.md` | Ready: Schema defined, sub-agent loopback integration pending. |

---

## 5. Immediate Next Steps

1. Run `npm run build` in the terminal and resolve all TypeScript compilation errors in `src/services/lmstudio.ts`.
2. Implement Zod input schemas and tool execution handlers in `src/tools/lmstudioLoopback.ts`.
3. Add the 30-second timeout guard using `AbortController` in the LM Studio REST client.