import { Timestamp, collection, deleteDoc, doc, onSnapshot, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { db, ensureFirebaseReady, isFirebaseConfigured } from './firebase';
import { FIREBASE_ROOT_COLLECTION, FIREBASE_ROOT_DOCUMENT } from './repository';

// Work-shift profiles live under their project: CMG-Payroll/root/projects/{projectId}/shifts/{shiftId}.
// They inherit the project Firestore Rules (assigned users read, MasterAdmin writes).
// A project has at most one default shift; employees without an explicit assignment use it.
const shiftsCollection = (projectId) => collection(db, FIREBASE_ROOT_COLLECTION, FIREBASE_ROOT_DOCUMENT, 'projects', projectId, 'shifts');

const byStart = (a, b) => String(a.startTime).localeCompare(String(b.startTime)) || String(a.name).localeCompare(String(b.name), 'th');

export function subscribeToShifts({ projectId, onData, onError }) {
  if (!isFirebaseConfigured || !projectId) { onData([]); return () => {}; }
  let unsubscribe = () => {};
  let cancelled = false;
  ensureFirebaseReady().then(() => {
    if (cancelled) return;
    unsubscribe = onSnapshot(
      shiftsCollection(projectId),
      (snapshot) => onData(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort(byStart)),
      onError,
    );
  }).catch(onError);
  return () => { cancelled = true; unsubscribe(); };
}

const normalizeShift = ({ name, startTime, endTime, note = '' }) => ({ name: name.trim(), startTime, endTime, note: note.trim() });

// The first shift of a project becomes its default automatically.
export async function saveShift({ projectId, shift, id, makeDefault = false }) {
  const values = normalizeShift(shift);
  const now = Timestamp.now();
  if (id) {
    await updateDoc(doc(shiftsCollection(projectId), id), { ...values, projectId, updatedAt: now });
    return id;
  }
  const ref = doc(shiftsCollection(projectId));
  await setDoc(ref, { ...values, projectId, isDefault: Boolean(makeDefault), createdAt: now, updatedAt: now });
  return ref.id;
}

// Exactly one default per project: clear the others in the same batch.
export async function setDefaultShift({ projectId, shifts, shiftId }) {
  const batch = writeBatch(db);
  shifts.forEach((shift) => {
    const shouldBeDefault = shift.id === shiftId;
    if (Boolean(shift.isDefault) !== shouldBeDefault) batch.update(doc(shiftsCollection(projectId), shift.id), { isDefault: shouldBeDefault, updatedAt: Timestamp.now() });
  });
  await batch.commit();
}

export const deleteShift = ({ projectId, shiftId }) => deleteDoc(doc(shiftsCollection(projectId), shiftId));

// Hours between start and end, wrapping past midnight for night shifts.
export function shiftHours(startTime, endTime) {
  const toMinutes = (time) => { const [h, m] = String(time || '').split(':').map(Number); return h * 60 + m; };
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return (((end - start) % 1440) + 1440) % 1440 / 60;
}

// Shift to use for an employee: the explicitly assigned one, otherwise the project default.
export const resolveEmployeeShift = (shifts, assignedShiftId) => (
  shifts.find((shift) => shift.id === assignedShiftId) || shifts.find((shift) => shift.isDefault) || null
);
