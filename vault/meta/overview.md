---
schema_version: 3
vault_scope: "vscode-mcp-supergateway"
updated_at: 2026-09-02T00:00:00Z
managed_by: host
---

# Vault Overview

This repo-local vault is the machine-readable knowledge base for the integrated MCP tooling and the local online help for the supergateway project. It lives inside the git-tracked project directory on purpose so that agents, docs tooling, and local MCP clients can read and update it without leaving the repository boundary.

## Directory semantics

- `meta/` – vault contract, schema, and global overview metadata; this is where the machine-readable conventions live.
- `help/` – user-facing online help, operational notes, and quick-reference documentation for local agents and operators.
- `templates/` – reusable note/task/ADR templates that match the project’s preferred structure.
- `notes/` – hand-written project notes, task write-ups, and working instructions.
- `ops/` – operational playbooks, incident notes, and environment-specific runbooks.
- `archive/` – superseded or historical content that should remain discoverable but not active in the default help flow.

## Why the vault is repo-local

The vault root is intentionally pinned to the project directory instead of a system-wide or host-scoped folder. This keeps the knowledge index reproducible, allows Git-based review of help changes, and makes external MCP tools behave consistently across local machines and contributor environments.

## Help expectations

- Keep content in Markdown.
- Prefer short, explicit sections and meaningful headings.
- Store operational details in `help/` or `ops/`, not in ad hoc root files.
- Use `meta/` for schema and contract-level rules only.
