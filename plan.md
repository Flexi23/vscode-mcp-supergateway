# Entwicklungsplan: vscode-mcp-supergateway

## 1. Projektübersicht & Ausgangslage

### Projektziel
`vscode-mcp-supergateway` ist eine Visual Studio Code Extension zur nahtlosen Steuerung, Überwachung und Konfiguration von **Supergateway**-Instanzen. Supergateway verbindet Model Context Protocol (MCP) Server über verschiedene Transportschichten (Stdio, SSE, Streamable HTTP, WebSockets) und ermöglicht lokalen sowie Remote-KI-Clients den Zugriff auf MCP-Werkzeuge.

### Aktueller Status & Vorgeschichte
- **Stand gestern**: Ein erster Entwicklungsplan für das Projekt wurde definiert.
- **Lokale LLM-Hürden**: Es traten Start- und Ausführungsprobleme beim Einsatz von `Qwen2.5-Coder` in der lokalen Entwicklungsumgebung auf.
- **Gemma-Implementierungsversuch**: Die Implementierung wurde stattdessen mit Gemma angestoßen (Commit `a37859b6278978c830019ad32aa3a85513169744`).
- **Ergebnis**: Der Code-Push ist unvollständig geblieben und hat das Ziel nicht vollständig erreicht. Unfertige Schnittstellen, fehlende Event-Handler oder unvollständige Typdefinitionen müssen nun konsolidiert werden.

---

## 2. Meilenstein-Übersicht

```
[Phase 0: Audit & Restrukturierung]
       │
       ▼
[Phase 1: Lokale Agenten- & Tooling-Stabilisierung]
       │
       ▼
[Phase 2: Supergateway Process Manager & Core Engine]
       │
       ▼
[Phase 3: VS Code UI, TreeView & Developer Experience]
       │
       ▼
[Phase 4: Fortgeschrittene Features & Security]
       │
       ▼
[Phase 5: Tests, Dokumentation & Release]
```

---

## 3. Detail-Fahrplan (Arbeitspakete)

### Phase 0: Audit & Code-Cleanup (Commit a37859b)
Ziel: Wiederherstellung eines lauffähigen, fehlerfreien Code-Fundaments nach dem abgebrochenen Gemma-Push.

- [ ] **Codebase-Diff-Analyse**:
  - Vergleich von Commit `a37859b6278978c830019ad32aa3a85513169744` mit dem `main`-Branch.
  - Identifikation aller nicht fertiggestellten Methoden, Typ-Fehler (TypeScript) und Platzhalter.
- [ ] **Bereinigung & Typ-Reparatur**:
  - Behebung von Syntax- und Transpilierungsfehlern (`npm run build` / `tsc`).
  - Bereinigung toted Codes oder unvollständiger Importe.
- [ ] **Modul-Isolierung**:
  - Trennung der Kernlogik (Process Spawning, Config Parsing) von der VS Code UI-Logik.

---

### Phase 1: Lokale Agenten- & Tooling-Stabilisierung (Qwen2.5 / Gemma)
Ziel: Stabile lokale Entwicklungsumgebung ohne Abbrüche bei KI-gestützter Code-Generierung.

- [ ] **Qwen2.5-Coder & Local LLM Debugging**:
  - Analyse der Fehlerursachen beim lokalen Betrieb von Qwen2.5-Coder (Ollama / LM Studio / vLLM).
  - Optimierung von Kontextfenster (Context Length), Temperature und System-Prompts für exakten TypeScript-Output.
- [ ] **Agenten-Workflows**:
  - Aufteilung großer Implementierungsschritte in atomare, überprüfbare Teilaufgaben (Prompt Chunking).
  - Einrichtung automatisierter Linting-Checks (`npm run lint`), die vom Agenten nach jedem Schritt ausgeführt werden.

---

### Phase 2: Supergateway Process Manager & Core Engine
Ziel: Robuster Hintergrund-Prozess-Manager zur Ausführung von Supergateway über Node.js `child_process`.

- [ ] **Process Lifecycle Handler**:
  - Starten/Stoppen von Supergateway via `npx -y supergateway` oder lokal installiertem Binärpaket.
  - Unterstützung der Haupt-Modi:
    - **stdio → SSE** (`--stdio "command"` `--port <port>`)
    - **SSE → stdio** (`--sse "https://..."`)
    - **Streamable HTTP → stdio** (`--streamableHttp "https://..."`)
    - **stdio → Streamable HTTP / WS** (`--outputTransport streamableHttp|ws`)
- [ ] **Prozess-Überwachung & Health-Checks**:
  - Überwachung von stdout/stderr zur Statuserkennung.
  - Automatischer Restart-Mechanismus bei unerwartetem Prozess-Beenden.
  - Port-Konflikt-Ermittlung und automatische Zuweisung freier Ports.
- [ ] **Konfigurations-Parser (`settings.json`)**:
  - Definition von VS Code Settings (`mcpSupergateway.defaultPort`, `mcpSupergateway.autoStart`, `mcpSupergateway.customEnv`).

---

### Phase 3: VS Code UI & UI Ergonomie
Ziel: Intuitive visuelle Interaktion in VS Code.

- [ ] **Status Bar Item**:
  - Anzeige des aktuellen Gateway-Status (z. B. `$(radio-tower) MCP Gateway: Running (Port 8000)`).
  - Quick-Pick Menü bei Klick: Starten, Stoppen, Logs öffnen, Konfiguration bearbeiten.
- [ ] **TreeView Explorer in der Sidebar**:
  - Visualisierung aktiver Gateway-Instanzen.
  - Anzeige verbundener Clients und MCP-Tools.
  - Inline-Aktionen: Restart, Pause, Copy Connection URL.
- [ ] **Dedicated Output Channel**:
  - Strukturierte Protokollierung aller Gateway-Events im VS Code Output Panel (`MCP Supergateway`).
  - Syntax-Hervorhebung und Log-Level-Filtering (Debug, Info, Error).

---

### Phase 4: Fortgeschrittene Features & Tunneling
Ziel: Unterstützung professioneller Entwicklungs-Szenarien und erweiterter Modus-Abdeckungen.

- [ ] **Authentifizierung & Header-Verwaltung**:
  - Unterstützung für Bearer-Tokens (`--oauth2Bearer`) und benutzerdefinierte Header (`--header`).
  - Sichere Speicherung sensibler Tokens im VS Code `SecretStorage`.
- [ ] **Tunneling-Integration**:
  - Nahtlose Anbindung an ngrok oder Tailscale zur Veröffentlichung lokaler Stdio-MCP-Server für Remote-Clients.
- [ ] **Integrationstests mit KI-Clients**:
  - Verifizierung der Funktionalität mit Claude Desktop, Cursor, Cline, Roo Code und lokalen MCP Inspector-Tools.

---

### Phase 5: Tests, Dokumentation & Release
Ziel: Hohe Softwarequalität und einfache Benutzung.

- [ ] **Testabdeckung**:
  - Unit-Tests für Process-Manager und Config-Parsing (Vitest / Mocha).
  - End-to-End Extension Host Tests.
- [ ] **Dokumentation & Anleitungen**:
  - Erstellung einer umfassenden `README.md` mit Code-Beispielen und Setup-Guides für lokale KI-Modelle (Qwen2.5-Coder / Gemma).
  - Erstellung eines `CONTRIBUTING.md` Guides.
- [ ] **Packaging & Marketplace Preparation**:
  - Erstellung des `.vsix` Package (`vsce package`).
  - Vorbereitung für die Veröffentlichung im Visual Studio Marketplace / Open VSX.

---

## 4. Sofortige Nächste Schritte (Action Items)

1. **Arbeitsbereich aufräumen**: `git status` und `git diff HEAD~1` ausführen, um alle Änderungen des Gemma-Commits zu inventarisieren.
2. **Build verifizieren**: `npm run build` bzw. `nsc` ausführen, um alle TypeScript-Typfehler des abgebrochenen Stands sichtbar zu machen.
3. **Task 0.1 abschließen**: Den Prozess-Manager refaktoren und sicherstellen, dass `supergateway` sauber als Kindprozess gestartet werden kann.
4. **Qwen2.5 / Gemma Setup validieren**: Ein einfaches Test-Skript ausführen, um die lokale Model-Antwort und Kontext-Stabilität sicherzustellen.
