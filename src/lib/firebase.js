import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

const hasConfig = Object.values(firebaseConfig).every(Boolean);
const app = hasConfig ? (getApps()[0] || initializeApp(firebaseConfig)) : null;

export const db = app ? getFirestore(app) : null;
export const storage = app ? getStorage(app) : null;
export const auth = app ? getAuth(app) : null;
export const isFirebaseConfigured = Boolean(db && storage);

// Users now sign in with a real account (see src/auth). Data access waits for
// Firebase Auth to finish restoring the persisted session so Firestore Rules see
// the signed-in user instead of an unauthenticated client.
export const ensureFirebaseReady = async () => {
  if (!isFirebaseConfigured || !auth) return null;
  await auth.authStateReady();
  return auth.currentUser;
};

// Master Database is intentionally a separate named Firebase app. The payroll
// app keeps using the existing Firebase project for its Firestore/Storage data,
// while the employee directory is read from the HR project's Firestore only
// when the user presses Sync.
const masterDatabaseConfig = {
  apiKey: import.meta.env.VITE_MASTERDATABASE_API_KEY,
  authDomain: import.meta.env.VITE_MASTERDATABASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_MASTERDATABASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_MASTERDATABASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_MASTERDATABASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_MASTERDATABASE_APP_ID,
  measurementId: import.meta.env.VITE_MASTERDATABASE_MEASUREMENT_ID,
};

const hasMasterDatabaseConfig = [
  masterDatabaseConfig.apiKey,
  masterDatabaseConfig.authDomain,
  masterDatabaseConfig.projectId,
  masterDatabaseConfig.appId,
].every(Boolean);

const masterDatabaseApp = hasMasterDatabaseConfig
  ? (getApps().find((candidate) => candidate.name === 'masterDatabase')
    || initializeApp(masterDatabaseConfig, 'masterDatabase'))
  : null;

export const masterDb = masterDatabaseApp ? getFirestore(masterDatabaseApp) : null;
export const masterAuth = masterDatabaseApp ? getAuth(masterDatabaseApp) : null;
export const isMasterDatabaseConfigured = Boolean(masterDb);

const masterAnonymousUserPromise = masterAuth
  ? (masterAuth.currentUser
    ? Promise.resolve(masterAuth.currentUser)
    : signInAnonymously(masterAuth)
      .then(({ user }) => user)
      .catch((error) => {
        // Firestore can still be read without auth when its Rules allow it. If
        // Rules require auth, the subsequent read will return the useful
        // permission error to the UI.
        console.warn('Master Database anonymous authentication is unavailable; continuing with the configured client.', error);
        return null;
      }))
  : Promise.resolve(null);

export const ensureMasterDatabaseReady = async () => {
  if (!isMasterDatabaseConfigured) return null;
  return masterAnonymousUserPromise;
};
