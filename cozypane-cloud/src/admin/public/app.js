// CozyPane Admin SPA

// Admin SPA may be served from admin.cozypane.com but API lives at api.cozypane.com
const API = window.location.origin.replace('admin.', 'api.');
let token = localStorage.getItem('admin_token') || '';

// --- API ---

async function api(path, opts = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(opts.headers || {}),
  };
  // Only set Content-Type for requests that have a body
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers,
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
  if (!token) { showLogin(); return false; }
  try {
    const stats = await api('/admin/stats');
    showApp();
    return true;
  } catch {
    showLogin();
    return false;
  }
}

// Handle OAuth callback (code or direct token)
async function handleCallback() {
  const params = new URLSearchParams(window.location.search);

  // Direct token login (e.g. from CozyPane app or manual)
  const directToken = params.get('token');
  if (directToken) {
    token = directToken;
    localStorage.setItem('admin_token', token);
    window.history.replaceState({}, '', '/admin/');
    return;
  }

  const code = params.get('code');
  if (!code) return;

  try {
    const res = await fetch(`${API}/auth/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (data.token) {
      token = data.token;
      localStorage.setItem('admin_token', token);
      window.history.replaceState({}, '', '/admin/');
    }
  } catch (e) {
    console.error('Auth failed:', e);
  }
}

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
                ${u.avatar_url ? `<img src="${u.avatar_url}" width="24" height="24" style="border-radius:50%">` : ''}
                <a href="#/users/${u.id}" class="user-link">${u.username}</a>
              </div>
            </td>
            <td>${u.deployment_count}</td>
            <td>${u.running_count}</td>
            <td>${u.is_admin ? 'Yes' : '-'}</td>
            <td>${formatDate(u.created_at)}</td>
            <td>
              <div class="btn-group">
                <button class="btn btn-sm" onclick="toggleAdmin(${u.id}, ${!u.is_admin})">${u.is_admin ? 'Revoke Admin' : 'Make Admin'}</button>
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
      ${user.avatar_url ? `<img src="${user.avatar_url}">` : ''}
      <div>
        <h2>${user.username}</h2>
        ${user.is_admin ? '<span class="badge badge-running">admin</span>' : ''}
      </div>
    </div>
    <div class="detail-meta">
      <div class="item"><div class="label">GitHub ID</div>${user.github_id}</div>
      <div class="item"><div class="label">Joined</div>${formatDate(user.created_at)}</div>
      <div class="item"><div class="label">Updated</div>${formatDate(user.updated_at)}</div>
      <div class="item"><div class="label">Deployments</div>${user.deployments.length}</div>
    </div>
    <h3>Deployments</h3>
    <table>
      <thead><tr><th>App</th><th>Status</th><th>Type</th><th>Tier</th><th>Updated</th></tr></thead>
      <tbody>
        ${user.deployments.map(d => `
          <tr>
            <td><a href="#/deployments/${d.id}" class="user-link">${d.app_name}</a></td>
            <td>${badge(d.status)}</td>
            <td>${d.project_type || '-'}</td>
            <td>${d.tier}</td>
            <td>${formatDate(d.updated_at)}</td>
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
            <td><a href="#/deployments/${d.id}" class="user-link">${d.app_name}</a></td>
            <td>
              <div style="display:flex;align-items:center;gap:0.4rem">
                ${d.avatar_url ? `<img src="${d.avatar_url}" width="20" height="20" style="border-radius:50%">` : ''}
                ${d.username}
              </div>
            </td>
            <td>${badge(d.status)}</td>
            <td>${d.project_type || '-'}</td>
            <td>${d.tier}</td>
            <td>${d.db_name ? `<span class="badge badge-running" style="background:#3b82f622;color:#3b82f6">PG</span>` : '-'}</td>
            <td>${d.status === 'running' ? `<a href="${d.url}" target="_blank" class="url-link">${d.subdomain}</a>` : '-'}</td>
            <td>${formatDate(d.updated_at)}</td>
            <td>
              <div class="btn-group">
                ${d.status === 'running' ? `<button class="btn btn-sm" onclick="stopDep(${d.id})">Stop</button>` : ''}
                ${d.container_id ? `<button class="btn btn-sm" onclick="restartDep(${d.id})">Restart</button>` : ''}
                <button class="btn btn-sm btn-danger" onclick="deleteDep(${d.id}, '${d.app_name}')">Delete</button>
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
        <h2>${d.app_name} ${badge(d.status)}</h2>
        <div style="font-size:0.85rem;color:#888;margin-top:0.3rem">by ${d.username}</div>
      </div>
    </div>
    <div class="detail-meta">
      <div class="item"><div class="label">Subdomain</div>${d.subdomain}</div>
      <div class="item"><div class="label">Type</div>${d.project_type || '-'}</div>
      <div class="item"><div class="label">Tier</div>${d.tier}</div>
      <div class="item"><div class="label">Port</div>${d.port}</div>
      <div class="item"><div class="label">Container</div><span style="font-family:monospace;font-size:0.8rem">${d.container_id ? d.container_id.slice(0, 12) : 'none'}</span></div>
      ${d.db_name ? `
        <div class="item"><div class="label">Database</div><span style="font-family:monospace;font-size:0.8rem">${d.db_name}</span></div>
        <div class="item"><div class="label">DB User</div><span style="font-family:monospace;font-size:0.8rem">${d.db_user || '-'}</span></div>
      ` : ''}
      <div class="item"><div class="label">Created</div>${formatDate(d.created_at)}</div>
      <div class="item"><div class="label">Updated</div>${formatDate(d.updated_at)}</div>
      ${d.status === 'running' ? `<div class="item"><div class="label">URL</div><a href="${d.url}" target="_blank" class="url-link">${d.url}</a></div>` : ''}
    </div>
    <div class="btn-group" style="margin-bottom:1.5rem">
      ${d.status === 'running' ? `<button class="btn" onclick="stopDep(${d.id}).then(()=>renderDeploymentDetail(${d.id}))">Stop</button>` : ''}
      ${d.container_id ? `<button class="btn" onclick="restartDep(${d.id}).then(()=>renderDeploymentDetail(${d.id}))">Restart</button>` : ''}
      <button class="btn" onclick="loadLogs(${d.id})">Load Logs</button>
      <button class="btn btn-danger" onclick="deleteDep(${d.id}, '${d.app_name}')">Delete</button>
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

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// --- Router ---

async function route() {
  const hash = location.hash || '#/';
  const parts = hash.slice(2).split('/');

  try {
    if (parts[0] === 'users' && parts[1]) {
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
  // Handle OAuth callback (redirected with ?token= or ?code=)
  if (window.location.search.includes('token=') || window.location.search.includes('code=')) {
    await handleCallback();
  }

  if (await checkAuth()) {
    // Show user info in nav
    try {
      const res = await fetch(`${API}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
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
