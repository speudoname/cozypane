import React, { useState, useEffect, useCallback, useRef } from 'react';

interface RemoteInfo {
  hasRemote: boolean;
  remoteUrl: string;
  ghAuthed: boolean;
  ghInstalled: boolean;
}

interface Props {
  cwd: string;
  onDiffClick: (path: string, before: string, after: string) => void;
  onBranchChange: (branch: string) => void;
  activityEvents: FileChangeEvent[];
  onTerminalCommand: (command: string) => void;
  claudeRunning: boolean;
}

function shellEscape(s: string): string {
  // Single-quote wrapping: replace each ' with '\''
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export default function GitPanel({ cwd, onDiffClick, onBranchChange, activityEvents, onTerminalCommand, claudeRunning }: Props) {
  const [isRepo, setIsRepo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [branch, setBranch] = useState('');
  const [detached, setDetached] = useState(false);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [commitMsg, setCommitMsg] = useState('');
  const [revertConfirm, setRevertConfirm] = useState(false);
  const [remoteInfo, setRemoteInfo] = useState<RemoteInfo>({ hasRemote: false, remoteUrl: '', ghAuthed: false, ghInstalled: false });
  const [generatingMsg, setGeneratingMsg] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => refreshRef.current?.(), 1500);
  }, []);

  const fetchRemoteInfo = useCallback(async () => {
    if (!cwd) return;
    try {
      const remote = await window.cozyPane.git.remoteInfo(cwd);
      setRemoteInfo(remote);
    } catch (err) {
      console.error('[GitPanel] remoteInfo error:', err);
    }
  }, [cwd]);

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
  refreshRef.current = refresh;

  // Refresh immediately on cwd change, fetch remote info once
  useEffect(() => {
    setLoading(true);
    refresh();
    fetchRemoteInfo();
  }, [cwd, refresh, fetchRemoteInfo]);

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

  // Poll git status every 5s while panel is mounted
  useEffect(() => {
    if (!isRepo) return;
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [isRepo, refresh]);

  // Write actions — all route through terminal
  const handleStage = (filePath: string) => { onTerminalCommand(`git add -- ${shellEscape(filePath)}`); scheduleRefresh(); };
  const handleUnstage = (filePath: string) => { onTerminalCommand(`git reset HEAD -- ${shellEscape(filePath)}`); scheduleRefresh(); };
  const handleStageAll = () => { onTerminalCommand('git add -A'); scheduleRefresh(); };
  const handleUnstageAll = () => { onTerminalCommand('git reset HEAD'); scheduleRefresh(); };
  const handleCommit = () => {
    if (!commitMsg.trim()) return;
    onTerminalCommand(`git commit -m ${shellEscape(commitMsg.trim())}`);
    setCommitMsg('');
    scheduleRefresh();
  };
  const handlePush = () => { onTerminalCommand('git push'); scheduleRefresh(); };
  const handlePull = () => { onTerminalCommand('git pull'); scheduleRefresh(); };
  const handlePullRebase = () => { onTerminalCommand('git pull --rebase'); scheduleRefresh(); };
  const handleRevertFile = (filePath: string) => { onTerminalCommand(`git checkout HEAD -- ${shellEscape(filePath)}`); scheduleRefresh(); };

  const handleDiff = async (filePath: string) => {
    const result = await window.cozyPane.git.diffFile(cwd, filePath);
    if (result.error) return;
    onDiffClick(filePath, result.before ?? '', result.after ?? '');
  };

  const aiTouchedFiles = files.filter(f => {
    return activityEvents.some(e => e.path.endsWith(f.path) || f.path.endsWith(e.name));
  });

  const handleRevertAll = () => {
    const paths = aiTouchedFiles.map(f => shellEscape(f.path)).join(' ');
    if (!paths) return;
    onTerminalCommand(`git checkout HEAD -- ${paths}`);
    setRevertConfirm(false);
    scheduleRefresh();
  };

  const handleGenerateMsg = async () => {
    setGeneratingMsg(true);
    try {
      const result = await window.cozyPane.git.generateCommitMsg(cwd);
      if (result.message) setCommitMsg(result.message);
    } catch (err) {
      console.error('[GitPanel] generateCommitMsg error:', err);
    } finally {
      setGeneratingMsg(false);
    }
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
          <button className="btn git-init-btn" onClick={() => { onTerminalCommand('git init'); scheduleRefresh(); }}>
            Initialize Repository
          </button>
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
          <div className="git-actions-row">
            <button className="btn git-action-btn" onClick={handlePull} title="Pull">Pull</button>
            <button className="btn git-action-btn" onClick={handlePullRebase} title="Pull --rebase">Pull -r</button>
            <button className="btn git-action-btn" onClick={handlePush} title="Push">Push</button>
          </div>
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
          <div className="git-commit-input-row">
            <button
              className="btn git-generate-btn"
              onClick={handleGenerateMsg}
              disabled={generatingMsg || staged.length === 0}
              title="Generate commit message with AI"
            >
              {generatingMsg ? '...' : 'AI'}
            </button>
            <input
              className="git-commit-input"
              placeholder="Commit message..."
              value={commitMsg}
              onChange={e => setCommitMsg(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleCommit(); } }}
            />
          </div>
          <button
            className="btn git-commit-btn"
            disabled={staged.length === 0 || !commitMsg.trim()}
            onClick={handleCommit}
          >
            Commit {staged.length} file{staged.length !== 1 ? 's' : ''}
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

        {/* Remote section */}
        <div className="git-remote-section">
          <div className="git-section-header">
            <span>REMOTE</span>
          </div>
          <div className="git-remote-body">
            {remoteInfo.hasRemote ? (
              <span className="git-remote-url">{remoteInfo.remoteUrl}</span>
            ) : remoteInfo.ghInstalled && remoteInfo.ghAuthed ? (
              <button
                className="btn git-action-btn"
                onClick={() => { onTerminalCommand('gh repo create --source=. --private --push'); scheduleRefresh(); }}
              >
                Create on GitHub
              </button>
            ) : remoteInfo.ghInstalled && !remoteInfo.ghAuthed ? (
              <>
                <span className="git-remote-hint">gh not authenticated.</span>
                <button
                  className="btn git-action-btn"
                  onClick={() => { onTerminalCommand('gh auth login --web'); }}
                >
                  Login to GitHub
                </button>
              </>
            ) : (
              <span className="git-remote-hint">Install gh CLI for GitHub features</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
