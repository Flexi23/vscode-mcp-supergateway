---
title: Local Agent Help
tags: [help, supergateway, mcp]
type: reference
created: 2026-09-02
status: in_progress
---

# Local Agent Help

This vault is the repo-local knowledge base for the supergateway project. It is intentionally stored inside the tracked repository so that integrated MCP tooling, local agents, and contributors can all find the same documentation without leaving the project root.

## Vault purpose

- Keep operational guidance near the code it describes.
- Provide stable, markdown-based context for local MCP tools.
- Preserve project help in a Git-visible location for review and auditing.

## Directory semantics

- `meta/` — schema and system-level vault contract.
- `help/` — user guidance and runbooks for operators and AI agents.
- `notes/` — working notes and project discussion snapshots.
- `templates/` — reusable note/task templates.
- `ops/` — operational procedures and troubleshooting.
- `archive/` — historical content kept for context but not used by the primary flow.

## Repository-local expectations

- Do not move the vault outside the repository root.
- Keep the path aligned with the single canonical variable `MARKDOWN_VAULT_ROOT` in the environment config.
- When the help content changes, document the reason and keep the structure visible.
