'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { User, LogOut, Shield, Settings, ChevronDown, Puzzle } from 'lucide-react';
import { useAuth, type UserRole } from './AuthProvider';

const ROLE_COLORS: Record<UserRole, string> = {
  viewer: '#00E676',
  analyst: '#4FC3F7',
  admin: '#FF3D3D',
};

const ROLE_BADGES: Record<UserRole, string> = {
  viewer: 'V',
  analyst: 'A',
  admin: 'ADMIN',
};

export default function UserMenu({ onOpenLogin, onOpenAdmin, onOpenPlugins }: { onOpenLogin: () => void; onOpenAdmin?: () => void; onOpenPlugins?: () => void }) {
  const { user, logout, hasRole } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Click outside to close
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  if (!user) {
    return (
      <button
        onClick={onOpenLogin}
        className="pointer-events-auto glass-panel px-2 py-1 flex items-center gap-1.5 text-[8px] font-mono tracking-widest hover:border-[var(--gold-primary)]/40 transition-all border-white/5"
      >
        <User className="w-2.5 h-2.5 text-[var(--gold-primary)]" />
        <span className="text-[var(--gold-primary)] font-bold">LOGIN</span>
      </button>
    );
  }

  return (
    <div ref={menuRef} className="relative pointer-events-auto">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="glass-panel px-2 py-1 flex items-center gap-1.5 text-[8px] font-mono tracking-widest hover:border-[var(--gold-primary)]/40 transition-all border-white/5"
      >
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: ROLE_COLORS[user.role] }}
        />
        <span className="text-white/80 font-bold truncate max-w-[60px]">{user.username}</span>
        <span
          className="px-1 rounded text-[7px] font-bold"
          style={{ backgroundColor: `${ROLE_COLORS[user.role]}20`, color: ROLE_COLORS[user.role] }}
        >
          {ROLE_BADGES[user.role]}
        </span>
        <ChevronDown className={`w-2 h-2 text-white/40 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            /* Open DOWNWARD from the button so it stays on-screen at the top-right.
               Cap height + scroll so it can never overflow the viewport. */
            className="absolute top-full mt-2 right-0 w-[260px] max-h-[80vh] overflow-y-auto z-[500]"
          >
            <div className="glass-panel p-2.5 border-white/15 shadow-2xl shadow-black/60">
              {/* User info */}
              <div className="px-2.5 py-2.5 border-b border-white/10 mb-2">
                <div className="text-[13px] font-mono text-white font-bold">{user.username}</div>
                <div className="text-[10px] font-mono text-[var(--text-muted)] truncate">{user.email}</div>
                <div className="flex items-center gap-1 mt-1.5">
                  <span
                    className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: `${ROLE_COLORS[user.role]}20`, color: ROLE_COLORS[user.role] }}
                  >
                    {user.role.toUpperCase()}
                  </span>
                </div>
              </div>

              {/* Admin panel link */}
              {hasRole('admin') && (
                <button
                  onClick={() => {
                    setIsOpen(false);
                    onOpenAdmin?.();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-3 mb-1 text-[12px] font-mono font-bold tracking-wide text-white bg-[var(--alert-red)]/10 hover:bg-[var(--alert-red)]/20 border border-[var(--alert-red)]/30 hover:border-[var(--alert-red)]/50 rounded-lg transition-colors"
                  style={{ color: ROLE_COLORS.admin }}
                >
                  <Shield className="w-4 h-4 shrink-0" />
                  ADMIN PANEL
                </button>
              )}

              {/* Plugin console link */}
              {hasRole('admin') && (
                <button
                  onClick={() => {
                    setIsOpen(false);
                    onOpenPlugins?.();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-3 mb-1 text-[12px] font-mono font-bold tracking-wide text-white/80 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-lg transition-colors"
                >
                  <Puzzle className="w-4 h-4 shrink-0" />
                  PLUGIN CONSOLE
                </button>
              )}

              {/* Logout */}
              <button
                onClick={() => {
                  setIsOpen(false);
                  logout();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-3 text-[12px] font-mono font-bold tracking-wide text-[var(--alert-red)]/80 hover:text-[var(--alert-red)] bg-white/5 hover:bg-white/10 border border-white/10 hover:border-[var(--alert-red)]/30 rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4 shrink-0" />
                LOGOUT
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
