import React, { useState, useEffect, useMemo } from 'react';

interface Props {
  isOpen: boolean;
  onToggle: () => void;
  onFileSelect: (path: string, name: string) => void;
  activeFile: string | null;
  onCwdChange: (cwd: string) => void;
  cwd: string;
  changedFiles?: Map<string, 'create' | 'modify' | 'delete'>;
  lastWatcherEvent?: FileChangeEvent | null;
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

export default function Sidebar({ isOpen, onToggle, onFileSelect, activeFile, onCwdChange, cwd, changedFiles, lastWatcherEvent }: Props) {
  const [tree, setTree] = useState<TreeNode[]>([]);

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
        onFileSelect(node.path, node.name);
      }
    } catch {}
  }

  function getFileIcon(node: TreeNode): string {
    if (node.isDirectory) {
      return node.expanded ? 'v' : '>';
    }
    const ext = node.name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'ts': case 'tsx': return 'T';
      case 'js': case 'jsx': return 'J';
      case 'css': case 'scss': return '#';
      case 'html': return '<>';
      case 'json': return '{}';
      case 'md': return 'M';
      case 'py': return 'P';
      case 'rs': return 'R';
      case 'go': return 'G';
      default: return '-';
    }
  }

  const folderName = cwd ? cwd.split('/').filter(Boolean).pop() || '/' : 'Files';
  const flatNodes = useMemo(() => flattenTree(tree), [tree]);

  return (
    <div className={`sidebar ${isOpen ? '' : 'collapsed'}`}>
      <div className="sidebar-header">
        <span className="sidebar-title" title={cwd}>{folderName}</span>
        <button className="sidebar-toggle" onClick={onToggle} aria-label="Toggle sidebar">
          &lt;
        </button>
      </div>
      <div className="file-tree">
        {flatNodes.map(node => {
          const changeType = changedFiles?.get(node.path);
          const changeColor = getChangeColor(changeType);
          return (
            <div
              key={node.path}
              className={`file-entry ${node.isDirectory ? 'directory' : ''} ${activeFile === node.path ? 'active' : ''}`}
              style={{ paddingLeft: 16 + node.depth * 16 }}
              onClick={() => handleClick(node)}
              draggable={node.isFile}
              onDragStart={e => {
                if (node.isFile) {
                  e.dataTransfer.setData('text/plain', node.path);
                  e.dataTransfer.effectAllowed = 'copy';
                }
              }}
            >
              <span className="file-icon">{getFileIcon(node)}</span>
              <span className="file-name" style={changeColor ? { color: changeColor } : undefined}>
                {node.name}
              </span>
              {changeType && (
                <span className="file-change-dot" style={{ color: changeColor }}>
                  {changeType === 'create' ? '+' : changeType === 'modify' ? '●' : '−'}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
