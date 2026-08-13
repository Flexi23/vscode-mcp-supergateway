# Development Plan: vscode-mcp-supergateway

## 1. Project Overview & Current Status

### Project Goal
vscode-mcp-supergateway is a Visual Studio Code Extension and a central Model Context Protocol (MCP) Gateway Hub. The project's purpose is to efficiently orchestrate, route, and offload context between IDE clients (VS Code, Copilot, Cursor), local LLM workers (LM Studio, Ollama), and remote as well as local MCP servers.

### Current Status (Update)
- **LM Studio Client & Resilience (Completed):** 30-second timeout guard via `AbortController` and prompt truncation (heuristic: 8000 tokens) implemented. Zod schema validation for tools is active.
- **Process Management (Completed):** Migration from PowerShell (`supergateway.ps1`) to a native Node.js Process Manager (`src/processManager.ts`) successful. Dynamic config loading and lifecycle management integrated.
- **Knowledge Vault & Task System (In Progress):** Vault contract (`contract.md`) and sub-agent task templates (`mcp-loopback.md`) exist. Read/write routines still need to be implemented.

## 2. Phase Roadmap

[Phase 0: Gemma Cleanup & Codebase Audit] -> DONE
│
▼
[Phase 1: LM Studio Loopback & Resilience Layer] -> DONE
│
▼
[Phase 2: Node.js Process Manager & Core Engine] -> DONE
│
▼
[Phase 3: Vault Integration & Loopback Workflows] -> IN PROGRESS
│
▼
[Phase 4: VS Code Extension UI & Status Bar Integration] -> PENDING
│
▼
[Phase 5: Automated Testing, Documentation & Marketplace Release] -> PENDING

## 3. Detailed Work Packages

### Phase 0 to 2: Completed
- Foundations laid, LM Studio Loopback implemented (including `lmstudio_complete`, `lmstudio_summarize_diff`, `lmstudio_update_vault_task`). Process Manager implemented in Node.js.

### Phase 3: Vault Integration & Loopback Workflows (Current Focus)
- **Contract Management (`vault/meta/contract.md`):**
  - Integration of read and write routines for the Vault contract to enable automatic context routing.
  - Development of a `VaultManager` service.
- **Task Execution Engine:**
  - Processing of structured tasks from `templates/mcp-loopback.md` by the local worker LLM.
  - Automatic updating of YAML frontmatter via `lmstudio_update_vault_task`.

### Phase 4: VS Code Extension UI
- **Status Bar Integration:**
  - Status display (e.g., `$(radio-tower) Supergateway: Active (8080)`) with quick-pick actions for Start, Stop, Logs, and Config.
- **Dedicated Output Channel:**
  - Logging of all gateway and subprocess events in the VS Code panel with configurable log levels.

### Phase 5: Automated Testing, Documentation & Release
- **Test Coverage:** Unit tests for Process Manager and LM Studio REST Client, integration tests via MCP Inspector.
- **Documentation & Packaging:** README.md updates, `.vsix` generation.

## 4. Component Status Matrix

| Component | Path / File | Status |
| :--- | :--- | :--- |
| LM Studio Client | `src/services/lmstudio.ts` | **Done** |
| MCP Tool Registry | `src/tools/lmstudioLoopback.ts` | **Done** |
| Gateway Server Engine | `src/server.ts` | **Done** |
| Process Manager Module| `src/processManager.ts` | **Done** |
| Knowledge Vault | `vault/meta/contract.md` | **In Progress** (Schema defined, engine missing) |

## 5. Immediate Next Steps
1. Implementation of the Vault read/write routines in a new TypeScript module (e.g., `src/services/vaultManager.ts`).
2. Creation of the workflow to parse and execute the tasks from `templates/mcp-loopback.md` via the local LM Studio worker.