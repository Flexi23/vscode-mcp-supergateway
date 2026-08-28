import path from 'path';
import { discoverProjectRoots, getIndexJobsSnapshot } from './codebaseMemory';

export enum ProjectRowState {
  unchecked = 'unchecked',
  checking = 'checking',
  indexing = 'indexing',
  active = 'active',
  ingestingSemantics = 'ingesting semantics',
}

export function buildDashboardHtml({
  activeTab = 'msp',
  adminUiPort,
  mspGatewayPort,
  cbmUiPort,
  siyuanPort = 6806,
}: {
  activeTab?: string;
  adminUiPort: number;
  mspGatewayPort: number;
  cbmUiPort: number;
  siyuanPort?: number;
}) {
  const tabs: Record<string, { label: string; href: string; source: string }> = {
    msp: {
      label: 'MSP Stack',
      href: '/msp',
      source: `http://127.0.0.1:${adminUiPort}/msp-admin`,
    },
    cbm: {
      label: 'CBM',
      href: '/cbm',
      source: `http://127.0.0.1:${adminUiPort}/cbm/overview`,
    },
    siyuan: {
      label: 'SiYuan',
      href: '/siyuan',
      source: `http://127.0.0.1:${siyuanPort}/`,
    },
  };

  const safeTab = tabs[activeTab] ? activeTab : 'msp';
  const activeView = tabs[safeTab];
  const buttons = Object.entries(tabs)
    .map(([key, value]) => {
      const selected = key === safeTab ? 'selected' : '';
      return `<a class="nav-button ${selected}" href="${value.href}" rel="noopener noreferrer">${value.label}</a>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Supergateway Dashboard</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #0f172a;
        --panel: rgba(15, 23, 42, 0.75);
        --panel-alt: rgba(30, 41, 59, 0.95);
        --border: rgba(148, 163, 184, 0.3);
        --text: #e2e8f0;
        --muted: #cbd5e1;
        --accent: #38bdf8;
        --accent-strong: #0ea5e9;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Consolas", "SFMono-Regular", "Menlo", monospace;
        background: linear-gradient(180deg, #020817 0%, #0f172a 100%);
        color: var(--text);
      }
      .topbar {
        position: sticky;
        top: 0;
        z-index: 20;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.8rem 1.25rem;
        background: rgba(9, 14, 24, 0.96);
        border-bottom: 1px solid rgba(125, 211, 252, 0.32);
        box-shadow: inset 0 -1px 0 rgba(125, 211, 252, 0.14);
        backdrop-filter: blur(8px);
      }
      .brand {
        display: inline-flex;
        align-items: center;
        margin-right: 0.9rem;
        margin-left: 0.1rem;
        padding: 0.15rem 0.5rem 0.2rem;
        border: 1px solid rgba(125, 211, 252, 0.46);
        border-radius: 0.45rem;
        background: rgba(15, 23, 42, 0.8);
        box-shadow: inset 0 0 0 1px rgba(125, 211, 252, 0.08), 0 0 16px rgba(56, 189, 248, 0.2);
        font-weight: 800;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: #7dd3fc;
        font-size: clamp(1.45rem, 2vw, 2.15rem);
        line-height: 1;
        text-shadow: 0 0 10px rgba(56, 189, 248, 0.9);
        transform: translateY(-1px);
      }
      .nav-button {
        padding: 0.6rem 0.9rem;
        border: 1px solid var(--border);
        border-radius: 0.45rem;
        background: rgba(15, 23, 42, 0.8);
        color: var(--text);
        text-decoration: none;
        transition: 0.2s ease;
        font-size: 0.82rem;
        font-family: "Consolas", "SFMono-Regular", "Menlo", monospace;
        letter-spacing: 0.04em;
        box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.08);
      }
      .nav-button:hover { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.2); }
      .nav-button.selected {
        background: rgba(14, 165, 233, 0.18);
        color: #dbeafe;
        border-color: rgba(56, 189, 248, 0.9);
        box-shadow: inset 0 0 12px rgba(56, 189, 248, 0.2), 0 0 12px rgba(56, 189, 248, 0.14);
        font-weight: 700;
      }
      .content-panel {
        min-height: calc(100vh - 72px);
        display: flex;
        align-items: stretch;
        justify-content: stretch;
        padding: 0.75rem;
      }
      .frame-shell {
        width: 100%;
        min-height: calc(100vh - 88px);
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 0.85rem;
        background: rgba(15, 23, 42, 0.7);
        overflow: hidden;
      }
      .app-iframe {
        display: block;
        width: 100%;
        height: 100%;
        min-height: calc(100vh - 88px);
        border: 0;
        background: #020817;
      }
    </style>
  </head>
  <body>
    <header class="topbar">
      <div class="brand">Supergateway</div>
      ${buttons}
    </header>
    <main class="content-panel">
      <div class="frame-shell">
        <iframe class="app-iframe" src="${activeView.source}" title="${activeView.label} UI" loading="lazy"></iframe>
      </div>
    </main>
  </body>
</html>`;
}

function resolveInitialProjectRowState(project: { status?: string; indexed?: boolean }): string {
  const normalizedStatus = String(project.status ?? '').trim().toLowerCase();
  if (normalizedStatus === 'success' || normalizedStatus === 'indexed' || normalizedStatus === 'ready' || normalizedStatus === 'active') {
    return 'active';
  }
  if (normalizedStatus === 'enriching' || normalizedStatus === 'ingesting' || normalizedStatus === 'ingesting semantics') {
    return 'ingesting semantics';
  }
  if (normalizedStatus === 'indexing') {
    return 'indexing';
  }
  if (normalizedStatus === 'checking') {
    return 'checking';
  }
  if (normalizedStatus === 'idle') {
    return 'idle';
  }
  if (normalizedStatus === 'unchecked' || normalizedStatus === 'pending' || normalizedStatus === '' || normalizedStatus === 'not_started') {
    return 'unchecked';
  }
  return project.indexed ? 'active' : 'unchecked';
}

export function buildCbmOverviewHtml({
  cbmUiPort,
  initialProjects = [],
}: {
  cbmUiPort: number;
  initialProjects?: Array<{ name?: string; project?: string; path?: string; root_path?: string; status?: string; indexed?: boolean }>;
}): string {
  const projectRowsHtml = initialProjects.length > 0
    ? initialProjects.map((project) => {
        const projectName = project.name || project.project || (project.root_path || project.path || '').split(/[\\/]/).filter(Boolean).pop() || 'project';
        const projectPath = project.root_path || project.path || project.project || projectName;
        const encodedPath = encodeURIComponent(projectPath);
        const rowState = resolveInitialProjectRowState(project);
        const statusText = rowState === 'ingesting semantics' ? 'ingesting semantics' : rowState;
        const actionMarkup = rowState === 'active'
          ? `<a class="graph-link" href="http://127.0.0.1:${cbmUiPort}/?tab=graph&project=${encodeURIComponent(projectName)}" target="_blank" rel="noopener noreferrer">Open 3D graph</a>`
          : rowState === 'indexing'
            ? '<span class="muted-action">in progress…</span>'
            : rowState === 'checking'
              ? '<span class="muted-action">checking…</span>'
              : rowState === 'idle'
                ? `<button type="button" class="index-button" data-path="${encodedPath}">Index</button><button type="button" class="semantic-button" data-path="${encodedPath}">Transfer semantic edges</button>`
                : '';
        return `<tr data-path="${encodedPath}" data-indexed="${String(Boolean(project.indexed))}" data-state="${rowState}">
          <td>${projectName}</td>
          <td class="status"><span class="status-pill ${rowState === 'ingesting semantics' ? 'ingesting-semantics' : rowState}">${statusText}</span></td>
          <td class="actions">${actionMarkup}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="3">No projects available yet.</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Codebase Memory — Project Overview</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #0f172a;
        --panel: rgba(15, 23, 42, 0.75);
        --panel-alt: rgba(30, 41, 59, 0.95);
        --border: rgba(148, 163, 184, 0.3);
        --text: #e2e8f0;
        --muted: #cbd5e1;
        --accent: #38bdf8;
        --accent-strong: #0ea5e9;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Consolas", "SFMono-Regular", "Menlo", monospace;
        background: linear-gradient(180deg, #020817 0%, #0f172a 100%);
        color: var(--text);
      }
      .panel { padding: 1rem 1.25rem; }
      h1 { font-size: 1.1rem; margin: 0 0 0.75rem; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
      th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid rgba(148, 163, 184, 0.25); font-size: 0.9rem; }
      td.status { text-transform: capitalize; }
      .status-stack { display: flex; flex-direction: column; gap: 0.3rem; min-width: 120px; }
      .status-pill { display: inline-block; padding: 0.15rem 0.45rem; border-radius: 999px; background: rgba(148, 163, 184, 0.18); border: 1px solid rgba(148, 163, 184, 0.2); }
      .status-pill.unchecked, .status-pill.idle, .status-pill.checking { background: rgba(59, 130, 246, 0.08); border-color: rgba(96, 165, 250, 0.32); color: #bfdbfe; }
      .status-pill.indexing { background: rgba(251, 191, 36, 0.18); border-color: rgba(251, 191, 36, 0.8); color: #fef3c7; box-shadow: 0 0 12px rgba(251, 191, 36, 0.14); }
      .status-pill.active { background: rgba(34, 197, 94, 0.18); border-color: rgba(34, 197, 94, 0.75); color: #dcfce7; box-shadow: 0 0 12px rgba(34, 197, 94, 0.18); }
      .status-pill.ingesting-semantics { background: rgba(168, 85, 247, 0.18); border-color: rgba(168, 85, 247, 0.75); color: #ede9fe; box-shadow: 0 0 12px rgba(168, 85, 247, 0.16); }
      .status-pill.error { background: rgba(239, 68, 68, 0.18); border-color: rgba(239, 68, 68, 0.8); color: #fecaca; }
      .progress { width: 100%; height: 0.52rem; border-radius: 999px; overflow: hidden; background: rgba(148, 163, 184, 0.15); }
      .progress > span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #38bdf8, #a78bfa); }
      .status-stack small { color: #bae6fd; font-weight: 600; }
      tr.indexed-row { background: rgba(34, 197, 94, 0.05); box-shadow: inset 0 0 0 1px rgba(34, 197, 94, 0.2); }
      tr.indexing-row { background: rgba(251, 191, 36, 0.04); box-shadow: inset 0 0 0 1px rgba(251, 191, 36, 0.2); }
      tr.active-row { background: rgba(34, 197, 94, 0.05); box-shadow: inset 0 0 0 1px rgba(34, 197, 94, 0.2); }
      tr.ingesting-row { background: rgba(168, 85, 247, 0.05); box-shadow: inset 0 0 0 1px rgba(168, 85, 247, 0.2); }
      td.actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
      button.index-button, button.semantic-button {
        padding: 0.35rem 0.9rem;
        border-radius: 999px;
        border: 1px solid rgba(148, 163, 184, 0.4);
        background: #38bdf8;
        color: #082f49;
        font-weight: 600;
        cursor: pointer;
      }
      button.semantic-button {
        background: #a78bfa;
        color: #1f113d;
      }
      button.index-button:disabled, button.semantic-button:disabled { opacity: 0.5; cursor: default; }
      .muted-action { color: #cbd5e1; opacity: 0.8; }
      a.graph-link {
        color: #bae6fd;
        text-decoration: none;
        font-weight: 600;
      }
      a.graph-link:hover { text-decoration: underline; }
      .graph-launcher {
        margin: 0 0 1rem;
        display: flex;
        justify-content: flex-start;
      }
      .graph-launch-button {
        display: inline-block;
        padding: 0.55rem 0.9rem;
        border-radius: 999px;
        border: 1px solid rgba(56, 189, 248, 0.5);
        background: rgba(14, 165, 233, 0.12);
        color: #e0f2fe;
        text-decoration: none;
        font-weight: 700;
      }
      .graph-launch-button:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    <div class="panel">
      <h1>Codebase Memory Projects</h1>
      <div class="graph-launcher">
        <a class="graph-launch-button" href="http://127.0.0.1:${cbmUiPort}/?tab=stats" target="_blank" rel="noopener noreferrer">Open graph in new tab</a>
      </div>
      <table>
        <thead><tr><th>Project</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody id="project-table-body">${projectRowsHtml}</tbody>
      </table>
    </div>
    <script>
      const cbmUiPort = ${cbmUiPort};

      function normalizeRowState(status, isIndexed) {
        const normalizedStatus = String(status || '').trim().toLowerCase();
        if (normalizedStatus === 'success' || normalizedStatus === 'indexed' || normalizedStatus === 'ready' || normalizedStatus === 'active') {
          return 'active';
        }
        if (normalizedStatus === 'enriching' || normalizedStatus === 'ingesting' || normalizedStatus === 'ingesting semantics') {
          return 'ingesting semantics';
        }
        if (normalizedStatus === 'indexing') {
          return 'indexing';
        }
        if (normalizedStatus === 'checking') {
          return 'checking';
        }
        if (normalizedStatus === 'idle') {
          return 'idle';
        }
        if (normalizedStatus === 'unchecked' || normalizedStatus === 'pending' || normalizedStatus === 'not_started' || normalizedStatus === '') {
          return 'unchecked';
        }
        if (isIndexed) {
          return 'active';
        }
        return 'unchecked';
      }

      function deriveProjectRowState(project, job) {
        const state = normalizeRowState(job && job.status, Boolean(project && project.indexed));
        if (state === 'active' || state === 'ingesting semantics' || state === 'indexing' || state === 'checking' || state === 'idle') {
          return state;
        }
        if (project && project.indexed) {
          return 'active';
        }
        return 'unchecked';
      }

      function renderStatusCell(statusEl, state, progress) {
        const normalizedState = state === 'active' ? 'active' : state === 'indexing' ? 'indexing' : state === 'ingesting semantics' ? 'ingesting-semantics' : state === 'checking' ? 'checking' : state === 'unchecked' ? 'unchecked' : 'idle';
        const statusText = state === 'ingesting semantics' ? 'ingesting semantics' : state;
        const effectiveProgress = typeof progress === 'number' ? Math.min(100, Math.max(0, Math.round(progress))) : null;
        statusEl.innerHTML = effectiveProgress === null
          ? '<span class="status-pill ' + normalizedState + '">' + statusText + '</span>'
          : '<div class="status-stack"><span class="status-pill ' + normalizedState + '">' + statusText + '</span><div class="progress"><span style="width:' + effectiveProgress + '%"></span></div><small>' + effectiveProgress + '%</small></div>';
      }

      function renderActionsCell(actionsEl, projectName, projectPath, state) {
        const encodedPath = encodeURIComponent(projectPath);
        const graphLink = '<a class="graph-link" href="http://127.0.0.1:' + cbmUiPort + '/?tab=graph&project=' + encodeURIComponent(projectName) + '" target="_blank" rel="noopener noreferrer">Open 3D graph</a>';

        if (state === 'active') {
          actionsEl.innerHTML = graphLink;
          return;
        }

        if (state === 'checking') {
          actionsEl.innerHTML = '<span class="muted-action">checking…</span>';
          return;
        }

        if (state === 'indexing') {
          actionsEl.innerHTML = '<span class="muted-action">in progress…</span>';
          return;
        }

        if (state === 'unchecked') {
          actionsEl.innerHTML = '';
          return;
        }

        if (state === 'idle') {
          actionsEl.innerHTML =
            '<button type="button" class="index-button" data-path="' + encodedPath + '">Index</button>' +
            '<button type="button" class="semantic-button" data-path="' + encodedPath + '">Transfer semantic edges</button>';
          return;
        }

        actionsEl.innerHTML = '';
      }

      function buildRow(project) {
        const projectName = project.name || project.project || (project.root_path || '').split(/[\\/]/).filter(Boolean).pop() || 'project';
        const projectPath = project.root_path || project.path || project.project_root || projectName;
        const encodedPath = encodeURIComponent(projectPath);
        const initialState = normalizeRowState(project.status, Boolean(project.indexed));
        const row = document.createElement('tr');
        row.dataset.path = encodedPath;
        row.dataset.indexed = String(Boolean(project.indexed));
        row.dataset.state = initialState;
        row.classList.toggle('active-row', false);
        row.classList.toggle('indexing-row', false);
        row.classList.toggle('ingesting-row', false);
        row.innerHTML =
          '<td>' + projectName + '</td>' +
          '<td class="status"></td>' +
          '<td class="actions"></td>';
        renderStatusCell(row.querySelector('.status'), initialState, null);
        renderActionsCell(row.querySelector('.actions'), projectName, projectPath, initialState);
        return row;
      }

      async function loadProjects() {
        const res = await fetch('/cbm/projects');
        const payload = await res.json();
        const projects = Array.isArray(payload.projects) ? payload.projects : Array.isArray(payload) ? payload : [];
        const tbody = document.getElementById('project-table-body');
        if (tbody.querySelector('tr[data-path]')) {
          const existingRows = new Map(Array.from(tbody.querySelectorAll('tr[data-path]')).map((row) => [String(row.dataset.path), row]));
          projects.forEach((project) => {
            const projectPath = project.root_path || project.path || project.project || project.name || '';
            const rowKey = encodeURIComponent(projectPath);
            const existingRow = existingRows.get(rowKey);
            if (existingRow) {
              const nextState = normalizeRowState(project.status, Boolean(project.indexed));
              existingRow.dataset.state = nextState;
              existingRow.dataset.indexed = String(Boolean(project.indexed));
              const projectName = project.name || project.project || (project.root_path || '').split(/[\\/]/).filter(Boolean).pop() || 'project';
              existingRow.firstChild.textContent = projectName;
              renderStatusCell(existingRow.querySelector('.status'), nextState, null);
              renderActionsCell(existingRow.querySelector('.actions'), projectName, projectPath, nextState);
              existingRows.delete(rowKey);
              return;
            }
            tbody.appendChild(buildRow(project));
          });
          if (existingRows.size > 0) {
            existingRows.forEach((row) => row.remove());
          }
          return;
        }

        tbody.innerHTML = '';

        if (projects.length === 0) {
          tbody.innerHTML = '<tr><td colspan="3">No projects available yet.</td></tr>';
          return;
        }

        projects.forEach((project) => tbody.appendChild(buildRow(project)));
        runSequentialProjectChecks();
      }

      function runSequentialProjectChecks() {
        const rows = Array.from(document.querySelectorAll('tr[data-path]'));
        if (rows.length === 0) {
          return;
        }

        let currentIndex = 0;
        const step = () => {
          const row = rows[currentIndex];
          if (!row) {
            return;
          }

          const projectPath = decodeURIComponent(row.dataset.path || '');
          const projectName = row.firstChild && row.firstChild.textContent ? row.firstChild.textContent : projectPath.split(/[\\/]/).filter(Boolean).pop() || 'project';
          const finalState = row.dataset.indexed === 'true' ? 'active' : 'idle';

          row.dataset.state = 'checking';
          row.classList.toggle('active-row', false);
          row.classList.toggle('indexing-row', false);
          row.classList.toggle('ingesting-row', false);
          renderStatusCell(row.querySelector('.status'), 'checking', null);
          renderActionsCell(row.querySelector('.actions'), projectName, projectPath, 'checking');

          setTimeout(() => {
            row.dataset.state = finalState;
            row.classList.toggle('active-row', finalState === 'active');
            row.classList.toggle('indexing-row', false);
            row.classList.toggle('ingesting-row', false);
            row.dataset.indexed = String(finalState === 'active');
            renderStatusCell(row.querySelector('.status'), finalState, null);
            renderActionsCell(row.querySelector('.actions'), projectName, projectPath, finalState);

            currentIndex += 1;
            if (currentIndex < rows.length) {
              setTimeout(step, 45);
            }
          }, 120);
        };

        setTimeout(step, 20);
      }

      async function refreshStatus() {
        const res = await fetch('/cbm/index-status');
        const jobs = await res.json();
        document.querySelectorAll('tr[data-path]').forEach((row) => {
          const projectPath = decodeURIComponent(row.dataset.path || '');
          const rowProject = row.__project || null;
          const job = jobs[projectPath] || null;
          const isIndexed = row.dataset.indexed === 'true';
          const state = deriveProjectRowState(rowProject || { indexed: isIndexed }, job);
          const progress = job && typeof job.progress === 'number' ? job.progress : null;

          row.dataset.state = state;
          row.classList.toggle('active-row', state === 'active');
          row.classList.toggle('indexing-row', state === 'indexing');
          row.classList.toggle('ingesting-row', state === 'ingesting semantics');
          row.classList.toggle('indexed-row', state === 'active');
          renderStatusCell(row.querySelector('.status'), state, progress);
          const projectName = row.firstChild && row.firstChild.textContent ? row.firstChild.textContent : projectPath.split(/[\\/]/).filter(Boolean).pop() || 'project';
          renderActionsCell(row.querySelector('.actions'), projectName, projectPath, state);
        });
      }

      document.addEventListener('click', async (event) => {
        const button = event.target.closest('.index-button');
        if (button) {
          const row = button.closest('tr');
          const statusEl = row && row.querySelector('.status');
          if (statusEl) {
            renderStatusCell(statusEl, 'Indexing Started', 0);
          }
          button.disabled = true;
          try {
            await fetch('/cbm/index?path=' + encodeURIComponent(decodeURIComponent(button.dataset.path || '')), { method: 'POST' });
          } finally {
            button.disabled = false;
            refreshStatus();
          }
          return;
        }

        const semanticButton = event.target.closest('.semantic-button');
        if (semanticButton) {
          semanticButton.disabled = true;
          try {
            await fetch('/cbm/enrich?path=' + encodeURIComponent(decodeURIComponent(semanticButton.dataset.path || '')), { method: 'POST' });
          } finally {
            semanticButton.disabled = false;
            refreshStatus();
          }
        }
      });

      function connectProgressSocket() {
        const ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/cbm/progress');
        ws.addEventListener('message', (event) => {
          try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'snapshot') {
              Object.entries(payload.jobs || {}).forEach(([path, job]) => {
                const row = document.querySelector('tr[data-path="' + encodeURIComponent(path) + '"]');
                if (!row) return;
                const statusEl = row.querySelector('.status');
                if (!statusEl) return;

                const progress = job && typeof job.progress === 'number' ? job.progress : null;
                const state = deriveProjectRowState({ indexed: row.dataset.indexed === 'true' }, job);
                row.dataset.state = state;
                row.classList.toggle('active-row', state === 'active');
                row.classList.toggle('indexing-row', state === 'indexing');
                row.classList.toggle('ingesting-row', state === 'ingesting semantics');
                row.classList.toggle('indexed-row', state === 'active');
                renderStatusCell(statusEl, state, progress);
                const projectName = row.firstChild && row.firstChild.textContent ? row.firstChild.textContent : 'project';
                const projectPath = decodeURIComponent(row.dataset.path || '');
                renderActionsCell(row.querySelector('.actions'), projectName, projectPath, state);
              });
              return;
            }

            if (payload.type === 'update' && payload.repoPath) {
              const row = document.querySelector('tr[data-path="' + encodeURIComponent(payload.repoPath) + '"]');
              if (!row) return;
              const statusEl = row.querySelector('.status');
              if (!statusEl) return;
              const job = payload.job || {};
              const state = deriveProjectRowState({ indexed: row.dataset.indexed === 'true' }, job);
              row.dataset.state = state;
              row.classList.toggle('active-row', state === 'active');
              row.classList.toggle('indexing-row', state === 'indexing');
              row.classList.toggle('ingesting-row', state === 'ingesting semantics');
              row.classList.toggle('indexed-row', state === 'active');
              renderStatusCell(statusEl, state, job.progress ?? null);
              const projectName = row.firstChild && row.firstChild.textContent ? row.firstChild.textContent : 'project';
              const projectPath = decodeURIComponent(row.dataset.path || '');
              renderActionsCell(row.querySelector('.actions'), projectName, projectPath, state);
            }
          } catch (error) {
            console.warn('failed to parse progress update', error);
          }
        });
        ws.addEventListener('close', () => {
          setTimeout(connectProgressSocket, 1500);
          setTimeout(() => refreshStatus(), 500);
        });
      }

      connectProgressSocket();
      loadProjects();
      refreshStatus();
    </script>
  </body>
</html>`;
}
