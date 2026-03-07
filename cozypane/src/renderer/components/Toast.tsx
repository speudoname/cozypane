import React, { useState, useEffect, useCallback } from 'react';

interface ToastItem {
  id: number;
  files: { name: string; type: 'create' | 'modify' | 'delete' }[];
  timestamp: number;
}

interface Props {
  events: FileChangeEvent[];
}

let nextId = 0;

export default function ToastContainer({ events }: Props) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const batchRef = React.useRef<{ files: { name: string; type: FileChangeEvent['type'] }[]; timer: ReturnType<typeof setTimeout> | null }>({ files: [], timer: null });
  const prevLengthRef = React.useRef(0);

  // Batch rapid file changes into a single toast
  useEffect(() => {
    if (events.length <= prevLengthRef.current) {
      prevLengthRef.current = events.length;
      return;
    }

    const newCount = events.length - prevLengthRef.current;
    prevLengthRef.current = events.length;

    for (let i = 0; i < newCount; i++) {
      const event = events[i];
      batchRef.current.files.push({ name: event.name, type: event.type });
    }

    if (batchRef.current.timer) clearTimeout(batchRef.current.timer);
    batchRef.current.timer = setTimeout(() => {
      const files = batchRef.current.files.slice(0, 5);
      const total = batchRef.current.files.length;
      batchRef.current.files = [];

      if (total > 5) {
        files.push({ name: `+${total - 5} more`, type: 'modify' });
      }

      const id = nextId++;
      setToasts(prev => [...prev, { id, files, timestamp: Date.now() }]);
    }, 500);
  }, [events.length]);

  // Auto-dismiss after 3s
  useEffect(() => {
    if (toasts.length === 0) return;
    const oldest = toasts[0];
    const age = Date.now() - oldest.timestamp;
    const delay = Math.max(0, 3000 - age);
    const timer = setTimeout(() => {
      setToasts(prev => prev.slice(1));
    }, delay);
    return () => clearTimeout(timer);
  }, [toasts]);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map(toast => (
        <div key={toast.id} className="toast" onClick={() => dismiss(toast.id)}>
          {toast.files.map((f, i) => (
            <div key={i} className="toast-file">
              <span className="toast-icon" style={{ color: f.type === 'create' ? 'var(--success)' : f.type === 'delete' ? 'var(--danger)' : 'var(--warning)' }}>
                {f.type === 'create' ? '+' : f.type === 'delete' ? '-' : 'M'}
              </span>
              <span className="toast-name">{f.name}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
