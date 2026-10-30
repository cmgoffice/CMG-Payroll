import { useEffect, useState } from 'react';

// Tiny history-based router: the app already keeps its own menu paths with
// pushState, so only the auth routes (/login, /register, /pending) need this.
const NAVIGATE_EVENT = 'cmg:navigate';
const FROM_KEY = 'cmg-payroll-login-from';

export const navigate = (to, { replace = false } = {}) => {
  if (window.location.pathname !== to) {
    window.history[replace ? 'replaceState' : 'pushState']({}, '', to);
  }
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
};

export const usePathname = () => {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', update);
    window.addEventListener(NAVIGATE_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAVIGATE_EVENT, update);
    };
  }, []);
  return pathname;
};

export function Navigate({ to, replace = true, rememberFrom = false }) {
  useEffect(() => {
    if (rememberFrom) {
      try {
        window.sessionStorage.setItem(FROM_KEY, window.location.pathname + window.location.search);
      } catch {
        // ignore
      }
    }
    navigate(to, { replace });
  }, [to, replace, rememberFrom]);
  return null;
}

// Original destination saved by ProtectedRoute, consumed once after login.
export const takeLoginDestination = () => {
  try {
    const from = window.sessionStorage.getItem(FROM_KEY);
    window.sessionStorage.removeItem(FROM_KEY);
    return from && !/^\/(login|register|pending)/.test(from) && from !== '/' ? from : '/dashboard';
  } catch {
    return '/dashboard';
  }
};

export function Spinner({ label = 'กำลังตรวจสอบสิทธิ์...' }) {
  return (
    <div className="auth-loading" role="status" aria-live="polite">
      <div className="auth-spinner" />
      <span>{label}</span>
    </div>
  );
}
