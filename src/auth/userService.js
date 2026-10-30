import { onSnapshot, updateDoc } from 'firebase/firestore';
import { toRoleList } from './constants';
import { userDocRef, usersCollection } from './authService';

export const subscribeToUsers = ({ onData, onError }) => onSnapshot(
  usersCollection(),
  (snapshot) => onData(snapshot.docs.map((item) => ({
    ...item.data(),
    email: item.id,
    role: toRoleList(item.data().role),
    assignedProjects: Array.isArray(item.data().assignedProjects) ? item.data().assignedProjects : [],
  }))),
  (error) => onError?.(error),
);

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Only the fields the admin actually changed are written. Two admins editing
// different fields of the same user therefore never overwrite each other, and
// an open edit form is never reset by someone else's save.
export const updateUserByAdmin = async (original, draft) => {
  const fields = ['firstName', 'lastName', 'position', 'role', 'status', 'assignedProjects'];
  const changes = Object.fromEntries(fields
    .filter((field) => !sameValue(original[field], draft[field]))
    .map((field) => [field, draft[field]]));
  if (!Object.keys(changes).length) return {};
  await updateDoc(userDocRef(original.email), changes);
  return changes;
};

export const setUserStatus = (email, status) => updateDoc(userDocRef(email), { status });
