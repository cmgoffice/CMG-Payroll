import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { auth, isFirebaseConfigured } from '../lib/firebase';
import {
  clearSessionExpiry,
  createUserProfile,
  fetchProfile,
  isProfileCreationInFlight,
  isSessionExpired,
  loginWithEmail,
  loginWithGoogle,
  logout,
  registerWithEmail,
  setSessionExpiry,
  subscribeToProfile,
  updateOwnProfile,
  watchAuthState,
} from './authService';
import { canAccessModule, isMasterAdmin, normalizeEmail, toRoleList } from './constants';

const AuthContext = createContext(null);

// Without a Firebase config the app runs in demo mode (local sample data), so
// there is nothing to sign in to: act as a local MasterAdmin.
const DEMO_USER = { uid: 'demo', email: 'demo@local', displayName: 'Demo', photoURL: '' };
const DEMO_PROFILE = {
  uid: 'demo',
  email: 'demo@local',
  firstName: 'โหมด',
  lastName: 'ตัวอย่าง',
  position: 'Demo',
  role: ['MasterAdmin'],
  status: 'approved',
  assignedProjects: [],
  photoURL: '',
  isFirstUser: true,
};

export function AuthProvider({ children }) {
  const [firebaseUser, setFirebaseUser] = useState(isFirebaseConfigured ? null : DEMO_USER);
  const [userProfile, setUserProfile] = useState(isFirebaseConfigured ? null : DEMO_PROFILE);
  // `loading` stays true until Firebase has checked the stored token AND the
  // first profile lookup has finished, so no page flashes the wrong screen.
  const [loading, setLoading] = useState(isFirebaseConfigured);
  // Set when the profile can neither be read nor created (usually Firestore Rules).
  const [profileError, setProfileError] = useState('');
  const email = firebaseUser?.email || '';
  const autoCreateTried = useRef('');

  useEffect(() => {
    if (!isFirebaseConfigured) return undefined;
    let cancelled = false;
    const unsubscribe = watchAuthState(async (user) => {
      // The previous version of the app signed everyone in anonymously. That
      // leftover session has no email/profile, so drop it and show the login page.
      if (user && (user.isAnonymous || !user.email)) {
        await logout().catch(() => {});
        return;
      }
      if (user && isSessionExpired()) {
        clearSessionExpiry();
        await logout().catch(() => {});
        return;
      }
      if (user && !window.localStorage.getItem('cmg-payroll-session-expiry')) setSessionExpiry();
      if (cancelled) return;
      setFirebaseUser(user);
      if (!user) {
        setUserProfile(null);
        setLoading(false);
        return;
      }
      setUserProfile((previous) => (previous?.email === normalizeEmail(user.email) ? previous : null));
      const profile = await fetchProfile(user.email);
      if (cancelled) return;
      if (profile) setUserProfile(profile);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Realtime profile: approval, role and project changes made by a MasterAdmin
  // take effect immediately without a refresh.
  useEffect(() => {
    if (!isFirebaseConfigured || !email) return undefined;
    return subscribeToProfile(
      email,
      async (profile) => {
        if (profile) {
          setProfileError('');
          setUserProfile(profile);
          return;
        }
        // Signed in but no profile document (e.g. interrupted registration).
        // Create a pending one unless a login/registration is writing it now.
        if (isProfileCreationInFlight() || autoCreateTried.current === email || !auth?.currentUser) return;
        autoCreateTried.current = email;
        try {
          await createUserProfile(auth.currentUser);
        } catch (error) {
          console.warn('สร้างโปรไฟล์อัตโนมัติไม่สำเร็จ', error);
          setProfileError(error?.code || error?.message || 'unknown');
        }
      },
      (error) => {
        console.warn('อ่านโปรไฟล์แบบเรียลไทม์ไม่สำเร็จ', error);
        setProfileError(error?.code || 'unknown');
      },
    );
  }, [email]);

  // Forces a profile read; needed because onAuthStateChanged can fire before
  // createUserProfile has finished for a brand-new account.
  const retryProfile = useCallback(() => {
    autoCreateTried.current = '';
    setProfileError('');
    window.location.reload();
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!isFirebaseConfigured) return DEMO_PROFILE;
    const current = auth?.currentUser;
    if (!current) return null;
    const profile = await fetchProfile(current.email);
    if (profile) setUserProfile(profile);
    return profile;
  }, []);

  const updateMyProfile = useCallback(async (changes) => {
    if (!isFirebaseConfigured) return;
    await updateOwnProfile(email, changes);
  }, [email]);

  const value = useMemo(() => ({
    firebaseUser,
    userProfile,
    loading,
    profileError,
    retryProfile,
    roles: userProfile ? toRoleList(userProfile.role) : [],
    isMasterAdmin: isMasterAdmin(userProfile),
    canAccess: (moduleId) => canAccessModule(userProfile, moduleId),
    refreshProfile,
    updateMyProfile,
    loginWithEmail,
    loginWithGoogle,
    registerWithEmail,
    logout,
  }), [firebaseUser, userProfile, loading, profileError, retryProfile, refreshProfile, updateMyProfile]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth ต้องใช้ภายใน AuthProvider');
  return context;
};
