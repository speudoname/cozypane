import React, { useState, useEffect, useCallback, useRef } from 'react';
import { isCozyModeEnabled, enableCozyMode, disableCozyMode } from '../lib/cozyMode';

interface Props {
  cwd: string;
  auth: DeployAuth;
  deployments: Deployment[];
  onLogin: () => void;
  onTerminalCommand: (command: string) => void;
  onRefresh: () => void;
  onOpenManagement: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  building: 'var(--warning, #e6b800)',
  running: 'var(--success, #4caf50)',
  stopped: 'var(--danger, #e74c3c)',
  error: 'var(--danger, #e74c3c)',
  failed: 'var(--danger, #e74c3c)',
  unhealthy: 'var(--warning, #e6b800)',
};

export default function DeployTab({ cwd, auth, deployments, onLogin, onTerminalCommand, onRefresh, onOpenManagement }: Props) {
  const [cozyMode, setCozyMode] = useState(false);
  const [cozyModeLoading, setCozyModeLoading] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [isDeploying, setIsDeploying] = useState(false);
  const deployTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [logViewId, setLogViewId] = useState<string | null>(null);
  const [logs, setLogs] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);

  const projectName = (cwd.split('/').pop() || '').toLowerCase();
  const matched = deployments.find(d => d.appName === projectName);

  useEffect(() => {
    if (cwd) isCozyModeEnabled(cwd).then(setCozyMode);
  }, [cwd]);

  useEffect(() => {
    return () => { if (deployTimeoutRef.current) clearTimeout(deployTimeoutRef.current); };
  }, []);

  // Auto-clear deploying state when build finishes
  useEffect(() => {
    if (matched && matched.status !== 'building') {
      setIsDeploying(false);
      if (deployTimeoutRef.current) { clearTimeout(deployTimeoutRef.current); deployTimeoutRef.current = null; }
    }
  }, [matched?.status]);

  const handleCozyModeToggle = useCallback(async () => {
    setCozyModeLoading(true);
    try {
      if (cozyMode) { await disableCozyMode(cwd); setCozyMode(false); }
      else { await enableCozyMode(cwd); setCozyMode(true); }
    } catch (err: any) {
      setDeployError(err.message || 'Failed to toggle Cozy Mode');
    } finally {
      setCozyModeLoading(false);
    }
  }, [cwd, cozyMode]);

  const startDeploy = useCallback(() => {
    setIsDeploying(true);
    if (deployTimeoutRef.current) clearTimeout(deployTimeoutRef.current);
    deployTimeoutRef.current = setTimeout(() => setIsDeploying(false), 3 * 60 * 1000);
    onTerminalCommand(`cozydeploy ${cwd}${matched ? ` --app ${matched.appName}` : ''}`);
  }, [cwd, onTerminalCommand, matched]);

  const handleViewLogs = useCallback(async (id: string) => {
    if (logViewId === id) { setLogViewId(null); setLogs(''); return; }
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

  const deploying = isDeploying || matched?.status === 'building';

  // Not in cozy mode
  if (!cozyMode) {
    return (
      <div className="deploy-panel">
        <div className="deploy-header">
          <span style={{ fontWeight: 600, fontSize: '0.95em' }}>Deploy</span>
        </div>
        <div className="deploy-center">
          <div style={{ textAlign: 'center', padding: '2em 1em', maxWidth: 340 }}>
            <p style={{ color: 'var(--text-primary)', marginBottom: '0.5em', fontSize: '0.95em', fontWeight: 600 }}>
              Enable Cozy Mode to deploy
            </p>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.2em', fontSize: '0.82em', lineHeight: 1.5 }}>
              Cozy Mode adds deployment guidelines to your project so Claude builds deploy-ready code.
            </p>
            <button onClick={handleCozyModeToggle} disabled={cozyModeLoading} className="deploy-btn-primary">
              {cozyModeLoading ? 'Enabling...' : 'Enable Cozy Mode'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Not authenticated
  if (!auth.authenticated) {
    return (
      <div className="deploy-panel">
        <div className="deploy-header">
          <span style={{ fontWeight: 600, fontSize: '0.95em' }}>Deploy</span>
        </div>
        <div className="deploy-center">
          <div style={{ textAlign: 'center', padding: '2em 1em' }}>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.2em', fontSize: '0.9em' }}>
              Sign in with GitHub to deploy
            </p>
            <button onClick={onLogin} className="deploy-btn-primary">Sign in with GitHub</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="deploy-panel">
      <div className="deploy-header">
        <span style={{ fontWeight: 600, fontSize: '0.95em' }}>{projectName}</span>
        <button onClick={onOpenManagement} className="deploy-btn-small">All Deploys</button>
      </div>

      {/* Deploy / Redeploy */}
      <div className="deploy-section">
        <button
          onClick={startDeploy}
          disabled={deploying}
          className="deploy-btn-primary"
          style={{ width: '100%', opacity: deploying ? 0.5 : 1, cursor: deploying ? 'not-allowed' : 'pointer' }}
        >
          {deploying ? 'Deploying...' : matched ? 'Redeploy' : 'CozyDeploy'}
        </button>
        {deploying && (
          <div style={{ fontSize: '0.78em', color: 'var(--text-secondary)', marginTop: '0.3em', textAlign: 'center' }}>
            Deployment in progress...
          </div>
        )}
        {deployError && <div style={{ color: 'var(--danger)', fontSize: '0.82em', marginTop: '0.4em' }}>{deployError}</div>}
      </div>

      {/* Current deployment status */}
      {matched ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 0.75em' }}>
          <div className="deploy-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.3em' }}>
              <span style={{ fontWeight: 600, fontSize: '0.9em' }}>{matched.appName}</span>
              <span style={{
                fontSize: '0.72em', padding: '1px 6px', borderRadius: 3,
                backgroundColor: `${STATUS_COLORS[matched.status] || '#666'}22`,
                color: STATUS_COLORS[matched.status] || '#666',
                fontWeight: 600, textTransform: 'uppercase',
              }}>
                {matched.status}
              </span>
            </div>

            {matched.url && matched.status === 'running' && (
              <a
                href={matched.url}
                onClick={(e) => { e.preventDefault(); window.open(matched.url, '_blank'); }}
                style={{ fontSize: '0.82em', color: 'var(--accent)', textDecoration: 'none', display: 'block', marginBottom: '0.3em' }}
              >
                {matched.subdomain}.cozypane.com
              </a>
            )}

            <div style={{ fontSize: '0.75em', color: 'var(--text-secondary)', marginBottom: '0.4em' }}>
              {matched.projectType} &middot; {matched.tier}
              {matched.framework && <> &middot; {matched.framework}</>}
            </div>

            <div style={{ display: 'flex', gap: '0.4em', flexWrap: 'wrap' }}>
              <button onClick={() => handleViewLogs(String(matched.id))} className="deploy-btn-tiny">
                {logViewId === String(matched.id) ? 'Hide Logs' : 'Logs'}
              </button>
              <button onClick={() => onRefresh()} className="deploy-btn-tiny">Refresh</button>
              {matched.url && matched.status === 'running' && (
                <button onClick={() => window.open(matched.url, '_blank')} className="deploy-btn-tiny">Visit</button>
              )}
            </div>

            {logViewId === String(matched.id) && (
              <div className="deploy-log-box">
                {logsLoading ? 'Loading logs...' : (logs || 'No logs available')}
              </div>
            )}
          </div>

          {/* This project's database */}
          {matched.hasDatabase && (
            <div className="deploy-card" style={{ borderLeft: '3px solid var(--info, #3b82f6)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4em', marginBottom: '0.2em' }}>
                <span style={{ fontSize: '0.78em', color: 'var(--info, #3b82f6)', fontWeight: 600 }}>
                  {matched.databaseType === 'redis' ? 'Redis' : matched.databaseType === 'mysql' ? 'MySQL' : 'PostgreSQL'}
                </span>
              </div>
              {matched.databaseName && (
                <div style={{ fontSize: '0.75em', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                  {matched.databaseName}
                </div>
              )}
              <div style={{ fontSize: '0.72em', color: 'var(--text-secondary)', marginTop: '0.2em' }}>
                Managed by CozyPane &middot; Auto-provisioned
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="deploy-center">
          <div style={{ textAlign: 'center', padding: '1.5em 1em', color: 'var(--text-secondary)', fontSize: '0.85em' }}>
            This project hasn't been deployed yet.
            <br />
            <span style={{ fontSize: '0.9em' }}>Click <strong>CozyDeploy</strong> above to get started.</span>
          </div>
        </div>
      )}

      {/* Cozy Mode toggle at bottom */}
      <div style={{ padding: '0.5em 0.75em', borderTop: '1px solid var(--border, #2a2b3e)' }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0.3em 0.4em', borderRadius: 6,
          border: `1px solid ${cozyMode ? 'var(--accent)44' : 'var(--border, #2a2b3e)'}`,
          backgroundColor: cozyMode ? 'var(--accent)11' : 'transparent',
        }}>
          <div style={{ fontSize: '0.78em', color: 'var(--text-secondary)' }}>Cozy Mode</div>
          <button
            onClick={handleCozyModeToggle}
            disabled={cozyModeLoading}
            role="switch"
            aria-checked={cozyMode}
            aria-label="Toggle Cozy Mode"
            style={{
              width: 34, height: 18, borderRadius: 9, border: 'none',
              backgroundColor: cozyMode ? 'var(--accent, #7c6fe0)' : 'var(--border, #3a3b4e)',
              cursor: cozyModeLoading ? 'wait' : 'pointer', position: 'relative', transition: 'background-color 0.2s', flexShrink: 0,
            }}
          >
            <div style={{
              width: 14, height: 14, borderRadius: '50%', backgroundColor: 'var(--text-primary, #fff)',
              position: 'absolute', top: 2, left: cozyMode ? 18 : 2, transition: 'left 0.2s',
            }} />
          </button>
        </div>
      </div>
    </div>
  );
}
