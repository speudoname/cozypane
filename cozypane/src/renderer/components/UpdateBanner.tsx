import React, { useState, useEffect, useCallback } from 'react';

interface Props {
  onRunUpdate: (command: string) => void;
}

export default function UpdateBanner({ onRunUpdate }: Props) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    // Check for cached result
    window.cozyPane.updates.getLast().then(cached => {
      if (cached && (cached.brewOutdated.length > 0 || cached.claudeUpdate)) {
        setInfo(cached);
      }
    });

    // Listen for new check results
    const cleanupAvailable = window.cozyPane.updates.onAvailable((newInfo) => {
      setInfo(newInfo);
      setDismissed(false);
    });

    // Listen for auto-update errors (network failures, signature mismatches, etc.)
    const cleanupError = window.cozyPane.updates.onError(({ message }) => {
      setUpdateError(message);
    });

    return () => {
      cleanupAvailable();
      cleanupError();
    };
  }, []);

  const handleUpdate = useCallback(async (opts: { brew: boolean; claude: boolean }) => {
    const command = await window.cozyPane.updates.getCommand(opts);
    if (command) {
      onRunUpdate(command);
      setDismissed(true);
    }
  }, [onRunUpdate]);

  const handleRecheck = useCallback(() => {
    setInfo(null);
    window.cozyPane.updates.check().then(result => {
      if (result.brewOutdated.length > 0 || result.claudeUpdate) {
        setInfo(result);
      }
    });
  }, []);

  if (updateError && !dismissed) {
    return (
      <div className="update-banner" style={{ borderLeft: '3px solid var(--danger, #e74c3c)' }}>
        <div className="update-banner-main">
          <span className="update-banner-icon">!</span>
          <span className="update-banner-text">Auto-update failed: {updateError}</span>
          <div className="update-banner-actions">
            <button className="btn update-btn-secondary" onClick={handleRecheck}>Retry</button>
            <button className="btn update-btn-dismiss" onClick={() => { setUpdateError(null); setDismissed(true); }} title="Dismiss">x</button>
          </div>
        </div>
      </div>
    );
  }

  if (!info || dismissed) return null;

  const brewCount = info.brewOutdated.length;
  const hasClaude = !!info.claudeUpdate;
  const hasAny = brewCount > 0 || hasClaude;

  if (!hasAny) return null;

  const parts: string[] = [];
  if (brewCount > 0) parts.push(`${brewCount} brew package${brewCount > 1 ? 's' : ''}`);
  if (hasClaude) parts.push(`Claude CLI (${info.claudeUpdate!.current} -> ${info.claudeUpdate!.latest})`);

  return (
    <div className="update-banner">
      <div className="update-banner-main">
        <span className="update-banner-icon">*</span>
        <span className="update-banner-text">
          Updates available: {parts.join(', ')}
        </span>
        <div className="update-banner-actions">
          {brewCount > 0 && hasClaude ? (
            <>
              <button className="btn update-btn" onClick={() => handleUpdate({ brew: true, claude: true })}>
                Update All
              </button>
              <button className="btn update-btn-secondary" onClick={() => setExpanded(!expanded)}>
                {expanded ? 'Less' : 'Details'}
              </button>
            </>
          ) : (
            <button className="btn update-btn" onClick={() => handleUpdate({ brew: brewCount > 0, claude: hasClaude })}>
              Update
            </button>
          )}
          <button className="btn update-btn-dismiss" onClick={() => setDismissed(true)} title="Dismiss">
            x
          </button>
        </div>
      </div>

      {expanded && (
        <div className="update-banner-details">
          {hasClaude && (
            <div className="update-detail-row">
              <span className="update-detail-name">Claude CLI</span>
              <span className="update-detail-version">{info.claudeUpdate!.current} -&gt; {info.claudeUpdate!.latest}</span>
              <button className="btn update-btn-sm" onClick={() => handleUpdate({ brew: false, claude: true })}>Update</button>
            </div>
          )}
          {brewCount > 0 && (
            <>
              <div className="update-detail-row">
                <span className="update-detail-name">Brew ({brewCount})</span>
                <span className="update-detail-version" />
                <button className="btn update-btn-sm" onClick={() => handleUpdate({ brew: true, claude: false })}>Update</button>
              </div>
              {info.brewOutdated.slice(0, 10).map(pkg => (
                <div key={pkg.name} className="update-detail-row update-detail-sub">
                  <span className="update-detail-name">{pkg.name}</span>
                  <span className="update-detail-version">{pkg.current} -&gt; {pkg.latest}</span>
                </div>
              ))}
              {brewCount > 10 && (
                <div className="update-detail-row update-detail-sub">
                  <span className="update-detail-name">...and {brewCount - 10} more</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
