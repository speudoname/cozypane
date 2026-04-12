import React from 'react';

interface DomainManagerProps {
  deployId: string;
  domains: CustomDomain[];
  newDomain: string;
  domainLoading: boolean;
  domainError: string | null;
  onNewDomainChange: (value: string) => void;
  onAddDomain: (deployId: string) => void;
  onVerifyDomain: (deployId: string, domainId: string) => void;
  onRemoveDomain: (deployId: string, domainId: string) => void;
}

export default function DomainManager({
  deployId,
  domains,
  newDomain,
  domainLoading,
  domainError,
  onNewDomainChange,
  onAddDomain,
  onVerifyDomain,
  onRemoveDomain,
}: DomainManagerProps) {
  return (
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
                <span style={{ fontSize: '0.72em', color: 'var(--success)', fontWeight: 600 }}>Connected</span>
              ) : (
                <button
                  onClick={() => onVerifyDomain(deployId, String(d.id))}
                  disabled={domainLoading}
                  className="deploy-btn-tiny"
                  style={{ color: 'var(--accent, #7c6fe0)' }}
                >
                  Verify
                </button>
              )}
              <button
                onClick={() => onRemoveDomain(deployId, String(d.id))}
                disabled={domainLoading}
                className="deploy-btn-tiny"
                style={{ color: 'var(--danger)', padding: '1px 5px' }}
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
          onChange={e => onNewDomainChange(e.target.value)}
          placeholder="example.com"
          onKeyDown={e => e.key === 'Enter' && onAddDomain(deployId)}
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
          onClick={() => onAddDomain(deployId)}
          disabled={domainLoading || !newDomain.trim()}
          className="deploy-btn-tiny"
          style={{ color: 'var(--accent, #7c6fe0)' }}
        >
          Add
        </button>
      </div>

      {domainError && (
        <div style={{ fontSize: '0.72em', color: 'var(--danger)', marginTop: '0.3em' }}>{domainError}</div>
      )}
    </div>
  );
}
