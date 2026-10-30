import {
  GoogleAuthProvider,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from 'firebase/auth';
import {
  Timestamp,
  addDoc,
  collection,
  doc,
  getDoc,
  increment,
  onSnapshot,
  runTransaction,
  updateDoc,
} from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { APP_NAME, DEFAULT_ROLE, MASTER_ADMIN_ROLE, normalizeEmail, toRoleList } from './constants';

const SESSION_EXPIRY_KEY = 'cmg-payroll-session-expiry';
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export const usersCollection = () => collection(db, APP_NAME, 'root', 'users');
export const userDocRef = (email) => doc(usersCollection(), normalizeEmail(email));
const appMetaRef = () => doc(db, APP_NAME, 'root', 'appMeta', 'config');
const activityLogsCollection = () => collection(db, APP_NAME, 'root', 'activityLogs');

// ---------------------------------------------------------------- session ----

// Called right after every sign-in, before any other await, so the guard in
// AuthContext never sees a freshly signed-in user without an expiry.
export const setSessionExpiry = () => {
  try {
    window.localStorage.setItem(SESSION_EXPIRY_KEY, String(Date.now() + SESSION_LIFETIME_MS));
  } catch {
    // Storage can be blocked; the Firebase session itself still persists.
  }
};

export const clearSessionExpiry = () => {
  try {
    window.localStorage.removeItem(SESSION_EXPIRY_KEY);
  } catch {
    // ignore
  }
};

export const isSessionExpired = () => {
  try {
    const expiry = Number(window.localStorage.getItem(SESSION_EXPIRY_KEY));
    return Number.isFinite(expiry) && expiry > 0 && Date.now() > expiry;
  } catch {
    return false;
  }
};

// Keep the token in Local Storage so the user stays signed in after a reload or
// browser restart. It must be applied before any sign-in call.
let persistencePromise = null;
const ensurePersistence = () => {
  if (!persistencePromise) {
    persistencePromise = setPersistence(auth, browserLocalPersistence).catch((error) => {
      persistencePromise = null;
      console.warn('ไม่สามารถตั้งค่า browserLocalPersistence', error);
    });
  }
  return persistencePromise;
};

// onAuthStateChanged fires as soon as the account exists, i.e. before the
// registration code has written the Firestore profile. AuthContext checks this
// flag so it does not create a nameless profile in the middle of a registration.
let profileCreationInFlight = 0;
export const isProfileCreationInFlight = () => profileCreationInFlight > 0;

// ---------------------------------------------------------------- errors -----

const AUTH_ERROR_MESSAGES = {
  'auth/invalid-credential': 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  'auth/user-not-found': 'ไม่พบบัญชีผู้ใช้นี้',
  'auth/wrong-password': 'รหัสผ่านไม่ถูกต้อง',
  'auth/invalid-email': 'รูปแบบอีเมลไม่ถูกต้อง',
  'auth/user-disabled': 'บัญชีนี้ถูกปิดใช้งาน',
  'auth/email-already-in-use': 'อีเมลนี้ถูกใช้สมัครแล้ว',
  'auth/weak-password': 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร',
  'auth/too-many-requests': 'ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่',
  'auth/network-request-failed': 'เชื่อมต่อเครือข่ายไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ต',
  'auth/popup-closed-by-user': 'ปิดหน้าต่าง Google ก่อนเข้าสู่ระบบสำเร็จ',
  'auth/cancelled-popup-request': 'ปิดหน้าต่าง Google ก่อนเข้าสู่ระบบสำเร็จ',
  'auth/popup-blocked': 'เบราว์เซอร์บล็อกหน้าต่าง Google กรุณาอนุญาต Pop-up',
  'auth/unauthorized-domain': 'โดเมนนี้ยังไม่ได้รับอนุญาตใน Firebase Authentication (Authorized domains)',
  'auth/operation-not-allowed': 'ยังไม่ได้เปิดใช้งานวิธีเข้าสู่ระบบนี้ใน Firebase Console',
};

const toAuthError = (error) => {
  const wrapped = new Error(AUTH_ERROR_MESSAGES[error?.code] || error?.message || 'เข้าสู่ระบบไม่สำเร็จ');
  wrapped.code = error?.code || 'auth/unknown';
  return wrapped;
};

const requireFirebase = () => {
  if (!auth || !db) {
    const error = new Error('ยังไม่ได้ตั้งค่า Firebase ในไฟล์ .env');
    error.code = 'firebase-not-configured';
    throw error;
  }
};

// -------------------------------------------------------------- activity -----

// Never awaited by callers: a logging failure must not block authentication.
export const logActivity = (action, profileOrUser, detail = {}) => {
  if (!db) return Promise.resolve();
  return addDoc(activityLogsCollection(), {
    action,
    email: normalizeEmail(profileOrUser?.email),
    uid: profileOrUser?.uid || '',
    detail,
    createdAt: Timestamp.now(),
  }).catch(() => {});
};

// --------------------------------------------------------------- profile -----

const toProfile = (snapshot) => ({
  ...snapshot.data(),
  email: snapshot.id,
  role: toRoleList(snapshot.data().role),
  assignedProjects: Array.isArray(snapshot.data().assignedProjects) ? snapshot.data().assignedProjects : [],
});

export const subscribeToProfile = (email, onData, onError) => onSnapshot(
  userDocRef(email),
  (snapshot) => onData(snapshot.exists() ? toProfile(snapshot) : null),
  (error) => onError?.(error),
);

// Silent by design: a failed read must leave the app loading-safe, not crash it.
export const fetchProfile = async (email) => {
  try {
    const snapshot = await getDoc(userDocRef(email));
    return snapshot.exists() ? toProfile(snapshot) : null;
  } catch (error) {
    console.warn('อ่านโปรไฟล์ผู้ใช้ไม่สำเร็จ', error);
    return null;
  }
};

const splitDisplayName = (displayName) => {
  const [firstName = '', ...rest] = String(displayName || '').trim().split(/\s+/);
  return { firstName, lastName: rest.join(' ') };
};

// The Firestore transaction makes "am I the first user?" race-free: two people
// registering at the same moment cannot both become MasterAdmin.
export const createUserProfile = async (firebaseUser, { firstName, lastName, position = '' } = {}) => {
  requireFirebase();
  const email = normalizeEmail(firebaseUser.email);
  const userRef = userDocRef(email);
  const metaRef = appMetaRef();
  const fromGoogle = splitDisplayName(firebaseUser.displayName);

  const { profile, created } = await runTransaction(db, async (transaction) => {
    const [userSnapshot, metaSnapshot] = await Promise.all([transaction.get(userRef), transaction.get(metaRef)]);
    if (userSnapshot.exists()) return { profile: toProfile(userSnapshot), created: false };

    const isFirstUser = !metaSnapshot.exists() || !metaSnapshot.data().firstUserRegistered;
    const nextProfile = {
      uid: firebaseUser.uid,
      email,
      firstName: firstName ?? fromGoogle.firstName,
      lastName: lastName ?? fromGoogle.lastName,
      position,
      role: isFirstUser ? [MASTER_ADMIN_ROLE] : [DEFAULT_ROLE],
      status: isFirstUser ? 'approved' : 'pending',
      assignedProjects: [],
      createdAt: Timestamp.now(),
      photoURL: firebaseUser.photoURL || '',
      isFirstUser,
    };
    transaction.set(userRef, nextProfile);

    if (!metaSnapshot.exists()) {
      transaction.set(metaRef, { firstUserRegistered: true, totalUsers: 1, createdAt: Timestamp.now() });
    } else if (isFirstUser) {
      transaction.update(metaRef, { firstUserRegistered: true, totalUsers: (metaSnapshot.data().totalUsers || 0) + 1 });
    } else {
      transaction.update(metaRef, { totalUsers: increment(1) });
    }
    return { profile: nextProfile, created: true };
  });

  if (created) logActivity('REGISTER', profile, { provider: firebaseUser.providerData?.[0]?.providerId || 'password' });
  return profile;
};

// Returns the stored profile, creating a pending one when the account has none.
export const ensureUserProfile = async (firebaseUser, extra) => {
  const existing = await fetchProfile(firebaseUser.email);
  if (existing) return existing;
  return createUserProfile(firebaseUser, extra);
};

// ------------------------------------------------------------ auth flows -----

export const loginWithEmail = async (email, password) => {
  requireFirebase();
  try {
    await ensurePersistence();
    const { user } = await signInWithEmailAndPassword(auth, normalizeEmail(email), password);
    setSessionExpiry();
    const profile = await ensureUserProfile(user);
    logActivity('LOGIN', profile, { provider: 'password' });
    return profile;
  } catch (error) {
    throw toAuthError(error);
  }
};

export const loginWithGoogle = async () => {
  requireFirebase();
  try {
    await ensurePersistence();
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    profileCreationInFlight += 1;
    let user;
    try {
      ({ user } = await signInWithPopup(auth, provider));
      setSessionExpiry();
      let profile = await fetchProfile(user.email);
      if (!profile) {
        profile = await createUserProfile(user);
      } else if (user.photoURL && profile.photoURL !== user.photoURL) {
        // Keep the Google avatar fresh; failure is harmless.
        updateDoc(userDocRef(user.email), { photoURL: user.photoURL }).catch(() => {});
        profile = { ...profile, photoURL: user.photoURL };
      }
      logActivity('LOGIN', profile, { provider: 'google' });
      return profile;
    } finally {
      profileCreationInFlight -= 1;
    }
  } catch (error) {
    throw toAuthError(error);
  }
};

export const registerWithEmail = async (email, password, firstName, lastName, position) => {
  requireFirebase();
  try {
    await ensurePersistence();
    profileCreationInFlight += 1;
    try {
      const { user } = await createUserWithEmailAndPassword(auth, normalizeEmail(email), password);
      setSessionExpiry();
      updateProfile(user, { displayName: `${firstName} ${lastName}`.trim() }).catch(() => {});
      const profile = await createUserProfile(user, {
        firstName: String(firstName || '').trim(),
        lastName: String(lastName || '').trim(),
        position: String(position || '').trim(),
      });
      logActivity('LOGIN', profile, { provider: 'password', afterRegister: true });
      return profile;
    } finally {
      profileCreationInFlight -= 1;
    }
  } catch (error) {
    throw toAuthError(error);
  }
};

export const logout = async () => {
  clearSessionExpiry();
  if (auth) await signOut(auth);
};

export const watchAuthState = (callback) => onAuthStateChanged(auth, callback);

// Users may only change their own display fields; role/status/projects are
// admin-only (enforced again by Firestore Rules).
export const updateOwnProfile = async (email, { firstName, lastName, position }) => {
  requireFirebase();
  await updateDoc(userDocRef(email), {
    firstName: String(firstName || '').trim(),
    lastName: String(lastName || '').trim(),
    position: String(position || '').trim(),
  });
  if (auth.currentUser) {
    updateProfile(auth.currentUser, { displayName: `${firstName} ${lastName}`.trim() }).catch(() => {});
  }
};
