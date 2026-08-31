# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.4.0] - 2026-08-31
### Added
- `docker-compose.yml` now publishes `CBM_UI_BACKEND_PORT` alongside the other gateway ports.
- Added a `/cbm/graph` proxy mount so the Codebase Memory graph UI (its own port only binds to the container's loopback interface and is therefore unreachable via the Docker port mapping) is reachable through the already-exposed dashboard port; all "Open 3D graph" links now go through it.

### Changed
- **Breaking:** the `/msp-admin` iframe route is removed. The MSP Stack admin app (`mcp-gateway`'s built-in UI) is now inlined directly into the `/msp` dashboard tab instead of being embedded via iframe: its HTML/CSS are fetched server-side and its stylesheet is rewritten to scope every selector under a `#msp-admin-root` container, avoiding style collisions with the dashboard's own chrome.
- Replaced the fragile referer-based detection of the admin app's root-absolute API calls (`/api/*`, `/auth/*`, `/health`) with an unconditional path-based passthrough, since referer sniffing is unreliable and doesn't survive the move to inlined content.
- Fixed a namespace collision where the Codebase Memory graph UI's own `/api/*`/`/rpc` calls (used for the "Indexed Projects" stats view and its "+ New Index" action) could be misrouted to the MSP admin upstream instead, since both upstreams share the `/api/` path prefix; the CBM-referer check is now evaluated for all HTTP methods, ahead of the MSP passthrough.
- Added `Cache-Control: no-store` to every redirect response the gateway relays, since browsers cache `301`s indefinitely even without explicit headers — a stale cached redirect from an earlier (now-fixed) routing bug was otherwise invisible to server-side testing and kept resurfacing in the browser.
- The `/cbm/overview` project table now renders directory names immediately from a fast filesystem scan instead of waiting for the CBM CLI-backed status lookup, which shells out to `npx` and previously blocked the whole page (and the whole single-threaded gateway process) for seconds; the CLI-backed persisted status is now fetched asynchronously by the client afterward. The CLI lookup itself is also cached for a few seconds and uses `--no-install` to skip a redundant npm registry check, and its response parsing was fixed to read the actual `{ structuredContent: { projects } }` shape instead of a non-existent top-level `projects` field (previously every project always showed as "unchecked").
- Fixed a rendering bug where the server-rendered table rows' whitespace-only text node (from template-literal indentation) was mistaken for the project-name cell by the client-side row-update code, visually shifting every column one slot to the right after the first status refresh.
- The `/cbm/overview` table's Status column is removed (redundant with the Actions column's own state text) and its visual style is unified with the `/msp` tab's theme (same color palette, typography, and `.btn`/`.btn.secondary` button styling). The "Index" action button is renamed "Add to Index" and no longer offers "Transfer semantic edges" before a project has ever been indexed (indexing already triggers semantic-edge transfer automatically); "Transfer semantic edges" now appears next to "Open 3D graph" for already-indexed projects instead, to support re-enriching without a full reindex.
- Removed the dead client-side `runSequentialProjectChecks` timeout-based "checking…" animation from the CBM overview page: real state transitions are already driven by async events (`fetch` polling and the `/cbm/progress` WebSocket), and the fast-render change above made this code path unreachable in normal operation anyway.

## [2.3.0] - 2026-08-20
### Added
- The dashboard's "Codebase Memory" tab now opens a new `/cbm/overview` page instead of embedding the CBM UI directly: it lists the project folders discovered under the configured workspace root, each with an "Index" button (`POST /cbm/index`) to trigger indexing for just that directory, live status polling (`GET /cbm/index-status`), and the actual CBM graph UI embedded below. Indexing logic used by the old startup auto-index and this new per-directory button was consolidated into a single job-tracked `indexRepository()` helper.
- Added a dedicated `semantic-bridge` MCP upstream that exposes both C# and TypeScript workspace and dependency tools over stdio, using a Roslyn-based .NET resolver for C# and file-based parsing for the remaining source types.
- Documented the IDE-native semantic bridge pattern in the architecture diagram and README: semantic providers are wrapped as MCP upstreams and then aggregated by the gateway instead of being reached directly from the container.
- Added the bridge wiring to `docker/gateway.config.json` and the MCP SDK dependency in `package.json` so the gateway can register the new upstream automatically.
- The startup log now waits for the gateway admin UI line before printing the final tool catalog, then groups discovered tools by upstream using normalized namespace/separator matching so the output shows the real exposed tool names instead of wildcard placeholders.
- Added ffmpeg to the runtime image so the bundled MarkItDown MCP upstream can handle media conversion in a self-contained container setup.

### Changed
- Refactored the monolithic startup flow into dedicated modules for gateway config, Codebase Memory setup, dashboard rendering, startup-log classification, and embedded proxy handling so the runtime stays easier to reason about and maintain.
- Replaced brittle raw string comparisons with a structured startup log classifier that recognizes upstream connection events and leaves unrelated gateway chatter in plain log output.
- Kept the embedded reverse-layer architecture but cleaned up the runtime config object and route handling into explicit dashboard and CBM proxy helpers without splitting the gateway into a separate service.
- Polished the console-like dashboard branding by increasing the SUPERGATE header prominence and keeping the terminal aesthetic consistent across the gateway UI.
- Fixed the Docker image build by pinning TypeScript to a published version that resolves correctly in the Node 24 runtime environment, preventing the `npm ci --omit=dev` failure during image creation.
- The dashboard tab label for the gateway entry was renamed from "Admin UI" to "Gateway" so the landing-page navigation matches the actual public-facing role of the MCP entry point.
- The Codebase Memory overview page now hides the "Index" button for already indexed projects, shows a dedicated "Transfer semantic edges" action for indexed directories, and opens the 3D graph in a new browser tab via a direct link. The same action path is also called automatically after a successful repository index so semantic dependency edges are transferred without an extra manual step.
- **Breaking:** the dashboard (`/dashboard`, and `/` as its default) moved from the public MCP port (`MCP_GATEWAY_PUBLIC_PORT`, e.g. `8080`) to the admin port (`ADMIN_UI_PORT`, e.g. `3100`), since the public port is meant for MCP client (SSE) traffic only, not human browsing. `main()` now logs the public MCP endpoint and the dashboard URL on startup.
- `startForwardProxy()` gained a `stripFrameHeaders` option, now enabled on the Codebase Memory UI proxy: it strips the upstream's `X-Frame-Options`/`Content-Security-Policy` response headers, which otherwise blocked the CBM UI from being framed on a different origin/port (the dashboard iframe).
- `docker-compose.yml` and `.env` now use explicit host bind-mount paths for the gateway data dir, Codebase Memory cache, and SiYuan workspace, with the GitLab API URL moved into the environment as well. This keeps runtime state and CBM cache independent and makes the config single-source-of-truth.
- The host-side CBM cache variable was renamed to `CBM_HOST_CACHE_DIR` and the compose/service wiring now mounts that explicit host path at `/root/cbm-cache`, while the runtime container-side variable remains `CBM_CACHE_DIR` for the upstream itself.
- `gateway.ts` now resets stale Codebase Memory runtime state (`config.json`, lockfiles, daemon directories, and `/tmp/cbm-daemon-*`) before startup so the UI defaults back to `/workspace` instead of reopening a stale `/root` browse root.
- Startup auto-indexing is now opt-in via `CBM_AUTO_INDEX_ENABLED`; `CBM_AUTO_INDEX_PATH` is only required when that flag is `true`, so disabled mode no longer fails on a missing path.
- The C#-only extractor was generalized to a semantic dependency resolver that handles `.cs`, `.razor`, `.js`, `.ts`, and Markdown references, and the related rename/docs cleanup was completed to match the broader responsibilities.
- The gateway now clears stale persistent state before startup and logs the admin UI and the final public RBAC MCP endpoint exactly once, using the environment-configured public port so rebuilds do not re-use stale gateway or CBM data.
- The README, gateway config, and environment docs were updated to match the final runtime layout and the separate host-mount model for the gateway DB, CBM cache, and workspace volumes.
- Renamed the SiYuan lockscreen env vars to `SIYUAN_LOCKSCREEN_CODE` and `SIYUAN_LOCKSCREEN_CODE_REQUIRED` so their semantics match the actual container lock-screen behavior rather than the generic access-code wording.
- Pinned the Supergateway dependency versions in `package.json` to exact versions for reproducible builds and removed the ambiguity around the SiYuan lock-screen semantics in the local environment config.
- Updated the CBM overview header to show the absolute host workspace path instead of the generic project-folder label, making the workspace root explicit in the dashboard.
- Reworked the startup log queue to carry caller and stream metadata so each emitted line is identifiable in the console output while keeping classification stable.
- Removed the transport column from the final tool summary and render the grouped tool list in a compact per-upstream layout after the public/admin URLs.
- Kept the runtime gateway config and boot flow separated by concern while preserving the embedded reverse-layer approach.

## [2.2.0] - 2026-08-16
### Changed
- **Breaking:** `.env`'s `SIYUAN_WORKSPACE_DIR` is replaced by `WORKSPACE_ROOT`, an absolute host path to the workspace root. `docker-compose.yml` derives both the `siyuan` service's workspace bind mount (`${WORKSPACE_ROOT}/vscode-mcp-supergateway/siyuan-workspace`) and a new read-only `gateway` mount (`${WORKSPACE_ROOT}:/workspace/root:ro`) from it, so only one variable needs to be set.
- `gateway.ts` gained `autoIndexCodebaseMemory()`, which runs `codebase-memory-mcp cli index_repository` against the new `CBM_AUTO_INDEX_PATH` env var (`/workspace/root`) on container startup instead of requiring a manual "Index this project" tool call. It runs detached/non-blocking so a large first index doesn't delay the gateway/proxy from coming up.
- **Breaking:** the aggregated `markdown-vault` upstream (`@wirux/mcp-markdown-vault`) is replaced by a `siyuan-note` upstream (`siyuan-mcp`), talking over REST to a new `siyuan` Docker Compose service (image `b3log/siyuan`, port `6806`). `docker/gateway.config.json` and `src/gateway.ts`'s `buildAdminConfig()` inject `SIYUAN_HOST`/`SIYUAN_PORT`/`SIYUAN_TOKEN` instead of `VAULT_PATH` for that upstream.
- **Breaking:** the local file-based vault subsystem is removed entirely. `src/services/vaultManager.ts` is deleted; a new `src/services/siyuanClient.ts` (`SiyuanClient`) talks to the SiYuan Kernel API (`readDoc`/`writeDoc`/`listNotebooks`) instead. `src/tools/lmstudioLoopback.ts`'s `lmstudio_update_vault_task` tool is replaced by `lmstudio_update_siyuan_task` (`doc_id` + `content`, writes via `SiyuanClient`), `src/services/loopbackWorkflow.ts`'s `LoopbackWorkflow` now reads task docs from SiYuan instead of vault files, and `src/server.ts` drops the `/api/vault/notes*` REST routes.
- `docker-compose.yml`: the `gateway-vault` named volume and its `/app/vault` mount are removed (no longer needed). The `siyuan` service's workspace is now a host bind mount derived from `WORKSPACE_ROOT` instead of the `siyuan-workspace` named volume, so notebooks/docs are directly inspectable/backupable on the host. `gateway-data` is unaffected.
- `.env.example` gained `SIYUAN_TOKEN`, `SIYUAN_LOCKSCREEN_CODE`, and `WORKSPACE_ROOT`. `README.md`, `AGENT_INSTRUCTIONS.md`, and the architecture diagram/tables updated accordingly.

## [2.1.0] - 2026-08-16
### Added
- `codebase-memory-mcp`'s built-in 3D graph-visualization UI is now reachable from outside the container at `http://localhost:9749`. `gateway.ts` writes `ui_enabled`/`ui_port` into the `codebase-memory` upstream's `CBM_CACHE_DIR/config.json` before that upstream's stdio session starts its coordination daemon (the daemon owns and serves the UI, bound to `127.0.0.1` only), then reverse-proxies the published port to it. The proxy binds the container's real interface address (not `0.0.0.0`, which would clash with the daemon's same-port loopback listener) and rewrites the `Origin`/`Referer` headers to `http://127.0.0.1:<port>`, since the daemon's same-origin check rejects the browser's literal `localhost` Origin with a 403. `docker-compose.yml`/`Dockerfile` publish/expose `9749`, configurable via the new `CBM_UI_PORT` env var.

### Changed
- `backend` and `gateway` merged into a single container/process: `server.ts` now exports `startBackendServer()` instead of listening at module scope, and `gateway.ts` calls it directly after starting the forward proxy, sharing `VAULT_PATH` via `process.env` so `VaultManager` and the `markdown-vault` upstream see the same files. `docker-compose.yml` drops the separate `backend` service (image, `8081` port, and its env vars folded into `gateway`), `Dockerfile` now runs `CMD ["node", "dist/gateway.js"]` and exposes `8081` alongside `8080`/`3100`, and `package.json`'s `main` points at `dist/gateway.js`. `node dist/server.js` still works standalone for local dev via a `require.main === module` guard.
- `VaultManager`'s default vault root now resolves from `VAULT_PATH` (falling back to `<repo>/vault`) instead of a `process.cwd()`-relative guess, so it behaves the same whether started standalone or from `gateway.ts`.
- `server.ts` gained a small request-logging middleware and three vault REST routes (`GET/POST /api/vault/notes`, `GET /api/vault/notes/:path`) for manual testing of the merged process.
- `README.md` architecture diagram redrawn (top-down → left-right) to reflect the actual single-process runtime: `gateway.ts` imports and starts `server.ts`'s Express app directly instead of spawning it as a second container, with the scheduler/loopback, MCP aggregate, and upstream MCP servers shown as distinct nodes.
- `README.md` diagram nodes now have explicit `classDef` styling (blue = this repo's code entry points, amber = third-party MCP packages, grey = host-side apps) plus `click` hyperlinks: `Supergateway`/`Loopback` link to `src/gateway.ts`/`src/server.ts`, the upstream nodes link to their npm/PyPI package pages, and the LM Studio nodes link to lmstudio.ai.
- `README.md` Services & Ports section reworded from a per-service table to a per-port table, documenting that `8081` is started in-process via `startBackendServer()` rather than as a separate service, and that both halves share the same `VAULT_PATH`.
- Removed the now-inaccurate "slow `docker compose build`?" tip, which assumed two separately built service targets.

### Added
- Preserved the original prototype work generated by Gemma 4 12B on a dedicated branch before the Docker-only refactor, then merged it back into `main` for provenance and traceability. That prototype:
  - Replaced `VaultService` with a new `VaultManager` service (`src/services/vaultManager.ts`), adding note read/write/list, contract reading, and hand-rolled YAML frontmatter get/update helpers, and rewired `src/server.ts` and `src/tools/lmstudioLoopback.ts` to use it.
  - Added a `LoopbackWorkflow` service (`src/services/loopbackWorkflow.ts`) that reads a vault task, sends it to the LM Studio client with a task-execution system prompt, and returns the result.
- `vscode/tasks.json` reintroduced as a versioned template documenting the workspace-root tasks that call `docker compose up/down` directly for this gateway — not a revival of the host-side scripting removed in 2.0.0.


## [2.0.0] - 2026-08-13
### Removed
- **Breaking:** the `dist/cli.js` CLI wrapper (`up`/`down`) and its `supergateway` bin entry. The workspace `.vscode/tasks.json` now calls `docker compose up -d --build` / `docker compose down` directly (matching the house style already used for other Docker tasks there), so the wrapper added indirection without value for that consumer. Anyone still using `npm run cli -- up/down` or the global `supergateway` bin should switch to `docker compose up -d --build` / `docker compose down` from the repo root.
- **Breaking:** the host-side scripting path — `vscode/supergateway.ps1`, `vscode/supergateway.js`, `vscode/supergateway.config.json`, `vscode/tasks.json`, and the `vscode/data/` log directory. Docker is now the only supported way to run the gateway; there is no scripting outside the container anymore. Upstream wiring lives in `docker/gateway.config.json`, and `.env` replaces the `GITLAB_PAT` process-environment dance (use `GITLAB_PERSONAL_ACCESS_TOKEN` there instead).
- The committed `dist/` build artifacts. `dist/` was already listed in `.gitignore` but had been tracked since before that rule existed; it is excluded from the Docker build context via `.dockerignore` and rebuilt inside the image by `RUN npm run build`, so a host-side copy served no purpose.
- Dead `package.json` entries: the `start` script (nothing invokes it — the Dockerfile uses `CMD ["node", "dist/server.js"]` and Compose sets explicit `command:` values) and the `types` field, which pointed at a `dist/server.d.ts` that was never emitted because `tsconfig.json` does not enable `declaration`.
- `task.allowAutomaticTasks` from `vscode/settings.json`, which only existed for the removed `vscode/tasks.json`.

### Changed
- `README.md` restructured for a linear onboarding path: Docker-only Quick Start (clone → `.env` → `docker compose up -d --build` → connect VS Code), followed by Services & Ports, Configured Upstreams, Key Features, Operations, and a separate "Developing on this repo" section for source builds.
- The architecture Mermaid diagram now draws the Docker Compose boundary explicitly, showing which components are containerized (gateway + all four upstreams, backend) versus host-side (VS Code/Copilot, LM Studio).
- `AGENT_INSTRUCTIONS.md` environment-variable section reduced to the Docker path only.

### Added
- Full Docker packaging: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`, and `docker/gateway.config.json`. One image bundles Node.js, Python, and all four upstream MCP servers (`codebase-memory`, `markdown-vault`, `gitlab`, `markitdown`), so the host needs nothing but Docker.
- `markitdown` upstream, exposing `convert_to_markdown(uri)` for documents, Office files, and PDFs.

### Docs
- Added a disclaimer to `README.md` noting that parts of this repository
  were generated with alternating small local LLMs.

## [1.0.0] - 2026-08-12
### Added
- Initial project setup and directory structure.
- LM Studio REST client with 30s timeout guard and prompt truncation.
- Basic MCP tool registrations for LM Studio loopback (complete, summarize_diff, update_vault_task).
- TypeScript configuration and build pipeline.