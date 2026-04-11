import React, { useState, useCallback } from 'react';
import { isCozyModeEnabled } from '../lib/cozyMode';

interface Props {
  onOpenProject: (cwd: string, cozyMode: boolean) => void;
  onCreateProject: (cwd: string, projectName: string, cozyMode: boolean) => void;
  onNewTerminal: () => void;
}

type Step = 'choose' | 'style-create' | 'create-name';

export default function TabLauncher({ onOpenProject, onCreateProject, onNewTerminal }: Props) {
  const [step, setStep] = useState<Step>('choose');
  const [projectName, setProjectName] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [error, setError] = useState('');

  const handleOpenProject = useCallback(async () => {
    try {
      const result = await window.cozyPane.fs.pickDirectory();
      if (result.paths && result.paths.length > 0) {
        const dir = result.paths[0];
        // Auto-detect cozy mode from existing CLAUDE.md marker — no need to ask
        const cozy = await isCozyModeEnabled(dir);
        onOpenProject(dir, cozy);
      }
    } catch {}
  }, [onOpenProject]);

  const handleCreateStep = useCallback(async () => {
    // Use saved default dir, fall back to home
    const settings = await window.cozyPane.settings.get();
    const dir = settings.defaultProjectDir || await window.cozyPane.fs.homedir();
    setParentDir(dir);
    setStep('create-name');
  }, []);

  const handleCreateConfirm = useCallback(() => {
    if (!projectName.trim()) {
      setError('Enter a project name');
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(projectName.trim())) {
      setError('Use only letters, numbers, hyphens, dots, underscores');
      return;
    }
    setError('');
    setStep('style-create');
  }, [projectName]);

  const handleCreateWithStyle = useCallback((cozyMode: boolean) => {
    const fullPath = `${parentDir}/${projectName.trim()}`;
    onCreateProject(fullPath, projectName.trim(), cozyMode);
  }, [parentDir, projectName, onCreateProject]);

  if (step === 'create-name') {
    return (
      <div style={containerStyle}>
        <div style={cardContainerStyle}>
          <h2 style={titleStyle}>Create New Project</h2>
          <div style={{ marginBottom: '1.2em' }}>
            <label style={labelStyle}>Project name</label>
            <input
              type="text"
              value={projectName}
              onChange={(e) => { setProjectName(e.target.value); setError(''); }}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateConfirm()}
              placeholder="my-cool-app"
              autoFocus
              style={inputStyle}
            />
            {error && <div style={errorStyle}>{error}</div>}
          </div>
          <div style={{ marginBottom: '1.2em' }}>
            <label style={labelStyle}>Location</label>
            <div style={{ display: 'flex', gap: '0.5em', alignItems: 'center' }}>
              <span style={{ fontSize: '0.82em', color: 'var(--text-secondary, #888)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {parentDir}/
              </span>
              <button onClick={async () => {
                const result = await window.cozyPane.fs.pickDirectory();
                if (result.paths?.[0]) setParentDir(result.paths[0]);
              }} style={smallActionBtnStyle}>
                Change
              </button>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4em', marginTop: '0.5em', fontSize: '0.78em', color: 'var(--text-secondary, #888)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                onChange={async (e) => {
                  if (e.target.checked) {
                    await window.cozyPane.settings.setDefaultDir(parentDir);
                  }
                }}
                style={{ margin: 0 }}
              />
              Make default
            </label>
          </div>
          <div style={{ display: 'flex', gap: '0.5em' }}>
            <button onClick={() => setStep('choose')} style={smallActionBtnStyle}>Back</button>
            <button onClick={handleCreateConfirm} style={accentBtnStyle}>Next</button>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'style-create') {
    return (
      <div style={containerStyle}>
        <div style={cardContainerStyle}>
          <h2 style={titleStyle}>How should Claude work?</h2>
          <p style={subtitleStyle}>
            Creating <strong>{projectName}</strong>
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75em', marginTop: '1em' }}>
            <button onClick={() => handleCreateWithStyle(true)} style={styleCardStyle}>
              <div style={styleCardTitleStyle}>Cozy Style</div>
              <div style={styleCardDescStyle}>
                Claude builds deployment-ready from the start. Project structure, Dockerfiles,
                database setup, and environment configs are all handled for CozyPane Cloud.
              </div>
            </button>
            <button onClick={() => handleCreateWithStyle(false)} style={{ ...styleCardStyle, borderColor: 'var(--border, #2a2b3e)' }}>
              <div style={styleCardTitleStyle}>Free Form</div>
              <div style={styleCardDescStyle}>
                Claude works with no deployment opinions. Build whatever you want, deploy wherever you want.
              </div>
            </button>
          </div>
          <button onClick={() => setStep('create-name')} style={{ ...smallActionBtnStyle, marginTop: '1em' }}>Back</button>
        </div>
      </div>
    );
  }

  // Main choose step
  return (
    <div style={containerStyle}>
      <div style={cardContainerStyle}>
        <h2 style={titleStyle}>What would you like to do?</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75em', marginTop: '1em' }}>
          <button onClick={handleOpenProject} style={mainBtnStyle}>
            <div style={btnIconStyle}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <div>
              <div style={btnTitleStyle}>Open Project</div>
              <div style={btnDescStyle}>Browse to an existing project folder</div>
            </div>
          </button>

          <button onClick={handleCreateStep} style={mainBtnStyle}>
            <div style={btnIconStyle}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </div>
            <div>
              <div style={btnTitleStyle}>Create New Project</div>
              <div style={btnDescStyle}>Start a fresh project with Claude</div>
            </div>
          </button>

          <button onClick={onNewTerminal} style={{ ...mainBtnStyle, borderColor: 'var(--border, #2a2b3e)' }}>
            <div style={btnIconStyle}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
              </svg>
            </div>
            <div>
              <div style={btnTitleStyle}>New Terminal</div>
              <div style={btnDescStyle}>Open a plain terminal</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  backgroundColor: 'var(--bg-primary, #1a1b2e)',
  padding: '2em',
};

const cardContainerStyle: React.CSSProperties = {
  maxWidth: 420,
  width: '100%',
};

const titleStyle: React.CSSProperties = {
  fontSize: '1.3em',
  fontWeight: 700,
  color: 'var(--text-primary, #e0e0e0)',
  marginBottom: '0.2em',
};

const subtitleStyle: React.CSSProperties = {
  fontSize: '0.88em',
  color: 'var(--text-secondary, #888)',
  marginBottom: '0.5em',
};

const mainBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '1em',
  padding: '1em 1.2em',
  borderRadius: 10,
  border: '1px solid var(--accent, #7c6fe0)33',
  backgroundColor: 'var(--bg-secondary, #1e1f32)',
  color: 'var(--text-primary, #e0e0e0)',
  cursor: 'pointer',
  textAlign: 'left' as const,
  transition: 'border-color 0.15s, background-color 0.15s',
  width: '100%',
};

const btnIconStyle: React.CSSProperties = {
  color: 'var(--accent, #7c6fe0)',
  flexShrink: 0,
};

const btnTitleStyle: React.CSSProperties = {
  fontSize: '0.95em',
  fontWeight: 600,
};

const btnDescStyle: React.CSSProperties = {
  fontSize: '0.78em',
  color: 'var(--text-secondary, #888)',
  marginTop: '0.15em',
};

const styleCardStyle: React.CSSProperties = {
  padding: '1em 1.2em',
  borderRadius: 10,
  border: '1px solid var(--accent, #7c6fe0)55',
  backgroundColor: 'var(--bg-secondary, #1e1f32)',
  color: 'var(--text-primary, #e0e0e0)',
  cursor: 'pointer',
  textAlign: 'left' as const,
  width: '100%',
  transition: 'border-color 0.15s',
};

const styleCardTitleStyle: React.CSSProperties = {
  fontSize: '0.95em',
  fontWeight: 600,
  marginBottom: '0.3em',
};

const styleCardDescStyle: React.CSSProperties = {
  fontSize: '0.78em',
  color: 'var(--text-secondary, #888)',
  lineHeight: 1.4,
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.82em',
  color: 'var(--text-secondary, #888)',
  marginBottom: '0.3em',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.5em 0.7em',
  borderRadius: 6,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'var(--bg-primary, #1a1b2e)',
  color: 'var(--text-primary, #e0e0e0)',
  fontSize: '0.95em',
  outline: 'none',
  boxSizing: 'border-box',
};

const errorStyle: React.CSSProperties = {
  color: '#e74c3c',
  fontSize: '0.78em',
  marginTop: '0.3em',
};

const accentBtnStyle: React.CSSProperties = {
  padding: '0.5em 1.2em',
  borderRadius: 6,
  border: 'none',
  backgroundColor: 'var(--accent, #7c6fe0)',
  color: '#fff',
  fontSize: '0.88em',
  fontWeight: 600,
  cursor: 'pointer',
  flex: 1,
};

const smallActionBtnStyle: React.CSSProperties = {
  padding: '0.4em 0.8em',
  borderRadius: 5,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'transparent',
  color: 'var(--text-secondary, #aaa)',
  fontSize: '0.82em',
  cursor: 'pointer',
};
