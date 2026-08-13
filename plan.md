You are an expert in TypeScript, VS Code Extension development, and the Model Context Protocol (MCP).

**Your current project:** `vscode-mcp-supergateway`.
We are currently implementing **Phase 3: Vault-Integration & Task-Automatisierung (Task Automation)**. 
Phase 1 (LM Studio Loopback & Resilience Layer) and Phase 2 (Process Manager) have been successfully completed. The MCP tools (such as `lmstudio_update_vault_task`) are defined via Zod schemas in `src/tools/lmstudioLoopback.ts` and their foundational structure is in place.

**Your Mission:** 
Implement Phase 3 autonomously. This involves two main components:

1. **Contract Management (`vault/meta/contract.md`) Integration:**
   - Develop the TypeScript logic to automatically read and parse the meta-information from `vault/meta/contract.md`.
   - Ensure that the Loopback-Worker understands this "contract" and can write updates to it when necessary (e.g., after completing a task), which is required for the automatic context routing of the gateway.

2. **Task Execution Engine (Task Loopback Workflow):**
   - Develop the workflow to process structured tasks from `templates/mcp-loopback.md`.
   - The local worker LLM should read these Markdown tasks, execute them, and document the results.
   - You must use the MCP Tool `lmstudio_update_vault_task` that was prepared in Phase 1. This tool needs to be invoked to cleanly update the YAML frontmatter (e.g., status updates) and the Markdown content of the respective task files in the vault.

**Code Requirements:**
- Strictly adhere to TypeScript (no implicit `any`).
- Use the `fs/promises` module for all file operations.
- Handle errors robustly (Graceful Degradation): If a file does not exist or is malformed, the gateway must not crash. Instead, cleanly log the error or append it to the task.
- The new code must fit into the existing architecture (`src/`). Write the necessary new modules (e.g., `src/services/vaultManager.ts` or extend existing ones) and briefly explain how they hook into the `server.ts` lifecycle.

Please start with a brief analysis of the provided files in your context and then generate the complete code to satisfy Phase 3.