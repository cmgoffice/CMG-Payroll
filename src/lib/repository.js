import { collection, doc, getDocs, onSnapshot, query, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';
import { get, ref as databaseRef } from 'firebase/database';
import { getDownloadURL as getStorageDownloadURL, ref as storageRef, uploadBytes } from 'firebase/storage';
import {
  db,
  ensureFirebaseReady,
  ensureMasterDatabaseReady,
  isFirebaseConfigured,
  isMasterDatabaseConfigured,
  masterDb,
  storage,
} from './firebase';
import { mockDatasets } from '../data/mockData';

export const FIREBASE_ROOT_COLLECTION = 'CMG-Payroll';
export const FIREBASE_ROOT_DOCUMENT = 'root';
export const MASTER_DATABASE_EMPLOYEE_PATH = 'CMG-HR-Database/root/employee_data';

const MASTER_EMPLOYEE_FIELDS = ['employeeId', 'firstName', 'lastName', 'department', 'position'];

const fieldAliases = {
  employeeId: ['employeeId', 'employee_id', 'employeeCode', 'employee_code', 'code', 'รหัสพนักงาน', 'รหัสพนักงาน '],
  firstName: ['firstName', 'first_name', 'firstname', 'name', 'ชื่อ', 'ชื่อจริง'],
  lastName: ['lastName', 'last_name', 'lastname', 'นามสกุล'],
  department: ['department', 'dept', 'แผนก'],
  position: ['position', 'jobTitle', 'job_title', 'title', 'ตำแหน่ง'],
};

const unwrapValue = (value) => {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
  return value;
};

const valueFromAliases = (record, aliases) => {
  for (const alias of aliases) {
    if (record && Object.prototype.hasOwnProperty.call(record, alias)) {
      const value = unwrapValue(record[alias]);
      if (value !== null && value !== undefined && String(value).trim() !== '') return value;
    }
  }
  return '';
};

const hasEmployeeField = (record) => Object.values(fieldAliases)
  .some((aliases) => aliases.some((alias) => Object.prototype.hasOwnProperty.call(record || {}, alias)));

const normalizeMasterEmployee = (record, fallbackEmployeeId = '') => {
  const source = record && typeof record === 'object' ? record : {};
  const employeeId = valueFromAliases(source, fieldAliases.employeeId) || fallbackEmployeeId;
  if (employeeId === null || employeeId === undefined || String(employeeId).trim() === '') return null;

  return MASTER_EMPLOYEE_FIELDS.reduce((employee, field) => {
    employee[field] = String(field === 'employeeId'
      ? employeeId
      : valueFromAliases(source, fieldAliases[field]) || '').trim();
    return employee;
  }, {});
};

const parseMasterEmployees = (value) => {
  if (!value || typeof value !== 'object') return [];

  if (hasEmployeeField(value)) {
    return [normalizeMasterEmployee(value)].filter(Boolean);
  }

  const entries = Array.isArray(value)
    ? value.map((record, index) => [String(index), record])
    : Object.entries(value);
  const records = entries.flatMap(([key, record]) => {
    if (record && typeof record === 'object' && hasEmployeeField(record)) {
      return [normalizeMasterEmployee(record, key)];
    }
    return [];
  }).filter(Boolean);

  // The source can contain both a Firebase key and an employeeId field. Keep
  // one row per employee so a repeated Sync does not create duplicates.
  return [...new Map(records.map((employee) => [employee.employeeId, employee])).values()];
};

const normalizedKey = (value) => String(value || '').trim().toLowerCase();

const inferSheet = (employee, existingRow) => {
  if (existingRow?.sheet === 'DC' || existingRow?.sheet === 'SUPPLY') return existingRow.sheet;
  if (/^sp/i.test(employee.employeeId) || /^s(?:ชุด|upply)/i.test(employee.department)) return 'SUPPLY';
  return 'DC';
};

const masterRecordId = (sheet, employeeId) => `master-${sheet.toLowerCase()}-${String(employeeId)
  .trim()
  .replace(/[^a-zA-Z0-9_-]/g, '-')}`;

const chunks = (items, size) => {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
};

const sortRows = (rows) => [...rows].sort((a, b) => {
  if (a.sequence !== undefined || b.sequence !== undefined) return Number(a.sequence || 0) - Number(b.sequence || 0);
  return String(a.employeeId || '').localeCompare(String(b.employeeId || ''));
});

const categoryCollection = (category) => collection(db, FIREBASE_ROOT_COLLECTION, FIREBASE_ROOT_DOCUMENT, category);

const safeFileName = (name) => name.replace(/[^a-zA-Z0-9._-ก-๙]/g, '_');

const uploadAttachments = async ({ category, sheet, recordId, files }) => {
  if (!files?.length || !storage) return [];

  return Promise.all(files.map(async (file) => {
    const path = `${FIREBASE_ROOT_COLLECTION}/${FIREBASE_ROOT_DOCUMENT}/${category}/${sheet}/${recordId}/${Date.now()}-${safeFileName(file.name)}`;
    const fileRef = storageRef(storage, path);
    await uploadBytes(fileRef, file, { contentType: file.type || 'application/octet-stream' });
    const url = await getStorageDownloadURL(fileRef);
    return {
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      path,
      url,
      uploadedAt: new Date().toISOString(),
    };
  }));
};

export const subscribeToDataset = ({ category, sheet, onData, onError }) => {
  if (!isFirebaseConfigured) {
    onData(sortRows(mockDatasets[category]?.[sheet] || []));
    return () => {};
  }

  let unsubscribe = () => {};
  let cancelled = false;

  const startSubscription = async () => {
    await ensureFirebaseReady();
    if (cancelled) return;

    const datasetQuery = query(categoryCollection(category), where('sheet', '==', sheet));
    unsubscribe = onSnapshot(
      datasetQuery,
      (snapshot) => onData(sortRows(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))),
      (error) => {
        console.error(`ไม่สามารถอ่านข้อมูล ${category}/${sheet} จาก Firebase`, error);
        onError?.(error);
        onData(sortRows(mockDatasets[category]?.[sheet] || []));
      },
    );
  };

  startSubscription().catch((error) => {
    console.error(`ไม่สามารถเริ่มอ่านข้อมูล ${category}/${sheet} จาก Firebase`, error);
    onError?.(error);
    onData(sortRows(mockDatasets[category]?.[sheet] || []));
  });

  return () => {
    cancelled = true;
    unsubscribe();
  };
};

export const saveDatasetRecord = async ({ category, sheet, record, files = [] }) => {
  const payload = { ...record, sheet, updatedAt: new Date().toISOString() };
  delete payload.id;
  delete payload.files;

  if (!isFirebaseConfigured) {
    return { id: record.id || `${category}-${sheet}-${Date.now()}`, ...payload };
  }

  await ensureFirebaseReady();

  if (record.id) {
    const recordRef = doc(categoryCollection(category), record.id);
    await setDoc(recordRef, payload, { merge: true });
    const attachments = await uploadAttachments({ category, sheet, recordId: record.id, files });
    if (attachments.length) {
      const mergedAttachments = [...(record.attachments || []), ...attachments];
      await updateDoc(recordRef, { attachments: mergedAttachments });
      payload.attachments = mergedAttachments;
    }
    return { id: record.id, ...payload };
  }

  const saved = doc(categoryCollection(category));
  const attachments = await uploadAttachments({ category, sheet, recordId: saved.id, files });
  if (attachments.length) {
    payload.attachments = attachments;
  }
  await setDoc(saved, payload);
  return { id: saved.id, ...payload };
};

export const syncMasterEmployees = async ({ existingRowsBySheet = {} } = {}) => {
  if (!isMasterDatabaseConfigured || !masterDb) {
    const error = new Error('ยังไม่ได้ตั้งค่า Master Database');
    error.code = 'master-database-not-configured';
    throw error;
  }
  if (!isFirebaseConfigured || !db) {
    const error = new Error('ยังไม่ได้ตั้งค่า Firebase ของระบบปลายทาง');
    error.code = 'firebase-not-configured';
    throw error;
  }

  await ensureMasterDatabaseReady();
  const snapshot = await get(databaseRef(masterDb, MASTER_DATABASE_EMPLOYEE_PATH));
  const employees = parseMasterEmployees(snapshot.exists() ? snapshot.val() : null);
  const storedRowsSnapshot = await getDocs(categoryCollection('rates'));
  const storedRows = storedRowsSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  const existingRows = [...storedRows, ...Object.values(existingRowsBySheet).flat()];
  const existingByEmployeeId = new Map();

  existingRows.forEach((row) => {
    const key = normalizedKey(row.employeeId);
    if (key && !existingByEmployeeId.has(key)) existingByEmployeeId.set(key, row);
  });

  const syncedRows = [];
  const changedRows = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  employees.forEach((employee) => {
    const existing = existingByEmployeeId.get(normalizedKey(employee.employeeId));
    const sheet = inferSheet(employee, existing);
    const id = existing?.id || masterRecordId(sheet, employee.employeeId);
    const syncedRow = {
      ...(existing || {}),
      id,
      sheet,
      ...employee,
    };
    const hasChanges = !existing || MASTER_EMPLOYEE_FIELDS.some((field) => String(existing[field] ?? '') !== employee[field]) || existing.sheet !== sheet;

    if (!existing) created += 1;
    else if (hasChanges) updated += 1;
    else unchanged += 1;

    if (hasChanges) {
      changedRows.push({ id, payload: { ...syncedRow, updatedAt: new Date().toISOString() } });
    }
    syncedRows.push(syncedRow);
  });

  if (changedRows.length) {
    for (const batchRows of chunks(changedRows, 450)) {
      const batch = writeBatch(db);
      batchRows.forEach(({ id, payload }) => {
        const firestorePayload = { ...payload };
        delete firestorePayload.id;
        delete firestorePayload.files;
        batch.set(doc(categoryCollection('rates'), id), firestorePayload, { merge: true });
      });
      await batch.commit();
    }
  }

  return {
    total: employees.length,
    created,
    updated,
    unchanged,
    rows: syncedRows,
  };
};
