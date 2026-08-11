---

## 🏗 Integration Flow

```mermaid
graph TD
    subgraph Clients["Clients (Frontier & Local Hosts)"]
        Copilot["Copilot / VS Code<br/>(Frontier Model / Strategy)"]
        LMStudio_Host["LM Studio<br/>(Client UI)"]
    end

    subgraph Gateway["Core Gateway"]
        Supergateway["Supergateway Server"]
    end

    subgraph Loopback["Local Worker Loopback"]
        LMStudio_Worker["LM Studio MCP Server<br/>(Local Small Models: Gemma 4 / LFM)"]
    end

    subgraph Backends["MCP Servers (Backend & Memory)"]
        CodebaseMemory["Codebase Memory"]
        MarkdownVault["Markdown Vault<br/>(Tasks, ADRs & Specs)"]
        GitLab["GitLab Integration"]
    end

    %% Client connections to Gateway
    Copilot -- "via MCP" --> Supergateway
    LMStudio_Host -- "via MCP" --> Supergateway

    %% Gateway routes to Backends and Loopback Worker
    Supergateway --> CodebaseMemory
    Supergateway --> MarkdownVault
    Supergateway --> GitLab
    
    %% Loopback Worker Execution
    Supergateway <-->|"Worker Loopback (Sub-Agent)"| LMStudio_Worker
    LMStudio_Worker -. "Reads/Updates" .-> MarkdownVault
```

---

## ⚡ Key Features & Concepts

- **Unified Control Plane:** Connect Copilot and LM Studio simultaneously to your underlying toolchain (GitLab, Codebase Memory, Vault).
- **Sub-Agent Loopback:** Offload context aggregation, diff generation, and documentation updates to fast local models running in LM Studio without consuming cloud tokens.
- **Markdown Vault Integration:** Structure project tasks, architectural decision records (ADRs), and feature specs directly in markdown files guarded by YAML access controls (`agent_access`).

---

## 🚀 Getting Started

### Prerequisites
- Node.js 20+
- [VS Code](https://code.visualstudio.com/) with GitHub Copilot
- [LM Studio](https://lmstudio.ai/) (optional, for local model offloading & loopback)

### Installation
```bash
git clone https://github.com/Flexi23/vscode-mcp-supergateway.git
cd vscode-mcp-supergateway
npm install
npm run build
```

---

## 🗺 Roadmap & Future Plan

### Phase 1: MVP & Core Gateway (Current)
- [x] Basic stdio / SSE transport routing.
- [x] Multi-backend server orchestration (Codebase Memory, GitLab, Vault).
- [x] Initial agent-assisted development groundwork.

### Phase 2: LM Studio Loopback & Context Worker
- [ ] Implement local LM Studio MCP tool wrapper (`summarize_diff`, `generate_adr`).
- [ ] Add zero-blocking async tool handling for local inference.
- [ ] Graceful fallback & timeout management when local GPUs are under heavy load.

### Phase 3: Vault & Task Management Enhancements
- [ ] Standardized YAML-Frontmatter parser for Markdown Vault (`tasks/`, `adrs/`).
- [ ] Agent scope security layer (`agent_access: read | append | edit | hidden`).
- [ ] Automated context bundle generator for Copilot prompts.

---

## 📄 License

MIT License. Feel free to contribute or adapt!