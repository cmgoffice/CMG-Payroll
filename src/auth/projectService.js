import {
  Timestamp,
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { APP_NAME } from './constants';

// Projects live at `CMG-Payroll/root/projects/{projectId}`, the same layer as
// `users`. Every module stores its data below its own project document, so a
// user who is not assigned to a project can neither see nor read that data.
export const projectsCollection = () => collection(db, APP_NAME, 'root', 'projects');
export const projectDocRef = (projectId) => doc(projectsCollection(), projectId);

const toProject = (snapshot) => ({ id: snapshot.id, ...snapshot.data() });
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'th');

// MasterAdmin lists the whole collection.
export const subscribeToAllProjects = ({ onData, onError }) => onSnapshot(
  projectsCollection(),
  (snapshot) => onData(snapshot.docs.map(toProject).filter((project) => !project.archived).sort(byName)),
  (error) => onError?.(error),
);

// Everyone else listens to each assigned project document individually, which
// keeps Firestore Rules simple (a `get`, never a collection `list`).
export const subscribeToProjectIds = (projectIds, { onData, onError }) => {
  const found = new Map();
  const emit = () => onData([...found.values()].filter((project) => !project.archived).sort(byName));
  if (!projectIds.length) {
    onData([]);
    return () => {};
  }
  const unsubscribers = projectIds.map((projectId) => onSnapshot(
    projectDocRef(projectId),
    (snapshot) => {
      if (snapshot.exists()) found.set(projectId, toProject(snapshot));
      else found.delete(projectId);
      emit();
    },
    (error) => {
      found.delete(projectId);
      emit();
      onError?.(error);
    },
  ));
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
};

export const createProject = async ({ name, code = '', description = '' }, creator) => {
  const ref = doc(projectsCollection());
  const now = Timestamp.now();
  await setDoc(ref, {
    name: String(name).trim(),
    code: String(code).trim(),
    description: String(description).trim(),
    archived: false,
    createdAt: now,
    updatedAt: now,
    createdBy: creator?.email || '',
  });
  return ref.id;
};

// Only the changed fields are written so concurrent edits do not clobber each other.
export const updateProject = (projectId, changes) => updateDoc(projectDocRef(projectId), {
  ...changes,
  updatedAt: Timestamp.now(),
});

// Archiving hides a project without deleting its data.
export const archiveProject = (projectId) => updateProject(projectId, { archived: true });

const chunks = (items, size) => {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
};

const LEGACY_COLLECTIONS = ['rates', 'payroll', 'settings', 'payrollPeriods'];

// One-off helper: copies the data that was stored before projects existed
// (`CMG-Payroll/root/{rates,payroll,settings,payrollPeriods}`) into a project.
// It only copies; the original documents stay untouched.
export const importLegacyDataIntoProject = async (projectId) => {
  const target = (name) => collection(projectDocRef(projectId), name);
  const existing = await getDocs(query(target('rates'), limit(1)));
  if (!existing.empty) {
    const error = new Error('โครงการนี้มีข้อมูลอยู่แล้ว');
    error.code = 'target-not-empty';
    throw error;
  }

  const entries = [];
  const legacyRoot = (name) => collection(db, APP_NAME, 'root', name);
  for (const name of LEGACY_COLLECTIONS) {
    const snapshot = await getDocs(legacyRoot(name));
    for (const item of snapshot.docs) {
      const targetRef = doc(target(name), item.id);
      entries.push([targetRef, item.data()]);
      if (name !== 'payrollPeriods') continue;
      const revisions = await getDocs(collection(item.ref, 'revisions'));
      for (const revision of revisions.docs) {
        const revisionTarget = doc(collection(targetRef, 'revisions'), revision.id);
        entries.push([revisionTarget, revision.data()]);
        const rows = await getDocs(collection(revision.ref, 'rows'));
        rows.docs.forEach((row) => entries.push([doc(collection(revisionTarget, 'rows'), row.id), row.data()]));
      }
    }
  }

  for (const batchEntries of chunks(entries, 400)) {
    const batch = writeBatch(db);
    batchEntries.forEach(([ref, data]) => batch.set(ref, data));
    await batch.commit();
  }
  return entries.length;
};
