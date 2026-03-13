import React, { useState, useEffect, useCallback, useRef } from 'react';

interface Props {
  cwd: string;
}

const STATUS_COLORS: Record<string, string> = {
  building: '#e6b800',
  running: '#4caf50',
  stopped: '#e74c3c',
  error: '#e74c3c',
  failed: '#e74c3c',
};

function sanitizeAppName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

export default function DeployPanel({ cwd }: Props) {
  const [auth, setAuth] = useState<DeployAuth>({ authenticated: false });
  const [loading, setLoading] = useState(true);
  const [project, setProject] = useState<ProjectDetection | null>(null);
  const [appName, setAppName] = useState('');
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [logViewId, setLogViewId] = useState<string | null>(null);
  const [logs, setLogs] = useState<string>('');
  const [logsLoading, setLogsLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check auth on mount
  useEffect(() => {
    setLoading(true);
    window.cozyPane.deploy.getAuth()
      .then(setAuth)
      .catch(() => setAuth({ authenticated: false }))
      .finally(() => setLoading(false));
  }, []);

  // Listen for protocol callback auth success
  useEffect(() => {
    const cleanup = window.cozyPane.deploy.onProtocolCallback(() => {
      window.cozyPane.deploy.getAuth().then(setAuth);
    });
    return cleanup;
  }, []);

  // Listen for auth success from protocol handler
  useEffect(() => {
    const cleanup = window.cozyPane.onMenuAction('deploy:auth-success', () => {
      window.cozyPane.deploy.getAuth().then(setAuth);
    });
    return cleanup;
  }, []);

  // Detect project when cwd changes
  useEffect(() => {
    if (!cwd) return;
    window.cozyPane.deploy.detectProject(cwd).then(p => {
      setProject(p);
      setAppName(sanitizeAppName(p.name));
    }).catch(() => setProject(null));
  }, [cwd]);

  // Load deployments when authenticated
  const loadDeployments = useCallback(() => {
    if (!auth.authenticated) return;
    window.cozyPane.deploy.list()
      .then((list: Deployment[]) => setDeployments(Array.isArray(list) ? list : []))
      .catch(() => setDeployments([]));
  }, [auth.authenticated]);

  useEffect(() => {
    loadDeployments();
  }, [loadDeployments]);

  // Poll building deployments
  useEffect(() => {
    const building = deployments.some(d => d.status === 'building');
    if (building) {
      pollRef.current = setInterval(loadDeployments, 3000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [deployments, loadDeployments]);

  const handleLogin = useCallback(async () => {
    await window.cozyPane.deploy.login();
  }, []);

  const handleLogout = useCallback(async () => {
    await window.cozyPane.deploy.logout();
    setAuth({ authenticated: false });
    setDeployments([]);
  }, []);

  const handleDeploy = useCallback(async () => {
    if (!project || deploying || !appName) return;
    setDeploying(true);
    setDeployError(null);
    try {
      const result = await window.cozyPane.deploy.start(cwd, appName);
      setDeployments(prev => {
        // Replace if same appName, otherwise prepend
        const existing = prev.findIndex(d => d.appName === result.appName);
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = result;
          return next;
        }
        return [result, ...prev];
      });
    } catch (err: any) {
      setDeployError(err.message || 'Deploy failed');
    } finally {
      setDeploying(false);
    }
  }, [cwd, project, deploying, appName]);

  const handleRedeploy = useCallback(async (id: string) => {
    try {
      const result = await window.cozyPane.deploy.redeploy(id);
      setDeployments(prev => prev.map(d => String(d.id) === id ? { ...d, ...result } : d));
    } catch (err: any) {
      setDeployError(err.message || 'Redeploy failed');
    }
  }, []);

  const handleDelete = useCallback(async (id: number) => {
    if (!window.confirm('Delete this deployment? This will stop the app.')) return;
    try {
      await window.cozyPane.deploy.delete(String(id));
      setDeployments(prev => prev.filter(d => d.id !== id));
    } catch (err: any) {
      setDeployError(err.message || 'Delete failed');
    }
  }, []);

  const handleViewLogs = useCallback(async (id: string) => {
    if (logViewId === id) {
      setLogViewId(null);
      setLogs('');
      return;
    }
    setLogViewId(id);
    setLogsLoading(true);
    try {
      const result = await window.cozyPane.deploy.logs(id);
      setLogs(typeof result === 'string' ? result : (result as any)?.logs || JSON.stringify(result, null, 2));
    } catch (err: any) {
      setLogs(`Error: ${err.message}`);
    } finally {
      setLogsLoading(false);
    }
  }, [logViewId]);

  if (loading) {
    return (
      <div className="deploy-panel" style={panelStyle}>
        <div style={centerStyle}>Loading...</div>
      </div>
    );
  }

  if (!auth.authenticated) {
    return (
      <div className="deploy-panel" style={panelStyle}>
        <div style={headerStyle}>
          <span style={{ fontWeight: 600, fontSize: '0.95em' }}>Deploy</span>
        </div>
        <div style={centerStyle}>
          <div style={{ textAlign: 'center', padding: '2em 1em' }}>
            <p style={{ color: 'var(--text-secondary, #aaa)', marginBottom: '0.5em', fontSize: '0.9em' }}>
              Deploy your apps to the cloud with one click.
            </p>
            <p style={{ color: 'var(--text-secondary, #888)', marginBottom: '1.2em', fontSize: '0.82em' }}>
              Your GitHub username will be your CozyPane identity.
            </p>
            <button onClick={handleLogin} style={primaryBtnStyle}>
              Sign in with GitHub
            </button>
          </div>
        </div>
      </div>
    );
  }

  const subdomain = appName ? `${appName}-${auth.username}` : '';
  const canDeploy = !deploying && project && project.type !== 'unknown' && appName.length >= 2;

  return (
    <div className="deploy-panel" style={panelStyle}>
      {/* User info */}
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5em', flex: 1 }}>
          {auth.avatarUrl && (
            <img src={auth.avatarUrl} alt="" style={{ width: 22, height: 22, borderRadius: '50%' }} />
          )}
          <span style={{ fontWeight: 600, fontSize: '0.95em' }}>{auth.username}</span>
        </div>
        <button onClick={handleLogout} style={smallBtnStyle} title="Sign out">Sign out</button>
      </div>

      {/* Deploy current project */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '0.8em', color: 'var(--text-secondary, #888)', marginBottom: '0.4em' }}>
          Current project {project ? `(${project.type})` : ''}
        </div>

        {/* Editable app name */}
        <div style={{ marginBottom: '0.5em' }}>
          <input
            type="text"
            value={appName}
            onChange={e => setAppName(sanitizeAppName(e.target.value))}
            placeholder="app-name"
            spellCheck={false}
            style={inputStyle}
          />
        </div>

        {/* Subdomain preview */}
        {subdomain && (
          <div style={{ fontSize: '0.78em', color: 'var(--text-secondary, #888)', marginBottom: '0.5em' }}>
            {subdomain}.cozypane.com
          </div>
        )}

        <button
          onClick={handleDeploy}
          disabled={!canDeploy}
          style={{
            ...primaryBtnStyle,
            opacity: canDeploy ? 1 : 0.5,
            cursor: canDeploy ? 'pointer' : 'not-allowed',
            width: '100%',
          }}
        >
          {deploying ? 'Deploying...' : 'Deploy'}
        </button>
        {deployError && (
          <div style={{ color: '#e74c3c', fontSize: '0.82em', marginTop: '0.4em' }}>{deployError}</div>
        )}
      </div>

      {/* Deployments list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {deployments.length > 0 && (
          <div style={{ fontSize: '0.8em', color: 'var(--text-secondary, #888)', padding: '0.5em 0.75em 0.25em' }}>
            Your deployments
          </div>
        )}
        {deployments.length === 0 && (
          <div style={{ color: 'var(--text-secondary, #666)', fontSize: '0.85em', textAlign: 'center', padding: '1.5em 0' }}>
            No deployments yet
          </div>
        )}
        <div style={{ padding: '0 0.75em 0.5em' }}>
          {deployments.map(dep => (
            <div key={dep.id} style={deploymentCardStyle}>
              {/* App name + status */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.2em' }}>
                <span style={{ fontWeight: 600, fontSize: '0.9em' }}>{dep.appName}</span>
                <span style={{
                  fontSize: '0.72em',
                  padding: '1px 6px',
                  borderRadius: 3,
                  backgroundColor: `${STATUS_COLORS[dep.status] || '#666'}22`,
                  color: STATUS_COLORS[dep.status] || '#666',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.03em',
                }}>
                  {dep.status}
                </span>
              </div>

              {/* URL */}
              {dep.url && dep.status === 'running' && (
                <a
                  href={dep.url}
                  style={{ fontSize: '0.82em', color: 'var(--accent, #7c6fe0)', textDecoration: 'none', display: 'block', marginBottom: '0.2em' }}
                  title={dep.url}
                  onClick={(e) => { e.preventDefault(); window.open(dep.url, '_blank'); }}
                >
                  {dep.subdomain}.cozypane.com
                </a>
              )}

              {/* Tier + type */}
              <div style={{ fontSize: '0.75em', color: 'var(--text-secondary, #777)', marginBottom: '0.4em' }}>
                {dep.projectType} &middot; {dep.tier}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: '0.4em', flexWrap: 'wrap' }}>
                <button onClick={() => handleViewLogs(String(dep.id))} style={tinyBtnStyle}>
                  {logViewId === String(dep.id) ? 'Hide Logs' : 'Logs'}
                </button>
                <button onClick={() => handleRedeploy(String(dep.id))} style={tinyBtnStyle}>
                  Redeploy
                </button>
                {dep.url && dep.status === 'running' && (
                  <button onClick={() => window.open(dep.url, '_blank')} style={tinyBtnStyle}>
                    Visit
                  </button>
                )}
                <button onClick={() => handleDelete(dep.id)} style={{ ...tinyBtnStyle, color: '#e74c3c' }}>
                  Delete
                </button>
              </div>

              {/* Log viewer */}
              {logViewId === String(dep.id) && (
                <div style={logBoxStyle}>
                  {logsLoading ? 'Loading logs...' : (logs || 'No logs available')}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  overflow: 'hidden',
};

const centerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 1,
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0.5em 0.75em',
  borderBottom: '1px solid var(--border, #2a2b3e)',
};

const sectionStyle: React.CSSProperties = {
  padding: '0.75em',
  borderBottom: '1px solid var(--border, #2a2b3e)',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.4em 0.6em',
  borderRadius: 4,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'var(--bg-primary, #1a1b2e)',
  color: 'var(--text-primary, #e0e0e0)',
  fontSize: '0.88em',
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '0.5em 1em',
  borderRadius: 6,
  border: 'none',
  backgroundColor: 'var(--accent, #7c6fe0)',
  color: '#fff',
  fontSize: '0.88em',
  fontWeight: 600,
  cursor: 'pointer',
};

const smallBtnStyle: React.CSSProperties = {
  padding: '0.25em 0.6em',
  borderRadius: 4,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'transparent',
  color: 'var(--text-secondary, #aaa)',
  fontSize: '0.8em',
  cursor: 'pointer',
};

const tinyBtnStyle: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 3,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'transparent',
  color: 'var(--text-secondary, #aaa)',
  fontSize: '0.78em',
  cursor: 'pointer',
};

const deploymentCardStyle: React.CSSProperties = {
  padding: '0.6em',
  marginBottom: '0.5em',
  borderRadius: 6,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'var(--bg-secondary, #1e1f32)',
};

const logBoxStyle: React.CSSProperties = {
  marginTop: '0.4em',
  padding: '0.5em',
  borderRadius: 4,
  backgroundColor: 'var(--bg-primary, #1a1b2e)',
  color: 'var(--text-secondary, #aaa)',
  fontSize: '0.78em',
  fontFamily: 'monospace',
  maxHeight: 200,
  overflowY: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};
