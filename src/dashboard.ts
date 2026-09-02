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
  inlineMspAdmin,
}: {
  activeTab?: string;
  adminUiPort: number;
  mspGatewayPort: number;
  cbmUiPort: number;
  siyuanPort?: number;
  inlineMspAdmin?: { css: string; body: string };
}) {
  const tabs: Record<string, { label: string; href: string; source: string }> = {
    msp: {
      label: 'MSP Stack',
      href: '/msp',
      // Trailing slash avoids the upstream's own redirect round-trip on every load.
      source: `http://127.0.0.1:${adminUiPort}/msp-admin/`,
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
      #msp-admin-root {
        width: 100%;
        min-height: calc(100vh - 88px);
        overflow: auto;
      }
      ${inlineMspAdmin?.css ?? ''}
    </style>
  </head>
  <body>
    <header class="topbar">
      <div class="brand">Supergateway</div>
      ${buttons}
    </header>
    <main class="content-panel">
      <div class="frame-shell">
        ${safeTab === 'msp' && inlineMspAdmin
          ? `<div id="msp-admin-root">${inlineMspAdmin.body}</div>`
          : `<iframe class="app-iframe" src="${activeView.source}" title="${activeView.label} UI" loading="lazy"></iframe>`}
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
        const actionMarkup = rowState === 'active'
          ? `<a class="text-action graph-link" href="/cbm/graph?tab=graph&project=${encodeURIComponent(projectName)}" target="_blank" rel="noopener noreferrer">Open 3D graph</a><a class="text-action semantic-button" href="#" data-path="${encodedPath}">Transfer semantic edges</a>`
          : rowState === 'indexing'
            ? '<span class="muted-action">indexing…</span>'
            : rowState === 'ingesting semantics'
              ? '<span class="muted-action">ingesting semantics…</span>'
              : rowState === 'checking'
                ? '<span class="muted-action">checking…</span>'
                : rowState === 'idle' || rowState === 'unchecked'
                  ? `<a class="text-action index-button" href="#" data-path="${encodedPath}">Add to Index</a>`
                  : '<span class="muted-action">—</span>';
        return `<tr data-path="${encodedPath}" data-indexed="${String(Boolean(project.indexed))}" data-state="${rowState}">` +
          `<td class="name">${projectName}</td>` +
          `<td class="actions"><div class="actions-inner">${actionMarkup}</div></td>` +
          `</tr>`;
      }).join('')
    : '<tr><td colspan="2">No projects available yet.</td></tr>';


  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Codebase Memory — Project Overview</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0f1419; --panel: #171d24; --panel2: #1e2630; --border: #2a3441;
        --text: #d8dee6; --muted: #8a97a5; --accent: #4da3ff; --ok: #3fb96a;
        --warn: #e0a23c; --err: #e05c5c; --radius: 8px;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      .panel { padding: 18px 22px; max-width: 1200px; }
      h2 { font-size: 14px; margin: 0 0 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
      section.panel { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: middle; }
      th { color: var(--muted); font-weight: 500; font-size: 12px; }
      col.col-name { width: 60%; }
      col.col-actions { width: 40%; }
      tr:last-child td { border-bottom: none; }
      tbody tr:hover { background: rgba(77, 163, 255, 0.06); }
      td.name { font-weight: 600; }
      tr.indexed-row, tr.active-row { background: rgba(63, 185, 106, 0.06); }
      tr.indexing-row { background: rgba(224, 162, 60, 0.06); }
      tr.ingesting-row { background: rgba(77, 163, 255, 0.06); }
      .actions-inner { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .text-action {
        color: var(--text);
        text-decoration: underline;
        text-underline-offset: 0.18em;
        text-decoration-thickness: 1px;
        font-size: 12px;
        line-height: 1.4;
        cursor: pointer;
        opacity: 0.9;
      }
      .text-action:hover { opacity: 1; }
      .text-action:visited { color: var(--text); }
      .muted-action { color: var(--muted); }
      .graph-launcher { margin: 0 0 16px; display: flex; justify-content: flex-start; }
    </style>
  </head>
  <body>
    <div class="panel">
      <h2>Codebase Memory Projects</h2>
      <section class="panel">
      <table>
        <colgroup><col class="col-name"><col class="col-actions"></colgroup>
        <thead><tr><th>Project</th><th>Actions</th></tr></thead>
        <tbody id="project-table-body">${projectRowsHtml}</tbody>
      </table>
      </section>
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

      function renderActionsCell(actionsEl, projectName, projectPath, state, progress) {
        const encodedPath = encodeURIComponent(projectPath);
        const graphLink = '<a class="text-action graph-link" href="/cbm/graph?tab=graph&project=' + encodeURIComponent(projectName) + '" target="_blank" rel="noopener noreferrer">Open 3D graph</a>';
        const effectiveProgress = typeof progress === 'number' ? Math.min(100, Math.max(0, Math.round(progress))) : null;
        const progressSuffix = effectiveProgress === null ? '' : ' ' + effectiveProgress + '%';

        const setInner = (html) => {
          actionsEl.innerHTML = '<div class="actions-inner">' + html + '</div>';
        };

        if (state === 'active') {
          setInner(graphLink + '<a class="text-action semantic-button" href="#" data-path="' + encodedPath + '">Transfer semantic edges</a>');
          return;
        }

        if (state === 'checking') {
          setInner('<span class="muted-action">checking…</span>');
          return;
        }

        if (state === 'indexing') {
          setInner('<span class="muted-action">indexing…' + progressSuffix + '</span>');
          return;
        }

        if (state === 'ingesting semantics') {
          setInner('<span class="muted-action">ingesting semantics…' + progressSuffix + '</span>');
          return;
        }

        if (state === 'unchecked' || state === 'idle') {
          setInner('<a class="text-action index-button" href="#" data-path="' + encodedPath + '">Add to Index</a>');
          return;
        }

        setInner('<span class="muted-action">—</span>');
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
        row.classList.toggle('active-row', initialState === 'active');
        row.classList.toggle('indexing-row', initialState === 'indexing');
        row.classList.toggle('ingesting-row', initialState === 'ingesting semantics');
        row.innerHTML =
          '<td class="name">' + projectName + '</td>' +
          '<td class="actions"></td>';
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
              const nameCell = existingRow.querySelector('.name');
              if (nameCell) {
                nameCell.textContent = projectName;
              }
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
          tbody.innerHTML = '<tr><td colspan="2">No projects available yet.</td></tr>';
          return;
        }

        projects.forEach((project) => tbody.appendChild(buildRow(project)));
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
          const projectName = row.firstChild && row.firstChild.textContent ? row.firstChild.textContent : projectPath.split(/[\\/]/).filter(Boolean).pop() || 'project';
          renderActionsCell(row.querySelector('.actions'), projectName, projectPath, state, progress);
        });
      }

      document.addEventListener('click', async (event) => {
        const button = event.target.closest('.index-button');
        if (button) {
          event.preventDefault();
          const row = button.closest('tr');
          if (row) {
            const projectPath = decodeURIComponent(row.dataset.path || '');
            const projectName = row.firstChild && row.firstChild.textContent ? row.firstChild.textContent : 'project';
            renderActionsCell(row.querySelector('.actions'), projectName, projectPath, 'indexing', 0);
          }
          button.setAttribute('aria-disabled', 'true');
          try {
            await fetch('/cbm/index?path=' + encodeURIComponent(decodeURIComponent(button.dataset.path || '')), { method: 'POST' });
          } finally {
            button.removeAttribute('aria-disabled');
            refreshStatus();
          }
          return;
        }

        const semanticButton = event.target.closest('.semantic-button');
        if (semanticButton) {
          event.preventDefault();
          semanticButton.setAttribute('aria-disabled', 'true');
          try {
            await fetch('/cbm/enrich?path=' + encodeURIComponent(decodeURIComponent(semanticButton.dataset.path || '')), { method: 'POST' });
          } finally {
            semanticButton.removeAttribute('aria-disabled');
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

                const progress = job && typeof job.progress === 'number' ? job.progress : null;
                const state = deriveProjectRowState({ indexed: row.dataset.indexed === 'true' }, job);
                row.dataset.state = state;
                row.classList.toggle('active-row', state === 'active');
                row.classList.toggle('indexing-row', state === 'indexing');
                row.classList.toggle('ingesting-row', state === 'ingesting semantics');
                row.classList.toggle('indexed-row', state === 'active');
                const projectName = row.firstChild && row.firstChild.textContent ? row.firstChild.textContent : 'project';
                const projectPath = decodeURIComponent(row.dataset.path || '');
                renderActionsCell(row.querySelector('.actions'), projectName, projectPath, state, progress);
              });
              return;
            }

            if (payload.type === 'update' && payload.repoPath) {
              const row = document.querySelector('tr[data-path="' + encodeURIComponent(payload.repoPath) + '"]');
              if (!row) return;
              const job = payload.job || {};
              const state = deriveProjectRowState({ indexed: row.dataset.indexed === 'true' }, job);
              row.dataset.state = state;
              row.classList.toggle('active-row', state === 'active');
              row.classList.toggle('indexing-row', state === 'indexing');
              row.classList.toggle('ingesting-row', state === 'ingesting semantics');
              row.classList.toggle('indexed-row', state === 'active');
              const projectName = row.firstChild && row.firstChild.textContent ? row.firstChild.textContent : 'project';
              const projectPath = decodeURIComponent(row.dataset.path || '');
              renderActionsCell(row.querySelector('.actions'), projectName, projectPath, state, job.progress ?? null);
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
