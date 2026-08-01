import React, { createContext, useCallback, useContext, useState, useRef } from 'react';

type ToastType = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

const ToastContext = createContext<{ toast: (type: ToastType, message: string) => void }>({ toast: () => {} });

export const useToast = () => useContext(ToastContext);

const ICONS: Record<ToastType, string> = { success: '✓', error: '✕', info: 'ℹ' };
const COLORS: Record<ToastType, { bg: string; border: string; fg: string }> = {
  success: { bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.4)', fg: '#34d399' },
  error: { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.4)', fg: '#f87171' },
  info: { bg: 'rgba(99,102,241,0.12)', border: 'rgba(99,102,241,0.4)', fg: '#818cf8' },
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const toast = useCallback((type: ToastType, message: string) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 200, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {toasts.map((t) => {
          const c = COLORS[t.type];
          return (
            <div
              key={t.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                minWidth: 260,
                maxWidth: 360,
                padding: '10px 14px',
                background: c.bg,
                border: `1px solid ${c.border}`,
                borderLeft: `3px solid ${c.fg}`,
                borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--shadow-lg)',
                color: 'var(--text-primary)',
                fontSize: 13,
                animation: 'toastIn 0.18s ease-out',
              }}
            >
              <span style={{ color: c.fg, fontWeight: 800 }}>{ICONS[t.type]}</span>
              <span style={{ flex: 1 }}>{t.message}</span>
            </div>
          );
        })}
      </div>
      <style>{`@keyframes toastIn{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:translateX(0)}}`}</style>
    </ToastContext.Provider>
  );
};
