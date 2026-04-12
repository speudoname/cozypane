import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';

interface RemoteInfo {
  hasRemote: boolean;
  remoteUrl: string;
  githubAuthed: boolean;
  isSSH: boolean;
}

interface Props {
  cwd: string;
  onDiffClick: (path: string, before: string, after: string) => void;
  onBranchChange: (branch: string) => void;
  activityEvents: FileChangeEvent[];
  onTerminalCommand: (command: string) => void;
  claudeRunning: boolean;
}

import { shellEscape } from '../lib/shellUtils';

export default function GitPanel({ cwd, onDiffClick, onBranchChange, activityEvents, onTerminalCommand, claudeRunning }: Props) {
  const [isRepo, setIsRepo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [branch, setBranch] = useState('');
  const [detached, setDetached] = useState(false);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [commitMsg, setCommitMsg] = useState('');
  const [revertConfirm, setRevertConfirm] = useState(false);
  const [remoteInfo, setRemoteInfo] = useState<RemoteInfo>({ hasRemote: false, remoteUrl: '', githubAuthed: false, isSSH: false });
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [remoteMode, setRemoteMode] = useState<'none' | 'create' | 'connect'>('none');
  const [repoVisibility, setRepoVisibility] = useState<'private' | 'public'>('private');
  const [repoSearch, setRepoSearch] = useState('');
  const [repoResults, setRepoResults] = useState<GitHubRepo[]>([]);
  const [searchingRepos, setSearchingRepos] = useState(false);
  const [error, setError] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [generatingMsg, setGeneratingMsg] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(''), 5000);
  }, []);

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

  useEffect(() => {
    setLoading(true);
    refresh();
    fetchRemoteInfo();
  }, [cwd, refresh, fetchRemoteInfo]);

  useEffect(() => {
    const unsub1 = window.cozyPane.git.onAuthChanged(() => {
      fetchRemoteInfo();
    });
    const unsub2 = window.cozyPane.deploy.onAuthSuccess(() => {
      fetchRemoteInfo();
    });
    const unsub3 = window.cozyPane.deploy.onAuthError(() => {
      showError('GitHub sign-in failed. Please try again.');
    });
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [fetchRemoteInfo, showError]);

  const prevEventCountRef = useRef(activityEvents.length);
  useEffect(() => {
    if (activityEvents.length === prevEventCountRef.current) return;
    prevEventCountRef.current = activityEvents.length;
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(refresh, 3000);
    return () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); };
  }, [activityEvents.length, refresh]);

  useEffect(() => {
    if (!isRepo) return;
    // Poll every 15s but skip refreshes while the window is hidden /
    // minimized. The component is already unmounted when the user switches
    // right-panel tabs, but this guard also kills the ~4-processes-per-minute
    // churn while the entire app is backgrounded — which matters for
    // battery life on long sessions.
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      refresh();
    };
    const interval = setInterval(tick, 15000);
    return () => clearInterval(interval);
  }, [isRepo, refresh]);

  // Actions
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
  const handlePush = async () => {
    const cmd = await window.cozyPane.git.wrapCommand('git push');
    onTerminalCommand(cmd);
    scheduleRefresh();
  };
  const handlePull = async () => {
    const cmd = await window.cozyPane.git.wrapCommand('git pull');
    onTerminalCommand(cmd);
    scheduleRefresh();
  };
  const handleRevertFile = (filePath: string) => { onTerminalCommand(`git checkout HEAD -- ${shellEscape(filePath)}`); scheduleRefresh(); };

  const handleCreateRepo = async () => {
    setCreatingRepo(true);
    setError('');
    try {
      const result = await window.cozyPane.git.createRepo(cwd, repoVisibility === 'private');
      if (result.error) {
        showError(result.error);
      } else {
        setRemoteMode('none');
        fetchRemoteInfo();
      }
    } catch (err: any) {
      showError(err.message || 'Failed to create repository');
    } finally {
      setCreatingRepo(false);
    }
  };

  const handleConnectRepo = async (repo: GitHubRepo) => {
    setError('');
    try {
      const result = await window.cozyPane.git.addRemote(cwd, repo.cloneUrl);
      if (result.error) {
        showError(result.error);
      } else {
        setRemoteMode('none');
        setRepoSearch('');
        setRepoResults([]);
        fetchRemoteInfo();
      }
    } catch (err: any) {
      showError(err.message || 'Failed to connect repository');
    }
  };

  const searchRepos = useCallback(async (query: string) => {
    setSearchingRepos(true);
    try {
      const result = await window.cozyPane.git.listRepos(query);
      setRepoResults(result.repos || []);
    } catch (err) {
      console.error('[GitPanel] listRepos error:', err);
    } finally {
      setSearchingRepos(false);
    }
  }, []);

  const handleSwitchToHttps = () => {
    const sshMatch = remoteInfo.remoteUrl.match(/^git@github\.com:(.+)$/);
    if (sshMatch) {
      const httpsUrl = `https://github.com/${sshMatch[1]}`;
      onTerminalCommand(`git remote set-url origin ${httpsUrl}`);
      scheduleRefresh();
      setTimeout(fetchRemoteInfo, 1500);
    }
  };

  const handleDiff = async (filePath: string) => {
    const result = await window.cozyPane.git.diffFile(cwd, filePath);
    if (result.error) return;
    onDiffClick(filePath, result.before ?? '', result.after ?? '');
  };

  const aiTouchedPaths = useMemo(() => {
    const s = new Set<string>();
    for (const e of activityEvents) { s.add(e.path); s.add(e.name); }
    return s;
  }, [activityEvents]);

  const aiTouchedFiles = useMemo(() =>
    files.filter(f => aiTouchedPaths.has(f.path) || aiTouchedPaths.has(f.path.split('/').pop() ?? '')),
  [files, aiTouchedPaths]);

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
      if (result.error) showError(result.error);
    } catch (err: any) {
      showError(err.message || 'Failed to generate message');
    } finally {
      setGeneratingMsg(false);
    }
  };

  const staged = files.filter(f => f.staged);
  const unstaged = files.filter(f => !f.staged);
  const displayCommits = commits.slice(0, 5);

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

  // Remote setup UI — shown inline when no remote or not authed
  const renderRemoteSetup = () => {
    if (!remoteInfo.githubAuthed) {
      return (
        <div className="git-remote-setup">
          <button className="btn git-github-btn" onClick={() => window.cozyPane.deploy.login()}>
            Sign in with GitHub
          </button>
        </div>
      );
    }

    if (!remoteInfo.hasRemote) {
      if (remoteMode === 'create') {
        return (
          <div className="git-remote-setup">
            <div className="git-remote-setup-inner">
              <div className="git-remote-create-header">
                <span className="git-remote-create-name">{cwd.split('/').pop()}</span>
                <button className="btn git-section-btn" onClick={() => setRemoteMode('none')}>Cancel</button>
              </div>
              <div className="git-remote-visibility">
                <label className="git-radio-label">
                  <input type="radio" name="visibility" checked={repoVisibility === 'private'} onChange={() => setRepoVisibility('private')} />
                  Private
                </label>
                <label className="git-radio-label">
                  <input type="radio" name="visibility" checked={repoVisibility === 'public'} onChange={() => setRepoVisibility('public')} />
                  Public
                </label>
              </div>
              <button className="btn git-commit-btn" onClick={handleCreateRepo} disabled={creatingRepo}>
                {creatingRepo ? 'Creating...' : 'Create Repository'}
              </button>
            </div>
          </div>
        );
      }

      if (remoteMode === 'connect') {
        return (
          <div className="git-remote-setup">
            <div className="git-remote-setup-inner">
              <div className="git-remote-connect-header">
                <input
                  className="git-commit-input"
                  placeholder="Search your repositories..."
                  value={repoSearch}
                  onChange={e => {
                    setRepoSearch(e.target.value);
                    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
                    searchTimerRef.current = setTimeout(() => searchRepos(e.target.value), 300);
                  }}
                  autoFocus
                />
                <button className="btn git-section-btn" onClick={() => { setRemoteMode('none'); setRepoSearch(''); setRepoResults([]); }}>Cancel</button>
              </div>
              <div className="git-repo-list">
                {searchingRepos ? (
                  <span className="git-remote-hint">Searching...</span>
                ) : repoResults.length === 0 ? (
                  <span className="git-remote-hint">No repositories found</span>
                ) : repoResults.map(repo => (
                  <div key={repo.fullName} className="git-repo-item" onClick={() => handleConnectRepo(repo)}>
                    <span className="git-repo-name">{repo.fullName}</span>
                    <span className="git-repo-vis">{repo.private ? 'private' : 'public'}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      }

      return (
        <div className="git-remote-setup">
          <div className="git-remote-setup-actions">
            <button className="btn git-action-btn" onClick={() => setRemoteMode('create')}>New Repository</button>
            <button className="btn git-action-btn" onClick={() => { setRemoteMode('connect'); searchRepos(''); }}>Connect Existing</button>
          </div>
        </div>
      );
    }

    if (remoteInfo.isSSH) {
      return (
        <div className="git-remote-setup">
          <span className="git-remote-url">{remoteInfo.remoteUrl}</span>
          <button className="btn git-action-btn" onClick={handleSwitchToHttps}>Switch to HTTPS</button>
        </div>
      );
    }

    return null;
  };

  const remoteSetup = renderRemoteSetup();
  const hasWorkingRemote = remoteInfo.hasRemote && !remoteInfo.isSSH;

  return (
    <div className="git-panel">
      <div className="git-header">
        <span className="git-title">Git</span>
        <span className="git-branch-name">{detached ? `(${branch})` : branch}</span>
      </div>

      <div className="git-body">
        {/* Error banner */}
        {error && (
          <div className="git-error" onClick={() => setError('')}>{error}</div>
        )}

        {/* Remote setup — prominent when not configured */}
        {remoteSetup && (
          <div className="git-section">{remoteSetup}</div>
        )}

        {/* Connected remote — compact display */}
        {hasWorkingRemote && (
          <div className="git-remote-connected">
            <span className="git-remote-url">{remoteInfo.remoteUrl}</span>
          </div>
        )}

        {/* Changes section — only when there are changes */}
        {unstaged.length > 0 && (
          <div className="git-section">
            <div className="git-section-header">
              <span>CHANGES ({unstaged.length})</span>
              <button className="btn git-section-btn" onClick={handleStageAll}>Stage All</button>
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
        )}

        {/* Revert AI changes — near the changes it relates to */}
        {aiTouchedFiles.length > 0 && (
          <div className="git-revert-section">
            {!revertConfirm ? (
              <button className="btn git-revert-btn" onClick={() => setRevertConfirm(true)}>
                Revert AI Changes ({aiTouchedFiles.length} files)
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

        {/* Staged section — only when there are staged files */}
        {staged.length > 0 && (
          <div className="git-section">
            <div className="git-section-header">
              <span>STAGED ({staged.length})</span>
              <button className="btn git-section-btn" onClick={handleUnstageAll}>Unstage All</button>
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
        )}

        {/* Commit + Push area */}
        <div className="git-commit-area">
          <div className="git-commit-input-row">
            <button
              className="btn git-generate-btn"
              onClick={handleGenerateMsg}
              disabled={generatingMsg || staged.length === 0}
              title="Generate commit message with AI"
            >
              {generatingMsg ? '...' : 'Generate'}
            </button>
            <input
              className="git-commit-input"
              placeholder="Commit message..."
              value={commitMsg}
              onChange={e => setCommitMsg(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleCommit(); } }}
            />
          </div>
          <div className="git-commit-actions">
            <button
              className="btn git-commit-btn"
              disabled={staged.length === 0 || !commitMsg.trim()}
              onClick={handleCommit}
            >
              Commit
            </button>
            {hasWorkingRemote && (
              <>
                <button className="btn git-push-btn" onClick={handlePush}>Push</button>
                <button className="btn git-pull-btn" onClick={handlePull}>Pull</button>
              </>
            )}
          </div>
        </div>

        {/* Recent commits — compact */}
        {displayCommits.length > 0 && (
          <div className="git-section">
            <div className="git-section-header">
              <span>RECENT</span>
            </div>
            <div className="git-commits-list">
              {displayCommits.map(c => (
                <div key={c.hash} className="git-commit-item">
                  <span className="git-commit-hash">{c.hash}</span>
                  <span className="git-commit-msg">{c.message}</span>
                  <span className="git-commit-time">{c.timeAgo}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
