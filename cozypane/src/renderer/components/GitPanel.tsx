import React, { useState, useEffect, useCallback, useRef } from 'react';

interface GitFileStatus {
  path: string;
  indexStatus: string;
  workStatus: string;
  staged: boolean;
  status: 'added' | 'modified' | 'deleted' | 'untracked' | 'renamed';
}

interface GitCommit {
  hash: string;
  message: string;
  timeAgo: string;
}

interface Props {
  cwd: string;
  onDiffClick: (path: string, before: string, after: string) => void;
  onBranchChange: (branch: string) => void;
  activityEvents: FileChangeEvent[];
}

export default function GitPanel({ cwd, onDiffClick, onBranchChange, activityEvents }: Props) {
  const [isRepo, setIsRepo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [branch, setBranch] = useState('');
  const [detached, setDetached] = useState(false);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [revertConfirm, setRevertConfirm] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!cwd) return;
    try {
      const repoCheck = await window.cozyPane.git.isRepo(cwd);
      setIsRepo(repoCheck.isRepo);
      if (!repoCheck.isRepo) {
        setLoading(false);
        onBranchChange('');
        return;
      }
    } catch (err) {
      console.error('[GitPanel] isRepo check failed:', err);
      setIsRepo(false);
      setLoading(false);
      return;
    }

    try {
      const [statusRes, branchRes, logRes] = await Promise.all([
        window.cozyPane.git.status(cwd),
        window.cozyPane.git.branch(cwd),
        window.cozyPane.git.log(cwd),
      ]);

      setFiles(statusRes.files || []);
      setBranch(branchRes.branch || '');
      setDetached(branchRes.detached || false);
      setCommits(logRes.commits || []);
      onBranchChange(branchRes.branch || '');
    } catch (err) {
      console.error('[GitPanel] refresh error:', err);
    }
    setLoading(false);
  }, [cwd, onBranchChange]);

  // Refresh immediately on cwd change
  useEffect(() => {
    setLoading(true);
    refresh();
  }, [cwd]);

  // Debounced refresh on activity events
  const prevEventCountRef = useRef(activityEvents.length);
  useEffect(() => {
    if (activityEvents.length === prevEventCountRef.current) return;
    prevEventCountRef.current = activityEvents.length;

    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(refresh, 1000);

    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [activityEvents.length, refresh]);

  // Poll git status every 3s while panel is mounted (catches CLI git commands)
  useEffect(() => {
    if (!isRepo) return;
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [isRepo, refresh]);

  const handleStage = async (filePath: string) => {
    await window.cozyPane.git.stage(cwd, filePath);
    refresh();
  };

  const handleUnstage = async (filePath: string) => {
    await window.cozyPane.git.unstage(cwd, filePath);
    refresh();
  };

  const handleStageAll = async () => {
    await window.cozyPane.git.stageAll(cwd);
    refresh();
  };

  const handleUnstageAll = async () => {
    await window.cozyPane.git.unstageAll(cwd);
    refresh();
  };

  const handleCommit = async () => {
    if (!commitMsg.trim()) return;
    setCommitting(true);
    await window.cozyPane.git.commit(cwd, commitMsg.trim());
    setCommitMsg('');
    setCommitting(false);
    refresh();
  };

  const handleDiff = async (filePath: string) => {
    const result = await window.cozyPane.git.diffFile(cwd, filePath);
    if (result.error) return;
    onDiffClick(filePath, result.before ?? '', result.after ?? '');
  };

  const handleRevertFile = async (filePath: string) => {
    await window.cozyPane.git.revertFile(cwd, filePath);
    refresh();
  };

  const aiTouchedFiles = files.filter(f => {
    return activityEvents.some(e => e.path.endsWith(f.path) || f.path.endsWith(e.name));
  });

  const handleRevertAll = async () => {
    const paths = aiTouchedFiles.map(f => f.path);
    if (paths.length === 0) return;
    await window.cozyPane.git.revertFiles(cwd, paths);
    setRevertConfirm(false);
    refresh();
  };

  const staged = files.filter(f => f.staged);
  const unstaged = files.filter(f => !f.staged);

  const statusIcon = (status: GitFileStatus['status']) => {
    switch (status) {
      case 'added': return '+';
      case 'modified': return 'M';
      case 'deleted': return 'D';
      case 'renamed': return 'R';
      case 'untracked': return '?';
    }
  };

  const statusColor = (status: GitFileStatus['status']) => {
    switch (status) {
      case 'added': return 'var(--success)';
      case 'modified': return 'var(--warning)';
      case 'deleted': return 'var(--danger)';
      case 'renamed': return 'var(--info)';
      case 'untracked': return 'var(--text-muted)';
    }
  };

  if (loading) {
    return <div className="git-panel"><div className="git-empty">Loading...</div></div>;
  }

  if (!isRepo) {
    return (
      <div className="git-panel">
        <div className="git-header">
          <span className="git-title">Git</span>
        </div>
        <div className="git-empty">
          Not a git repository.
          <br /><br />
          Run <code>git init</code> in the terminal to get started.
        </div>
      </div>
    );
  }

  return (
    <div className="git-panel">
      <div className="git-header">
        <span className="git-title">Git</span>
        <button className="btn git-refresh-btn" onClick={refresh} title="Refresh">Refresh</button>
      </div>

      <div className="git-body">
        <div className="git-branch-row">
          <span className="git-branch-label">Branch:</span>
          <span className="git-branch-name">{detached ? `(${branch})` : branch}</span>
        </div>

        {/* Staged section */}
        <div className="git-section">
          <div className="git-section-header">
            <span>STAGED ({staged.length})</span>
            {staged.length > 0 && (
              <button className="btn git-section-btn" onClick={handleUnstageAll}>Unstage All</button>
            )}
          </div>
          {staged.map(f => (
            <div key={`staged-${f.path}`} className="git-file-item">
              <span className="git-file-icon" style={{ color: statusColor(f.status) }}>{statusIcon(f.status)}</span>
              <span className="git-file-name" onClick={() => handleDiff(f.path)} title={f.path}>{f.path}</span>
              <div className="git-file-actions">
                <button className="btn git-file-btn" onClick={() => handleUnstage(f.path)}>Unstage</button>
              </div>
            </div>
          ))}
        </div>

        {/* Changes section */}
        <div className="git-section">
          <div className="git-section-header">
            <span>CHANGES ({unstaged.length})</span>
            {unstaged.length > 0 && (
              <button className="btn git-section-btn" onClick={handleStageAll}>Stage All</button>
            )}
          </div>
          {unstaged.map(f => (
            <div key={`unstaged-${f.path}`} className="git-file-item">
              <span className="git-file-icon" style={{ color: statusColor(f.status) }}>{statusIcon(f.status)}</span>
              <span className="git-file-name" onClick={() => handleDiff(f.path)} title={f.path}>{f.path}</span>
              <div className="git-file-actions">
                {f.status !== 'untracked' && (
                  <button className="btn git-file-btn" onClick={() => handleDiff(f.path)}>Diff</button>
                )}
                {f.status === 'deleted' ? (
                  <button className="btn git-file-btn git-undo-btn" onClick={() => handleRevertFile(f.path)}>Undo</button>
                ) : (
                  <button className="btn git-file-btn" onClick={() => handleStage(f.path)}>Stage</button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Commit area */}
        <div className="git-commit-area">
          <input
            className="git-commit-input"
            placeholder="Commit message..."
            value={commitMsg}
            onChange={e => setCommitMsg(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleCommit(); } }}
          />
          <button
            className="btn git-commit-btn"
            disabled={staged.length === 0 || !commitMsg.trim() || committing}
            onClick={handleCommit}
          >
            {committing ? 'Committing...' : `Commit ${staged.length} file${staged.length !== 1 ? 's' : ''}`}
          </button>
        </div>

        {/* Recent commits */}
        {commits.length > 0 && (
          <div className="git-section">
            <div className="git-section-header">
              <span>RECENT COMMITS</span>
            </div>
            <div className="git-commits-list">
              {commits.map(c => (
                <div key={c.hash} className="git-commit-item">
                  <span className="git-commit-hash">{c.hash}</span>
                  <span className="git-commit-msg">{c.message}</span>
                  <span className="git-commit-time">{c.timeAgo}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Revert AI changes */}
        {aiTouchedFiles.length > 0 && (
          <div className="git-revert-section">
            {!revertConfirm ? (
              <button className="btn git-revert-btn" onClick={() => setRevertConfirm(true)}>
                Revert All AI Changes ({aiTouchedFiles.length} files)
              </button>
            ) : (
              <div className="git-revert-confirm">
                <span>Revert {aiTouchedFiles.length} files?</span>
                <button className="btn git-revert-yes" onClick={handleRevertAll}>Yes</button>
                <button className="btn git-revert-cancel" onClick={() => setRevertConfirm(false)}>Cancel</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
