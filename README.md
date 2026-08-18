# VS Code MCP Supergateway

A centralized, multi-client Model Context Protocol (MCP) gateway that aggregates, routes, and offloads context between IDE clients, local LLM workers, and backend MCP services.

---

## 💡 Overview & Value Proposition

As MCP usage grows, managing multiple disjointed MCP servers across different clients (VS Code/Copilot, LM Studio, etc.) becomes cumbersome. **VS Code MCP Supergateway** acts as a unified hub:

1. **Multiplexing & Routing:** Connect multiple clients to a single, orchestrated MCP endpoint.
2. **Context & Token Savings:** Keep expensive Frontier Model context clean by delegating repetitive context-structuring tasks to local worker models.
3. **LM Studio Loopback Pattern:** Turn LM Studio into both an MCP consumer *and* a high-speed local MCP tool/worker for tasks like documentation linting, diff summarization, and task management.

---

## 🏗 Architecture

Everything except your IDE and LM Studio runs inside Docker — the containers bring their own Node.js, Python, and all four upstream MCP servers.

```mermaid
graph LR
    subgraph Host["🖥 Host machine"]
        Copilot["VS Code / Copilot Chat"]

        subgraph LMStudio["LM Studio"]
          LMStudioServer["Local API server :1234"]
          LMStudioUI["Client UI"]
          LocalAgents@{ shape: subproc, label: "local agents" }
        end

        subgraph Docker["🐳 Docker Compose"]
            Supergateway["Supergateway MCP Server"]

            Proxy@{ shape: subproc, label: "MSP Stack MCP Aggregate<br/>(admin UI :3100)" }
            SemanticBridge["VS Code API bridge MCP<br/>code dependency resolver<br/>for C# / JS / MD / ..." ]
            Loopback@{ shape: subproc, label: "Agent Tasks<br/>(loopback API :8081)" }
            MCP@{ shape: processes, label: "Access Controlled Tools &<br/> Task Mgmt for Local Agents<br/>(MCP :8080)" }

            GitLab["GitLab MCP"]
            SiYuanNote["SiYuan Note MCP<br/>(Markdown Vault UI :6806)"]
            CodebaseMemory["Codebase Memory MCP<br>(3D graph/admin UI :9749)"]
            MarkItDown["MarkItDown MCP<br/>(docs/Office/PDF to Markdown)"]
        end
    end

    Supergateway --> |forward proxy| Proxy
    Supergateway --> |scheduler| Loopback
    SemanticBridge -. provide semantic edges .-> CodebaseMemory
    Supergateway --> |provider|MCP

    MCP --> Copilot
    MCP --> LMStudioServer

    LMStudioServer --> |openweight model provider| LocalAgents
    LMStudioServer --> |diff / changeset| Loopback
    Loopback --> |managed prompt| LMStudioServer
    Loopback -. prepare context for<br/> cloud frontier models .-> Copilot
    Loopback <-. reads & updates .-> SiYuanNote

    LocalAgents --> Copilot
    LocalAgents --> Loopback
    LocalAgents --> LMStudioUI

    Proxy --> CodebaseMemory
    Proxy --> GitLab
    Proxy --> MarkItDown
    Proxy --> SiYuanNote
    Proxy --> SemanticBridge

    click Supergateway "blob/main/src/gateway.ts" "Entry point: src/gateway.ts (main())"
    click SemanticBridge "blob/main/src/csharpSemanticMcp.ts" "Entry point: src/csharpSemanticMcp.ts (semantic API bridge)"
    click Loopback "blob/main/src/server.ts" "Entry point: src/server.ts (startBackendServer)"
    click Proxy href "https://www.npmjs.com/package/@mspstack/mcp-gateway" "npm: @mspstack/mcp-gateway" _blank
    click MCP href "https://www.npmjs.com/package/@mspstack/mcp-gateway" "npm: @mspstack/mcp-gateway (RBAC & tool access)" _blank
    click SiYuanNote href "https://www.npmjs.com/package/siyuan-mcp" "npm: siyuan-mcp" _blank
    click CodebaseMemory href "https://www.npmjs.com/package/codebase-memory-mcp" "npm: codebase-memory-mcp" _blank
    click GitLab href "https://www.npmjs.com/package/@zereight/mcp-gitlab" "npm: @zereight/mcp-gitlab" _blank
    click MarkItDown href "https://pypi.org/project/markitdown-mcp/" "PyPI: markitdown-mcp" _blank
    click LMStudioServer href "https://lmstudio.ai/docs/app/api" "LM Studio local server docs" _blank
    click LMStudioUI href "https://lmstudio.ai/" "LM Studio" _blank

    classDef entryPoint fill:#dbeafe,stroke:#1d4ed8,stroke-width:2px,color:#1e3a8a;
    classDef thirdParty fill:#fef3c7,stroke:#b45309,stroke-width:2px,color:#78350f;
    classDef hostApp fill:#e5e7eb,stroke:#4b5563,stroke-width:1px,color:#111827;

    class Supergateway,SemanticBridge,Loopback entryPoint;
    class Proxy,MCP,SiYuanNote,CodebaseMemory,GitLab,MarkItDown thirdParty;
    class Copilot,LMStudioServer,LMStudioUI,LocalAgents hostApp;

    style Host fill:#f8fafc,stroke:#64748b,stroke-width:1px
    style LMStudio fill:#f1f5f9,stroke:#94a3b8,stroke-width:1px,stroke-dasharray: 3 3
    style Docker fill:#ecfeff,stroke:#0e7490,stroke-width:2px
```

Legend: 🟦 blue = this repo's code entry points (click to open the source file) · 🟨 amber = third-party MCP servers/packages (click for npm/PyPI page) · ⬜ grey = host-side applications you already run (VS Code, LM Studio). Subgraph backgrounds: outer host boundary in slate, the LM Studio group dashed, the Docker Compose boundary in cyan.

---

## 🚀 Quick Start

### 1. Prerequisites

- [Docker](https://www.docker.com/) — Docker Desktop on Windows/macOS. **This is the only requirement.** Node.js, Python, and every upstream MCP server are bundled inside the image; nothing is installed on your host.
- [VS Code](https://code.visualstudio.com/) with GitHub Copilot — the client that will consume the gateway.
- [LM Studio](https://lmstudio.ai/) — optional, only for local model offloading & the loopback tools.

### 2. Clone and configure

```bash
git clone https://github.com/Flexi23/vscode-mcp-supergateway.git
cd vscode-mcp-supergateway
cp .env.example .env
```

Then edit [`.env`](.env.example):

| Variable | Required | Purpose |
|---|---|---|
| `GITLAB_API_URL` | **required** for the `gitlab` upstream | Base URL for the GitLab REST API, for example `https://gitlab.uni-rostock.de/api/v4`. |
| `GITLAB_PERSONAL_ACCESS_TOKEN` | for the `gitlab` upstream | Injected into the `gitlab` upstream by [`src/gateway.ts`](src/gateway.ts). Without it that upstream fails to connect and its tools are missing from the admin UI. |
| `SIYUAN_TOKEN` | optional for the `siyuan-note` upstream | SiYuan API token (SiYuan: Settings -> About -> API Token). For local/dev mode you can leave it empty and set `SIYUAN_TOKEN_REQUIRED=false`; the upstream then talks to the kernel without an `Authorization` header. |
| `SIYUAN_TOKEN_REQUIRED` | optional | When set to `true`, the gateway warns if the token is empty or a placeholder; otherwise token auth is disabled and the upstream works without one. |
| `SIYUAN_ACCESS_AUTH_CODE` | **required** for the `siyuan` service | Lock-screen password for the `siyuan` container's own web UI (<http://localhost:6806>); the container refuses to start without it (or `SIYUAN_ACCESS_AUTH_CODE_BYPASS=true`). |
| `SIYUAN_WORKSPACE_DIR` | **required** | Absolute host path to the SiYuan workspace directory, mounted directly at `/siyuan/workspace` inside the `siyuan` container. This is intentionally independent from the Codebase Memory paths. |
| `GATEWAY_HOST_DATA_DIR` | **required** | Absolute host path for the gateway runtime data directory (the `gateway.db` and admin config), mounted into the `gateway` container at `/app/data`. This is separate from the CBM cache. |
| `CBM_AUTO_INDEX_ENABLED` | optional | Set to `true` to enable the startup auto-index; otherwise startup indexing stays off and `CBM_AUTO_INDEX_PATH` is ignored. |
| `CBM_AUTO_INDEX_PATH` | only when enabled | Absolute host path that Codebase Memory should index on startup. Required only if `CBM_AUTO_INDEX_ENABLED=true`. |
| `CBM_DEFAULT_PATH` | **required** | Absolute host path that Codebase Memory opens by default in its UI. |
| `CBM_CACHE_DIR` | **required** | Absolute host path for the bind mount that Codebase Memory uses as its writable cache; it is mounted into the `gateway` container at `/root/cbm-cache`. |
| `LMSTUDIO_BASE_URL` | for the loopback tools | Defaults to `http://host.docker.internal:1234/v1`. Inside a container `localhost` means *the container*, so a host-side LM Studio must be reached via `host.docker.internal` (Docker Desktop only). |

### 3. Start

```bash
docker compose up -d --build
```

The first build takes a while and produces a ~2.9 GB image — see [🐳 Operations](#-operations) for why.

### 4. Connect VS Code

Point your MCP client config at the gateway's public port:

```json
{
  "servers": {
    "central-mcp-gateway": {
      "type": "sse",
      "url": "http://localhost:8080/sse"
    }
  }
}
```

Verify it came up:

```bash
curl http://localhost:8080/ping     # -> ok
docker compose logs gateway         # -> [upstream:*] connected (stdio) x4
```

The admin UI lives at <http://localhost:3100/admin>.

> Port numbers are a strict `.env` concern: every published and internal port must be declared in [.env](.env) and consumed in [`docker-compose.yml`](docker-compose.yml) as `${VAR}`. No numeric port literals are used as a second source of truth.

---

## 📦 Services & Ports

`gateway.ts` and `server.ts` run as a single Node process in a single container (`vscode-mcp-supergateway-backend:local`), started via `node dist/gateway.js` (see [`docker-compose.yml`](docker-compose.yml)). `gateway.ts` imports and starts `server.ts`'s Express app directly instead of spawning a second container.

| Port | What it is |
|---|---|
| `8080` | Public MCP endpoint — the forward proxy your MCP client (Copilot/LM Studio) connects to. |
| `3100` | `@mspstack/mcp-gateway` admin UI + direct MCP endpoint. |
| `8081` | Express LM Studio loopback backend (`lmstudio_complete`, `lmstudio_summarize_diff`, `lmstudio_update_siyuan_task`), started in-process via `startBackendServer()`. |
| `9749` | `codebase-memory-mcp`'s own 3D graph-visualization UI (<http://localhost:9749>). Its coordination daemon only binds `127.0.0.1` and rejects cross-origin browser requests, so `gateway.ts` enables it via `CBM_CACHE_DIR/config.json` and reverse-proxies the published port to it, rewriting `Origin`/`Referer` to satisfy its same-origin check; override the port with `CBM_UI_PORT`. |

The LM Studio loopback's `lmstudio_update_siyuan_task` tool reads/writes SiYuan documents directly via `SiyuanClient` (`src/services/siyuanClient.ts`), the same backend the `siyuan-note` upstream talks to (see [Configured Upstreams](#-configured-upstreams)).

### What is `@mspstack/mcp-gateway`?

[`@mspstack/mcp-gateway`](https://www.npmjs.com/package/@mspstack/mcp-gateway) ("MSPStack Gateway", MIT-licensed, by [Eugene Samotija](https://github.com/selic)) is a third-party, self-hosted MCP aggregator: it federates any number of MCP servers (stdio or HTTP) behind one endpoint with namespaced tools, and normally adds OAuth 2.1 / static-token auth, role-based tool access, and secret-store integration (OpenBao, Azure Key Vault) on top — built for MSPs running many client-facing MCP servers.

`src/gateway.ts` spawns it via `npx -y @mspstack/mcp-gateway --port <admin-port> --config <admin-config> --db-path <db>` and sets `DEV_ALLOW_UNAUTHENTICATED=true`, which puts it in its documented localhost-only, no-auth mode — we only use its core aggregation feature (one MCP endpoint for our four stdio upstreams), none of the OAuth/RBAC/secret-store machinery. `DEV_ALLOW_UNAUTHENTICATED=true` must **never** be used on anything but `127.0.0.1`/localhost; the package itself refuses to start without it or a real auth method configured. Requires Node ≥24 (uses the built-in `node:sqlite`, no native dependencies) — see the Node version note below.

---

## 🔌 Configured Upstreams

All four run inside the `gateway` container; the runtime column only says which language runtime the image provides for them.

| Upstream | Package | Runtime | Notes |
|---|---|---|---|
| `codebase-memory` | `codebase-memory-mcp` | Node | Auto-indexes the absolute `CBM_AUTO_INDEX_PATH` on container startup (mounted read-only at `/workspace`), and opens the absolute `CBM_DEFAULT_PATH` in its UI; own graph UI on port 9749 (see [Services & Ports](#-services--ports)), shared `CBM_CACHE_DIR` with the UI process. |
| `csharp-semantic` | local bridge | Node | Exposes C# workspace/file enumeration and dependency graph extraction via the stdio MCP server in [`src/csharpSemanticMcp.ts`](src/csharpSemanticMcp.ts). It is the pattern for IDE-native capabilities: wrap VS Code / C# semantic APIs as a dedicated MCP tool surface, then let the gateway aggregate them behind one routing layer. |
| `siyuan-note` | [`siyuan-mcp`](https://www.npmjs.com/package/siyuan-mcp) | Node | Talks to the `siyuan` Docker Compose service (`SIYUAN_HOST=siyuan`, port `6806`) over its REST API; requires `SIYUAN_TOKEN` (SiYuan: Settings -> About -> API Token, see [.env.example](.env.example)). |
| `gitlab` | `@zereight/mcp-gitlab` | Node | Requires `GITLAB_PERSONAL_ACCESS_TOKEN` (see [Quick Start](#2-clone-and-configure)). |
| `markitdown` | [`markitdown-mcp`](https://pypi.org/project/markitdown-mcp/) | Python | Exposes a single tool, `convert_to_markdown(uri)`, for `http:`, `https:`, `file:`, and `data:` URIs. |

Upstream wiring lives in [`docker/gateway.config.json`](docker/gateway.config.json). The `siyuan` service itself (image `b3log/siyuan`) is defined in [`docker-compose.yml`](docker-compose.yml) and also publishes its own web UI at <http://localhost:6806>; set `SIYUAN_ACCESS_AUTH_CODE` in `.env` to lock it down.

---

## ⚡ Key Features & Concepts

- **Unified Control Plane:** Connect Copilot and LM Studio simultaneously to your underlying toolchain (GitLab, Codebase Memory, SiYuan Note, MarkItDown).
- **Sub-Agent Loopback:** Offload context aggregation, diff generation, and documentation updates to fast local models running in LM Studio without consuming cloud tokens.
- **C# Semantic Edge Resolver:** Resolve cross-file C# dependencies in the VS Code C# language service and emit graph links for the codebase-memory indexer, so the 3D graph contains structural edges instead of only isolated file nodes.
- **Pattern: IDE native capabilities as MCP upstreams:** the gateway does not reach into VS Code directly. Instead, each IDE-specific capability is wrapped in its own MCP stdio bridge (for example [`src/csharpSemanticMcp.ts`](src/csharpSemanticMcp.ts)), which exposes a narrow, typed tool surface (`csharp_list_workspace_files`, `csharp_extract_dependency_graph`). The gateway then aggregates that bridge like any other upstream. This keeps the routing layer uniform while making semantic IDE features available to all clients through the same MCP interface.
- **SiYuan Note Integration:** Read and edit notebooks, documents, content blocks, and native databases in a running SiYuan instance through the `siyuan-note` upstream.
- **Document Conversion:** [MarkItDown](https://github.com/microsoft/markitdown) upstream exposes `convert_to_markdown(uri)`, turning PDFs, Office documents, images, and other files into Markdown for downstream agent consumption.

---

## 🐳 Operations

```bash
docker compose up -d --build   # start (rebuilds if needed)
docker compose logs -f gateway # follow gateway logs
docker compose down            # stop and remove
```

Notes:
- **Data persistence:** the gateway DB lives in the `gateway-data` named volume (not a bind mount) — inspect with `docker compose exec gateway sh`. The SiYuan workspace is a host bind mount from `SIYUAN_WORKSPACE_DIR` (see [.env.example](.env.example)), so it's directly inspectable/backupable on the host.
- **Node ≥24 required:** `@mspstack/mcp-gateway` declares it in its `engines` field, so [`Dockerfile`](Dockerfile) uses `node:24-alpine` (builder) / `node:24-bookworm-slim` (runtime). Do not downgrade to `node:20`.
- **Image size (~2.9 GB):** caused by Python's `markitdown[all]` (onnxruntime, pandas, azure SDKs, ...) plus ~330 Node packages. Accepted trade-off for having zero host-level dependencies.

---

## 🛠 Developing on this repo

Only relevant if you change the TypeScript sources. The image compiles `src/` itself during `docker compose build`, so you never need a host-side build to *run* anything — a local install is purely for editor IntelliSense and fast type-check feedback:

```bash
npm install          # type definitions for your editor
npx tsc --noEmit     # type-check without producing dist/
```

Then rebuild the image to pick up your changes:

```bash
docker compose up -d --build
```

---

## 🗺 Roadmap & Future Plan

### Phase 1: MVP & Core Gateway (Current)
- [x] Basic stdio / SSE transport routing.
- [x] Multi-backend server orchestration (Codebase Memory, GitLab, SiYuan Note).
- [x] Initial agent-assisted development groundwork.

### Phase 2: Host-Side VS Code Semantic Bridge (Next)
- [ ] Build a dedicated VS Code extension or host-side bridge that owns the language-service lifecycle and exposes semantic queries as MCP stdio servers.
- [ ] Route semantic requests through the same gateway pattern used for existing upstreams; each semantic domain is a dedicated upstream, not a direct Docker-only dependency.
- [ ] Expose typed tools such as `csharp_list_workspace_files`, `csharp_find_references`, `csharp_find_definitions`, and `csharp_extract_dependency_graph` from the host side.
- [ ] Extend the same pattern to Razor and JavaScript/TypeScript symbol and reference queries so the graph includes UI/view semantics as well as backend semantics.
- [ ] Add explicit Markdown reference extraction (`markdown_find_links`, `markdown_extract_reference_map`, `markdown_resolve_local_links`) so the semantic layer can connect prose, ADRs, docs, and code via structured references.
- [ ] Keep the Docker gateway as the aggregator and policy layer while the VS Code host remains the semantic data provider.
- [ ] Add a fallback path for non-IDE or non-C# environments that uses file-level dependency heuristics instead of Roslyn semantic data.

### Phase 3: Unified Semantic Layer (Roslyn + Razor + JS + Docs)
- [ ] Treat the IDE semantic stack as a single capability family: C#, Razor, JavaScript/TypeScript, and Markdown reference-aware analysis.
- [ ] Build shared graph normalization so each semantic domain emits the same edges and metadata shape (`source`, `target`, `kind`, `uri`, `range`, `symbol`, `referenceType`).
- [ ] Preserve language-specific nuance: Roslyn for C#, Razor symbol resolution for `.razor`, TypeScript language service for JS/TS, and markdown link/reference parsing for docs.
- [ ] Feed the unified semantic graph into the same codebase-memory pipeline so the knowledge graph can reason across code and documentation, not only raw file names.
- [ ] Add cross-domain queries such as “what docs mention this component?” or “which C# symbol owns this Razor binding?”

### Phase 4: LM Studio Loopback & Context Worker
- [ ] Implement local LM Studio MCP tool wrapper (`summarize_diff`, `generate_adr`).
- [ ] Add zero-blocking async tool handling for local inference.
- [ ] Graceful fallback & timeout management when local GPUs are under heavy load.

### Phase 5: SiYuan Note & Task Management Enhancements
- [ ] Structured task/ADR documents in SiYuan, driven by the `siyuan-note` upstream and `lmstudio_update_siyuan_task`.
- [ ] Agent scope security layer (permission checks around destructive SiYuan operations).
- [ ] Automated context bundle generator for Copilot prompts.

### Design note: host-side semantic provider
The semantic graph in this project is intentionally treated as a host-side capability, not as an in-container feature. VS Code and the installed language services own the Roslyn / Razor / JS/TS semantics, while the gateway remains the centralized routing layer. This keeps the architecture consistent: “feature provider” and “routing aggregator” are separate responsibilities, and each source of capability is exposed as its own MCP upstream. Markdown references are not a separate ecosystem; they are a semantic layer that links code and docs explicitly, so the graph can answer questions across implementation, UX, and documentation.

---

## 📄 License

MIT License. Feel free to contribute or adapt!

---

## 🧪 Disclaimer

Parts of this repository were deliberately generated with small local LLMs rather than a single frontier model — quality and style vary accordingly between commits. This includes the preserved original prototype created by Gemma 4 12B, which was saved on its own branch before the Docker refactor and later merged back into `main` for provenance. See individual commit messages for which model produced each change.