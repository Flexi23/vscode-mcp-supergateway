---
title: Vault Policy
tags: [policy, vault, supergateway]
type: reference
created: 2026-09-02
status: draft
---

# Vault Policy

This project keeps its markdown vault inside the git-tracked repository so that local MCP tools, agents, and contributors all use the same canonical help location. The vault is not a system-wide or host-scoped directory; it is scoped to the project itself.

## Canonical root

The canonical environment variable is `MARKDOWN_VAULT_ROOT`. It must point to the repository-local vault directory, for example:

```text
C:\gitlab.uni-rostock.de\limati-inf\vscode-mcp-supergateway\vault
```

This keeps the vault discoverable in Git, reviewable in pull requests, and stable for local tooling.

## Directory semantics

- `meta/` — schema, contract, and global policy metadata for the vault itself.
- `help/` — user-facing and agent-facing help, quick references, and onboarding guidance.
- `notes/` — working notes, task write-ups, and project discussion snapshots.
- `templates/` — reusable note and task templates.
- `ops/` — operational procedures, troubleshooting, and environment-specific runbooks.
- `archive/` — historical or superseded content kept for context without blocking the active workflow.

## Generation vs. source-of-truth

The directories above are the source-of-truth for project knowledge and help. The generated cache directory `.markdown_vault_mcp/` is machine-generated state used for indexing and semantic lookup; it must remain local and excluded from version control.

## Principles

- Keep the vault inside the repository root.
- Keep tracked content in Markdown.
- Keep generated index/cache data out of Git.
- Prefer clear, descriptive folder names over ad hoc files in the root.
