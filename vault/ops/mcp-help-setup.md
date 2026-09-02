---
title: MCP help setup
tags: [ops, setup, supergateway]
type: reference
created: 2026-09-02
status: in_progress
---

# MCP help setup

This project stores its markdown vault under the git-tracked repository directory so that the local MCP tooling can discover and update help files reliably.

## Required env value

- `MARKDOWN_VAULT_ROOT` = repository-local path to the vault root

## Recommended structure

```text
vscode-mcp-supergateway/
  vault/
    meta/
    help/
    notes/
    templates/
    ops/
    archive/
```

## Reasoning

This layout makes the vault visible to the repo and its tooling while preserving a clear semantic separation between metadata, help, task notes, and operations documentation.
