import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useConfirm } from '../lib/confirmContext';
import DomainManager from './DomainManager';

interface Props {
  auth: DeployAuth;
  deployments: Deployment[];
  onLogin: () => void;
  onLogout: () => void;
  onRefresh: () => void;
  onTerminalCommand: (command: string) => void;
}

type Tab = 'deployments' | 'databases';

const STATUS_COLORS: Record<string, string> = {
  building: 'var(--warning, #e6b800)',
  running: 'var(--success, #4caf50)',
  stopped: 'var(--danger, #e74c3c)',
  error: 'var(--danger, #e74c3c)',
  failed: 'var(--danger, #e74c3c)',
  unhealthy: 'var(--warning, #e6b800)',
};

const DB_ICONS: Record<string, string> = {
  postgres: 'PG',
  redis: 'RD',
  mysql: 'MY',
};

export default function DeployManagement({ auth, deployments, onLogin, onLogout, onRefresh, onTerminalCommand }: Props) {
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>('deployments');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [logViewId, setLogViewId] = useState<string | null>(null);
  const [logs, setLogs] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [domainViewId, setDomainViewId] = useState<string | null>(null);
  const [domains, setDomains] = useState<CustomDomain[]>([]);
  const [newDomain, setNewDomain] = useState('');
  const [domainLoading, setDomainLoading] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const deploymentsWithDb = deployments.filter(d => d.hasDatabase);

  // --- Actions ---

  const handleRestart = useCallback(async (id: string) => {
    try {
      await window.cozyPane.deploy.redeploy(id);
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Restart failed');
    }
  }, [onRefresh]);

  const handleDelete = useCallback(async (id: number, appName: string) => {
    const ok = await confirm({
      title: 'Delete deployment?',
      message: `Delete "${appName}"? This will stop the container, remove its image, and drop any provisioned database.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await window.cozyPane.deploy.delete(String(id));
      onRefresh();
    } catch (err: any) {
      setActionError(err.message || 'Delete failed');
    }
  }, [confirm, onRefresh]);

  const handleRedeploy = useCallback((appName: string) => {
    onTerminalCommand(`cozydeploy . --app ${appName}`);
  }, [onTerminalCommand]);

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

  const handleToggleDomains = useCallback(async (id: string) => {
    if (domainViewId === id) { setDomainViewId(null); setDomains([]); setDomainError(null); return; }
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
    try {
      await window.cozyPane.deploy.verifyDomain(deployId, String(domainId));
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

  if (!auth.authenticated) {
    return (
      <div className="deploy-mgmt">
        <div className="deploy-mgmt-header">
          <span style={{ fontWeight: 600 }}>CozyPane Cloud</span>
        </div>
        <div className="deploy-center">
          <div style={{ textAlign: 'center', padding: '2em 1em' }}>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1em', fontSize: '0.9em' }}>
              Sign in to manage your deployments
            </p>
            <button onClick={onLogin} className="deploy-btn-primary">Sign in with GitHub</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="deploy-mgmt">
      {/* Header */}
      <div className="deploy-mgmt-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5em' }}>
          {auth.avatarUrl && <img src={auth.avatarUrl} alt="" style={{ width: 20, height: 20, borderRadius: '50%' }} />}
          <span style={{ fontWeight: 600, fontSize: '0.9em' }}>{auth.username}</span>
        </div>
        <div style={{ display: 'flex', gap: '0.3em' }}>
          <button onClick={onRefresh} className="deploy-btn-tiny">Refresh</button>
          <button onClick={onLogout} className="deploy-btn-tiny">Sign out</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="deploy-mgmt-tabs">
        <button className={`deploy-mgmt-tab ${tab === 'deployments' ? 'active' : ''}`} onClick={() => setTab('deployments')}>
          Deployments ({deployments.length})
        </button>
        <button className={`deploy-mgmt-tab ${tab === 'databases' ? 'active' : ''}`} onClick={() => setTab('databases')}>
          Databases ({deploymentsWithDb.length})
        </button>
      </div>

      {actionError && (
        <div style={{ padding: '0.4em 0.75em', fontSize: '0.82em', color: 'var(--danger)' }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: '0.5em', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>x</button>
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0.5em 0.75em' }}>
        {tab === 'deployments' && (
          <>
            {deployments.length === 0 && (
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.85em', textAlign: 'center', padding: '2em 0' }}>
                No deployments yet
              </div>
            )}
            {deployments.map(dep => (
              <div key={dep.id} className="deploy-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.2em' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.88em' }}>{dep.appName}</span>
                  <span style={{
                    fontSize: '0.7em', padding: '1px 6px', borderRadius: 3,
                    backgroundColor: `${STATUS_COLORS[dep.status] || '#666'}22`,
                    color: STATUS_COLORS[dep.status] || '#666',
                    fontWeight: 600, textTransform: 'uppercase',
                  }}>
                    {dep.status}
                  </span>
                </div>

                {dep.url && dep.status === 'running' && (
                  <a href={dep.url} onClick={e => { e.preventDefault(); window.open(dep.url, '_blank'); }}
                    style={{ fontSize: '0.8em', color: 'var(--accent)', textDecoration: 'none', display: 'block', marginBottom: '0.2em' }}>
                    {dep.subdomain}.cozypane.com
                  </a>
                )}

                <div style={{ fontSize: '0.73em', color: 'var(--text-secondary)', marginBottom: '0.3em' }}>
                  {dep.projectType} &middot; {dep.tier}
                  {dep.framework && <> &middot; {dep.framework}</>}
                  {dep.group && <> &middot; group: {dep.group}</>}
                  {dep.hasDatabase && (
                    <span style={{
                      marginLeft: '0.4em', padding: '0 4px', borderRadius: 3,
                      backgroundColor: 'color-mix(in srgb, var(--info, #3b82f6) 13%, transparent)',
                      color: 'var(--info, #3b82f6)', fontSize: '0.92em', fontWeight: 600,
                    }}>
                      {dep.databaseType === 'redis' ? 'Redis' : dep.databaseType === 'mysql' ? 'MySQL' : 'PG'}
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', gap: '0.35em', flexWrap: 'wrap' }}>
                  <button onClick={() => handleViewLogs(String(dep.id))} className="deploy-btn-tiny">
                    {logViewId === String(dep.id) ? 'Hide Logs' : 'Logs'}
                  </button>
                  <button onClick={() => handleToggleDomains(String(dep.id))} className="deploy-btn-tiny">
                    {domainViewId === String(dep.id) ? 'Hide Domains' : 'Domains'}
                  </button>
                  <button onClick={() => handleRedeploy(dep.appName)} className="deploy-btn-tiny">Redeploy</button>
                  <button onClick={() => handleRestart(String(dep.id))} className="deploy-btn-tiny">Restart</button>
                  {dep.url && dep.status === 'running' && (
                    <button onClick={() => window.open(dep.url, '_blank')} className="deploy-btn-tiny">Visit</button>
                  )}
                  <button onClick={() => handleDelete(dep.id, dep.appName)} className="deploy-btn-tiny" style={{ color: 'var(--danger)' }}>Delete</button>
                </div>

                {logViewId === String(dep.id) && (
                  <div className="deploy-log-box">{logsLoading ? 'Loading logs...' : (logs || 'No logs available')}</div>
                )}

                {domainViewId === String(dep.id) && (
                  <DomainManager
                    deployId={String(dep.id)}
                    domains={domains}
                    newDomain={newDomain}
                    domainLoading={domainLoading}
                    domainError={domainError}
                    onNewDomainChange={setNewDomain}
                    onAddDomain={handleAddDomain}
                    onVerifyDomain={handleVerifyDomain}
                    onRemoveDomain={handleRemoveDomain}
                  />
                )}
              </div>
            ))}
          </>
        )}

        {tab === 'databases' && (
          <>
            {deploymentsWithDb.length === 0 && (
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.85em', textAlign: 'center', padding: '2em 0' }}>
                No databases provisioned
              </div>
            )}
            {deploymentsWithDb.map(dep => (
              <div key={`db-${dep.id}`} className="deploy-card" style={{ borderLeft: '3px solid var(--info, #3b82f6)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.2em' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}>
                    <span style={{ fontSize: '0.82em', color: 'var(--info, #3b82f6)', fontWeight: 700 }}>
                      {DB_ICONS[dep.databaseType || 'postgres'] || 'DB'}
                    </span>
                    <span style={{ fontSize: '0.85em', fontWeight: 600 }}>{dep.appName}</span>
                  </div>
                  <span style={{
                    fontSize: '0.7em', padding: '1px 5px', borderRadius: 3,
                    backgroundColor: `${STATUS_COLORS[dep.status] || '#666'}22`,
                    color: STATUS_COLORS[dep.status] || '#666',
                    fontWeight: 600, textTransform: 'uppercase',
                  }}>
                    {dep.status}
                  </span>
                </div>
                <div style={{ fontSize: '0.75em', color: 'var(--text-secondary)' }}>
                  {dep.databaseType === 'redis' ? 'Redis' : dep.databaseType === 'mysql' ? 'MySQL' : 'PostgreSQL'}
                  {dep.databaseName && <span style={{ fontFamily: 'monospace' }}> &middot; {dep.databaseName}</span>}
                </div>
                <div style={{ fontSize: '0.72em', color: 'var(--text-secondary)', marginTop: '0.15em' }}>
                  Auto-provisioned &middot; Managed by CozyPane
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
