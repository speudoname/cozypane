// CozyPane Admin SPA

// Admin SPA may be served from admin.cozypane.com but API lives at api.cozypane.com
const API = window.location.origin.replace('admin.', 'api.');

// Auth: the /auth/admin-callback endpoint sets an HttpOnly cookie named
// `admin_session`. This SPA cannot read HttpOnly cookies (that's the point),
// so we just set `credentials: 'include'` on every API fetch and let the
// browser send the cookie automatically. There is no token in localStorage
// or in the URL fragment anywhere — the old `?token=`/`#token=` flow has
// been removed.

// --- API ---

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  // Only set Content-Type for requests that have a body
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers,
    credentials: 'include',
  });
  if (res.status === 401 || res.status === 403) {
    showLogin();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || res.statusText);
  }
  return res.json();
}

// --- Auth ---

function showLogin() {
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'block';
}

function showApp() {
  document.getElementById('app').style.display = 'flex';
  document.getElementById('login-screen').style.display = 'none';
}

function doLogin() {
  // Fetch admin client ID from the API so it's not hardcoded
  const domain = window.location.hostname.replace('admin.', '');
  const redirect = encodeURIComponent(`${API}/auth/admin-callback`);
  fetch(`${API}/auth/admin-client-id`)
    .then(r => r.json())
    .then(data => {
      window.location.href = `https://github.com/login/oauth/authorize?client_id=${data.clientId}&redirect_uri=${redirect}&scope=read:user`;
    })
    .catch(() => alert('Failed to get OAuth config'));
}

async function checkAuth() {
  // The cookie is HttpOnly — we can't read it. Just hit /admin/stats and
  // see if the server rejects us. If it does, show the login screen.
  try {
    await api('/admin/stats');
    showApp();
    return true;
  } catch {
    showLogin();
    return false;
  }
}

// OAuth callback no longer needs client-side handling: /auth/admin-callback
// on the server sets the admin_session cookie and redirects back to
// /admin/. The SPA just calls checkAuth() on boot.
// This stub exists only to clear any legacy localStorage entries from
// previous sessions.
function clearLegacyStorage() {
  try { localStorage.removeItem('admin_token'); } catch { /* ignore */ }
}

let healthInterval = null;

// --- Rendering ---

const $ = (id) => document.getElementById(id);
const html = (el, content) => { el.innerHTML = content; };

function setActive(page) {
  document.querySelectorAll('.nav-link').forEach(a => {
    a.classList.toggle('active', a.dataset.page === page);
  });
}

function badge(status) {
  return `<span class="badge badge-${status}">${status}</span>`;
}

function formatDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// --- Pages ---

async function renderDashboard() {
  setActive('dashboard');
  const stats = await api('/admin/stats');
  const statusEntries = Object.entries(stats.byStatus || {});
  const tierEntries = Object.entries(stats.byTier || {});

  html($('content'), `
    <h3>Dashboard</h3>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">Total Users</div>
        <div class="value">${stats.totalUsers}</div>
      </div>
      <div class="stat-card">
        <div class="label">Total Deployments</div>
        <div class="value">${stats.totalDeployments}</div>
      </div>
      <div class="stat-card">
        <div class="label">Databases</div>
        <div class="value">${stats.totalDatabases || 0}</div>
      </div>
      ${statusEntries.map(([s, c]) => `
        <div class="stat-card">
          <div class="label">${s}</div>
          <div class="value">${c}</div>
        </div>
      `).join('')}
    </div>
    ${tierEntries.length ? `
      <h3>By Tier</h3>
      <div class="stats-grid">
        ${tierEntries.map(([t, c]) => `
          <div class="stat-card">
            <div class="label">${t}</div>
            <div class="value">${c}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `);
}

let usersPage = 1;
let usersSearch = '';

async function renderUsers() {
  setActive('users');
  const data = await api(`/admin/users?page=${usersPage}&limit=20&search=${encodeURIComponent(usersSearch)}`);

  html($('content'), `
    <h3>Users (${data.total})</h3>
    <div class="toolbar">
      <input type="text" id="user-search" placeholder="Search users..." value="${usersSearch}">
    </div>
    <table>
      <thead><tr>
        <th>User</th><th>Deployments</th><th>Running</th><th>Admin</th><th>Joined</th><th>Actions</th>
      </tr></thead>
      <tbody>
        ${data.users.map(u => `
          <tr>
            <td>
              <div style="display:flex;align-items:center;gap:0.5rem">
                ${u.avatarUrl ? `<img src="${u.avatarUrl}" width="24" height="24" style="border-radius:50%">` : ''}
                <a href="#/users/${u.id}" class="user-link">${u.username}</a>
              </div>
            </td>
            <td>${u.deploymentCount}</td>
            <td>${u.runningCount}</td>
            <td>${u.isAdmin ? 'Yes' : '-'}</td>
            <td>${formatDate(u.createdAt)}</td>
            <td>
              <div class="btn-group">
                <button class="btn btn-sm" onclick="toggleAdmin(${u.id}, ${!u.isAdmin})">${u.isAdmin ? 'Revoke Admin' : 'Make Admin'}</button>
                <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id}, '${u.username}')">Delete</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${renderPagination(data.total, data.page, data.limit, 'usersGoTo')}
  `);

  $('user-search').addEventListener('input', debounce(e => {
    usersSearch = e.target.value;
    usersPage = 1;
    renderUsers();
  }, 300));
}

async function renderUserDetail(id) {
  setActive('users');
  const user = await api(`/admin/users/${id}`);

  html($('content'), `
    <a href="#/users" class="back-link">&larr; Back to Users</a>
    <div class="detail-header">
      ${user.avatarUrl ? `<img src="${user.avatarUrl}">` : ''}
      <div>
        <h2>${user.username}</h2>
        ${user.isAdmin ? '<span class="badge badge-running">admin</span>' : ''}
      </div>
    </div>
    <div class="detail-meta">
      <div class="item"><div class="label">GitHub ID</div>${user.githubId}</div>
      <div class="item"><div class="label">Joined</div>${formatDate(user.createdAt)}</div>
      <div class="item"><div class="label">Updated</div>${formatDate(user.updatedAt)}</div>
      <div class="item"><div class="label">Deployments</div>${user.deployments.length}</div>
    </div>
    <h3>Deployments</h3>
    <table>
      <thead><tr><th>App</th><th>Status</th><th>Type</th><th>Tier</th><th>Updated</th></tr></thead>
      <tbody>
        ${user.deployments.map(d => `
          <tr>
            <td><a href="#/deployments/${d.id}" class="user-link">${d.appName}</a></td>
            <td>${badge(d.status)}</td>
            <td>${d.projectType || '-'}</td>
            <td>${d.tier}</td>
            <td>${formatDate(d.updatedAt)}</td>
          </tr>
        `).join('')}
        ${user.deployments.length === 0 ? '<tr><td colspan="5" style="color:#666">No deployments</td></tr>' : ''}
      </tbody>
    </table>
  `);
}

let depsPage = 1;
let depsStatus = '';

async function renderDeployments() {
  setActive('deployments');
  const params = `page=${depsPage}&limit=20${depsStatus ? `&status=${depsStatus}` : ''}`;
  const data = await api(`/admin/deployments?${params}`);

  html($('content'), `
    <h3>Deployments (${data.total})</h3>
    <div class="toolbar">
      <select id="dep-status">
        <option value="">All statuses</option>
        <option value="running" ${depsStatus === 'running' ? 'selected' : ''}>Running</option>
        <option value="building" ${depsStatus === 'building' ? 'selected' : ''}>Building</option>
        <option value="stopped" ${depsStatus === 'stopped' ? 'selected' : ''}>Stopped</option>
        <option value="failed" ${depsStatus === 'failed' ? 'selected' : ''}>Failed</option>
        <option value="error" ${depsStatus === 'error' ? 'selected' : ''}>Error</option>
      </select>
    </div>
    <table>
      <thead><tr><th>App</th><th>User</th><th>Status</th><th>Type</th><th>Tier</th><th>DB</th><th>URL</th><th>Updated</th><th>Actions</th></tr></thead>
      <tbody>
        ${data.deployments.map(d => `
          <tr>
            <td><a href="#/deployments/${d.id}" class="user-link">${d.appName}</a></td>
            <td>
              <div style="display:flex;align-items:center;gap:0.4rem">
                ${d.avatarUrl ? `<img src="${d.avatarUrl}" width="20" height="20" style="border-radius:50%">` : ''}
                ${d.username}
              </div>
            </td>
            <td>${badge(d.status)}</td>
            <td>${d.projectType || '-'}</td>
            <td>${d.tier}</td>
            <td>${d.dbName ? `<span class="badge badge-running" style="background:#3b82f622;color:#3b82f6">PG</span>` : '-'}</td>
            <td>${d.status === 'running' ? `<a href="${d.url}" target="_blank" class="url-link">${d.subdomain}</a>` : '-'}</td>
            <td>${formatDate(d.updatedAt)}</td>
            <td>
              <div class="btn-group">
                ${d.status === 'running' ? `<button class="btn btn-sm" onclick="stopDep(${d.id})">Stop</button>` : ''}
                ${d.containerId ? `<button class="btn btn-sm" onclick="restartDep(${d.id})">Restart</button>` : ''}
                <button class="btn btn-sm btn-danger" onclick="deleteDep(${d.id}, '${d.appName}')">Delete</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${renderPagination(data.total, data.page, data.limit, 'depsGoTo')}
  `);

  $('dep-status').addEventListener('change', e => {
    depsStatus = e.target.value;
    depsPage = 1;
    renderDeployments();
  });
}

async function renderDeploymentDetail(id) {
  setActive('deployments');
  const d = await api(`/admin/deployments/${id}`);

  html($('content'), `
    <a href="#/deployments" class="back-link">&larr; Back to Deployments</a>
    <div class="detail-header">
      <div>
        <h2>${d.appName} ${badge(d.status)}</h2>
        <div style="font-size:0.85rem;color:#888;margin-top:0.3rem">by ${d.username}</div>
      </div>
    </div>
    <div class="detail-meta">
      <div class="item"><div class="label">Subdomain</div>${d.subdomain}</div>
      <div class="item"><div class="label">Type</div>${d.projectType || '-'}</div>
      <div class="item"><div class="label">Tier</div>${d.tier}</div>
      <div class="item"><div class="label">Port</div>${d.port}</div>
      <div class="item"><div class="label">Container</div><span style="font-family:monospace;font-size:0.8rem">${d.containerId ? d.containerId.slice(0, 12) : 'none'}</span></div>
      ${d.dbName ? `
        <div class="item"><div class="label">Database</div><span style="font-family:monospace;font-size:0.8rem">${d.dbName}</span></div>
        <div class="item"><div class="label">DB User</div><span style="font-family:monospace;font-size:0.8rem">${d.dbUser || '-'}</span></div>
      ` : ''}
      <div class="item"><div class="label">Created</div>${formatDate(d.createdAt)}</div>
      <div class="item"><div class="label">Updated</div>${formatDate(d.updatedAt)}</div>
      ${d.status === 'running' ? `<div class="item"><div class="label">URL</div><a href="${d.url}" target="_blank" class="url-link">${d.url}</a></div>` : ''}
    </div>
    <div class="btn-group" style="margin-bottom:1.5rem">
      ${d.status === 'running' ? `<button class="btn" onclick="stopDep(${d.id}).then(()=>renderDeploymentDetail(${d.id}))">Stop</button>` : ''}
      ${d.containerId ? `<button class="btn" onclick="restartDep(${d.id}).then(()=>renderDeploymentDetail(${d.id}))">Restart</button>` : ''}
      <button class="btn" onclick="loadLogs(${d.id})">Load Logs</button>
      <button class="btn btn-danger" onclick="deleteDep(${d.id}, '${d.appName}')">Delete</button>
    </div>
    <div id="logs-container"></div>
  `);
}

// --- Actions ---

async function toggleAdmin(id, val) {
  await api(`/admin/users/${id}`, { method: 'PUT', body: JSON.stringify({ is_admin: val }) });
  renderUsers();
}

async function deleteUser(id, name) {
  if (!confirm(`Delete user "${name}" and all their deployments, databases, and images?`)) return;
  try {
    const res = await api(`/admin/users/${id}`, { method: 'DELETE' });
    if (res.warnings) alert('Deleted with warnings:\n' + res.warnings.join('\n'));
  } catch (e) {
    alert('Failed to delete user: ' + e.message);
  }
  renderUsers();
}

async function stopDep(id) {
  try {
    const res = await api(`/admin/deployments/${id}/stop`, { method: 'POST' });
    if (res.warnings) alert('Stopped with warnings:\n' + res.warnings.join('\n'));
  } catch (e) {
    alert('Failed to stop: ' + e.message);
  }
  if (location.hash.includes(`/deployments/${id}`)) renderDeploymentDetail(id);
  else renderDeployments();
}

async function restartDep(id) {
  try {
    await api(`/admin/deployments/${id}/restart`, { method: 'POST' });
  } catch (e) {
    alert('Failed to restart: ' + e.message);
  }
  if (location.hash.includes(`/deployments/${id}`)) renderDeploymentDetail(id);
  else renderDeployments();
}

async function deleteDep(id, name) {
  if (!confirm(`Delete deployment "${name}"? This will stop the container, remove the image, and drop any provisioned database.`)) return;
  try {
    const res = await api(`/admin/deployments/${id}`, { method: 'DELETE' });
    if (res.warnings) alert('Deleted with warnings:\n' + res.warnings.join('\n'));
  } catch (e) {
    alert('Failed to delete: ' + e.message);
    return;
  }
  location.hash = '#/deployments';
}

async function loadLogs(id) {
  const container = document.getElementById('logs-container');
  container.innerHTML = '<div style="color:#888">Loading logs...</div>';
  try {
    const data = await api(`/admin/deployments/${id}/logs`);
    container.innerHTML = `<h3>Container Logs</h3><div class="log-box">${escapeHtml(data.logs || 'No logs')}</div>`;
  } catch (e) {
    container.innerHTML = `<div style="color:#e74c3c">${escapeHtml(e.message)}</div>`;
  }
}

// --- Helpers ---

function renderPagination(total, page, limit, goToFn) {
  const totalPages = Math.ceil(total / limit);
  if (totalPages <= 1) return '';
  return `
    <div class="pagination">
      <button class="btn btn-sm" onclick="${goToFn}(${page - 1})" ${page <= 1 ? 'disabled' : ''}>Prev</button>
      <span class="info">Page ${page} of ${totalPages}</span>
      <button class="btn btn-sm" onclick="${goToFn}(${page + 1})" ${page >= totalPages ? 'disabled' : ''}>Next</button>
    </div>
  `;
}

window.usersGoTo = (p) => { usersPage = p; renderUsers(); };
window.depsGoTo = (p) => { depsPage = p; renderDeployments(); };

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// --- Health ---

let healthErrorPeriod = '24h';

async function renderHealthPage(subTab) {
  setActive('health');
  if (healthInterval) { clearInterval(healthInterval); healthInterval = null; }

  const tabs = [
    { id: 'overview', label: 'Overview', href: '#/health' },
    { id: 'errors', label: 'Errors', href: '#/health/errors' },
    { id: 'queues', label: 'Queues', href: '#/health/queues' },
    { id: 'infra', label: 'Infrastructure', href: '#/health/infra' },
    { id: 'database', label: 'Database', href: '#/health/database' },
    { id: 'apps', label: 'App Checks', href: '#/health/apps' },
  ];

  const tabBar = '<div class="health-tabs">' + tabs.map(t =>
    '<a href="' + t.href + '" class="health-tab' + (t.id === subTab ? ' active' : '') + '">' + t.label + '</a>'
  ).join('') + '</div><div id="health-content"></div>';

  html($('content'), tabBar);

  const renderers = {
    overview: renderHealthOverview,
    errors: renderHealthErrors,
    queues: renderHealthQueues,
    infra: renderHealthInfra,
    database: renderHealthDatabase,
    apps: renderHealthApps,
  };

  if (renderers[subTab]) await renderers[subTab]();
}

async function renderHealthOverview() {
  async function fetchAndRender() {
    try {
      const h = await api('/admin/health');
      let content = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">'
        + '<h3 style="margin:0">System Health</h3>'
        + '<div style="display:flex;align-items:center;gap:0.75rem">'
        + '<span class="health-timestamp">Updated ' + new Date().toLocaleTimeString() + '</span>'
        + '<button class="btn btn-sm" onclick="location.hash=\'#/health\'">Refresh</button>'
        + '<button class="btn btn-sm" onclick="runSmokeTest()">Smoke Test</button>'
        + '</div></div>'
        + '<div class="health-status-row">'
        + healthDot(h.server.status, 'API Server')
        + healthDot(h.postgres.status, 'PostgreSQL')
        + healthDot(h.redis.status, 'Redis')
        + healthDot(h.docker.status, 'Docker')
        + '</div>'
        + '<div id="smoke-results"></div>'
        + '<div class="health-grid">'
        + '<div class="health-card"><div class="health-card-title">API Server</div>'
        + '<div class="health-row"><span>Uptime</span><span>' + formatUptime(h.server.uptime) + '</span></div>'
        + '<div class="health-row"><span>Node.js</span><span>' + h.server.nodeVersion + '</span></div>'
        + '<div class="health-row"><span>Memory (RSS)</span><span>' + h.server.memoryUsage.rss + '</span></div>'
        + '<div class="health-row"><span>Heap Used</span><span>' + h.server.memoryUsage.heapUsed + '</span></div>'
        + '</div>'
        + '<div class="health-card"><div class="health-card-title">PostgreSQL</div>'
        + '<div class="health-row"><span>Version</span><span>' + (h.postgres.version || '-') + '</span></div>'
        + '<div class="health-row"><span>Tenant DBs</span><span>' + (h.postgres.databases ?? '-') + '</span></div>'
        + '<div class="health-row"><span>Total Size</span><span>' + (h.postgres.totalSize || '-') + '</span></div>'
        + '<div class="health-row"><span>Pool (idle/total)</span><span>' + h.postgres.poolSize.idle + '/' + h.postgres.poolSize.total + '</span></div>'
        + '<div class="health-row"><span>Pool Waiting</span><span>' + h.postgres.poolSize.waiting + '</span></div>'
        + '</div>'
        + '<div class="health-card"><div class="health-card-title">Redis</div>'
        + '<div class="health-row"><span>Keys</span><span>' + (h.redis.keys ?? '-') + '</span></div>'
        + '<div class="health-row"><span>Memory</span><span>' + (h.redis.memory || '-') + '</span></div>'
        + '</div>'
        + '<div class="health-card"><div class="health-card-title">Docker</div>'
        + '<div class="health-row"><span>Containers</span><span>' + h.docker.containers.running + ' running / ' + h.docker.containers.total + ' total</span></div>'
        + '<div class="health-row"><span>Stopped</span><span>' + h.docker.containers.stopped + '</span></div>'
        + '<div class="health-row"><span>Images</span><span>' + h.docker.images + '</span></div>'
        + '</div>'
        + '<div class="health-card"><div class="health-card-title">Deployments</div>'
        + '<div class="health-row"><span>Running</span><span class="health-good">' + h.deployments.running + '</span></div>'
        + '<div class="health-row"><span>Building</span><span class="health-warn">' + h.deployments.building + '</span></div>'
        + '<div class="health-row"><span>Failed</span><span class="health-bad">' + h.deployments.failed + '</span></div>'
        + '<div class="health-row"><span>Recent Errors (24h)</span><span class="health-bad">' + h.deployments.recentErrors + '</span></div>'
        + '</div>'
        + '<div class="health-card"><div class="health-card-title">Build Queue</div>'
        + '<div class="health-row"><span>Active</span><span>' + h.queue.active + '</span></div>'
        + '<div class="health-row"><span>Waiting</span><span>' + h.queue.waiting + '</span></div>'
        + '<div class="health-row"><span>Completed</span><span>' + h.queue.completed + '</span></div>'
        + '<div class="health-row"><span>Failed</span><span>' + h.queue.failed + '</span></div>'
        + '</div>'
        + '</div>';

      // Trends (48h sparklines)
      try {
        const snapData = await api('/admin/health/snapshots?hours=48');
        if (snapData.snapshots && snapData.snapshots.length > 1) {
          const snaps = snapData.snapshots;
          const memPoints = snaps.map(s => s.memoryRss || 0);
          const heapPoints = snaps.map(s => s.heapUsed || 0);
          const containerPoints = snaps.map(s => s.containersRunning || 0);
          const errorPoints = snaps.map(s => s.recentErrors || 0);
          content += '<h3 style="margin-top:1.5rem;margin-bottom:0.75rem">Trends (48h)</h3>'
            + '<div class="health-grid">'
            + '<div class="health-card">' + renderSparklineSVG(memPoints, { label: 'Memory RSS (MB)', color: '#7c6fe0' }) + '</div>'
            + '<div class="health-card">' + renderSparklineSVG(heapPoints, { label: 'Heap Used (MB)', color: '#e6b800' }) + '</div>'
            + '<div class="health-card">' + renderSparklineSVG(containerPoints, { label: 'Running Containers', color: '#4caf50' }) + '</div>'
            + '<div class="health-card">' + renderSparklineSVG(errorPoints, { label: 'Errors (24h)', color: '#e74c3c' }) + '</div>'
            + '</div>';
        }
      } catch(e) { /* no trends yet */ }

      html($('health-content'), content);
    } catch (e) {
      html($('health-content'), '<div class="error">Failed to load health data: ' + esc(e.message) + '</div>');
    }
  }

  await fetchAndRender();
  healthInterval = setInterval(fetchAndRender, 30000);
}

window.runSmokeTest = async function() {
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Testing...';
  try {
    const data = await api('/admin/health/smoke-test', { method: 'POST' });
    const container = document.getElementById('smoke-results');
    if (container) {
      container.innerHTML = '<div class="smoke-results">' + data.results.map(function(r) {
        return '<div class="smoke-card ' + r.status + '">'
          + '<div style="font-weight:600;margin-bottom:0.3rem">' + r.service + '</div>'
          + '<div style="font-size:0.8rem;color:' + (r.status === 'ok' ? '#4caf50' : '#e74c3c') + '">' + (r.status === 'ok' ? r.latencyMs + 'ms' : r.error) + '</div>'
          + '</div>';
      }).join('') + '</div>';
    }
  } catch(e) { /* ignore */ }
  btn.disabled = false; btn.textContent = 'Smoke Test';
};

function renderSparklineSVG(dataPoints, opts) {
  opts = opts || {};
  var width = opts.width || 400;
  var height = opts.height || 80;
  var color = opts.color || '#7c6fe0';
  var label = opts.label || '';
  if (!dataPoints || dataPoints.length < 2) return '<div style="color:#666;font-size:0.8rem">No data yet</div>';
  var max = Math.max.apply(null, dataPoints.concat([1]));
  var min = Math.min.apply(null, dataPoints);
  var range = max - min || 1;
  var stepX = width / (dataPoints.length - 1);
  var points = dataPoints.map(function(val, i) {
    var x = (i * stepX).toFixed(1);
    var y = (height - ((val - min) / range) * (height - 16) - 8).toFixed(1);
    return x + ',' + y;
  });
  var pathD = 'M ' + points.join(' L ');
  var areaD = pathD + ' L ' + width + ',' + height + ' L 0,' + height + ' Z';
  var uid = label.replace(/[^a-z]/gi, '');
  return '<svg width="100%" viewBox="0 0 ' + width + ' ' + height + '" style="display:block;margin:0.3rem 0">'
    + '<defs><linearGradient id="g' + uid + '" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.25"/>'
    + '<stop offset="100%" stop-color="' + color + '" stop-opacity="0.02"/>'
    + '</linearGradient></defs>'
    + '<path d="' + areaD + '" fill="url(#g' + uid + ')"/>'
    + '<path d="' + pathD + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round"/>'
    + '<text x="0" y="11" font-size="10" fill="#888">' + label + '</text>'
    + '<text x="' + width + '" y="11" font-size="10" fill="#ccc" text-anchor="end">' + dataPoints[dataPoints.length - 1] + '</text>'
    + '</svg>';
}

async function renderHealthErrors() {
  const data = await api('/admin/health/sentry?period=' + healthErrorPeriod);
  const periods = ['24h', '48h', '7d', '14d'];
  let h = '<div class="period-filters">' + periods.map(function(p) {
    return '<button class="btn btn-sm' + (p === healthErrorPeriod ? ' active' : '') + '" onclick="setErrorPeriod(\'' + p + '\')">' + p + '</button>';
  }).join('') + '</div>';

  if (!data.issues || data.issues.length === 0) {
    h += '<div style="color:#888;padding:2rem;text-align:center">No unresolved issues in the last ' + healthErrorPeriod + '</div>';
  } else {
    h += '<table class="table"><thead><tr><th>Issue</th><th>Events</th><th>Users</th><th>Last Seen</th><th>Project</th><th></th></tr></thead><tbody>';
    for (const issue of data.issues) {
      const projClass = issue.project === 'cozypane-cloud' ? 'badge-running' : 'badge-building';
      h += '<tr>'
        + '<td><div style="font-weight:500">' + esc(issue.title) + '</div><div style="font-size:0.75rem;color:#666">' + issue.shortId + '</div></td>'
        + '<td>' + issue.count + '</td>'
        + '<td>' + issue.userCount + '</td>'
        + '<td>' + formatDate(issue.lastSeen) + '</td>'
        + '<td><span class="badge ' + projClass + '">' + issue.project.replace('cozypane-', '') + '</span></td>'
        + '<td><a href="' + issue.permalink + '" target="_blank" style="color:#7c6fe0">View</a></td>'
        + '</tr>';
    }
    h += '</tbody></table>';
  }
  html($('health-content'), h);
}

window.setErrorPeriod = function(p) {
  healthErrorPeriod = p;
  renderHealthErrors();
};

async function renderHealthQueues() {
  const data = await api('/admin/health/queues/failed');
  let h = '';
  for (const q of data.queues) {
    h += '<div class="health-card" style="margin-bottom:1rem">'
      + '<div class="health-card-title">' + q.name + '</div>'
      + '<div class="health-grid" style="grid-template-columns:repeat(4,1fr);gap:0.5rem;margin-bottom:0.5rem">'
      + '<div class="health-row"><span>Active</span><span>' + q.counts.active + '</span></div>'
      + '<div class="health-row"><span>Waiting</span><span>' + q.counts.waiting + '</span></div>'
      + '<div class="health-row"><span>Completed</span><span>' + q.counts.completed + '</span></div>'
      + '<div class="health-row"><span>Failed</span><span class="health-bad">' + q.counts.failed + '</span></div>'
      + '</div>';

    if (q.failedJobs && q.failedJobs.length > 0) {
      h += '<div style="margin-top:0.5rem"><div style="font-size:0.8rem;color:#888;margin-bottom:0.3rem">Failed Jobs</div>';
      h += '<table class="table"><thead><tr><th>Job ID</th><th>App</th><th>Error</th><th>Time</th></tr></thead><tbody>';
      for (const job of q.failedJobs) {
        const time = job.finishedOn ? formatDate(new Date(job.finishedOn).toISOString()) : '-';
        h += '<tr style="cursor:pointer" onclick="toggleExpand(this)">'
          + '<td>' + (job.id || '-') + '</td>'
          + '<td>' + esc(job.data?.appName || '-') + '</td>'
          + '<td class="truncate">' + esc(job.failedReason) + '</td>'
          + '<td>' + time + '</td>'
          + '</tr>'
          + '<tr class="expand-detail" style="display:none"><td colspan="4"><pre class="log-box" style="margin:0;white-space:pre-wrap;font-size:0.78rem;max-height:200px;overflow:auto">' + esc(job.failedReason) + '</pre></td></tr>';
      }
      h += '</tbody></table></div>';
    }
    h += '</div>';
  }
  if (!data.queues || data.queues.length === 0) h = '<div style="color:#888;text-align:center;padding:2rem">No queues found</div>';
  html($('health-content'), h);
}

window.toggleExpand = function(row) {
  const detail = row.nextElementSibling;
  if (detail && detail.classList.contains('expand-detail')) {
    detail.style.display = detail.style.display === 'none' ? '' : 'none';
  }
};

async function renderHealthInfra() {
  const data = await api('/admin/health/server');
  const mem = data.memory;
  const memColor = mem.usedPercent > 85 ? '#e74c3c' : mem.usedPercent > 70 ? '#e6b800' : '#4caf50';
  const diskPct = parseFloat(data.disk.usedPercent) || 0;
  const diskColor = diskPct > 85 ? '#e74c3c' : diskPct > 70 ? '#e6b800' : '#4caf50';

  let h = '<div class="health-grid">'
    // CPU
    + '<div class="health-card"><div class="health-card-title">CPU</div>'
    + '<div class="health-row"><span>Cores</span><span>' + data.cpu.cores + '</span></div>'
    + '<div class="health-row"><span>Load 1m</span><span>' + data.cpu.loadAvg[0].toFixed(2) + '</span></div>'
    + '<div class="health-row"><span>Load 5m</span><span>' + data.cpu.loadAvg[1].toFixed(2) + '</span></div>'
    + '<div class="health-row"><span>Load 15m</span><span>' + data.cpu.loadAvg[2].toFixed(2) + '</span></div>'
    + '</div>'
    // Memory
    + '<div class="health-card"><div class="health-card-title">Memory</div>'
    + '<div class="usage-bar"><div class="usage-fill" style="width:' + mem.usedPercent + '%;background:' + memColor + '"></div></div>'
    + '<div class="health-row"><span>Used</span><span>' + mem.usedMB + ' / ' + mem.totalMB + ' MB (' + mem.usedPercent + '%)</span></div>'
    + '<div class="health-row"><span>Free</span><span>' + mem.freeMB + ' MB</span></div>'
    + '</div>'
    // Disk
    + '<div class="health-card"><div class="health-card-title">Disk (/)</div>'
    + '<div class="usage-bar"><div class="usage-fill" style="width:' + diskPct + '%;background:' + diskColor + '"></div></div>'
    + '<div class="health-row"><span>Used</span><span>' + data.disk.used + ' / ' + data.disk.total + ' (' + data.disk.usedPercent + ')</span></div>'
    + '<div class="health-row"><span>Available</span><span>' + data.disk.available + '</span></div>'
    + '</div>'
    + '</div>';

  // Docker containers
  if (data.containers && data.containers.length > 0) {
    h += '<h3 style="margin-top:1.5rem;margin-bottom:0.75rem">Docker Containers</h3>';
    h += '<table class="table"><thead><tr><th>Name</th><th>State</th><th>Status</th><th>Image</th></tr></thead><tbody>';
    for (const c of data.containers) {
      const stateColor = c.state === 'running' ? '#4caf50' : '#e74c3c';
      h += '<tr><td>' + esc(c.name) + '</td><td><span style="color:' + stateColor + '">' + c.state + '</span></td><td>' + esc(c.status) + '</td><td style="color:#888;font-size:0.8rem">' + esc(c.image) + '</td></tr>';
    }
    h += '</tbody></table>';
  }
  html($('health-content'), h);
}

async function renderHealthDatabase() {
  const data = await api('/admin/health/database');
  const pu = data.poolUtilization;
  const puPct = pu.total > 0 ? Math.round((pu.total - pu.idle) / pu.total * 100) : 0;
  const puColor = puPct > 80 ? '#e74c3c' : puPct > 60 ? '#e6b800' : '#4caf50';

  let h = '<div class="health-grid">'
    + '<div class="health-card"><div class="health-card-title">Connection Pool</div>'
    + '<div class="usage-bar"><div class="usage-fill" style="width:' + puPct + '%;background:' + puColor + '"></div></div>'
    + '<div class="health-row"><span>Active</span><span>' + (pu.total - pu.idle) + ' / ' + pu.total + ' (' + puPct + '%)</span></div>'
    + '<div class="health-row"><span>Idle</span><span>' + pu.idle + '</span></div>'
    + '<div class="health-row"><span>Waiting</span><span>' + pu.waiting + '</span></div>'
    + '<div class="health-row"><span>DB Connections</span><span>' + data.connectionCount + '</span></div>'
    + '</div></div>';

  // Tables
  if (data.tables && data.tables.length > 0) {
    h += '<h3 style="margin-top:1.5rem;margin-bottom:0.75rem">Tables</h3>';
    h += '<table class="table"><thead><tr><th>Table</th><th>Est. Rows</th><th>Size</th><th>Dead Tuples</th><th>Last Vacuum</th></tr></thead><tbody>';
    for (const t of data.tables) {
      const deadClass = t.dead_tuples > 10000 ? ' class="health-bad"' : '';
      h += '<tr><td>' + esc(t.name) + '</td><td>' + (t.estimated_rows || 0).toLocaleString() + '</td><td>' + t.total_size + '</td><td' + deadClass + '>' + (t.dead_tuples || 0).toLocaleString() + '</td><td>' + (t.last_autovacuum ? formatDate(t.last_autovacuum) : '-') + '</td></tr>';
    }
    h += '</tbody></table>';
  }

  // Slow queries
  if (data.slowQueries && data.slowQueries.length > 0) {
    h += '<h3 style="margin-top:1.5rem;margin-bottom:0.75rem">Slow Queries (Top 10)</h3>';
    h += '<table class="table"><thead><tr><th>Query</th><th>Calls</th><th>Total (ms)</th><th>Mean (ms)</th></tr></thead><tbody>';
    for (const q of data.slowQueries) {
      const meanClass = q.mean_time_ms > 100 ? ' style="color:#e74c3c"' : '';
      h += '<tr><td style="font-family:monospace;font-size:0.75rem;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(q.query) + '">' + esc(q.query) + '</td><td>' + q.calls.toLocaleString() + '</td><td>' + Math.round(q.total_time_ms).toLocaleString() + '</td><td' + meanClass + '>' + q.mean_time_ms.toFixed(1) + '</td></tr>';
    }
    h += '</tbody></table>';
  } else if (data.slowQueries === null) {
    h += '<div style="color:#666;font-size:0.85rem;margin-top:1rem">pg_stat_statements extension not available</div>';
  }
  html($('health-content'), h);
}

async function renderHealthApps() {
  let h = '<div style="margin-bottom:1rem"><button class="btn btn-primary" onclick="runAppChecks()">Run Health Checks</button></div>';
  h += '<div id="app-checks-results"><div style="color:#888;text-align:center;padding:2rem">Click "Run Health Checks" to check all running deployments</div></div>';
  html($('health-content'), h);
}

window.runAppChecks = async function() {
  const container = document.getElementById('app-checks-results');
  container.innerHTML = '<div style="color:#888;text-align:center;padding:2rem">Checking deployments...</div>';
  try {
    const data = await api('/admin/health/app-checks');
    if (!data.checks || data.checks.length === 0) {
      container.innerHTML = '<div style="color:#888;text-align:center;padding:2rem">No running deployments</div>';
      return;
    }
    let h = '<table class="table"><thead><tr><th>App</th><th>URL</th><th>Status</th><th>Response Time</th><th>Error</th></tr></thead><tbody>';
    for (const c of data.checks) {
      let statusBadge = '';
      if (c.httpStatus) {
        const cls = c.httpStatus < 300 ? 'badge-running' : c.httpStatus < 400 ? 'badge-building' : 'badge-failed';
        statusBadge = '<span class="badge ' + cls + '">' + c.httpStatus + '</span>';
      } else {
        statusBadge = '<span class="badge badge-failed">ERR</span>';
      }
      const rtColor = c.responseTimeMs ? (c.responseTimeMs < 500 ? '#4caf50' : c.responseTimeMs < 2000 ? '#e6b800' : '#e74c3c') : '#888';
      h += '<tr><td>' + esc(c.appName) + '</td><td><a href="' + esc(c.url) + '" target="_blank" style="color:#7c6fe0">' + esc(c.subdomain) + '</a></td><td>' + statusBadge + '</td><td style="color:' + rtColor + '">' + (c.responseTimeMs ? c.responseTimeMs + 'ms' : '-') + '</td><td style="color:#e74c3c;font-size:0.8rem">' + (c.error ? esc(c.error) : '') + '</td></tr>';
    }
    h += '</tbody></table>';
    container.innerHTML = h;
  } catch(e) {
    container.innerHTML = '<div class="error">Failed: ' + e.message + '</div>';
  }
};

function healthDot(status, label) {
  const color = status === 'running' ? '#4caf50' : status === 'unreachable' ? '#e74c3c' : '#e6b800';
  return `<div class="health-indicator"><span class="health-dot" style="background:${color}"></span><span>${label}</span></div>`;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? d + 'd ' + h + 'h ' + m + 'm' : h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}

// --- Router ---

async function route() {
  if (healthInterval) { clearInterval(healthInterval); healthInterval = null; }
  const hash = location.hash || '#/';
  const parts = hash.slice(2).split('/');

  try {
    if (parts[0] === 'health') {
      const subTab = parts[1] || 'overview';
      await renderHealthPage(subTab);
    } else if (parts[0] === 'users' && parts[1]) {
      await renderUserDetail(parts[1]);
    } else if (parts[0] === 'users') {
      await renderUsers();
    } else if (parts[0] === 'deployments' && parts[1]) {
      await renderDeploymentDetail(parts[1]);
    } else if (parts[0] === 'deployments') {
      await renderDeployments();
    } else {
      await renderDashboard();
    }
  } catch (e) {
    if (e.message !== 'Unauthorized') {
      html($('content'), `<div style="color:#e74c3c;padding:2rem">${escapeHtml(e.message)}</div>`);
    }
  }
}

window.addEventListener('hashchange', route);

// --- Init ---

(async () => {
  // Clear any legacy localStorage token from the old URL-fragment flow.
  clearLegacyStorage();

  if (await checkAuth()) {
    // Show user info in nav — the cookie carries auth now.
    try {
      const res = await fetch(`${API}/auth/me`, { credentials: 'include' });
      if (res.ok) {
        const user = await res.json();
        $('nav-user').innerHTML = `
          ${user.avatarUrl ? `<img src="${user.avatarUrl}">` : ''}
          <span>${user.username}</span>
        `;
      }
    } catch {}
    route();
  }
})();
