import React, { useState, useEffect, useCallback, useRef } from 'react';
import { isCozyModeEnabled, enableCozyMode, disableCozyMode } from '../lib/cozyMode';

interface Props {
  cwd: string;
  onTerminalCommand: (command: string) => void;
  claudeRunning: boolean;
  onDeploymentsLoaded?: (deployments: Deployment[]) => void;
}

const STATUS_COLORS: Record<string, string> = {
  building: 'var(--warning, #e6b800)',
  running: 'var(--success, #4caf50)',
  stopped: 'var(--danger, #e74c3c)',
  error: 'var(--danger, #e74c3c)',
  failed: 'var(--danger, #e74c3c)',
  unhealthy: 'var(--warning, #e6b800)',
};

export default function DeployPanel({ cwd, onTerminalCommand, claudeRunning, onDeploymentsLoaded }: Props) {
  const [auth, setAuth] = useState<DeployAuth>({ authenticated: false });
  const [loading, setLoading] = useState(true);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [logViewId, setLogViewId] = useState<string | null>(null);
  const [logs, setLogs] = useState<string>('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [domainViewId, setDomainViewId] = useState<string | null>(null);
  const [domains, setDomains] = useState<CustomDomain[]>([]);
  const [newDomain, setNewDomain] = useState('');
  const [domainLoading, setDomainLoading] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [cozyMode, setCozyMode] = useState(false);
  const [cozyModeLoading, setCozyModeLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check cozy mode state when cwd changes
  useEffect(() => {
    if (cwd) {
      isCozyModeEnabled(cwd).then(setCozyMode);
    }
  }, [cwd]);

  const handleCozyModeToggle = useCallback(async () => {
    setCozyModeLoading(true);
    try {
      if (cozyMode) {
        await disableCozyMode(cwd);
        setCozyMode(false);
      } else {
        await enableCozyMode(cwd);
        setCozyMode(true);
      }
    } catch (err: any) {
      setDeployError(err.message || 'Failed to toggle Cozy Mode');
    } finally {
      setCozyModeLoading(false);
    }
  }, [cwd, cozyMode]);

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
      window.cozyPane.deploy.getAuth().then(setAuth).catch(() => {});
    });
    return cleanup;
  }, []);

  // Listen for auth success from protocol handler
  useEffect(() => {
    const cleanup = window.cozyPane.onMenuAction('deploy:auth-success', () => {
      window.cozyPane.deploy.getAuth().then(setAuth).catch(() => {});
    });
    return cleanup;
  }, []);

  // Listen for auth error from protocol handler
  useEffect(() => {
    const cleanup = window.cozyPane.onMenuAction('deploy:auth-error', () => {
      setDeployError('Authentication failed. Please try again.');
    });
    return cleanup;
  }, []);

  // Load deployments when authenticated
  const onDeploymentsLoadedRef = useRef(onDeploymentsLoaded);
  onDeploymentsLoadedRef.current = onDeploymentsLoaded;

  const loadDeployments = useCallback(() => {
    if (!auth.authenticated) return;
    window.cozyPane.deploy.list()
      .then((list: any) => {
        if (list?.error) { setDeployments([]); return; }
        const deployments = Array.isArray(list) ? list : [];
        setDeployments(deployments);
        onDeploymentsLoadedRef.current?.(deployments);
      })
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

  const handleDeploy = useCallback(() => {
    // Send "cozydeploy" command to Claude Code in the terminal.
    // Claude picks this up and uses the cozypane_deploy MCP tool.
    onTerminalCommand(`cozydeploy ${cwd}`);
  }, [cwd, onTerminalCommand]);

  const handleRedeploy = useCallback((appName?: string) => {
    // Full redeploy: re-upload source + rebuild (same as initial deploy)
    onTerminalCommand(`cozydeploy ${cwd}${appName ? ` --app ${appName}` : ''}`);
  }, [cwd, onTerminalCommand]);

  const handleRestart = useCallback(async (id: string) => {
    try {
      const result = await window.cozyPane.deploy.redeploy(id);
      setDeployments(prev => prev.map(d => String(d.id) === id ? { ...d, ...result } : d));
    } catch (err: any) {
      setDeployError(err.message || 'Restart failed');
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

  const handleToggleDomains = useCallback(async (id: string) => {
    if (domainViewId === id) {
      setDomainViewId(null);
      setDomains([]);
      setDomainError(null);
      return;
    }
    setDomainViewId(id);
    setDomainLoading(true);
    setDomainError(null);
    try {
      const result = await window.cozyPane.deploy.listDomains(id);
      if (result?.error) { setDomainError(result.error); setDomains([]); }
      else setDomains(result?.domains || []);
    } catch (err: any) {
      setDomainError(err.message);
    } finally {
      setDomainLoading(false);
    }
  }, [domainViewId]);

  const handleAddDomain = useCallback(async (deployId: string) => {
    const domain = newDomain.trim().toLowerCase();
    if (!domain) return;
    setDomainLoading(true);
    setDomainError(null);
    try {
      const result = await window.cozyPane.deploy.addDomain(deployId, domain);
      if (result?.error) { setDomainError(result.error); return; }
      setNewDomain('');
      // Refresh domains list
      const list = await window.cozyPane.deploy.listDomains(deployId);
      setDomains(list?.domains || []);
    } catch (err: any) {
      setDomainError(err.message);
    } finally {
      setDomainLoading(false);
    }
  }, [newDomain]);

  const handleVerifyDomain = useCallback(async (deployId: string, domainId: string) => {
    setDomainLoading(true);
    setDomainError(null);
    try {
      const result = await window.cozyPane.deploy.verifyDomain(deployId, String(domainId));
      if (result?.error && !result?.verified) {
        setDomainError(result.error);
      }
      // Refresh domains list
      const list = await window.cozyPane.deploy.listDomains(deployId);
      setDomains(list?.domains || []);
    } catch (err: any) {
      setDomainError(err.message);
    } finally {
      setDomainLoading(false);
    }
  }, []);

  const handleRemoveDomain = useCallback(async (deployId: string, domainId: string) => {
    setDomainLoading(true);
    setDomainError(null);
    try {
      await window.cozyPane.deploy.removeDomain(deployId, String(domainId));
      const list = await window.cozyPane.deploy.listDomains(deployId);
      setDomains(list?.domains || []);
    } catch (err: any) {
      setDomainError(err.message);
    } finally {
      setDomainLoading(false);
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

  // Show Cozy Mode prompt when deploy features are not enabled
  if (!cozyMode) {
    return (
      <div className="deploy-panel" style={panelStyle}>
        <div style={headerStyle}>
          <span style={{ fontWeight: 600, fontSize: '0.95em' }}>Deploy</span>
        </div>
        <div style={centerStyle}>
          <div style={{ textAlign: 'center', padding: '2em 1em', maxWidth: 340 }}>
            <p style={{ color: 'var(--text-primary, #e0e0e0)', marginBottom: '0.5em', fontSize: '0.95em', fontWeight: 600 }}>
              Enable Cozy Mode to deploy
            </p>
            <p style={{ color: 'var(--text-secondary, #888)', marginBottom: '1.2em', fontSize: '0.82em', lineHeight: 1.5 }}>
              Cozy Mode adds deployment guidelines to your project so Claude builds deploy-ready code and can use CozyPane Cloud.
            </p>
            <button
              onClick={handleCozyModeToggle}
              disabled={cozyModeLoading}
              style={primaryBtnStyle}
            >
              {cozyModeLoading ? 'Enabling...' : 'Enable Cozy Mode'}
            </button>
            {deployError && (
              <div style={{ color: '#e74c3c', fontSize: '0.82em', marginTop: '0.6em' }}>{deployError}</div>
            )}
          </div>
        </div>
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
          Current project
        </div>
        <div style={{ fontSize: '0.88em', marginBottom: '0.5em', color: 'var(--text-primary, #e0e0e0)' }}>
          {cwd.split('/').pop() || cwd}
        </div>

        {/* Cozy Mode toggle */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '0.6em',
          padding: '0.4em 0.5em',
          borderRadius: 6,
          border: `1px solid ${cozyMode ? 'var(--accent, #7c6fe0)44' : 'var(--border, #2a2b3e)'}`,
          backgroundColor: cozyMode ? 'var(--accent, #7c6fe0)11' : 'transparent',
        }}>
          <div>
            <div style={{ fontSize: '0.84em', fontWeight: 600, color: 'var(--text-primary, #e0e0e0)' }}>
              Cozy Mode
            </div>
            <div style={{ fontSize: '0.72em', color: 'var(--text-secondary, #777)', marginTop: '0.1em' }}>
              {cozyMode ? 'Claude builds deployment-ready' : 'Claude works freely'}
            </div>
          </div>
          <button
            onClick={handleCozyModeToggle}
            disabled={cozyModeLoading}
            style={{
              width: 38,
              height: 20,
              borderRadius: 10,
              border: 'none',
              backgroundColor: cozyMode ? 'var(--accent, #7c6fe0)' : 'var(--border, #3a3b4e)',
              cursor: cozyModeLoading ? 'wait' : 'pointer',
              position: 'relative',
              transition: 'background-color 0.2s',
              flexShrink: 0,
            }}
          >
            <div style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              backgroundColor: '#fff',
              position: 'absolute',
              top: 2,
              left: cozyMode ? 20 : 2,
              transition: 'left 0.2s',
            }} />
          </button>
        </div>

        {(() => {
          const projectName = (cwd.split('/').pop() || '').toLowerCase();
          const existingDeploy = deployments.find(d =>
            d.appName === projectName || d.status === 'running' || d.status === 'unhealthy'
          );
          const isRedeploy = !!existingDeploy;
          return (
            <>
              <button
                onClick={handleDeploy}
                disabled={claudeRunning}
                style={{
                  ...primaryBtnStyle,
                  opacity: claudeRunning ? 0.5 : 1,
                  cursor: claudeRunning ? 'not-allowed' : 'pointer',
                  width: '100%',
                  backgroundColor: isRedeploy ? 'var(--accent, #7c6fe0)' : 'var(--accent, #7c6fe0)',
                }}
              >
                {claudeRunning ? 'Claude is busy...' : isRedeploy ? 'Redeploy' : 'CozyDeploy'}
              </button>
              {claudeRunning && (
                <div style={{ fontSize: '0.78em', color: 'var(--text-secondary, #888)', marginTop: '0.3em', textAlign: 'center' }}>
                  Wait for Claude to finish, or open a new terminal tab
                </div>
              )}
              <div style={{ fontSize: '0.78em', color: 'var(--text-secondary, #666)', marginTop: '0.3em', textAlign: 'center' }}>
                {isRedeploy ? 'Re-upload and rebuild your project' : 'Claude will analyze your project and deploy it'}
              </div>
            </>
          );
        })()}
        {deployError && (
          <div style={{ color: '#e74c3c', fontSize: '0.82em', marginTop: '0.4em' }}>{deployError}</div>
        )}
      </div>

      {/* Deployments list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5em 0.75em 0.25em' }}>
          <span style={{ fontSize: '0.8em', color: 'var(--text-secondary, #888)' }}>
            Your deployments
          </span>
          <button onClick={loadDeployments} style={tinyBtnStyle} title="Refresh">
            Refresh
          </button>
        </div>
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

              {/* Tier + type + database */}
              <div style={{ fontSize: '0.75em', color: 'var(--text-secondary, #777)', marginBottom: '0.4em' }}>
                {dep.projectType} &middot; {dep.tier}
                {dep.hasDatabase && (
                  <span style={{
                    marginLeft: '0.4em',
                    padding: '1px 5px',
                    borderRadius: 3,
                    backgroundColor: '#3b82f622',
                    color: '#3b82f6',
                    fontSize: '0.92em',
                    fontWeight: 600,
                  }}>
                    PostgreSQL
                  </span>
                )}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: '0.4em', flexWrap: 'wrap' }}>
                <button onClick={() => handleViewLogs(String(dep.id))} style={tinyBtnStyle}>
                  {logViewId === String(dep.id) ? 'Hide Logs' : 'Logs'}
                </button>
                <button onClick={() => handleToggleDomains(String(dep.id))} style={tinyBtnStyle}>
                  {domainViewId === String(dep.id) ? 'Hide Domains' : 'Domains'}
                </button>
                <button onClick={() => handleRedeploy(dep.appName)} style={tinyBtnStyle}>
                  Redeploy
                </button>
                <button onClick={() => handleRestart(String(dep.id))} style={tinyBtnStyle}>
                  Restart
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

              {/* Custom domains */}
              {domainViewId === String(dep.id) && (
                <div style={{ marginTop: '0.5em', padding: '0.5em', borderRadius: 4, border: '1px solid var(--border, #2a2b3e)', backgroundColor: 'var(--bg-primary, #1a1b2e)' }}>
                  <div style={{ fontSize: '0.8em', fontWeight: 600, marginBottom: '0.4em', color: 'var(--text-primary, #e0e0e0)' }}>
                    Custom Domains
                  </div>

                  {domainLoading && <div style={{ fontSize: '0.78em', color: 'var(--text-secondary, #888)' }}>Loading...</div>}

                  {/* Existing domains */}
                  {domains.map(d => (
                    <div key={d.id} style={{ padding: '0.3em 0', borderBottom: '1px solid var(--border, #2a2b3e)22' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: '0.82em', color: 'var(--text-primary, #e0e0e0)' }}>{d.domain}</span>
                        <div style={{ display: 'flex', gap: '0.3em', alignItems: 'center' }}>
                          {d.verified ? (
                            <span style={{ fontSize: '0.72em', color: '#4caf50', fontWeight: 600 }}>Connected</span>
                          ) : (
                            <button
                              onClick={() => handleVerifyDomain(String(dep.id), String(d.id))}
                              disabled={domainLoading}
                              style={{ ...tinyBtnStyle, color: 'var(--accent, #7c6fe0)' }}
                            >
                              Verify
                            </button>
                          )}
                          <button
                            onClick={() => handleRemoveDomain(String(dep.id), String(d.id))}
                            disabled={domainLoading}
                            style={{ ...tinyBtnStyle, color: '#e74c3c', padding: '1px 5px' }}
                          >
                            x
                          </button>
                        </div>
                      </div>
                      {!d.verified && d.cname && (
                        <div style={{ fontSize: '0.72em', color: 'var(--text-secondary, #777)', marginTop: '0.2em', fontFamily: 'monospace' }}>
                          CNAME {d.domain} &rarr; {d.cname}
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Add domain form */}
                  <div style={{ display: 'flex', gap: '0.3em', marginTop: '0.4em' }}>
                    <input
                      type="text"
                      value={newDomain}
                      onChange={e => setNewDomain(e.target.value)}
                      placeholder="example.com"
                      onKeyDown={e => e.key === 'Enter' && handleAddDomain(String(dep.id))}
                      style={{
                        flex: 1,
                        padding: '3px 6px',
                        borderRadius: 3,
                        border: '1px solid var(--border, #2a2b3e)',
                        backgroundColor: 'var(--bg-secondary, #1e1f32)',
                        color: 'var(--text-primary, #e0e0e0)',
                        fontSize: '0.78em',
                        outline: 'none',
                      }}
                    />
                    <button
                      onClick={() => handleAddDomain(String(dep.id))}
                      disabled={domainLoading || !newDomain.trim()}
                      style={{ ...tinyBtnStyle, color: 'var(--accent, #7c6fe0)' }}
                    >
                      Add
                    </button>
                  </div>

                  {domainError && (
                    <div style={{ fontSize: '0.72em', color: '#e74c3c', marginTop: '0.3em' }}>{domainError}</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Databases section */}
        {deployments.some(d => d.hasDatabase) && (
          <>
            <div style={{ padding: '0.5em 0.75em 0.25em' }}>
              <span style={{ fontSize: '0.8em', color: 'var(--text-secondary, #888)' }}>
                Your databases
              </span>
            </div>
            <div style={{ padding: '0 0.75em 0.5em' }}>
              {deployments.filter(d => d.hasDatabase).map(dep => (
                <div key={`db-${dep.id}`} style={{
                  ...deploymentCardStyle,
                  borderLeft: '3px solid #3b82f6',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4em', marginBottom: '0.2em' }}>
                    <span style={{ fontSize: '0.78em', color: '#3b82f6', fontWeight: 600 }}>PostgreSQL</span>
                    <span style={{ fontSize: '0.78em', color: 'var(--text-secondary, #777)' }}>&middot; {dep.appName}</span>
                  </div>
                  <div style={{ fontSize: '0.75em', color: 'var(--text-secondary, #666)' }}>
                    Managed by CozyPane &middot; Auto-provisioned with deployment
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
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
