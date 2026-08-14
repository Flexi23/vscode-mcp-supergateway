# Development Plan: vscode-mcp-supergateway

## 1. Project Goal & Philosophy
**vscode-mcp-supergateway** is a local hub that coordinates MCP requests between IDEs and LLMs.
*Important rule for development:* Since we are working with local agents (12B class), this plan is divided into **very small, isolated steps**. Each step ideally touches only 1 to a maximum of 2 files.

---

## 2. Current Status
- ✅ **LM Studio Client:** Basic setup and resilience are in place (timeout guards).
- ✅ **Process Management:** Node.js Process Manager is running.
- 🚧 **Base Infrastructure:** Vault management and routing are under construction.

---

## 3. Next Milestones (Granular)

### Phase 1: Complete Base Vault
*Goal: A simple file system without complex task management.*
- [ ] **Task 1.1:** Test and extensively finalize `vaultManager.ts`. Ensure that `readNote` and `writeNote` work. Do not add any further features.
- [ ] **Task 1.2:** Integrate `vaultManager.ts` into a simple API route in `server.ts` to enable rudimentary testing of the function.

### Phase 2: Establish Dummy Routing
*Goal: The gateway server receives requests and returns a hardcoded string to secure the VS Code connection.*
- [ ] **Task 2.1:** Simplify `server.ts`. Set up an endpoint that is recognized by VS Code as an MCP server.
- [ ] **Task 2.2:** Forward an incoming request to the `LMStudioClient` – very simply, without dynamic loopbacks.

### Phase 3: The Simple Loopback Test
*Goal: The local model can read a note using a tool.*
- [ ] **Task 3.1:** Register **only a single tool** (`read_note`) in `lmstudioLoopback.ts`. Temporarily remove all other tool definitions to minimize prompt overhead.
- [ ] **Task 3.2:** Execute a test call. If the model can read the file, Phase 3 is complete.

---

## 4. Instructions for the Local Agent
1. **One task at a time:** Never work on tasks from different phases simultaneously.
2. **KISS Principle:** (Keep it simple, stupid). Do not invent abstract classes or interfaces if a simple function suffices.
3. **Context Limit:** Only load the file into the editor/context that is explicitly mentioned in the current task.
