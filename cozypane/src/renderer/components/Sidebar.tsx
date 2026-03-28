import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ChevronRight, ChevronDown, FilePlus, FolderPlus, Pencil, Trash2, FileCode, FileJson, FileText, Braces } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onToggle: () => void;
  onFileSelect: (path: string, name: string) => void;
  onDiffClick?: (path: string) => void;
  activeFile: string | null;
  onCwdChange: (cwd: string) => void;
  cwd: string;
  changedFiles?: Map<string, 'create' | 'modify' | 'delete'>;
  lastWatcherEvent?: FileChangeEvent | null;
  fontSize?: number;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
}

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  children: TreeNode[] | null;
  expanded: boolean;
  depth: number;
}

function updateNode(nodes: TreeNode[], path: string, updater: (node: TreeNode) => TreeNode): TreeNode[] {
  return nodes.map(node => {
    if (node.path === path) {
      return updater({ ...node });
    }
    if (node.children) {
      return { ...node, children: updateNode(node.children, path, updater) };
    }
    return node;
  });
}

function sortEntries(a: { isDirectory: boolean; name: string }, b: { isDirectory: boolean; name: string }): number {
  if (a.isDirectory && !b.isDirectory) return -1;
  if (!a.isDirectory && b.isDirectory) return 1;
  return a.name.localeCompare(b.name);
}

function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.expanded && node.children) {
      result.push(...flattenTree(node.children));
    }
  }
  return result;
}

function getChangeColor(type: string | undefined): string | undefined {
  if (!type) return undefined;
  switch (type) {
    case 'create': return 'var(--success)';
    case 'modify': return 'var(--warning)';
    case 'delete': return 'var(--danger)';
    default: return undefined;
  }
}

interface ContextMenu {
  x: number;
  y: number;
  node: TreeNode | null; // null = clicked on empty area (root level)
}

interface InlineInput {
  parentPath: string; // directory where new item goes, or path being renamed
  mode: 'new-file' | 'new-folder' | 'rename';
  targetNode?: TreeNode; // for rename
  value: string;
}

export default function Sidebar({ isOpen, onToggle, onFileSelect, onDiffClick, activeFile, onCwdChange, cwd, changedFiles, lastWatcherEvent, fontSize, onZoomIn, onZoomOut, onZoomReset }: Props) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [inlineInput, setInlineInput] = useState<InlineInput | null>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);

  // Load root tree when cwd changes
  useEffect(() => {
    if (!cwd) return;
    window.cozyPane.fs.readdir(cwd).then(entries => {
      setTree(entries.map(entry => ({
        ...entry, depth: 0, expanded: false, children: null,
      })));
    }).catch(() => {});
  }, [cwd]);

  // Update tree in-place when watcher events arrive from App
  useEffect(() => {
    if (!lastWatcherEvent || !cwd) return;
    const event = lastWatcherEvent;

    const relativePath = event.path.startsWith(cwd) ? event.path.slice(cwd.length + 1) : null;
    if (!relativePath) return;

    const parentDir = event.path.slice(0, event.path.lastIndexOf('/'));
    const fileName = event.path.slice(event.path.lastIndexOf('/') + 1);

    if (event.type === 'delete') {
      if (parentDir === cwd) {
        setTree(prev => prev.filter(n => n.path !== event.path));
      } else {
        setTree(prev => updateNode(prev, parentDir, parent => ({
          ...parent,
          children: parent.children ? parent.children.filter(n => n.path !== event.path) : null,
        })));
      }
    } else if (event.type === 'create') {
      const newNode: TreeNode = {
        name: fileName,
        path: event.path,
        isDirectory: event.isDirectory,
        isFile: !event.isDirectory,
        children: null,
        expanded: false,
        depth: 0,
      };

      if (parentDir === cwd) {
        setTree(prev => {
          if (prev.some(n => n.path === event.path)) return prev;
          const next = [...prev, { ...newNode, depth: 0 }];
          return next.sort(sortEntries);
        });
      } else {
        setTree(prev => updateNode(prev, parentDir, parent => {
          if (!parent.expanded || !parent.children) return parent;
          if (parent.children.some(n => n.path === event.path)) return parent;
          const children = [...parent.children, { ...newNode, depth: parent.depth + 1 }];
          children.sort(sortEntries);
          return { ...parent, children };
        }));
      }
    }
    // 'modify' doesn't change tree structure — just the color indicator via changedFiles
  }, [lastWatcherEvent, cwd]);

  // Focus inline input after it mounts
  useEffect(() => {
    if (inlineInput) setTimeout(() => inlineInputRef.current?.focus(), 30);
  }, [inlineInput]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const startCreate = useCallback((mode: 'new-file' | 'new-folder', node: TreeNode | null) => {
    const parentPath = node ? (node.isDirectory ? node.path : node.path.slice(0, node.path.lastIndexOf('/'))) : cwd;
    setInlineInput({ parentPath, mode, value: '' });
    setContextMenu(null);
  }, [cwd]);

  const startRename = useCallback((node: TreeNode) => {
    setInlineInput({ parentPath: node.path.slice(0, node.path.lastIndexOf('/')), mode: 'rename', targetNode: node, value: node.name });
    setContextMenu(null);
  }, []);

  const handleDelete = useCallback(async (node: TreeNode) => {
    setContextMenu(null);
    if (!window.confirm(`Delete "${node.name}"?`)) return;
    const result = node.isDirectory
      ? await (window.cozyPane.fs as any).rmdir(node.path)
      : await (window.cozyPane.fs as any).unlink(node.path);
    if (result?.error) alert(result.error);
  }, []);

  const commitInlineInput = useCallback(async () => {
    if (!inlineInput) return;
    const name = inlineInput.value.trim();
    if (!name) { setInlineInput(null); return; }

    if (inlineInput.mode === 'rename' && inlineInput.targetNode) {
      const newPath = inlineInput.parentPath + '/' + name;
      const result = await (window.cozyPane.fs as any).rename(inlineInput.targetNode.path, newPath);
      if (result?.error) alert(result.error);
    } else if (inlineInput.mode === 'new-folder') {
      const newPath = inlineInput.parentPath + '/' + name;
      const result = await window.cozyPane.fs.mkdir(newPath);
      if (result?.error) alert(result.error);
    } else if (inlineInput.mode === 'new-file') {
      const newPath = inlineInput.parentPath + '/' + name;
      const result = await window.cozyPane.fs.writefile(newPath, '');
      if (result?.error) alert(result.error);
      else onFileSelect(newPath, name);
    }
    setInlineInput(null);
  }, [inlineInput, onFileSelect]);

  async function handleClick(node: TreeNode) {
    try {
      if (node.isDirectory) {
        if (node.expanded) {
          setTree(prev => updateNode(prev, node.path, n => ({
            ...n, expanded: false, children: null,
          })));
        } else {
          const entries = await window.cozyPane.fs.readdir(node.path);
          const children: TreeNode[] = entries.map(entry => ({
            ...entry, depth: node.depth + 1, expanded: false, children: null,
          }));
          setTree(prev => updateNode(prev, node.path, n => ({
            ...n, expanded: true, children,
          })));
        }
      } else {
        // If the file has been changed and we have a diff handler, show the diff
        const changeType = changedFiles?.get(node.path);
        if (changeType === 'modify' && onDiffClick) {
          onDiffClick(node.path);
        } else {
          onFileSelect(node.path, node.name);
        }
      }
    } catch {}
  }

  function getFileIcon(node: TreeNode): React.ReactNode {
    if (node.isDirectory) {
      return node.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />;
    }
    const ext = node.name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'ts': case 'tsx': case 'js': case 'jsx': return <FileCode size={13} />;
      case 'json': return <FileJson size={13} />;
      case 'css': case 'scss': case 'less': return <Braces size={13} />;
      default: return <FileText size={13} />;
    }
  }

  // Build a map of directory paths → number of changed files inside them
  const changedDirs = useMemo(() => {
    const counts = new Map<string, number>();
    if (!changedFiles || !cwd) return counts;
    for (const filePath of changedFiles.keys()) {
      // Walk up from the file's parent dir to cwd, incrementing each ancestor
      let dir = filePath.slice(0, filePath.lastIndexOf('/'));
      while (dir.length >= cwd.length) {
        counts.set(dir, (counts.get(dir) || 0) + 1);
        const parent = dir.slice(0, dir.lastIndexOf('/'));
        if (parent === dir) break;
        dir = parent;
      }
    }
    return counts;
  }, [changedFiles, cwd]);

  const folderName = cwd ? cwd.split('/').filter(Boolean).pop() || '/' : 'Files';
  const flatNodes = useMemo(() => flattenTree(tree), [tree]);

  return (
    <div className={`sidebar ${isOpen ? '' : 'collapsed'}`} onContextMenu={e => handleContextMenu(e, null)}>
      <div className="sidebar-header">
        <span className="sidebar-title" title={cwd}>{folderName}</span>
        <div className="sidebar-header-actions">
          <button className="sidebar-icon-btn" onClick={() => startCreate('new-file', null)} title="New File"><FilePlus size={14} /></button>
          <button className="sidebar-icon-btn" onClick={() => startCreate('new-folder', null)} title="New Folder"><FolderPlus size={14} /></button>
          {onZoomIn && onZoomOut && (
            <div className="zoom-controls zoom-controls-compact">
              <button className="zoom-btn" onClick={onZoomOut} title="Zoom out">−</button>
              <button className="zoom-label" onClick={onZoomReset} title="Reset zoom">{fontSize ?? 13}</button>
              <button className="zoom-btn" onClick={onZoomIn} title="Zoom in">+</button>
            </div>
          )}
          <button className="sidebar-toggle" onClick={onToggle} aria-label="Toggle sidebar">
            &lt;
          </button>
        </div>
      </div>
      <div className="file-tree">
        {flatNodes.map(node => {
          const changeType = changedFiles?.get(node.path);
          const changeColor = getChangeColor(changeType);
          const dirChangeCount = node.isDirectory ? changedDirs.get(node.path) : undefined;
          const isRenaming = inlineInput?.mode === 'rename' && inlineInput.targetNode?.path === node.path;
          return (
            <div
              key={node.path}
              className={`file-entry ${node.isDirectory ? 'directory' : ''} ${activeFile === node.path ? 'active' : ''} ${dirChangeCount ? 'has-changes' : ''} ${node.name.startsWith('.') ? 'dotfile' : ''}`}
              style={{ paddingLeft: 16 + node.depth * 16 }}
              onClick={() => !isRenaming && handleClick(node)}
              onContextMenu={e => { e.stopPropagation(); handleContextMenu(e, node); }}
              draggable={node.isFile && !isRenaming}
              onDragStart={e => {
                if (node.isFile) {
                  e.dataTransfer.setData('text/plain', node.path);
                  e.dataTransfer.effectAllowed = 'copy';
                }
              }}
            >
              <span className="file-icon">{getFileIcon(node)}</span>
              {isRenaming ? (
                <input
                  ref={inlineInputRef}
                  className="sidebar-inline-input"
                  value={inlineInput!.value}
                  onChange={e => setInlineInput(prev => prev ? { ...prev, value: e.target.value } : null)}
                  onKeyDown={e => { if (e.key === 'Enter') commitInlineInput(); else if (e.key === 'Escape') setInlineInput(null); }}
                  onBlur={commitInlineInput}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span className="file-name" style={changeColor ? { color: changeColor } : undefined}>
                  {node.name}
                </span>
              )}
              {!isRenaming && changeType && (
                <span className="file-change-dot" style={{ color: changeColor }}>
                  {changeType === 'create' ? '+' : changeType === 'modify' ? '●' : '−'}
                </span>
              )}
              {!isRenaming && dirChangeCount && !changeType && (
                <span className="dir-change-badge">{dirChangeCount}</span>
              )}
            </div>
          );
        })}

        {/* Inline create input — shown at bottom of the relevant directory */}
        {inlineInput && inlineInput.mode !== 'rename' && (
          <div className="file-entry" style={{ paddingLeft: 16 }}>
            <span className="file-icon">{inlineInput.mode === 'new-folder' ? <FolderPlus size={13} /> : <FilePlus size={13} />}</span>
            <input
              ref={inlineInputRef}
              className="sidebar-inline-input"
              placeholder={inlineInput.mode === 'new-folder' ? 'folder name' : 'file name'}
              value={inlineInput.value}
              onChange={e => setInlineInput(prev => prev ? { ...prev, value: e.target.value } : null)}
              onKeyDown={e => { if (e.key === 'Enter') commitInlineInput(); else if (e.key === 'Escape') setInlineInput(null); }}
              onBlur={commitInlineInput}
            />
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="sidebar-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          <button onClick={() => startCreate('new-file', contextMenu.node)}><FilePlus size={13} /> New File</button>
          <button onClick={() => startCreate('new-folder', contextMenu.node)}><FolderPlus size={13} /> New Folder</button>
          {contextMenu.node && (
            <>
              <div className="context-menu-divider" />
              <button onClick={() => startRename(contextMenu.node!)}><Pencil size={13} /> Rename</button>
              <button className="danger" onClick={() => handleDelete(contextMenu.node!)}><Trash2 size={13} /> Delete</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
