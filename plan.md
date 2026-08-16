# System Role
You are an expert TypeScript and C# developer specializing in VS Code Extension development, Language Server Protocol (LSP), and the Model Context Protocol (MCP).

# Context
I am developing `vscode-mcp-supergateway`, a central Multi-Client MCP Gateway. Currently, I am building a "codebase memory graph" to visualize and index workspaces in a 3D graph (using nodes and edges).

My indexer already runs on workspace binding and successfully extracts all C# files as independent `nodes` in my 3D cloud. However, I am missing the `edges` (dependencies/connections) between these C# files. Because C# uses implicit references via namespaces (unlike explicit `import` statements in JS/TS), a simple Regex or string-matching parser fails to build accurate connections.

# Task
I want to implement a robust solution to extract cross-file dependencies and generate the `edges` for my graph. Since this is running inside a VS Code extension, the most elegant and precise way is to leverage the active C# Language Server (OmniSharp or C# Dev Kit) via VS Code's built-in provider APIs, rather than building a standalone Roslyn analyzer from scratch.

Please provide a TypeScript implementation for my VS Code extension that:
1. Takes a list of indexed C# file URIs (`nodes`).
2. Programmatically queries the C# Language Server using VS Code's built-in commands (e.g., `vscode.executeDocumentSymbolProvider` combined with `vscode.executeReferenceProvider` or `vscode.executeDefinitionProvider`).
3. Maps these references/definitions back to other files in the workspace to construct the `edges`.
4. Outputs the final result as a standard graph links array: `[{ "source": "FileA.cs", "target": "FileB.cs", "weight": 1 }]`.

# Constraints & Environment
- **LLM/Hardware Context:** I am running a local LM Studio worker (Gemma 4 12B, 100k context) on a machine with an i9, 16GB System RAM, and an 8GB VRAM RTX 2070. The extraction process should be hardware-aware — meaning the TypeScript implementation should use batching, pagination, or async generators so it doesn't freeze the VS Code extension host or overload the system when querying hundreds of files.
- Ensure the code checks if the C# extension is active/ready before querying.
- Keep the code modular so I can easily integrate it into my existing indexer loop.
- Focus on extracting structural dependencies (e.g., Class A in File 1 uses Class B in File 2).

# Output Request
Provide the complete, documented TypeScript module, along with a brief explanation of how the VS Code API calls are chained together to mimic Roslyn's semantic dependency resolution.