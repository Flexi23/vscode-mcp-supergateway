import path from 'path';
import { discoverProjectRoots, getIndexJobsSnapshot } from './codebaseMemory';

export function buildDashboardHtml({
  activeTab = 'admin',
  adminUiPort,
  cbmUiPort,
}: {
  activeTab?: string;
  adminUiPort: number;
  cbmUiPort: number;
}) {
  const tabs: Record<string, { label: string; url: string }> = {
    admin: { label: 'MSPStack', url: `http://127.0.0.1:${adminUiPort}/admin` },
    cbm: { label: 'CBM', url: `http://127.0.0.1:${adminUiPort}/cbm/overview` },
    siyuan: { label: 'SiYuan', url: 'http://127.0.0.1:6806/' },
  };

  const safeTab = tabs[activeTab] ? activeTab : 'admin';
  const buttons = Object.entries(tabs)
    .map(([key, value]) => {
      const selected = key === safeTab ? 'selected' : '';
      return `<a class="nav-button ${selected}" href="http://127.0.0.1:${adminUiPort}/?tab=${key}">${value.label}</a>`;
    })
    .join('');
  const externalGraphButton = `<a class="nav-button" href="http://127.0.0.1:${cbmUiPort}/" target="_blank" rel="noopener noreferrer">3D Graph</a>`;

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
      .frame-shell {
        height: calc(100vh - 72px);
        padding: 1rem;
      }
      iframe {
        width: 100%;
        height: 100%;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: white;
      }
    </style>
  </head>
  <body>
    <header class="topbar">
      <div class="brand">Supergateway</div>
      ${buttons}
      ${externalGraphButton}
    </header>
    <div class="frame-shell">
      <iframe
        title="hosted ui"
        src="${tabs[safeTab].url}"
        referrerpolicy="no-referrer-when-downgrade"
      ></iframe>
    </div>
  </body>
</html>`;
}

export function buildCbmOverviewHtml({
  cbmDefaultPath,
  cbmHostWorkspaceDir,
  cbmUiPort,
}: {
  cbmDefaultPath: string;
  cbmHostWorkspaceDir: string;
  cbmUiPort: number;
}): string {
  const repoPaths = discoverProjectRoots(cbmDefaultPath);
  const jobs = getIndexJobsSnapshot();

  const rows = repoPaths
    .map((repoPath) => {
      const name = path.basename(repoPath) || 'workspace';
      const encodedPath = encodeURIComponent(repoPath);
      const job = jobs[repoPath];
      const status = job?.status ?? 'idle';
      const progress = typeof job?.progress === 'number' ? Math.min(100, Math.max(0, Math.round(job.progress))) : null;
      const statusDisplay = progress === null
        ? `<span class="status-pill">${status}</span>`
        : `<div class="status-stack"><span class="status-pill">${status}</span><div class="progress"><span style="width:${progress}%"></span></div><small>${progress}%</small></div>`;
      const isIndexed = status === 'success';
      const indexButton = isIndexed ? '' : `<button type="button" class="index-button" data-path="${encodedPath}">Index</button>`;
      const enrichButton = isIndexed
        ? `<button type="button" class="semantic-button" data-path="${encodedPath}">Transfer semantic edges</button>`
        : '';
      const graphLink = isIndexed
        ? `<a class="graph-link" href="http://127.0.0.1:${cbmUiPort}/" target="_blank" rel="noopener noreferrer">Open 3D graph</a>`
        : '';

      return `<tr data-path="${encodedPath}">
        <td>${name}</td>
        <td class="path">${repoPath}</td>
        <td class="status">${statusDisplay}</td>
        <td class="actions">
          ${indexButton}
          ${enrichButton}
          ${graphLink}
        </td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Codebase Memory — Project Overview</title>
    <style>
      body { margin: 0; font-family: "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; }
      .panel { padding: 1rem 1.25rem; }
      h1 { font-size: 1.1rem; margin: 0 0 0.75rem; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
      th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid rgba(148, 163, 184, 0.25); font-size: 0.9rem; }
      td.path { color: #94a3b8; font-family: monospace; }
      td.status { text-transform: capitalize; }
      .status-stack { display: flex; flex-direction: column; gap: 0.3rem; min-width: 120px; }
      .status-pill { display: inline-block; padding: 0.15rem 0.45rem; border-radius: 999px; background: rgba(148, 163, 184, 0.18); border: 1px solid rgba(148, 163, 184, 0.2); }
      .progress { width: 100%; height: 0.52rem; border-radius: 999px; overflow: hidden; background: rgba(148, 163, 184, 0.15); }
      .progress > span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #38bdf8, #a78bfa); }
      .status-stack small { color: #bae6fd; font-weight: 600; }
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
      a.graph-link {
        color: #bae6fd;
        text-decoration: none;
        font-weight: 600;
      }
      a.graph-link:hover { text-decoration: underline; }
      iframe { width: 100%; height: 70vh; border: 1px solid rgba(148, 163, 184, 0.3); border-radius: 12px; background: white; }
    </style>
  </head>
  <body>
    <div class="panel">
      <h1>${cbmHostWorkspaceDir}</h1>
      <table>
        <thead><tr><th>Project</th><th>Path</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <iframe title="codebase memory graph" src="http://127.0.0.1:${cbmUiPort}/?tab=stats"></iframe>
    </div>
    <script>
      async function refreshStatus() {
        const res = await fetch('/cbm/index-status');
        const jobs = await res.json();
        document.querySelectorAll('tr[data-path]').forEach((row) => {
          const path = decodeURIComponent(row.dataset.path || '');
          const job = jobs[path];
          const status = job ? job.status : 'idle';
          const progress = job && typeof job.progress === 'number' ? Math.min(100, Math.max(0, Math.round(job.progress))) : null;
          const statusHtml = progress === null
            ? '<span class="status-pill">' + status + '</span>'
            : '<div class="status-stack"><span class="status-pill">' + status + '</span><div class="progress"><span style="width:' + progress + '%"></span></div><small>' + progress + '%</small></div>';
          row.querySelector('.status').innerHTML = statusHtml;
        });
      }
      document.querySelectorAll('.index-button').forEach((button) => {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await fetch('/cbm/index?path=' + button.dataset.path, { method: 'POST' });
          } finally {
            button.disabled = false;
            refreshStatus();
          }
        });
      });
      document.querySelectorAll('.semantic-button').forEach((button) => {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await fetch('/cbm/enrich?path=' + button.dataset.path, { method: 'POST' });
          } finally {
            button.disabled = false;
            refreshStatus();
          }
        });
      });
      setInterval(refreshStatus, 2000);
      refreshStatus();
    </script>
  </body>
</html>`;
}
