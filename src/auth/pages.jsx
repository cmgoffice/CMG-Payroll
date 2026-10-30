import { useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { STATUS_LABELS, displayNameOf } from './constants';
import { Navigate, Spinner, navigate, takeLoginDestination } from './router';

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
    <path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z" />
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
  </svg>
);

// Shared redirect rules, driven by the profile (see LoginPage behaviour):
// rejected -> error message, pending -> /pending, approved -> destination.
function useRedirectByProfile(setError) {
  const { loading, firebaseUser, userProfile, logout } = useAuth();
  useEffect(() => {
    if (loading || !firebaseUser || !userProfile) return;
    if (userProfile.status === 'rejected') {
      setError('บัญชีนี้ถูกปฏิเสธการเข้าใช้งาน กรุณาติดต่อผู้ดูแลระบบ');
      logout().catch(() => {});
    } else if (userProfile.status === 'pending') {
      navigate('/pending', { replace: true });
    } else if (userProfile.status === 'approved') {
      navigate(takeLoginDestination(), { replace: true });
    }
  }, [loading, firebaseUser, userProfile, logout, setError]);
}

function AuthCard({ title, subtitle, children, footer }) {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand"><div className="brand-mark">CMG</div><div><div className="brand-name">CMG Payroll</div><div className="brand-subtitle">จัดการค่าแรง</div></div></div>
        <h1>{title}</h1>
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}
        {children}
        {footer && <div className="auth-footer">{footer}</div>}
      </section>
    </main>
  );
}

// While `loading` is true the login form must never render: the stored token is
// still being checked and a signed-in user would otherwise see it flash before
// being redirected to the dashboard.
export function LoginPage() {
  const { loading, firebaseUser, loginWithEmail, loginWithGoogle, refreshProfile } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useRedirectByProfile(setError);

  if (loading) return <Spinner />;
  // Token found: show the spinner while the redirect effect above runs.
  if (firebaseUser && !error) return <Spinner label="กำลังเข้าสู่ระบบ..." />;

  const run = async (action) => {
    setBusy(true);
    setError('');
    try {
      await action();
      // onAuthStateChanged can fire before the profile exists for new users.
      await refreshProfile();
    } catch (loginError) {
      setError(loginError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="เข้าสู่ระบบ"
      subtitle="ใช้บัญชีที่ได้รับอนุมัติเพื่อเข้าใช้งานระบบ"
      footer={<>ยังไม่มีบัญชี? <a href="/register" onClick={(event) => { event.preventDefault(); navigate('/register'); }}>สมัครใช้งาน</a></>}
    >
      <form className="auth-form" onSubmit={(event) => { event.preventDefault(); run(() => loginWithEmail(email, password)); }}>
        <label><span>อีเมล</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" /></label>
        <label><span>รหัสผ่าน</span><input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="รหัสผ่าน" /></label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="primary-button" type="submit" disabled={busy}>{busy ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}</button>
      </form>
      <div className="auth-divider"><span>หรือ</span></div>
      <button type="button" className="google-button" disabled={busy} onClick={() => run(loginWithGoogle)}><GoogleIcon />เข้าสู่ระบบด้วย Google</button>
    </AuthCard>
  );
}

export function RegisterPage() {
  const { loading, firebaseUser, registerWithEmail, refreshProfile } = useAuth();
  const [form, setForm] = useState({ firstName: '', lastName: '', position: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useRedirectByProfile(setError);

  if (loading) return <Spinner />;
  if (firebaseUser && !error) return <Spinner label="กำลังเข้าสู่ระบบ..." />;

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    if (form.password !== form.confirm) {
      setError('รหัสผ่านและการยืนยันรหัสผ่านไม่ตรงกัน');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await registerWithEmail(form.email, form.password, form.firstName, form.lastName, form.position);
      await refreshProfile();
    } catch (registerError) {
      setError(registerError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="สมัครใช้งาน"
      subtitle="ผู้สมัครคนแรกของระบบจะเป็น MasterAdmin ผู้สมัครคนถัดไปต้องรอผู้ดูแลอนุมัติ"
      footer={<>มีบัญชีแล้ว? <a href="/login" onClick={(event) => { event.preventDefault(); navigate('/login'); }}>เข้าสู่ระบบ</a></>}
    >
      <form className="auth-form" onSubmit={submit}>
        <div className="auth-row">
          <label><span>ชื่อ</span><input required value={form.firstName} onChange={set('firstName')} /></label>
          <label><span>นามสกุล</span><input required value={form.lastName} onChange={set('lastName')} /></label>
        </div>
        <label><span>ตำแหน่ง</span><input value={form.position} onChange={set('position')} /></label>
        <label><span>อีเมล</span><input type="email" autoComplete="email" required value={form.email} onChange={set('email')} /></label>
        <div className="auth-row">
          <label><span>รหัสผ่าน</span><input type="password" autoComplete="new-password" minLength={6} required value={form.password} onChange={set('password')} /></label>
          <label><span>ยืนยันรหัสผ่าน</span><input type="password" autoComplete="new-password" minLength={6} required value={form.confirm} onChange={set('confirm')} /></label>
        </div>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="primary-button" type="submit" disabled={busy}>{busy ? 'กำลังสมัคร...' : 'สมัครใช้งาน'}</button>
      </form>
    </AuthCard>
  );
}

export function PendingApprovalPage() {
  const { userProfile, logout } = useAuth();
  // Approval arrives in realtime through the profile subscription.
  if (userProfile?.status === 'approved') return <Navigate to="/dashboard" />;
  return (
    <AuthCard title="รออนุมัติการเข้าใช้งาน" subtitle={`สวัสดี ${displayNameOf(userProfile)} — บัญชีของคุณอยู่ในสถานะ “${STATUS_LABELS[userProfile?.status] || ''}”`}>
      <p className="auth-note">ผู้ดูแลระบบ (MasterAdmin) จะตรวจสอบและกำหนดสิทธิ์ให้คุณ หน้านี้จะเปลี่ยนเป็นหน้าหลักอัตโนมัติเมื่อได้รับอนุมัติ ไม่ต้องรีเฟรช</p>
      <button type="button" className="secondary-button" onClick={() => logout().then(() => navigate('/login', { replace: true }))}>ออกจากระบบ</button>
    </AuthCard>
  );
}
