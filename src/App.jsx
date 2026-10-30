import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { effectiveNetTotal, effectiveTravelAmount, formatCell, formatCurrency, isCampTravel, isNameRecentlyChanged, menuItems, sourceCatalog, usersMenuItem } from './data/schema';
import { isFirebaseConfigured, isMasterDatabaseConfigured } from './lib/firebase';
import { archivePayrollPeriod, deleteDatasetRecord, setActiveProject, isRowVisible, loadPayrollRevisionRows, PAYROLL_SAVEDRAFT_STATUS, saveDatasetRecord, savePayrollPeriod, savePayrollRevision, saveColumnSettings, saveSpecialPositionOptions, subscribeToColumnSettings, subscribeToDataset, subscribeToPayrollPeriods, subscribeToPayrollRevisions, subscribeToSpecialPositionOptions, syncMasterEmployees } from './lib/repository';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ProjectProvider, useProjects } from './auth/ProjectContext';
import ProtectedRoute from './auth/ProtectedRoute';
import { LoginPage, PendingApprovalPage, RegisterPage } from './auth/pages';
import { Spinner, usePathname } from './auth/router';
import { subscribeToUsers } from './auth/userService';
import { NoProjectNotice, ProfileModal, ProjectsPage, SidebarProfileCard, TopbarProfileMenu, UserManagementPage } from './auth/ui';
import './styles.css';
import './auth/auth.css';

// Spreadsheet tooling is only needed when the user imports/exports a file.
// Keep the large XLSX dependency out of the initial payroll screen bundle.
const loadSpreadsheetTools = () => import('./lib/spreadsheet');
const parseRateWorkbook = (...args) => loadSpreadsheetTools().then(({ parseRateWorkbook: parse }) => parse(...args));
const downloadRateWorkbook = (...args) => loadSpreadsheetTools().then(({ downloadRateWorkbook: download }) => download(...args));

const emptyDataset = { payroll: {}, rates: {} };
const SPECIAL_POSITION_OPTIONS_STORAGE_KEY = 'cmg-payroll-special-position-options';
const COLUMN_SETTINGS_STORAGE_KEY = 'cmg-payroll-column-settings-v1';
const PAYROLL_PERIOD_STORAGE_KEY = 'cmg-payroll-current-period-v1';
const MIN_COLUMN_WIDTH = 28;
const TABLE_PAGE_SIZE = 50;
const PAYROLL_RATE_SHEET_BY_PAYROLL_SHEET = { DC: 'DC', SUPPLY: 'SUPPLY' };
const EMPTY_LIST = [];
const RATE_IMPORT_FIELDS = [
  'dailyRateYear69',
  'travelRate',
  'specialPosition',
  'specialPositionAmount',
  'phoneAllowance',
  'welfareSupport',
];

const readSpecialPositionOptions = () => {
  if (typeof window === 'undefined') return [];
  try {
    const stored = window.localStorage.getItem(SPECIAL_POSITION_OPTIONS_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed)
      ? [...new Set(parsed.map((value) => String(value ?? '').trim()).filter(Boolean))]
      : [];
  } catch {
    return [];
  }
};

const readColumnSettings = () => {
  if (typeof window === 'undefined') return {};
  try {
    const stored = window.localStorage.getItem(COLUMN_SETTINGS_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const readPayrollPeriod = () => {
  const fallback = {
    id: 'period-2569-sample',
    name: 'งวดตัวอย่าง',
    status: PAYROLL_SAVEDRAFT_STATUS,
    createdAt: new Date().toISOString(),
  };
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(PAYROLL_PERIOD_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : null;
    return parsed && parsed.id && parsed.name ? { ...fallback, ...parsed } : fallback;
  } catch {
    return fallback;
  }
};

const normalizeEmployeeKey = (value) => String(value || '').trim().toLowerCase();

const payrollRowFromRate = (rate, sheet, sequence) => {
  const employeeId = String(rate.employeeId || '').trim();
  const dailyRate = Number(rate.dailyRateYear69 || 0);
  const positionAllowance = Number(rate.specialPositionAmount ?? rate.positionAllowance ?? 0);
  const phoneAllowance = Number(rate.phoneAllowance || 0);
  return {
    id: `auto-payroll-${sheet}-${employeeId.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
    sheet,
    sequence,
    employeeId,
    firstName: rate.firstName || '',
    lastName: rate.lastName || '',
    department: rate.department || '',
    teamName: rate.teamName || '',
    position: rate.position || '',
    normalDays: 0,
    overtime15: 0,
    overtime2Sunday: 0,
    overtime2Holiday: 0,
    holidayHours: 0,
    travelFormula: 0,
    dailyRate,
    travelRate: rate.travelRate ?? '',
    positionAllowance,
    phoneAllowance,
    overtimeRate15: dailyRate / 8 * 1.5,
    regularWage: 0,
    overtime15Amount: 0,
    overtime2SundayAmount: 0,
    overtime2HolidayAmount: 0,
    holidayHoursAmount: 0,
    positionPhoneTotal: positionAllowance + phoneAllowance,
    travelAmount: 0,
    contractWork: 0,
    wageDrop: 0,
    deduction: 0,
    socialSecurity: 0,
    netTotal: 0,
    note: '',
  };
};

// Payroll rows are no longer created automatically: the user adds them from the
// rate tables. This only refreshes the rate-derived fields of rows already added.
const buildPayrollRowsFromRates = (existingPayroll = {}, ratesBySheet = {}) => {
  const nextPayroll = { ...existingPayroll };
  let changed = false;

  Object.keys(sourceCatalog.payroll.tabs).forEach((sheet) => {
    const sourceSheet = PAYROLL_RATE_SHEET_BY_PAYROLL_SHEET[sheet];
    const existingRows = existingPayroll[sheet] || [];
    const sourceRows = (ratesBySheet[sourceSheet] || []).filter(isRowVisible);
    if (!existingRows.length || !sourceRows.length) return;

    const rateByEmployeeId = new Map(sourceRows.map((row) => [normalizeEmployeeKey(row.employeeId), row]));
    nextPayroll[sheet] = existingRows.map((current) => {
      const rate = rateByEmployeeId.get(normalizeEmployeeKey(current.employeeId));
      if (!rate) return current;

      const dailyRate = Number(rate.dailyRateYear69 || 0);
      const positionAllowance = Number(rate.specialPositionAmount ?? rate.positionAllowance ?? 0);
      const phoneAllowance = Number(rate.phoneAllowance || 0);
      const syncedIdentity = {
        firstName: rate.firstName || '',
        lastName: rate.lastName || '',
        department: rate.department || '',
        teamName: rate.teamName || '',
        position: rate.position || '',
        dailyRate,
        travelRate: rate.travelRate ?? '',
        positionAllowance,
        phoneAllowance,
        overtimeRate15: dailyRate / 8 * 1.5,
        positionPhoneTotal: positionAllowance + phoneAllowance,
      };
      if (!Object.entries(syncedIdentity).some(([key, value]) => String(current[key] ?? '') !== String(value ?? ''))) return current;
      changed = true;
      return { ...current, ...syncedIdentity };
    });
  });

  return { rows: nextPayroll, changed };
};

const createPeriodId = (name) => {
  const slug = String(name || 'period')
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9ก-๙]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 44) || 'period';
  return `period-${slug}-${Date.now()}`;
};

const defaultColumnWidth = (column) => {
  if (column.key === 'sequence') return 58;
  if (column.type === 'special-position') return 250;
  if (['firstName', 'lastName', 'department', 'teamName', 'position', 'project', 'note'].includes(column.key)) return 142;
  if (column.type === 'currency' || column.type === 'number') return 108;
  return 126;
};

const normalizeColumnSettings = (columns, settings = {}) => {
  const availableKeys = columns.map((column) => column.key);
  const savedOrder = Array.isArray(settings.order) ? settings.order : [];
  const order = [...savedOrder.filter((key) => availableKeys.includes(key)), ...availableKeys.filter((key) => !savedOrder.includes(key))];
  const savedVisible = Array.isArray(settings.visible) ? settings.visible : availableKeys;
  const visible = availableKeys.filter((key) => savedVisible.includes(key));
  const widths = Object.fromEntries(columns.map((column) => {
    const savedWidth = Number(settings.widths?.[column.key]);
    return [column.key, Number.isFinite(savedWidth) ? Math.max(MIN_COLUMN_WIDTH, Math.min(420, savedWidth)) : defaultColumnWidth(column)];
  }));
  return { order, visible: visible.length ? visible : availableKeys.slice(0, 1), widths };
};

const SPECIAL_POSITION_PALETTE = [
  { background: '#fff2ce', border: '#e3b54f', text: '#815600', dot: '#d69418' },
  { background: '#e7f0ff', border: '#9ab9ee', text: '#315b9f', dot: '#5f8fe0' },
  { background: '#e5f7ee', border: '#93d1ae', text: '#26734a', dot: '#45a86f' },
  { background: '#f1eaff', border: '#b9a0e7', text: '#67439f', dot: '#8e69ce' },
  { background: '#ffe7e1', border: '#e7a38f', text: '#9a4938', dot: '#d66e55' },
  { background: '#e2f5f5', border: '#8bcaca', text: '#286d70', dot: '#3da1a4' },
  { background: '#ffe7f2', border: '#e4a3c2', text: '#963c69', dot: '#cc5d91' },
];

const colorForSpecialPosition = (value, options = []) => {
  if (!value) return { background: '#f4f6f7', border: '#d7e0e4', text: '#71818a', dot: '#aebbc0' };
  const optionIndex = options.filter(Boolean).indexOf(value);
  if (optionIndex >= 0) return SPECIAL_POSITION_PALETTE[optionIndex % SPECIAL_POSITION_PALETTE.length];
  return SPECIAL_POSITION_PALETTE[0];
};

const iconForMenu = {
  projects: '▦',
  users: '♙',
  overview: '⌂',
  payroll: '฿',
  rates: '▤',
  adminWage: '✎',
};

const menuPaths = {
  overview: '/dashboard',
  projects: '/projects',
  users: '/admin',
  payroll: '/payroll',
  rates: '/rates',
  adminWage: '/admin-wage',
};

const menuIdFromPath = (pathname) => {
  const normalizedPath = String(pathname || '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (normalizedPath === '/overview') return 'overview';
  return Object.entries(menuPaths).find(([, path]) => path === normalizedPath)?.[0] || 'overview';
};

const pathForMenu = (menu) => menuPaths[menu] || menuPaths.overview;

// Recomputes the wage amounts of a payroll row after the admin changes days/OT/adjustments.
const recalcPayrollRow = (row) => {
  const num = (value) => Number(value) || 0;
  const round = (value) => Math.round(value * 100) / 100;
  const dailyRate = num(row.dailyRate);
  const hourly = dailyRate / 8;
  const normalDays = num(row.normalDays);
  const overtimeRate15 = row.overtimeRate15 ? num(row.overtimeRate15) : hourly * 1.5;
  const regularWage = dailyRate * normalDays;
  const overtime15Amount = num(row.overtime15) * overtimeRate15;
  const overtime2SundayAmount = num(row.overtime2Sunday) * hourly * 2;
  const overtime2HolidayAmount = num(row.overtime2Holiday) * hourly * 2;
  const holidayHoursAmount = num(row.holidayHours) * hourly * 3;
  const positionPhoneTotal = num(row.positionAllowance) + num(row.phoneAllowance);
  const travelAmount = isCampTravel(row.travelRate) ? 0 : num(row.travelRate) * normalDays;
  const netTotal = regularWage + overtime15Amount + overtime2SundayAmount + overtime2HolidayAmount + holidayHoursAmount
    + positionPhoneTotal + travelAmount + num(row.contractWork) + num(row.wageDrop) - num(row.deduction) - num(row.socialSecurity);
  return {
    ...row,
    travelFormula: normalDays,
    overtimeRate15: round(overtimeRate15),
    regularWage: round(regularWage),
    overtime15Amount: round(overtime15Amount),
    overtime2SundayAmount: round(overtime2SundayAmount),
    overtime2HolidayAmount: round(overtime2HolidayAmount),
    holidayHoursAmount: round(holidayHoursAmount),
    positionPhoneTotal: round(positionPhoneTotal),
    travelAmount: round(travelAmount),
    netTotal: round(netTotal),
  };
};

const ADMIN_WAGE_FIELDS = [
  { key: 'normalDays', label: 'วันทำงาน' },
  { key: 'overtime15', label: 'OT 1.5' },
  { key: 'overtime2Sunday', label: 'OT 2 อาทิตย์' },
  { key: 'overtime2Holiday', label: 'OT 2 วันหยุด' },
  { key: 'holidayHours', label: 'OT 3 วันหยุด' },
  { key: 'contractWork', label: 'งานเหมา' },
  { key: 'wageDrop', label: 'ค่าแรงตก' },
  { key: 'deduction', label: 'หักเงิน' },
];

function AdminWagePage({ rowsBySheet, period, onChangeRow, onAdd, onSave }) {
  const sheets = Object.keys(sourceCatalog.payroll.tabs);
  const [sheet, setSheet] = useState(sheets[0]);
  const [query, setQuery] = useState('');
  const rows = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (rowsBySheet[sheet] || []).filter((row) => !keyword
      || `${row.employeeId} ${row.firstName} ${row.lastName} ${row.department}`.toLowerCase().includes(keyword));
  }, [rowsBySheet, sheet, query]);
  const total = rows.reduce((sum, row) => sum + effectiveNetTotal(row), 0);

  return (
    <div className="page-content">
      <section className="page-heading-row payroll-heading-row">
        <div>
          <div className="eyebrow">ADMIN</div>
          <h1>Admin ลงค่าแรง</h1>
          <p className="page-description">กรอกจำนวนวันทำงาน, OT และเงินหักของพนักงานงวด {period?.name || 'ปัจจุบัน'} ระบบคำนวณยอดสุทธิให้อัตโนมัติ</p>
        </div>
        <div className="page-heading-actions">
          <button className="secondary-button" onClick={() => onAdd(sheet)}>＋ เพิ่มพนักงาน</button>
          <button className="primary-button" onClick={onSave}>บันทึก</button>
        </div>
      </section>
      <section className="data-panel">
        <div className="data-panel-toolbar">
          <div className="tabs-inline">
            {sheets.map((name) => (
              <button key={name} className={name === sheet ? 'primary-button' : 'secondary-button'} onClick={() => setSheet(name)}>{name}</button>
            ))}
          </div>
          <div className="toolbar-controls">
            <label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหารหัส / ชื่อ / แผนก" /></label>
          </div>
        </div>
        <div className="table-summary"><span><strong>{rows.length}</strong> รายการ</span><span>ยอดสุทธิรวม <strong>{formatCurrency(total)}</strong></span></div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>ลำดับ</th><th>รหัส</th><th>ชื่อ-นามสกุล</th><th>แผนก</th><th>ค่าแรง/วัน</th>
                {ADMIN_WAGE_FIELDS.map((field) => <th key={field.key}>{field.label}</th>)}
                <th>ยอดสุทธิ</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td className="empty-state" colSpan={ADMIN_WAGE_FIELDS.length + 6}>ยังไม่มีพนักงานในแท็บนี้<span>กด “เพิ่มพนักงาน” เพื่อเลือกจากอัตราค่าแรง</span></td></tr>
              ) : rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.sequence}</td>
                  <td className="employee-code">{row.employeeId}</td>
                  <td>{`${row.firstName || ''} ${row.lastName || ''}`.trim()}</td>
                  <td>{row.department}</td>
                  <td>{formatCurrency(row.dailyRate)}</td>
                  {ADMIN_WAGE_FIELDS.map((field) => (
                    <td key={field.key}>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        className="admin-wage-input"
                        value={row[field.key] ?? 0}
                        onChange={(event) => onChangeRow(sheet, row.id, { [field.key]: event.target.value === '' ? 0 : Number(event.target.value) })}
                      />
                    </td>
                  ))}
                  <td className="calculated-cell"><strong>{formatCurrency(effectiveNetTotal(row))}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const createBlankRecord =(category, sheet) => {
  const record = { sheet };
  sourceCatalog[category].tabs[sheet].columns.forEach((column) => {
    if (column.key === 'sequence') return;
    if (column.type === 'special-position') {
      record[column.key] = '';
      record[column.amountKey] = 0;
      return;
    }
    record[column.key] = column.type === 'number' || column.type === 'currency' ? 0 : '';
  });
  return record;
};

function Workspace({ projectId }) {
  const { userProfile, isMasterAdmin, canAccess } = useAuth();
  const { projects, activeProject, activeProjectId, selectProject } = useProjects();
  const [users, setUsers] = useState(EMPTY_LIST);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [activeMenu, setActiveMenu] = useState(() => menuIdFromPath(window.location.pathname));
  const [activeTabs, setActiveTabs] = useState({ payroll: 'DC', rates: 'DC' });
  const [datasets, setDatasets] = useState(emptyDataset);
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState(null);
  const [toast, setToast] = useState('');
  const [firebaseError, setFirebaseError] = useState('');
  const [syncingRates, setSyncingRates] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [payrollPeriod, setPayrollPeriod] = useState(readPayrollPeriod);
  const [payrollRevisions, setPayrollRevisions] = useState([]);
  const [payrollPeriods, setPayrollPeriods] = useState([]);
  const [payrollView, setPayrollView] = useState('list');
  const [openingPeriodId, setOpeningPeriodId] = useState('');
  const [payrollModal, setPayrollModal] = useState(null);
  const [payrollAddSheet, setPayrollAddSheet] = useState(null);
  const [periodToDelete, setPeriodToDelete] = useState(null);
  const [deletingPeriod, setDeletingPeriod] = useState(false);
  const [savingPayrollRevision, setSavingPayrollRevision] = useState(false);
  const [specialPositionOptions, setSpecialPositionOptions] = useState(readSpecialPositionOptions);
  const initialSpecialPositionOptions = useRef(specialPositionOptions);
  const specialPositionOptionsReady = useRef(!isFirebaseConfigured);
  const syncedSpecialPositionOptions = useRef(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(SPECIAL_POSITION_OPTIONS_STORAGE_KEY, JSON.stringify(specialPositionOptions));
    } catch {
      // Local storage is an enhancement; row data still persists normally.
    }
  }, [specialPositionOptions]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PAYROLL_PERIOD_STORAGE_KEY, JSON.stringify(payrollPeriod));
    } catch {
      // Local storage is only a convenience; saved revisions use Firebase when configured.
    }
  }, [payrollPeriod]);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeToSpecialPositionOptions({
      onData: (remoteOptions) => {
        if (!active) return;
        specialPositionOptionsReady.current = true;
        if (Array.isArray(remoteOptions)) {
          // Remember what Firebase holds so the save effect below does not write it back.
          syncedSpecialPositionOptions.current = JSON.stringify(remoteOptions);
          setSpecialPositionOptions((current) => (JSON.stringify(current) === syncedSpecialPositionOptions.current ? current : remoteOptions));
        } else if (initialSpecialPositionOptions.current.length) {
          saveSpecialPositionOptions(initialSpecialPositionOptions.current).catch((error) => {
            console.error('ไม่สามารถย้ายตัวเลือกค่าตำแหน่งพิเศษขึ้น Firebase', error);
          });
        }
      },
      onError: () => {
        specialPositionOptionsReady.current = true;
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isFirebaseConfigured || !specialPositionOptionsReady.current) return;
    const serialized = JSON.stringify(specialPositionOptions);
    if (serialized === syncedSpecialPositionOptions.current) return;
    syncedSpecialPositionOptions.current = serialized;
    saveSpecialPositionOptions(specialPositionOptions).catch((error) => {
      console.error('ไม่สามารถบันทึกตัวเลือกค่าตำแหน่งพิเศษลง Firebase', error);
    });
  }, [specialPositionOptions]);

  useEffect(() => {
    const unsubscribers = [];
    Object.entries(sourceCatalog).forEach(([category, config]) => {
      Object.keys(config.tabs).forEach((sheet) => {
        unsubscribers.push(subscribeToDataset({
          category,
          sheet,
          onData: (rows) => setDatasets((current) => ({
            ...current,
            [category]: { ...current[category], [sheet]: rows },
          })),
          onError: (error) => {
            setFirebaseError(error?.code === 'permission-denied'
              ? 'Firebase ปฏิเสธสิทธิ์การอ่านข้อมูล'
              : 'Firebase ไม่สามารถอ่านข้อมูลได้ในขณะนี้');
          },
        }));
      });
    });
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  useEffect(() => {
    const result = buildPayrollRowsFromRates(datasets.payroll, datasets.rates);
    if (!result.changed) return;
    setDatasets((current) => {
      const next = buildPayrollRowsFromRates(current.payroll, current.rates);
      return next.changed ? { ...current, payroll: next.rows } : current;
    });
  }, [datasets.rates]);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeToPayrollPeriods({
      onData: (periods) => {
        if (active) setPayrollPeriods(periods);
      },
      onError: (error) => {
        if (!active) return;
        setFirebaseError(error?.code === 'permission-denied'
          ? 'Firebase ปฏิเสธสิทธิ์การอ่านรายการงวด'
          : 'Firebase ไม่สามารถอ่านรายการงวดได้ในขณะนี้');
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    setPayrollRevisions([]);
    const unsubscribe = subscribeToPayrollRevisions({
      periodId: payrollPeriod.id,
      onData: (revisions) => {
        if (active) setPayrollRevisions(revisions);
      },
      onError: (error) => {
        if (!active) return;
        setFirebaseError(error?.code === 'permission-denied'
          ? 'Firebase ปฏิเสธสิทธิ์การอ่าน Revision'
          : 'Firebase ไม่สามารถอ่าน Revision ได้ในขณะนี้');
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [payrollPeriod.id]);

  // MasterAdmin watches all users in realtime (user table + pending badge).
  useEffect(() => {
    if (!isFirebaseConfigured || !isMasterAdmin) return undefined;
    return subscribeToUsers({
      onData: (list) => {
        setUsers(list);
        setUsersLoaded(true);
      },
      onError: (error) => {
        console.warn('อ่านรายชื่อผู้ใช้ไม่สำเร็จ', error);
        setUsersLoaded(true);
      },
    });
  }, [isMasterAdmin]);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const payrollRows = useMemo(() => Object.values(datasets.payroll).flat(), [datasets.payroll]);
  const rateRows = useMemo(() => Object.values(datasets.rates).flat().filter(isRowVisible), [datasets.rates]);
  const positionColorOptions = useMemo(() => {
    const allRows = [...Object.values(datasets.rates).flat(), ...Object.values(datasets.payroll).flat()];
    return [...new Set([
      ...specialPositionOptions,
      ...allRows.flatMap((row) => [row.position, row.specialPosition]),
    ].map((value) => String(value || '').trim()).filter(Boolean))];
  }, [datasets.rates, datasets.payroll, specialPositionOptions]);
  const totalPayroll = useMemo(() => payrollRows.reduce((sum, row) => sum + effectiveNetTotal(row), 0), [payrollRows]);
  const activeMenuItem = [...menuItems, usersMenuItem].find((item) => item.id === activeMenu) || menuItems.find((item) => item.id === 'overview');
  const menuAllowed = canAccess(activeMenu);
  const needsProject = !projectId && !['projects', 'users'].includes(activeMenu);
  const pendingUserCount = useMemo(() => users.filter((user) => user.status === 'pending').length, [users]);
  const visibleMenuItems = menuItems.filter((item) => canAccess(item.id));

  // A menu the user's roles do not unlock is replaced by the overview.
  useEffect(() => {
    if (menuAllowed) return;
    const fallbackPath = menuPaths.overview;
    window.history.replaceState({ menu: 'overview' }, '', fallbackPath);
    setActiveMenu('overview');
  }, [menuAllowed]);
  const activeSheet = activeTabs[activeMenu];
  const activeTableRows = useMemo(() => {
    const sourceRows = datasets[activeMenu]?.[activeSheet] || EMPTY_LIST;
    return activeMenu === 'rates' ? sourceRows.filter(isRowVisible) : sourceRows;
  }, [activeMenu, activeSheet, datasets]);

  useEffect(() => {
    const initialMenu = menuIdFromPath(window.location.pathname);
    const initialPath = pathForMenu(initialMenu);
    if (window.location.pathname !== initialPath) {
      window.history.replaceState({ menu: initialMenu }, '', initialPath);
    }

    const handlePopState = () => {
      const nextMenu = menuIdFromPath(window.location.pathname);
      const nextPath = pathForMenu(nextMenu);
      if (window.location.pathname !== nextPath) {
        window.history.replaceState({ menu: nextMenu }, '', nextPath);
      }
      setActiveMenu(nextMenu);
      setSearch('');
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    document.title = `CMG Payroll · ${activeMenuItem.label}`;
  }, [activeMenuItem.label]);

  const selectMenu = (menu) => {
    const nextMenu = menuPaths[menu] ? menu : 'overview';
    const nextPath = pathForMenu(nextMenu);
    if (window.location.pathname !== nextPath) {
      window.history.pushState({ menu: nextMenu }, '', nextPath);
    }
    setActiveMenu(nextMenu);
    setSearch('');
    setPayrollAddSheet(null);
    if (nextMenu === 'payroll') setPayrollView('list');
  };

  const upsertPayrollPeriodCard = (period) => {
    setPayrollPeriods((current) => [period, ...current.filter((item) => item.id !== period.id)]);
  };

  const confirmDeletePayrollPeriod = async () => {
    const target = periodToDelete;
    if (!target || deletingPeriod) return;
    setDeletingPeriod(true);
    try {
      await archivePayrollPeriod(target);
      setPayrollPeriods((current) => current.filter((item) => item.id !== target.id));
      setPeriodToDelete(null);
      setFirebaseError('');
      setToast(`ลบงวด “${target.name}” แล้ว`);
    } catch (error) {
      console.error('ไม่สามารถลบงวดค่าแรง', error);
      setToast(error?.code === 'permission-denied' ? 'ลบงวดไม่สำเร็จ: Firebase ปฏิเสธสิทธิ์' : 'ลบงวดไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อ');
    } finally {
      setDeletingPeriod(false);
    }
  };

  const openPayrollPeriod = async (period) => {
    if (openingPeriodId) return;
    setOpeningPeriodId(period.id);
    try {
      setPayrollPeriod({ id: period.id, name: period.name, status: period.status || PAYROLL_SAVEDRAFT_STATUS, createdAt: period.createdAt, activeRevisionId: period.activeRevisionId, updatedAt: period.updatedAt });
      const savedRows = period.activeRevisionId
        ? await loadPayrollRevisionRows({ periodId: period.id, revisionId: period.activeRevisionId })
        : [];
      setDatasets((current) => {
        if (savedRows.length) {
          const bySheet = savedRows.reduce((groups, row) => ({ ...groups, [row.sheet]: [...(groups[row.sheet] || []), row] }), {});
          return { ...current, payroll: bySheet };
        }
        return { ...current, payroll: {} };
      });
      setSearch('');
      setPayrollView('detail');
    } catch (error) {
      console.error('ไม่สามารถเปิดงวดค่าแรง', error);
      setToast('เปิดงวดไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อ');
    } finally {
      setOpeningPeriodId('');
    }
  };

  // Rate rows a payroll tab can draw from; a tab without its own rate sheet may use any of them.
  const payrollSourceRates = (sheet) => {
    const sourceSheet = PAYROLL_RATE_SHEET_BY_PAYROLL_SHEET[sheet];
    const rows = sourceSheet ? datasets.rates[sourceSheet] || [] : Object.values(datasets.rates).flat();
    return rows.filter(isRowVisible);
  };

  const addPayrollRows = (sheet, rates) => {
    const existingRows = datasets.payroll[sheet] || [];
    const existingIds = new Set(existingRows.map((row) => normalizeEmployeeKey(row.employeeId)));
    const newRates = rates.filter((rate) => {
      const key = normalizeEmployeeKey(rate.employeeId);
      if (!key || existingIds.has(key)) return false;
      existingIds.add(key);
      return true;
    });
    if (!newRates.length) {
      setToast('รายชื่อที่เลือกอยู่ในตารางนี้แล้ว');
      return false;
    }
    const startSequence = existingRows.reduce((max, row) => Math.max(max, Number(row.sequence) || 0), 0);
    const newRows = newRates.map((rate, index) => payrollRowFromRate(rate, sheet, startSequence + index + 1));
    setDatasets((current) => ({
      ...current,
      payroll: { ...current.payroll, [sheet]: [...(current.payroll[sheet] || []), ...newRows] },
    }));
    setPayrollAddSheet(null);
    setToast(`เพิ่ม ${newRows.length} รายการเข้าแท็บ ${sheet} แล้ว`);
    return true;
  };

  const updateAdminWageRow = (sheet, rowId, changes) => {
    setDatasets((current) => ({
      ...current,
      payroll: {
        ...current.payroll,
        [sheet]: (current.payroll[sheet] || []).map((row) => (row.id === rowId ? recalcPayrollRow({ ...row, ...changes }) : row)),
      },
    }));
  };

  const openEditor = (category, sheet, row = null) => {
    setEditor({ category, sheet, row: row ? { ...row } : createBlankRecord(category, sheet) });
  };

  const saveRecord = async (record, files = [], { baseUpdatedAt, force = false } = {}) => {
    const { category, sheet } = editor;
    if (!record.id && category === 'rates') {
      // Guard against creating the same employee twice (e.g. two people adding at once).
      const key = normalizeEmployeeKey(record.employeeId);
      const duplicate = key && Object.values(datasets.rates).flat().some((row) => normalizeEmployeeKey(row.employeeId) === key);
      if (duplicate) {
        setToast(`รหัสพนักงาน ${record.employeeId} มีอยู่ในระบบแล้ว`);
        return false;
      }
    }
    try {
      const saved = await saveDatasetRecord({ category, sheet, record, files, expectedUpdatedAt: record.id ? baseUpdatedAt : undefined, force });
      setDatasets((current) => {
        const rows = current[category][sheet] || [];
        const exists = rows.some((row) => row.id === saved.id);
        return {
          ...current,
          [category]: {
            ...current[category],
            [sheet]: exists ? rows.map((row) => row.id === saved.id ? saved : row) : [...rows, saved],
          },
        };
      });
      setEditor(null);
      setFirebaseError('');
      setToast(isFirebaseConfigured ? 'บันทึกข้อมูลลง Firebase แล้ว' : 'บันทึกข้อมูลในโหมดตัวอย่างแล้ว');
      return true;
    } catch (error) {
      // Someone else saved this record first: keep the open form and let it merge.
      if (error?.code === 'conflict') return { conflict: error.latest };
      console.error('ไม่สามารถบันทึกข้อมูลลง Firebase', error);
      setToast(error?.code === 'permission-denied'
        ? 'บันทึกไม่สำเร็จ: Firebase ปฏิเสธสิทธิ์'
        : 'บันทึกไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อ');
      return false;
    }
  };

  const saveInlineRate = async ({ sheet, row, changes }) => {
    try {
      const saved = await saveDatasetRecord({
        category: 'rates',
        sheet,
        record: { ...row, ...changes },
        expectedUpdatedAt: row.updatedAt,
      });
      setDatasets((current) => ({
        ...current,
        rates: {
          ...current.rates,
          [sheet]: (current.rates[sheet] || []).map((item) => item.id === saved.id ? saved : item),
        },
      }));
      setFirebaseError('');
      setToast(isFirebaseConfigured ? 'บันทึกค่าตำแหน่งพิเศษลง Firebase แล้ว' : 'บันทึกค่าตำแหน่งพิเศษแล้ว');
      return true;
    } catch (error) {
      if (error?.code === 'conflict') {
        setToast('มีผู้อื่นแก้ไขรายการนี้ก่อน ระบบแสดงข้อมูลล่าสุดแล้ว กรุณาตรวจสอบและบันทึกอีกครั้ง');
        return false;
      }
      console.error('ไม่สามารถบันทึกค่าตำแหน่งพิเศษ', error);
      setToast(error?.code === 'permission-denied'
        ? 'บันทึกไม่สำเร็จ: Firebase ปฏิเสธสิทธิ์'
        : 'บันทึกไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อ');
      return false;
    }
  };

  const deleteRecord = async () => {
    const { category, sheet, row } = deleteTarget;
    try {
      // Payroll rows belong to the open period and are stored with its revisions, not as documents.
      if (category !== 'payroll') await deleteDatasetRecord({ category, record: row });
      setDatasets((current) => ({
        ...current,
        [category]: {
          ...current[category],
          [sheet]: (current[category][sheet] || []).filter((item) => item.id !== row.id),
        },
      }));
      setDeleteTarget(null);
      setFirebaseError('');
      setToast('ลบรายการแล้ว');
    } catch (error) {
      console.error('ไม่สามารถลบข้อมูลจาก Firebase', error);
      setToast(error?.code === 'permission-denied'
        ? 'ลบไม่สำเร็จ: Firebase ปฏิเสธสิทธิ์'
        : 'ลบไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อ');
    }
  };

  const syncRates = async () => {
    setSyncingRates(true);
    try {
      const result = await syncMasterEmployees({ existingRowsBySheet: datasets.rates });
      const syncedIds = new Set(result.rows.map((row) => row.id));
      setDatasets((current) => {
        const nextRates = Object.fromEntries(Object.entries(current.rates).map(([sheet, rows]) => [
          sheet,
          rows.filter((row) => !syncedIds.has(row.id)),
        ]));

        result.rows.forEach((row) => {
          nextRates[row.sheet] = [...(nextRates[row.sheet] || []), row];
        });

        return { ...current, rates: nextRates };
      });
      setFirebaseError('');
      setToast(`Sync สำเร็จ: เพิ่ม ${result.created} รายการ · อัปเดต ${result.updated} รายการ · ไม่เปลี่ยนแปลง ${result.unchanged} รายการ`);
    } catch (error) {
      console.error('ไม่สามารถ Sync ข้อมูลพนักงานจาก Master Database', error);
      const message = error?.code === 'permission-denied'
        ? 'Sync ไม่สำเร็จ: Master Database ปฏิเสธสิทธิ์การอ่าน'
        : error?.code === 'master-database-not-configured'
          ? 'Sync ไม่สำเร็จ: ยังไม่ได้ตั้งค่า Master Database ใน .env'
          : error?.code === 'firebase-not-configured'
            ? 'Sync ไม่สำเร็จ: ยังไม่ได้ตั้งค่า Firebase ของระบบปลายทาง'
            : 'Sync ไม่สำเร็จ กรุณาตรวจสอบฐานข้อมูลต้นทางและการเชื่อมต่อ';
      setToast(message);
    } finally {
      setSyncingRates(false);
    }
  };

  const createRateImportPlan = (parsed) => {
    const importedByEmployeeId = new Map(parsed.records.map((record) => [record.employeeId.trim().toLowerCase(), record]));
    const allowedSpecialPositions = new Set((specialPositionOptions || []).map((value) => String(value).trim()));
    const systemRowsByEmployeeId = new Map();
    Object.entries(datasets.rates).forEach(([systemSheet, rows]) => {
      rows.forEach((row) => {
        const employeeId = String(row.employeeId || '').trim().toLowerCase();
        if (employeeId && !systemRowsByEmployeeId.has(employeeId)) systemRowsByEmployeeId.set(employeeId, { row, sheet: systemSheet });
      });
    });
    const specialPositionErrors = [...importedByEmployeeId.entries()]
      .filter(([, record]) => record.specialPosition && !allowedSpecialPositions.has(String(record.specialPosition).trim()))
      .map(([, record]) => ({ employeeId: record.employeeId, value: String(record.specialPosition).trim() }));
    const invalidSpecialPositionIds = specialPositionErrors.map(({ employeeId }) => employeeId);
    const invalidSpecialPositionValues = [...new Set(specialPositionErrors.map(({ value }) => value))];
    const matchedRows = [...importedByEmployeeId.entries()]
      .map(([employeeId, imported]) => ({ employeeId: imported.employeeId, imported, target: systemRowsByEmployeeId.get(employeeId) }))
      .filter(({ employeeId, target }) => target && !invalidSpecialPositionIds.some((id) => id.toLowerCase() === employeeId.toLowerCase()));
    const notUpdatedIds = [...importedByEmployeeId.entries()]
      .filter(([employeeId]) => !systemRowsByEmployeeId.has(employeeId))
      .map(([, record]) => record.employeeId);

    return {
      parsed,
      matchedRows,
      updatedIds: matchedRows.map(({ employeeId }) => employeeId),
      notUpdatedIds,
      invalidIds: parsed.invalidEmployeeIds || [],
      invalidSpecialPositionIds,
      invalidSpecialPositionValues,
    };
  };

  const importRates = async ({ file, parsed: parsedFile, previewOnly = false }) => {
    try {
      const parsed = parsedFile || await parseRateWorkbook(file);
      if (!parsed.records.length) {
        setToast('นำเข้าไม่สำเร็จ: ไม่พบแถวข้อมูลที่มีรหัสพนักงาน');
        return false;
      }

      const plan = createRateImportPlan(parsed);
      if (previewOnly) return { ...plan, preview: true };
      if (!plan.matchedRows.length) {
        setToast('นำเข้าไม่สำเร็จ: ไม่พบรหัสจากไฟล์ในระบบ');
        return false;
      }

      const savedRows = await Promise.all(plan.matchedRows.map(({ imported, target }) => {
        const importedRates = Object.fromEntries(RATE_IMPORT_FIELDS
          .filter((field) => Object.prototype.hasOwnProperty.call(imported, field))
          .map((field) => [field, imported[field]]));
        return saveDatasetRecord({
          category: 'rates',
          sheet: target.sheet,
          record: {
            ...target.row,
            ...importedRates,
            // The imported file is only a rate update. Employee identity and
            // profile fields stay sourced from the system row.
            status: 'ทำงาน',
            employeeStatus: 'ทำงาน',
          },
        });
      }));

      setDatasets((current) => {
        const savedById = new Map(savedRows.map((row) => [row.id, row]));
        return {
          ...current,
          rates: {
            ...current.rates,
            ...Object.fromEntries(Object.entries(current.rates).map(([systemSheet, rows]) => [
              systemSheet,
              rows.map((row) => savedById.get(row.id) || row),
            ])),
          },
        };
      });
      setFirebaseError('');
      const warnings = [
        parsed.duplicateEmployeeIds.length ? `ซ้ำ ${parsed.duplicateEmployeeIds.length} รหัส` : '',
        parsed.invalidRows.length ? `ข้ามค่าตัวเลข ${parsed.invalidRows.length} ช่อง` : '',
        plan.notUpdatedIds.length ? `ไม่พบในระบบ ${plan.notUpdatedIds.length} รหัส` : '',
      ].filter(Boolean).join(' · ');
      const importedBySheet = savedRows.reduce((counts, row) => ({ ...counts, [row.sheet]: (counts[row.sheet] || 0) + 1 }), {});
      const sheetSummary = Object.entries(importedBySheet).map(([systemSheet, count]) => `${systemSheet} ${count}`).join(' · ');
      setToast(`นำเข้าสำเร็จ ${savedRows.length} รายการ (${sheetSummary})${warnings ? ` · ${warnings}` : ''}`);
      return { ok: true, updatedIds: plan.updatedIds, notUpdatedIds: plan.notUpdatedIds };
    } catch (error) {
      console.error('ไม่สามารถนำเข้าไฟล์อัตราค่าแรง', error);
      setToast(error?.message || 'นำเข้าไม่สำเร็จ กรุณาตรวจสอบรูปแบบไฟล์');
      return false;
    }
  };

  const openSavePayrollRevision = () => {
    if (!payrollRows.length) {
      setToast('ยังไม่มีรายการพนักงานสำหรับบันทึกงวดนี้');
      return;
    }
    setPayrollModal({ type: 'save', initialName: `Revision ${payrollRevisions.length + 1}` });
  };

  const savePayrollRevisionSnapshot = async (revisionName) => {
    const normalizedName = String(revisionName || '').trim();
    if (!normalizedName) return false;
    setSavingPayrollRevision(true);
    try {
      const saved = await savePayrollRevision({
        period: payrollPeriod,
        revisionName: normalizedName,
        rows: payrollRows,
        revisionCount: payrollRevisions.length + 1,
      });
      setPayrollRevisions((current) => [saved, ...current.filter((revision) => revision.id !== saved.id)]);
      upsertPayrollPeriodCard({
        ...payrollPeriod,
        periodId: payrollPeriod.id,
        activeRevisionId: saved.id,
        revisionCount: payrollRevisions.length + 1,
        rowCount: saved.rowCount,
        updatedAt: saved.updatedAt,
      });
      setPayrollPeriod((current) => ({
        ...current,
        status: PAYROLL_SAVEDRAFT_STATUS,
        activeRevisionId: saved.id,
        updatedAt: saved.updatedAt,
      }));
      setPayrollModal(null);
      setFirebaseError('');
      setToast(`บันทึก ${normalizedName} เป็น Savedraft แล้ว · ${saved.rowCount} รายการ`);
      return true;
    } catch (error) {
      console.error('ไม่สามารถบันทึก Revision ค่าแรงรายงวด', error);
      setToast(error?.code === 'permission-denied'
        ? 'บันทึก Revision ไม่สำเร็จ: Firebase ปฏิเสธสิทธิ์'
        : error?.code === 'timeout'
          ? 'บันทึก Revision ไม่สำเร็จ: เชื่อมต่อ Firebase ไม่ตอบสนอง'
          : 'บันทึก Revision ไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อ');
      return false;
    } finally {
      setSavingPayrollRevision(false);
    }
  };

  const openNewPayrollPeriod = () => {
    setPayrollModal({ type: 'new-period', initialName: '' });
  };

  const createPayrollPeriod = (periodName) => {
    const normalizedName = String(periodName || '').trim();
    if (!normalizedName) return false;
    const nextPeriod = {
      id: createPeriodId(normalizedName),
      name: normalizedName,
      status: PAYROLL_SAVEDRAFT_STATUS,
      createdAt: new Date().toISOString(),
    };
    setPayrollPeriod(nextPeriod);
    setPayrollRevisions([]);
    setPayrollModal(null);
    setSearch('');
    setPayrollView('detail');
    upsertPayrollPeriodCard({ ...nextPeriod, periodId: nextPeriod.id, revisionCount: 0, rowCount: 0, updatedAt: nextPeriod.createdAt });
    savePayrollPeriod(nextPeriod).catch((error) => {
      console.error('ไม่สามารถบันทึกงวดใหม่', error);
      setToast('สร้างงวดในระบบไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อ');
    });
    setDatasets((current) => ({ ...current, payroll: {} }));
    setToast(`เปิดงวดใหม่ “${normalizedName}” แล้ว · พร้อมบันทึกเป็น Savedraft`);
    return true;
  };

  const connectionLabel = firebaseError || (isFirebaseConfigured ? 'Firebase พร้อมใช้งาน' : 'โหมดตัวอย่าง');

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <SidebarProfileCard />
        <div className="brand-lockup">
          <div className="brand-mark">CMG</div>
          <div>
            <div className="brand-name">CMG Payroll</div>
            <div className="brand-subtitle">จัดการค่าแรง</div>
          </div>
        </div>

        <div className="nav-label">เมนูหลัก</div>
        <nav className="main-nav" aria-label="เมนูหลัก">
          {visibleMenuItems.map((item) => (
            <a key={item.id} href={pathForMenu(item.id)} className={`nav-item ${activeMenu === item.id ? 'active' : ''}`} onClick={(event) => { event.preventDefault(); selectMenu(item.id); }} aria-current={activeMenu === item.id ? 'page' : undefined}>
              <span className="nav-icon">{iconForMenu[item.id]}</span>
              <span>{item.label}</span>
              {sourceCatalog[item.id] && <span className="nav-count">{Object.keys(sourceCatalog[item.id].tabs).length}</span>}
            </a>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="source-mini-card">
            <div className="source-mini-title">แหล่งข้อมูล</div>
            <div className="source-mini-row"><span className={`status-dot ${firebaseError ? 'error' : ''}`} />{firebaseError ? 'ตรวจสอบ Firebase' : isFirebaseConfigured ? 'เชื่อมต่อ Firebase' : 'โหมดตัวอย่าง'}</div>
            <div className="source-mini-note">ข้อมูลอ้างอิงจากไฟล์ Excel ปี 2569</div>
          </div>
          {isMasterAdmin && (
            <a href={pathForMenu('users')} className={`nav-item user-admin-nav ${activeMenu === 'users' ? 'active' : ''}`} onClick={(event) => { event.preventDefault(); selectMenu('users'); }} aria-current={activeMenu === 'users' ? 'page' : undefined}>
              <span className="nav-icon">{iconForMenu.users}</span>
              <span>{usersMenuItem.label}</span>
              {pendingUserCount > 0 && <span className="nav-badge" title="ผู้ขอเข้าใช้งานที่รออนุมัติ" aria-label={`${pendingUserCount} คนรออนุมัติ`}>{pendingUserCount}</span>}
            </a>
          )}
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb"><span>CMG Payroll</span><span className="breadcrumb-separator">/</span><strong>{activeMenuItem.label}</strong></div>
          <div className="topbar-actions">
            {projects.length > 0 && (
              <select className="project-switcher" aria-label="โครงการ" value={activeProjectId} onChange={(event) => selectProject(event.target.value)}>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            )}
            <span className={`connection-pill ${isFirebaseConfigured ? 'connected' : ''} ${firebaseError ? 'error' : ''}`}><span className="status-dot" />{connectionLabel}</span>
            <button className="icon-button" aria-label="การแจ้งเตือน" onClick={() => isMasterAdmin && selectMenu('users')}>♢{isMasterAdmin && pendingUserCount > 0 && <span className="notification-dot" />}</button>
            <TopbarProfileMenu onEditProfile={() => setProfileOpen(true)} />
          </div>
        </header>

        {!menuAllowed ? null : activeMenu === 'projects' ? (
          <ProjectsPage projects={projects} activeProjectId={activeProjectId} onSelect={selectProject} onOpen={() => selectMenu('overview')} onNotify={setToast} />
        ) : activeMenu === 'users' ? (
          <UserManagementPage users={users} projects={projects} loaded={usersLoaded} onNotify={setToast} />
        ) : needsProject ? (
          <NoProjectNotice onOpenProjects={() => selectMenu('projects')} />
        ) : activeMenu === 'overview' ? (
          <Overview totalPayroll={totalPayroll} payrollRows={payrollRows} rateRows={rateRows} onNavigate={selectMenu} />
        ) : activeMenu === 'adminWage' ? (
          <AdminWagePage
            rowsBySheet={datasets.payroll}
            period={payrollPeriod}
            onChangeRow={updateAdminWageRow}
            onAdd={(sheet) => { selectMenu('payroll'); setActiveTabs((tabs) => ({ ...tabs, payroll: sheet })); setPayrollView('detail'); setPayrollAddSheet(sheet); }}
            onSave={openSavePayrollRevision}
          />
        ) : activeMenu === 'payroll' && payrollView === 'list' ? (
          <PayrollPeriodList
            periods={payrollPeriods}
            currentPeriodId={payrollPeriod.id}
            openingId={openingPeriodId}
            onOpen={openPayrollPeriod}
            onDelete={setPeriodToDelete}
            onNew={openNewPayrollPeriod}
          />
        ) : activeMenu === 'payroll' && payrollAddSheet ? (
          <AddPayrollRowsPage
            sheet={payrollAddSheet}
            period={payrollPeriod}
            rates={payrollSourceRates(payrollAddSheet)}
            existingEmployeeIds={new Set((datasets.payroll[payrollAddSheet] || []).map((row) => normalizeEmployeeKey(row.employeeId)))}
            onBack={() => setPayrollAddSheet(null)}
            onAdd={(rates) => addPayrollRows(payrollAddSheet, rates)}
          />
        ) : (
          <DatasetView
            onBack={activeMenu === 'payroll' ? () => { setPayrollView('list'); setSearch(''); } : undefined}
            category={activeMenu}
            sheet={activeTabs[activeMenu]}
            onSheetChange={(sheet) => setActiveTabs((tabs) => ({ ...tabs, [activeMenu]: sheet }))}
            rows={activeTableRows}
            search={search}
            setSearch={setSearch}
            onAdd={() => (activeMenu === 'payroll' ? setPayrollAddSheet(activeTabs.payroll) : openEditor(activeMenu, activeTabs[activeMenu]))}
            onEdit={(row) => openEditor(activeMenu, activeTabs[activeMenu], row)}
            onInlineUpdate={activeMenu === 'rates' ? (row, changes) => saveInlineRate({ sheet: activeTabs[activeMenu], row, changes }) : undefined}
            onDelete={(row) => setDeleteTarget({ category: activeMenu, sheet: activeTabs[activeMenu], row })}
            onSync={activeMenu === 'rates' ? syncRates : undefined}
            onImport={activeMenu === 'rates' ? importRates : undefined}
            period={activeMenu === 'payroll' ? payrollPeriod : undefined}
            revisionCount={activeMenu === 'payroll' ? payrollRevisions.length : 0}
            onSavePeriod={activeMenu === 'payroll' ? openSavePayrollRevision : undefined}
            onOpenNewPeriod={activeMenu === 'payroll' ? openNewPayrollPeriod : undefined}
            specialPositionOptions={activeMenu === 'rates' ? specialPositionOptions : EMPTY_LIST}
            specialPositionColorOptions={activeMenu === 'rates' ? specialPositionOptions : EMPTY_LIST}
            positionColorOptions={positionColorOptions}
            onSpecialPositionOptionsChange={activeMenu === 'rates' ? setSpecialPositionOptions : undefined}
            syncing={syncingRates}
            canSyncMaster={isMasterDatabaseConfigured}
          />
        )}
      </main>

      {editor && (
        <RecordEditor
          category={editor.category}
          sheet={editor.sheet}
          record={editor.row}
          liveRecord={editor.row.id ? (datasets[editor.category]?.[editor.sheet] || EMPTY_LIST).find((row) => row.id === editor.row.id) : undefined}
          onClose={() => setEditor(null)}
          onSave={saveRecord}
          specialPositionOptions={specialPositionOptions}
        />
      )}
      {deleteTarget && (
        <ConfirmDelete
          row={deleteTarget.row}
          category={deleteTarget.category}
          onClose={() => setDeleteTarget(null)}
          onConfirm={deleteRecord}
        />
      )}
      {payrollModal && (
        <PayrollPeriodModal
          mode={payrollModal.type}
          initialName={payrollModal.initialName}
          period={payrollPeriod}
          rowCount={payrollRows.length}
          revisionCount={payrollRevisions.length}
          busy={savingPayrollRevision}
          onClose={() => !savingPayrollRevision && setPayrollModal(null)}
          onSubmit={payrollModal.type === 'save' ? savePayrollRevisionSnapshot : createPayrollPeriod}
        />
      )}
      {periodToDelete && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !deletingPeriod && setPeriodToDelete(null)}>
          <section className="editor-modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-period-title">
            <div className="modal-header">
              <div><div className="eyebrow">สรุปค่าแรง</div><h2 id="delete-period-title">ลบงวดนี้?</h2></div>
            </div>
            <p className="confirm-text">ต้องการลบงวด <strong>{periodToDelete.name}</strong> ({periodToDelete.revisionCount || 0} Revision · {periodToDelete.rowCount || 0} รายการ) ข้อมูลของงวดนี้จะหายไปจากระบบ และไม่แสดงในหน้านี้อีก</p>
            <div className="modal-footer"><button type="button" className="secondary-button" onClick={() => setPeriodToDelete(null)} disabled={deletingPeriod}>ยกเลิก</button><button type="button" className="danger-button" onClick={confirmDeletePayrollPeriod} disabled={deletingPeriod}>{deletingPeriod ? 'กำลังลบ...' : 'ยืนยันลบงวด'}</button></div>
          </section>
        </div>
      )}
      {profileOpen && <ProfileModal onClose={() => setProfileOpen(false)} onNotify={setToast} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function ProjectGate() {
  const { activeProjectId, loaded } = useProjects();
  // Repository paths follow the active project; the workspace re-mounts when it
  // changes so no data from the previous project can linger on screen.
  setActiveProject(activeProjectId);
  if (!loaded) return <Spinner label="กำลังโหลดโครงการ..." />;
  return <Workspace key={activeProjectId || 'none'} projectId={activeProjectId} />;
}

function AppRoutes() {
  const pathname = usePathname().replace(/\/+$/, '').toLowerCase();
  if (pathname === '/login') return <LoginPage />;
  if (pathname === '/register') return <RegisterPage />;
  if (pathname === '/pending') return <ProtectedRoute requireApproved={false}><PendingApprovalPage /></ProtectedRoute>;
  return (
    <ProtectedRoute>
      <ProjectProvider><ProjectGate /></ProjectProvider>
    </ProtectedRoute>
  );
}

function App() {
  return <AuthProvider><AppRoutes /></AuthProvider>;
}

function Overview({ totalPayroll, payrollRows, rateRows, onNavigate }) {
  const bySheet = Object.entries(sourceCatalog.payroll.tabs).map(([sheet, config]) => ({
    sheet,
    label: config.label,
    count: payrollRows.filter((row) => row.sheet === sheet).length,
    total: payrollRows.filter((row) => row.sheet === sheet).reduce((sum, row) => sum + effectiveNetTotal(row), 0),
  }));

  return (
    <div className="page-content">
      <section className="hero-section">
        <div>
          <div className="eyebrow">ระบบบริหารจัดการค่าแรง</div>
          <h1>ภาพรวมค่าแรง</h1>
          <p className="page-description">จัดการข้อมูลอัตราค่าแรงและค่าแรงรายงวดจากโครงสร้าง Excel เดิมในหน้าจอเดียว</p>
        </div>
        <div className="hero-period"><span className="calendar-icon">▣</span><div><span className="muted-label">รอบข้อมูล</span><strong>ปี 2569 · งวดตัวอย่าง</strong></div></div>
      </section>

      <section className="metric-grid">
        <MetricCard label="ยอดค่าแรงสุทธิ" value={`฿${formatCurrency(totalPayroll)}`} detail="จากข้อมูลค่าแรงรายงวด" accent="orange" />
        <MetricCard label="รายการค่าแรง" value={formatCurrency(payrollRows.length)} detail="ข้อมูลตัวอย่าง 3 ชุด" accent="blue" />
        <MetricCard label="พนักงานในทะเบียน" value={formatCurrency(rateRows.length)} detail="จากเมนูอัตราค่าแรง" accent="green" />
        <MetricCard label="โครงสร้างชีต" value="5 ชีต" detail="แบ่งตามเมนูและแท็บ" accent="purple" />
      </section>

      <div className="overview-grid">
        <section className="panel panel-large">
          <div className="panel-heading"><div><h2>สรุปค่าแรงตามชุดงาน</h2><p>ตัวเลขจะเปลี่ยนตามรายการที่บันทึกในแต่ละแท็บ</p></div><button className="text-button" onClick={() => onNavigate('payroll')}>เปิดข้อมูลค่าแรง <span>→</span></button></div>
          <div className="summary-list">
            {bySheet.map((item) => (
              <div className="summary-row" key={item.sheet}>
                <div className="summary-name"><span className="summary-icon">{item.sheet === 'DC' ? 'D' : item.sheet === 'SUPPLY' ? 'S' : 'ซ'}</span><div><strong>{item.label}</strong><span>{item.count} รายการ</span></div></div>
                <div className="summary-total">฿{formatCurrency(item.total)}</div>
                <div className="summary-bar"><span style={{ width: `${Math.min(100, Math.max(8, item.total / Math.max(totalPayroll, 1) * 100))}%` }} /></div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel quick-panel">
          <div className="panel-heading"><div><h2>เริ่มต้นใช้งาน</h2><p>จัดการข้อมูลตามโครงสร้างไฟล์ต้นแบบ</p></div></div>
          <button className="quick-action" onClick={() => onNavigate('rates')}><span className="quick-action-icon">▤</span><span><strong>ตรวจสอบอัตราค่าแรง</strong><small>ทะเบียนพนักงานและอัตรา</small></span><span className="arrow">→</span></button>
          <button className="quick-action" onClick={() => onNavigate('payroll')}><span className="quick-action-icon orange-bg">฿</span><span><strong>บันทึกค่าแรงรายงวด</strong><small>จำนวนวัน, OT และเงินหัก</small></span><span className="arrow">→</span></button>
        </section>
      </div>
    </div>
  );
}

function MetricCard({ label, value, detail, accent }) {
  return <div className={`metric-card ${accent}`}><div className="metric-icon">{accent === 'orange' ? '฿' : accent === 'blue' ? '▣' : accent === 'green' ? '♙' : '⊞'}</div><div><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-detail">{detail}</div></div></div>;
}

const formatPeriodDate = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
};

function PayrollPeriodList({ periods, currentPeriodId, openingId, onOpen, onDelete, onNew }) {
  return (
    <div className="page-content dataset-page">
      <section className="page-heading-row payroll-heading-row">
        <div><div className="eyebrow">PAYROLL PERIODS</div><h1>สรุปค่าแรง</h1><p className="page-description">เลือกงวดงานที่บันทึกไว้เพื่อเปิดดูและแก้ไขข้อมูล</p></div>
        <div className="page-heading-actions period-actions"><button className="primary-button" onClick={onNew}>＋ เปิดงวดใหม่</button></div>
      </section>
      {periods.length ? (
        <div className="period-card-grid">
          {periods.map((period) => (
            <div key={period.id} className="period-card-wrap">
            <button type="button" className="period-card-delete" onClick={() => onDelete(period)} disabled={Boolean(openingId)} aria-label={`ลบงวด ${period.name}`} title="ลบงวด">🗑</button>
            <button type="button" className={`period-card ${period.id === currentPeriodId ? 'is-current' : ''}`} onClick={() => onOpen(period)} disabled={Boolean(openingId)}>
              <span className="period-card-top"><span className="period-card-status">{period.status || PAYROLL_SAVEDRAFT_STATUS}</span>{period.id === currentPeriodId && <span className="period-card-current">งวดล่าสุดที่เปิด</span>}</span>
              <strong className="period-card-name">{period.name}</strong>
              <span className="period-card-stats">
                <span><b>{period.revisionCount || 0}</b> Revision</span>
                <span><b>{period.rowCount || 0}</b> รายการ</span>
              </span>
              <span className="period-card-footer"><span>สร้าง {formatPeriodDate(period.createdAt)}</span><span>{openingId === period.id ? 'กำลังเปิด...' : `อัปเดต ${formatPeriodDate(period.updatedAt || period.createdAt)}`}</span></span>
            </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="period-empty"><strong>ยังไม่มีงวดที่บันทึกไว้</strong><span>กด “เปิดงวดใหม่” เพื่อเริ่มบันทึกค่าแรงงวดแรก</span></div>
      )}
    </div>
  );
}

function DatasetView({ onBack, category, sheet, onSheetChange, rows, search, setSearch, onAdd, onEdit, onInlineUpdate, onDelete, onSync, onImport, period, revisionCount = 0, onSavePeriod, onOpenNewPeriod, specialPositionOptions, specialPositionColorOptions = [], positionColorOptions = [], onSpecialPositionOptionsChange, syncing, canSyncMaster }) {
  const config = sourceCatalog[category];
  const tab = config.tabs[sheet];
  const settingsKey = `${category}:${sheet}`;
  const importInputRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [clock, setClock] = useState(Date.now());
  const [columnSettingsByTable, setColumnSettingsByTable] = useState(readColumnSettings);
  const tableScrollRef = useRef(null);
  const sourceLabel = category === 'rates' ? 'แหล่งข้อมูล Master Database' : 'โครงสร้างจากไฟล์';
  const sourceName = category === 'rates' ? 'CMG-HR-Database/root/employee_data' : config.sourceFile;
  const sourceMeta = category === 'rates' ? 'กด Sync เพื่ออัปเดต' : `${period?.name || 'งวดปัจจุบัน'} · ${revisionCount} Revision`;
  const columnSettings = useMemo(() => normalizeColumnSettings(tab.columns, columnSettingsByTable[settingsKey]), [tab.columns, columnSettingsByTable, settingsKey]);
  const visibleColumns = useMemo(() => columnSettings.order
    .filter((key) => columnSettings.visible.includes(key))
    .map((key) => tab.columns.find((column) => column.key === key))
    .filter(Boolean), [columnSettings, tab.columns]);
  const filteredRows = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) return rows;
    return rows.filter((row) => Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(normalized)));
  }, [rows, search]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / TABLE_PAGE_SIZE));
  const pageRows = useMemo(() => {
    const start = (currentPage - 1) * TABLE_PAGE_SIZE;
    return filteredRows.slice(start, start + TABLE_PAGE_SIZE);
  }, [currentPage, filteredRows]);
  const pageStart = filteredRows.length ? (currentPage - 1) * TABLE_PAGE_SIZE + 1 : 0;
  const pageEnd = Math.min(currentPage * TABLE_PAGE_SIZE, filteredRows.length);
  const sourceBanner = <div className="source-banner"><span className="source-file-icon">▤</span><div><span className="source-label">{sourceLabel}</span><strong>{sourceName}</strong></div><span className="source-meta">{sourceMeta}</span></div>;

  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 60 * 1000);
    return () => window.clearInterval(interval);
  }, []);

  // Column settings live in the central repository; localStorage is only a cache.
  const columnSettingsLoaded = useRef(false);
  const columnSettingsLocal = useRef(columnSettingsByTable);
  const columnSettingsDirty = useRef(false);

  useEffect(() => {
    const unsubscribe = subscribeToColumnSettings({
      onData: (remote) => {
        if (remote) {
          // Keep unsaved local edits for the table being edited; otherwise take the shared copy.
          setColumnSettingsByTable(columnSettingsDirty.current ? { ...remote, ...columnSettingsLocal.current } : remote);
        } else if (Object.keys(columnSettingsLocal.current).length) {
          columnSettingsDirty.current = true;
        }
        columnSettingsLoaded.current = true;
        if (!remote) setColumnSettingsByTable((current) => ({ ...current }));
      },
      onError: () => { columnSettingsLoaded.current = true; },
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    columnSettingsLocal.current = columnSettingsByTable;
    try {
      window.localStorage.setItem(COLUMN_SETTINGS_STORAGE_KEY, JSON.stringify(columnSettingsByTable));
    } catch {
      // Local storage is an enhancement; the table still works for this session.
    }
    if (!columnSettingsLoaded.current || !columnSettingsDirty.current) return undefined;
    const timer = window.setTimeout(() => {
      columnSettingsDirty.current = false;
      saveColumnSettings(columnSettingsByTable).catch((error) => {
        columnSettingsDirty.current = true;
        console.error('ไม่สามารถบันทึกการตั้งค่าคอลัมน์ไปยัง Firebase', error);
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [columnSettingsByTable]);

  useEffect(() => {
    setCurrentPage(1);
  }, [sheet, search]);

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, pageCount));
  }, [pageCount]);

  useEffect(() => {
    tableScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [currentPage, sheet]);

  const updateColumnSettings = (change) => {
    columnSettingsDirty.current = true;
    setColumnSettingsByTable((current) => {
      const existing = normalizeColumnSettings(tab.columns, current[settingsKey]);
      const next = typeof change === 'function' ? change(existing) : { ...existing, ...change };
      return { ...current, [settingsKey]: normalizeColumnSettings(tab.columns, next) };
    });
  };

  const handleImportFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !onImport) return;
    setImporting(true);
    try {
      const preview = await onImport({ file, previewOnly: true });
      if (preview?.preview) setImportPreview({ file, ...preview });
    } finally {
      setImporting(false);
    }
  };

  const confirmImport = async () => {
    if (!importPreview || !onImport) return;
    setImporting(true);
    try {
      const result = await onImport({ file: importPreview.file, parsed: importPreview.parsed });
      if (result?.ok) setImportPreview(null);
    } finally {
      setImporting(false);
    }
  };

  const fileActions = category === 'rates' ? (
    <div className="dataset-file-actions">
      <button className="secondary-button" onClick={() => downloadRateWorkbook({ sheet, template: true })} title="ดาวน์โหลดหัวตารางตามไฟล์ต้นแบบ">ดาวน์โหลด Template</button>
      <button className="secondary-button" onClick={() => downloadRateWorkbook({ rows: filteredRows, sheet })} title="ส่งออกข้อมูลในแท็บนี้">Export</button>
      <button className="secondary-button" onClick={() => importInputRef.current?.click()} disabled={importing} title="Import ไฟล์เดียวแล้วกระจายข้อมูลไปแท็บ DC และ SUPPLY ตามรหัสในระบบ">{importing ? 'กำลัง Import...' : 'Import DC + SUPPLY'}</button>
      <input ref={importInputRef} className="hidden-file-input" type="file" accept=".xlsx,.xls,.csv,.tsv" onChange={handleImportFile} />
    </div>
  ) : null;

  return (
    <div className="page-content dataset-page">
      {category === 'rates' ? (
        <section className="page-heading-row source-row">{sourceBanner}<div className="dataset-actions">{fileActions}{onSync && <button className="sync-button" onClick={onSync} disabled={syncing} title={canSyncMaster ? 'ดึงข้อมูลพนักงานจาก Master Database' : 'กรุณาตั้งค่า Master Database ในไฟล์ .env'}><span>↻</span> {syncing ? 'กำลัง Sync...' : 'Sync ข้อมูล'}</button>}</div></section>
      ) : (
        <>
          <section className="page-heading-row payroll-heading-row"><div>{onBack && <button className="secondary-button period-back-button" onClick={onBack}>← งวดทั้งหมด</button>}<div className="eyebrow">PAYROLL PERIODS</div><h1>{config.label}{period?.name ? <> <span className="period-title-name">{period.name}</span></> : null}</h1><p className="page-description">{tab.description} · กด “เพิ่มรายการ” เพื่อเลือกพนักงานจากอัตราค่าแรง</p></div><div className="page-heading-actions period-actions"><div className="period-state"><span>งวดปัจจุบัน</span><strong>{period?.name || 'งวดปัจจุบัน'}</strong><small><b>Savedraft</b> · {revisionCount} Revision</small></div><button className="secondary-button add-row-button" onClick={onAdd}><span>＋</span> เพิ่มรายการ</button><button className="primary-button" onClick={onSavePeriod}>บันทึก</button></div></section>
          {sourceBanner}
        </>
      )}

      <div className="tabs" role="tablist" aria-label={`แท็บ${config.label}`}>
        {Object.entries(config.tabs).map(([tabId, item]) => <button key={tabId} role="tab" aria-selected={sheet === tabId} className={`tab-button ${sheet === tabId ? 'active' : ''}`} onClick={() => { onSheetChange(tabId); setSearch(''); }}>{item.label}<span className="tab-count">{tabId === sheet ? rows.length : '·'}</span></button>)}
      </div>

      <section className="data-panel">
        <div className="data-panel-toolbar"><div><h2>{tab.label}</h2><p>หัวตารางตรงตามชีตต้นแบบ แถวข้อมูลเริ่มที่แถว {tab.dataStartRow}</p></div><div className="toolbar-controls">{category === 'rates' && <SpecialPositionOptionsManager options={specialPositionOptions} onChange={onSpecialPositionOptionsChange} />}<ColumnSettingsManager columns={tab.columns} settings={columnSettings} onChange={updateColumnSettings} /><div className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ค้นหาพนักงานหรือข้อมูล..." /></div><button className="filter-button">≡ <span>ตัวกรอง</span></button></div></div>
        <div className="table-summary"><span>แสดง <strong>{pageStart}-{pageEnd}</strong> จาก {filteredRows.length} รายการ</span></div>
        <div ref={tableScrollRef} className="table-scroll"><DataTable columns={visibleColumns} columnWidths={columnSettings.widths} onColumnResize={(key, width) => updateColumnSettings((current) => ({ ...current, widths: { ...current.widths, [key]: width } }))} rows={pageRows} sheet={sheet} now={clock} onEdit={onEdit} onInlineUpdate={onInlineUpdate} onDelete={onDelete} specialPositionOptions={specialPositionColorOptions} positionColorOptions={positionColorOptions} /></div>
        <PaginationControls currentPage={currentPage} pageCount={pageCount} totalCount={filteredRows.length} onPageChange={setCurrentPage} />
        <div className="data-panel-footer"><span>แหล่งข้อมูล: {sourceName} / ชีต {tab.sourceSheet.trim()}</span><span>อัปเดตล่าสุด: {isFirebaseConfigured ? 'Firebase' : 'ข้อมูลตัวอย่าง'}</span></div>
      </section>
      {importPreview && <ImportSummaryModal preview={importPreview} busy={importing} onClose={() => !importing && setImportPreview(null)} onConfirm={confirmImport} />}
    </div>
  );
}

function PaginationControls({ currentPage, pageCount, totalCount, onPageChange }) {
  if (pageCount <= 1) return null;
  const goToPage = (page) => onPageChange(Math.max(1, Math.min(pageCount, page)));
  return (
    <nav className="pagination-bar" aria-label="การแบ่งหน้าตาราง">
      <span className="pagination-summary">หน้าละ {TABLE_PAGE_SIZE} รายการ · ทั้งหมด {totalCount} รายการ</span>
      <div className="pagination-controls">
        <button type="button" className="pagination-button" onClick={() => goToPage(1)} disabled={currentPage === 1} aria-label="หน้าแรก">«</button>
        <button type="button" className="pagination-button" onClick={() => goToPage(currentPage - 1)} disabled={currentPage === 1} aria-label="หน้าก่อนหน้า">‹</button>
        <span className="pagination-current">หน้า {currentPage} / {pageCount}</span>
        <button type="button" className="pagination-button" onClick={() => goToPage(currentPage + 1)} disabled={currentPage === pageCount} aria-label="หน้าถัดไป">›</button>
        <button type="button" className="pagination-button" onClick={() => goToPage(pageCount)} disabled={currentPage === pageCount} aria-label="หน้าสุดท้าย">»</button>
      </div>
    </nav>
  );
}

function ImportSummaryModal({ preview, busy, onClose, onConfirm }) {
  const renderIds = (ids, emptyLabel = 'ไม่มี') => {
    if (!ids.length) return <span className="import-summary-empty">{emptyLabel}</span>;
    const visibleIds = ids.slice(0, 80);
    return <><div className="import-summary-id-list">{visibleIds.map((id) => <span key={id}>{id}</span>)}</div>{ids.length > visibleIds.length && <small>และอีก {ids.length - visibleIds.length} รหัส</small>}</>;
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="editor-modal import-summary-modal" role="dialog" aria-modal="true" aria-labelledby="import-summary-title">
        <div className="modal-header">
          <div><div className="eyebrow">IMPORT DC + SUPPLY</div><h2 id="import-summary-title">ตรวจสอบข้อมูลก่อนนำเข้า</h2><p className="import-summary-file">ไฟล์: {preview.file.name}</p></div>
          <button className="close-button" onClick={onClose} disabled={busy}>×</button>
        </div>
        <div className="import-summary-content">
          <div className="import-summary-cards">
            <div className="import-summary-card success"><strong>{preview.updatedIds.length}</strong><span>รหัสที่อัปเดตได้</span></div>
            <div className="import-summary-card warning"><strong>{preview.notUpdatedIds.length}</strong><span>รหัสที่ไม่อัปเดต</span></div>
            <div className="import-summary-card danger"><strong>{preview.invalidIds.length}</strong><span>รหัสมีค่าผิดรูปแบบ</span></div>
            <div className="import-summary-card danger"><strong>{preview.invalidSpecialPositionIds.length}</strong><span>ตำแหน่งพิเศษไม่ตรง</span></div>
          </div>
          <p className="import-summary-note">ระบบจะอัปเดตเฉพาะคอลัมน์อัตราที่กำหนด และใช้รหัสพนักงานในระบบเป็นหลัก</p>
          {preview.invalidSpecialPositionIds.length > 0 && <div className="import-summary-section danger-section special-position-error"><h3>Import ยังไม่พร้อม: ตำแหน่งพิเศษไม่ตรงรายการ</h3><p>กรุณาปิดหน้าต่างนี้ ไปที่ปุ่ม <strong>จัดการตัวเลือก</strong> แล้วสร้างรายการให้ตรงกับ Text ในไฟล์ก่อน จากนั้นเลือกไฟล์ Import ใหม่อีกครั้ง</p><small>Text ที่ไม่พบ: {preview.invalidSpecialPositionValues.join(', ')}</small>{renderIds(preview.invalidSpecialPositionIds)}</div>}
          <div className="import-summary-section"><h3>รหัสที่อัปเดตได้</h3>{renderIds(preview.updatedIds)}</div>
          <div className="import-summary-section warning-section"><h3>รหัสที่ไม่อัปเดต / ไม่พบในระบบ</h3>{renderIds(preview.notUpdatedIds)}</div>
          {preview.invalidIds.length > 0 && <div className="import-summary-section danger-section"><h3>รหัสที่มีค่าตัวเลขผิดรูปแบบ</h3>{renderIds(preview.invalidIds)}<small>ระบบจะข้ามเฉพาะช่องตัวเลขที่ผิดรูปแบบ</small></div>}
          {preview.parsed.duplicateEmployeeIds.length > 0 && <div className="import-summary-section warning-section"><h3>รหัสซ้ำในไฟล์</h3>{renderIds(preview.parsed.duplicateEmployeeIds)}<small>ระบบใช้ข้อมูลแถวสุดท้ายของรหัสนั้น</small></div>}
        </div>
        <div className="modal-footer"><button className="secondary-button" onClick={onClose} disabled={busy}>ยกเลิก</button><button className="primary-button" onClick={onConfirm} disabled={busy || !preview.updatedIds.length || preview.invalidSpecialPositionIds.length > 0}>{busy ? 'กำลังนำเข้า...' : preview.invalidSpecialPositionIds.length > 0 ? 'ตกลง' : `ยืนยัน Import ${preview.updatedIds.length} รายการ`}</button></div>
      </section>
    </div>
  );
}

function SpecialPositionOptionsManager({ options = [], onChange }) {
  const [open, setOpen] = useState(false);
  const [newOption, setNewOption] = useState('');

  const addOption = (event) => {
    event.preventDefault();
    const value = newOption.trim();
    if (!value || options.includes(value)) return;
    onChange?.([...options, value]);
    setNewOption('');
  };

  const removeOption = (option) => {
    onChange?.(options.filter((item) => item !== option));
  };

  return (
    <div className="special-options-manager">
      <button className="special-options-button" type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <span>⚙</span> จัดการตัวเลือก <small>{options.length}</small>
      </button>
      {open && (
        <div className="special-options-popover" role="dialog" aria-label="จัดการตัวเลือกค่าตำแหน่งพิเศษ">
          <div className="special-options-title"><strong>ตัวเลือกค่าตำแหน่งพิเศษ</strong><button type="button" onClick={() => setOpen(false)} aria-label="ปิด">×</button></div>
          <p>รายการเหล่านี้จะปรากฏใน Dropdown ของทุกแถว</p>
          <div className="special-options-list">
            {options.length ? options.map((option) => { const color = colorForSpecialPosition(option, options); return <div className="special-option-item" key={option} style={{ backgroundColor: color.background, borderColor: color.border, color: color.text }}><span className="special-option-label"><i style={{ backgroundColor: color.dot }} />{option}</span><button type="button" onClick={() => removeOption(option)} aria-label={`ลบ ${option}`}>ลบ</button></div>; }) : <span className="special-options-empty">ยังไม่มีรายการ กรอกชื่อด้านล่างเพื่อเพิ่ม</span>}
          </div>
          <form className="special-options-form" onSubmit={addOption}>
            <input value={newOption} onChange={(event) => setNewOption(event.target.value)} placeholder="เช่น หัวหน้าชุด" aria-label="ชื่อตำแหน่งพิเศษใหม่" />
            <button type="submit" disabled={!newOption.trim() || options.includes(newOption.trim())}>เพิ่ม</button>
          </form>
        </div>
      )}
    </div>
  );
}

function ColumnSettingsManager({ columns, settings, onChange }) {
  const [open, setOpen] = useState(false);
  const [draggingKey, setDraggingKey] = useState('');
  const [dragOverKey, setDragOverKey] = useState('');
  const managerRef = useRef(null);
  const pointerDragRef = useRef(null);
  const columnsByKey = useMemo(() => new Map(columns.map((column) => [column.key, column])), [columns]);
  const orderedColumns = settings.order.map((key) => columnsByKey.get(key)).filter(Boolean);
  const visibleCount = settings.visible.length;

  useEffect(() => {
    if (!open) return undefined;
    const handleOutsideClick = (event) => {
      if (!managerRef.current?.contains(event.target)) setOpen(false);
    };
    const handleEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  useEffect(() => {
    const finishPointerDrag = () => {
      pointerDragRef.current = null;
      setDraggingKey('');
      setDragOverKey('');
    };
    window.addEventListener('pointerup', finishPointerDrag);
    window.addEventListener('pointercancel', finishPointerDrag);
    return () => {
      window.removeEventListener('pointerup', finishPointerDrag);
      window.removeEventListener('pointercancel', finishPointerDrag);
    };
  }, []);

  const toggleColumn = (key) => {
    const isVisible = settings.visible.includes(key);
    if (isVisible && visibleCount === 1) return;
    const visible = isVisible ? settings.visible.filter((item) => item !== key) : [...settings.visible, key];
    onChange({ visible });
  };

  const moveColumn = (sourceKey, targetKey) => {
    if (!sourceKey || sourceKey === targetKey) return;
    const nextOrder = [...settings.order];
    const sourceIndex = nextOrder.indexOf(sourceKey);
    const targetIndex = nextOrder.indexOf(targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    nextOrder.splice(sourceIndex, 1);
    nextOrder.splice(nextOrder.indexOf(targetKey), 0, sourceKey);
    onChange({ order: nextOrder });
  };

  const startPointerDrag = (event, key) => {
    if (event.button !== 0 || event.target.closest('input, button')) return;
    pointerDragRef.current = key;
    setDraggingKey(key);
  };

  const finishPointerDrag = (key) => {
    if (!pointerDragRef.current) return;
    moveColumn(pointerDragRef.current, key);
    pointerDragRef.current = null;
    setDraggingKey('');
    setDragOverKey('');
  };

  return (
    <div className="column-settings-manager" ref={managerRef}>
      <button className="column-settings-button" type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-haspopup="dialog">
        <span>☷</span> คอลัมน์ <small>{visibleCount}/{columns.length}</small>
      </button>
      {open && (
        <div className="column-settings-popover" role="dialog" aria-label="จัดการคอลัมน์ตาราง">
          <div className="column-settings-title"><div><strong>จัดการคอลัมน์</strong><span>ลากเพื่อเรียงลำดับ · ติ๊กเพื่อซ่อน/แสดง</span></div><button type="button" onClick={() => setOpen(false)} aria-label="ปิด">×</button></div>
          <div className="column-settings-list">
            {orderedColumns.map((column) => {
              const checked = settings.visible.includes(column.key);
              const onlyVisible = checked && visibleCount === 1;
              return (
                <div
                  className={`column-settings-item ${draggingKey === column.key ? 'is-dragging' : ''} ${dragOverKey === column.key ? 'is-drag-over' : ''}`}
                  key={column.key}
                  draggable={false}
                  onPointerDown={(event) => startPointerDrag(event, column.key)}
                  onPointerEnter={() => { if (pointerDragRef.current) setDragOverKey(column.key); }}
                  onPointerUp={() => finishPointerDrag(column.key)}
                  onDragStart={(event) => {
                    setDraggingKey(column.key);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', column.key);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDragOverKey(column.key);
                  }}
                  onDragLeave={() => setDragOverKey('')}
                  onDrop={(event) => {
                    event.preventDefault();
                    moveColumn(event.dataTransfer.getData('text/plain') || draggingKey, column.key);
                    setDraggingKey('');
                    setDragOverKey('');
                  }}
                  onDragEnd={() => {
                    setDraggingKey('');
                    setDragOverKey('');
                  }}
                >
                  <span className="column-drag-handle" aria-hidden="true">⠿</span>
                  <label className="column-checkbox"><input type="checkbox" checked={checked} disabled={onlyVisible} onChange={() => toggleColumn(column.key)} /><span>{column.label}</span></label>
                  {onlyVisible && <small>ต้องแสดง 1 คอลัมน์</small>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const sameOptionList = (previous = EMPTY_LIST, next = EMPTY_LIST) => previous === next
  || (previous.length === 0 && next.length === 0);

const DEDUCT_COLUMN_KEYS = ['wageDrop', 'deduction', 'socialSecurity'];
const INCOME_COLUMN_KEYS = ['dailyRate', 'travelRate', 'positionAllowance', 'phoneAllowance', 'overtimeRate15', 'contractWork'];
const columnSignClass = (key) => (DEDUCT_COLUMN_KEYS.includes(key) ? 'col-deduct' : INCOME_COLUMN_KEYS.includes(key) ? 'col-income' : '');

const DataTableRow = memo(function DataTableRow({ sheet, columns, row, now, onEdit, onInlineUpdate, onDelete, specialPositionOptions, positionColorOptions }) {
  return <tr onDoubleClick={(event) => { if (event.target.closest('button, input, select, textarea')) return; onEdit(row); }}>{columns.map((column) => {
    const nameChanged = isNameRecentlyChanged(row, column.key, now);
    const displayValue = column.key === 'travelAmount' ? effectiveTravelAmount(row) : column.key === 'netTotal' ? effectiveNetTotal(row) : row[column.key];
    return <td key={column.key} title={nameChanged ? 'ชื่อถูกเปลี่ยนจาก Master Database ภายใน 24 ชั่วโมงที่ผ่านมา' : undefined} className={[columnSignClass(column.key), column.key === 'netTotal' ? 'align-right' : '', !column.editable && column.editable !== undefined ? 'calculated-cell' : '', column.key === 'firstName' || column.key === 'lastName' ? 'name-cell' : '', nameChanged ? 'name-changed-cell' : '', column.type === 'special-position' ? 'special-position-cell' : '', column.key === 'position' ? 'position-cell' : ''].filter(Boolean).join(' ')}>{column.type === 'special-position' ? <SpecialPositionCell row={row} column={column} options={specialPositionOptions} onChange={(changes) => onInlineUpdate?.(row, changes)} /> : column.key === 'position' ? <PositionBadge value={row[column.key]} options={positionColorOptions} /> : column.key === 'employeeId' ? <strong className="employee-code">{formatCell(displayValue, column.type)}</strong> : column.key === 'netTotal' || column.key === 'dailyRateYear69' ? <strong>{formatCell(displayValue, column.type)}</strong> : formatCell(displayValue, column.type)}</td>;
  })}<td className="action-cell"><button className="row-edit-button" onClick={() => onEdit(row)}>แก้ไข</button>{onDelete && <button className="row-delete-button" onClick={() => onDelete(row)}>ลบ</button>}</td></tr>;
}, (previous, next) => previous.sheet === next.sheet
  && previous.columns === next.columns
  && previous.row === next.row
  && previous.now === next.now
  && sameOptionList(previous.specialPositionOptions, next.specialPositionOptions)
  && sameOptionList(previous.positionColorOptions, next.positionColorOptions)
  && Boolean(previous.onDelete) === Boolean(next.onDelete));

const DataTable = memo(function DataTable({ sheet, columns, columnWidths = {}, onColumnResize, rows, now = Date.now(), onEdit, onInlineUpdate, onDelete, specialPositionOptions = EMPTY_LIST, positionColorOptions = EMPTY_LIST }) {
  const resizeRef = useRef(null);
  const [resizePreview, setResizePreview] = useState(null);
  const [selectedKeys, setSelectedKeys] = useState([]);
  const tableWidth = columns.reduce((total, column) => total + (Number(columnWidths[column.key]) || 120), 88);

  useEffect(() => {
    const handleMouseMove = (event) => {
      const current = resizeRef.current;
      if (!current) return;
      const delta = event.clientX - current.startX;
      const width = Math.max(MIN_COLUMN_WIDTH, Math.min(420, current.startWidth + delta));
      current.width = width;
      current.delta = delta;
      setResizePreview({ key: current.key, left: current.startLeft + width - current.startWidth, width });
    };
    const handleMouseUp = () => {
      const current = resizeRef.current;
      if (!current) return;
      const finalWidth = current.width ?? current.startWidth;
      (current.keys || [current.key]).forEach((key) => onColumnResize?.(key, finalWidth));
      resizeRef.current = null;
      setResizePreview(null);
      document.body.classList.remove('is-resizing-column');
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [onColumnResize]);

  const toggleSelected = (key) => setSelectedKeys((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));

  const startResize = (event, column) => {
    event.preventDefault();
    event.stopPropagation();
    const table = event.currentTarget.closest('table');
    const header = event.currentTarget.closest('th');
    const tableRect = table?.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    const startWidth = Number(columnWidths[column.key]) || 120;
    const startLeft = tableRect && headerRect ? headerRect.right - tableRect.left : startWidth;
    const keys = selectedKeys.includes(column.key) ? selectedKeys : [column.key];
    const startWidths = Object.fromEntries(keys.map((key) => [key, Number(columnWidths[key]) || 120]));
    resizeRef.current = { key: column.key, keys, startWidths, startX: event.clientX, startWidth, startLeft, width: startWidth, delta: 0 };
    setResizePreview({ key: column.key, left: startLeft, width: startWidth });
    document.body.classList.add('is-resizing-column');
  };

  return (
    <div className="data-table-stage">
      {resizePreview && <span className="column-resize-preview" style={{ left: `${resizePreview.left}px` }} aria-hidden="true" />}
      <table className="data-table" style={{ width: `${tableWidth}px` }}>
        <colgroup>
          {columns.map((column) => <col key={column.key} style={{ width: `${columnWidths[column.key] || 120}px` }} />)}
          <col className="action-column" style={{ width: '88px' }} />
        </colgroup>
        <thead><tr>{columns.map((column) => <th key={column.key} onClick={() => toggleSelected(column.key)} title="คลิกเพื่อเลือกหลายคอลัมน์ แล้วลากขอบเพื่อปรับพร้อมกัน" className={[columnSignClass(column.key), column.key === 'netTotal' ? 'align-right' : '', selectedKeys.includes(column.key) ? 'selected-header' : '', !column.editable && column.editable !== undefined ? 'calculated-header' : '', column.type === 'special-position' ? 'special-position-header' : ''].filter(Boolean).join(' ')}><span className="column-header-label">{column.label}</span><span className="column-resizer" role="separator" aria-label={`ปรับความกว้างคอลัมน์ ${column.label}`} onClick={(event) => event.stopPropagation()} onMouseDown={(event) => startResize(event, column)} /></th>)}<th className="action-header">จัดการ</th></tr></thead>
        <tbody>{rows.length ? rows.map((row) => <DataTableRow key={row.id || `${sheet}-${row.sequence}-${row.employeeId}`} sheet={sheet} columns={columns} row={row} now={now} onEdit={onEdit} onInlineUpdate={onInlineUpdate} onDelete={onDelete} specialPositionOptions={specialPositionOptions} positionColorOptions={positionColorOptions} />) : <tr><td colSpan={columns.length + 1} className="empty-state"><span className="empty-icon">⌁</span><strong>ยังไม่มีข้อมูลในแท็บนี้</strong><span>กด “เพิ่มรายการ” เพื่อเริ่มบันทึกข้อมูล</span></td></tr>}</tbody>
      </table>
    </div>
  );
}, (previous, next) => previous.sheet === next.sheet
  && previous.columns === next.columns
  && previous.columnWidths === next.columnWidths
  && previous.rows === next.rows
  && previous.now === next.now
  && sameOptionList(previous.specialPositionOptions, next.specialPositionOptions)
  && sameOptionList(previous.positionColorOptions, next.positionColorOptions)
  && Boolean(previous.onDelete) === Boolean(next.onDelete));

function PositionBadge({ value, options }) {
  const label = formatCell(value, 'text');
  if (label === '-') return label;
  const color = colorForSpecialPosition(String(value || '').trim(), options);
  return <span className="position-badge" style={{ backgroundColor: color.background, borderColor: color.border, color: color.text }}><i style={{ backgroundColor: color.dot }} /><span className="position-badge-label">{label}</span></span>;
}

function SpecialPositionPicker({ value = '', options = [], onChange, ariaLabel = 'เลือกค่าตำแหน่งพิเศษ' }) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef(null);
  const availableOptions = [...new Set(['', ...(options || [])])];
  const selectedColor = colorForSpecialPosition(value, availableOptions);

  useEffect(() => {
    if (!open) return undefined;
    const handleOutsideClick = (event) => {
      if (!pickerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  return (
    <div className="special-position-picker" ref={pickerRef} onDoubleClick={(event) => event.stopPropagation()}>
      <button type="button" className="special-position-picker-button" style={{ backgroundColor: selectedColor.background, borderColor: selectedColor.border, color: selectedColor.text }} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); setOpen((current) => !current); }} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}>
        <span className="special-option-label"><i style={{ backgroundColor: selectedColor.dot }} />{value || 'ไม่ระบุ'}</span><span className="special-position-picker-arrow">▾</span>
      </button>
      {open && <div className="special-position-picker-menu" role="listbox" aria-label={ariaLabel}>
        {availableOptions.map((option) => { const color = colorForSpecialPosition(option, availableOptions); return <button type="button" role="option" aria-selected={value === option} className="special-position-picker-option" key={option || '__empty'} style={{ backgroundColor: color.background, borderColor: color.border, color: color.text }} onMouseDown={(event) => event.stopPropagation()} onClick={() => { onChange(option); setOpen(false); }}><span className="special-option-label"><i style={{ backgroundColor: color.dot }} />{option || 'ไม่ระบุ'}</span>{value === option && <span className="special-position-picker-check">✓</span>}</button>; })}
      </div>}
    </div>
  );
}

function SpecialPositionCell({ row, column, options, onChange }) {
  const [selected, setSelected] = useState(row[column.key] || '');
  const [amount, setAmount] = useState(row[column.key] ? (row[column.amountKey] ?? '') : 0);

  useEffect(() => {
    setSelected(row[column.key] || '');
    setAmount(row[column.key] ? (row[column.amountKey] ?? '') : 0);
  }, [row.id, row[column.key], row[column.amountKey], column.amountKey, column.key]);

  const availableOptions = [...new Set([...(options || []), selected].filter(Boolean))];
  const commitAmount = () => {
    if (!selected) {
      setAmount(0);
      onChange({ [column.key]: '', [column.amountKey]: 0 });
      return;
    }
    const nextAmount = amount === '' ? '' : Number(amount);
    if (amount !== '' && !Number.isFinite(nextAmount)) return;
    onChange({ [column.key]: selected, [column.amountKey]: nextAmount });
  };

  return <div className="special-position-editor" onDoubleClick={(event) => event.stopPropagation()}><SpecialPositionPicker value={selected} options={availableOptions} onChange={(value) => { setSelected(value); if (!value) { setAmount(0); onChange({ [column.key]: '', [column.amountKey]: 0 }); } else { onChange({ [column.key]: value }); } }} /><div className="special-amount-input"><span>฿</span><input type="number" min="0" step="0.01" value={selected ? amount : 0} disabled={!selected} onChange={(event) => setAmount(event.target.value)} onBlur={commitAmount} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} placeholder="จำนวนเงิน" aria-label="ค่าแรงตำแหน่งพิเศษ" /></div></div>;
}

function AddPayrollRowsPage({ sheet, period, rates, existingEmployeeIds, onBack, onAdd }) {
  const [mode, setMode] = useState('single');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());

  const available = useMemo(() => rates.filter((rate) => !existingEmployeeIds.has(normalizeEmployeeKey(rate.employeeId))), [rates, existingEmployeeIds]);
  const teams = useMemo(() => {
    const groups = new Map();
    available.forEach((rate) => {
      const name = String(rate.teamName || '').trim();
      if (!name) return;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(rate);
    });
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'th')).map(([name, members]) => ({ name, members }));
  }, [available]);
  const keyword = search.trim().toLowerCase();
  const visibleRates = useMemo(() => available.filter((rate) => !keyword
    || [rate.employeeId, rate.firstName, rate.lastName, rate.teamName, rate.position].some((value) => String(value ?? '').toLowerCase().includes(keyword))), [available, keyword]);
  const visibleTeams = useMemo(() => teams.filter((team) => !keyword
    || team.name.toLowerCase().includes(keyword)
    || team.members.some((rate) => [rate.employeeId, rate.firstName, rate.lastName].some((value) => String(value ?? '').toLowerCase().includes(keyword)))), [teams, keyword]);
  const selectedRates = useMemo(() => available.filter((rate) => selected.has(rate.id)), [available, selected]);
  const selectedTeams = useMemo(() => new Set(selectedRates.map((rate) => String(rate.teamName || '').trim()).filter(Boolean)).size, [selectedRates]);

  const setMany = (rows, checked) => setSelected((current) => {
    const next = new Set(current);
    rows.forEach((rate) => (checked ? next.add(rate.id) : next.delete(rate.id)));
    return next;
  });
  const allVisibleSelected = mode === 'single'
    ? visibleRates.length > 0 && visibleRates.every((rate) => selected.has(rate.id))
    : visibleTeams.length > 0 && visibleTeams.every((team) => team.members.every((rate) => selected.has(rate.id)));
  const toggleAllVisible = () => setMany(mode === 'single' ? visibleRates : visibleTeams.flatMap((team) => team.members), !allVisibleSelected);

  return (
    <div className="page-content dataset-page add-rows-page">
      <section className="page-heading-row payroll-heading-row">
        <div className="add-rows-heading">
          <button type="button" className="secondary-button" onClick={onBack}>← กลับตารางค่าแรง</button>
          <div><div className="eyebrow">ADD TO {sheet}</div><h1>เพิ่มรายการพนักงาน</h1><p className="page-description">งวด {period?.name || 'ปัจจุบัน'} · แท็บ {sheet} · เลือกจากตารางอัตราค่าแรง เหลือให้เลือก {available.length} คน</p></div>
        </div>
      </section>

      <section className="panel add-rows-panel">
        <div className="add-rows-toolbar">
          <div className="add-mode-switch" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'single'} className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}>เพิ่มรายคน</button>
            <button type="button" role="tab" aria-selected={mode === 'team'} className={mode === 'team' ? 'active' : ''} onClick={() => setMode('team')}>เพิ่มเป็นชุด</button>
          </div>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={mode === 'single' ? 'ค้นหารหัส ชื่อ ตำแหน่ง หรือชื่อชุด' : 'ค้นหาชื่อชุด หรือชื่อสมาชิก'} />
        </div>

        {mode === 'team' && !teams.length ? (
          <div className="add-empty">{available.length ? 'ยังไม่มีข้อมูลชื่อชุด · ไปที่หน้าอัตราค่าแรงแล้วกด Sync เพื่อดึงชื่อชุดจาก Master Database' : 'เพิ่มพนักงานครบทุกคนแล้ว'}</div>
        ) : (
          <div className="add-rows-table" role="listbox" aria-multiselectable="true">
            {mode === 'single' ? (
              <>
                <label className="add-rows-row add-rows-head">
                  <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} disabled={!visibleRates.length} />
                  <span>รหัส</span><span>ชื่อ - นามสกุล</span><span>ชื่อชุด</span><span>ตำแหน่ง</span>
                </label>
                <div className="add-rows-scroll">
                  {visibleRates.map((rate) => (
                    <label key={rate.id} role="option" aria-selected={selected.has(rate.id)} className={`add-rows-row ${selected.has(rate.id) ? 'selected' : ''}`}>
                      <input type="checkbox" checked={selected.has(rate.id)} onChange={(event) => setMany([rate], event.target.checked)} />
                      <strong>{rate.employeeId}</strong>
                      <span>{[rate.firstName, rate.lastName].filter(Boolean).join(' ') || '-'}</span>
                      <span>{rate.teamName || '-'}</span>
                      <span>{rate.position || '-'}</span>
                    </label>
                  ))}
                  {!visibleRates.length && <div className="add-empty">{available.length ? 'ไม่พบรายชื่อที่ค้นหา' : 'เพิ่มพนักงานครบทุกคนแล้ว'}</div>}
                </div>
              </>
            ) : (
              <>
                <label className="add-rows-row add-team-row add-rows-head">
                  <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} disabled={!visibleTeams.length} />
                  <span>ชื่อชุด</span><span>จำนวนคน</span><span>สมาชิก</span>
                </label>
                <div className="add-rows-scroll">
                  {visibleTeams.map((team) => {
                    const count = team.members.filter((rate) => selected.has(rate.id)).length;
                    const checked = count === team.members.length;
                    return (
                      <label key={team.name} role="option" aria-selected={checked} className={`add-rows-row add-team-row ${count ? 'selected' : ''}`}>
                        <input type="checkbox" checked={checked} ref={(node) => { if (node) node.indeterminate = count > 0 && !checked; }} onChange={(event) => setMany(team.members, event.target.checked)} />
                        <strong>{team.name}</strong>
                        <span>{team.members.length} คน</span>
                        <span className="add-team-members">{team.members.slice(0, 4).map((rate) => [rate.firstName, rate.lastName].filter(Boolean).join(' ') || rate.employeeId).join(', ')}{team.members.length > 4 ? ` และอีก ${team.members.length - 4} คน` : ''}</span>
                      </label>
                    );
                  })}
                  {!visibleTeams.length && <div className="add-empty">ไม่พบชุดที่ค้นหา</div>}
                </div>
              </>
            )}
          </div>
        )}

        <div className="add-rows-footer">
          <div className="add-rows-summary"><strong>เลือกแล้ว {selectedRates.length} คน</strong><span>{selectedTeams ? `จาก ${selectedTeams} ชุด` : 'ยังไม่ได้เลือก'} · เหลือให้เลือก {available.length} คน</span></div>
          <button type="button" className="secondary-button" onClick={() => setSelected(new Set())} disabled={!selectedRates.length}>ล้างที่เลือก</button>
          <button type="button" className="secondary-button" onClick={onBack}>ยกเลิก</button>
          <button type="button" className="primary-button" onClick={() => onAdd(selectedRates)} disabled={!selectedRates.length}>{selectedRates.length ? `เพิ่ม ${selectedRates.length} คน` : 'เพิ่มรายการ'}</button>
        </div>
      </section>
    </div>
  );
}

function PayrollPeriodModal({ mode, initialName, period, rowCount, revisionCount, busy, onClose, onSubmit }) {
  const [name, setName] = useState(initialName || '');
  const isSaveMode = mode === 'save';

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    onSubmit(name.trim());
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="editor-modal period-modal" role="dialog" aria-modal="true" aria-labelledby="payroll-period-modal-title">
        <div className="modal-header">
          <div>
            <div className="eyebrow">{isSaveMode ? 'SAVE PAYROLL PERIOD' : 'NEW PAYROLL PERIOD'}</div>
            <h2 id="payroll-period-modal-title">{isSaveMode ? 'ตั้งชื่อ Revision' : 'เปิดงวดใหม่'}</h2>
            <p className="period-modal-subtitle">{isSaveMode ? `งวด ${period?.name || 'ปัจจุบัน'} · ${rowCount} รายการ · เก็บข้อมูลทั้ง 3 แท็บ` : 'เริ่มงวดด้วยตารางว่าง แล้วกด “เพิ่มรายการ” เพื่อเลือกพนักงานทีละคนหรือทีละทีม'}</p>
          </div>
          <button className="close-button" onClick={onClose} disabled={busy}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="period-modal-content">
            <label className="period-name-field">
              <span>{isSaveMode ? 'ชื่อ Revision' : 'ชื่องวดใหม่'}</span>
              <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={isSaveMode ? 'เช่น ตรวจสอบรอบแรก' : 'เช่น งวดวันที่ 1–15 พ.ย. 2569'} maxLength={120} />
            </label>
            <div className="period-modal-info"><span>สถานะหลังบันทึก</span><strong>Savedraft</strong>{isSaveMode && <small>Revision เดิมจะยังคงอยู่ครบ · งวดนี้มี {revisionCount} Revision ก่อนหน้า</small>}</div>
          </div>
          <div className="modal-footer"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>ยกเลิก</button><button type="submit" className="primary-button" disabled={busy || !name.trim()}>{busy ? 'กำลังบันทึก...' : isSaveMode ? 'บันทึก Revision' : 'เปิดงวดใหม่'}</button></div>
        </form>
      </section>
    </div>
  );
}

function ConfirmDelete({ row, category, onClose, onConfirm }) {
  const isPayroll = category === 'payroll';
  const [deleting, setDeleting] = useState(false);
  const name = [row.firstName, row.lastName].filter(Boolean).join(' ');

  const handleConfirm = async () => {
    setDeleting(true);
    try {
      await onConfirm();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !deleting && onClose()}>
      <section className="editor-modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="modal-header">
          <div><div className="eyebrow">{isPayroll ? 'สรุปค่าแรง' : 'อัตราค่าแรง'}</div><h2 id="confirm-title">ลบรายการนี้?</h2></div>
        </div>
        <p className="confirm-text">ต้องการลบ <strong>{[row.employeeId, name].filter(Boolean).join(' · ') || 'รายการนี้'}</strong> ออกจากตาราง{isPayroll ? 'ค่าแรงรายงวด (ไม่กระทบตารางอัตราค่าแรง) การลบจะมีผลเมื่อบันทึก Revision' : 'อัตราค่าแรง การลบไม่สามารถกู้คืนได้'}</p>
        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose} disabled={deleting}>ยกเลิก</button>
          <button className="danger-button" onClick={handleConfirm} disabled={deleting}>{deleting ? 'กำลังลบ...' : 'ลบรายการ'}</button>
        </div>
      </section>
    </div>
  );
}

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function RecordEditor({ category, sheet, record, liveRecord, onClose, onSave, specialPositionOptions = [] }) {
  // `base` is the version the form was opened from. Realtime updates from other
  // people never touch `draft`, so nobody loses what they are typing.
  const [base, setBase] = useState(record);
  const [draft, setDraft] = useState(record);
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [mergeNotice, setMergeNotice] = useState('');
  const savingRef = useRef(false);
  const columns = sourceCatalog[category].tabs[sheet].columns.filter((column) => column.editable !== false && column.key !== 'sequence');
  const isNew = !record.id;
  const labelOf = (key) => sourceCatalog[category].tabs[sheet].columns.find((column) => column.key === key || column.amountKey === key)?.label || key;
  const changedByOthers = Boolean(liveRecord && String(liveRecord.updatedAt || '') !== String(base.updatedAt || ''));

  const update = (key, value, type) => setDraft((current) => ({ ...current, [key]: type === 'number' || type === 'currency' ? (value === '' ? '' : Number(value)) : value }));
  const updateSpecialPosition = (column, value) => setDraft((current) => ({
    ...current,
    [column.key]: value,
    [column.amountKey]: value ? (current[column.amountKey] ?? 0) : 0,
  }));

  // Takes the latest saved values for every field the user did not edit and
  // keeps the user's own edits on top.
  const mergeLatest = (latest) => {
    const mine = Object.keys(draft).filter((key) => key !== 'attachments' && !sameValue(draft[key], base[key]));
    const clashing = mine.filter((key) => !sameValue(latest[key], base[key]) && !sameValue(latest[key], draft[key]));
    setDraft({ ...latest, ...Object.fromEntries(mine.map((key) => [key, draft[key]])) });
    setBase(latest);
    setMergeNotice(clashing.length
      ? `มีผู้อื่นแก้ไขรายการนี้แล้ว รวมข้อมูลล่าสุดให้แล้ว (ฟิลด์ที่ชนกัน ใช้ค่าของคุณ: ${clashing.map(labelOf).join(', ')}) ตรวจสอบแล้วกดบันทึกอีกครั้ง`
      : 'มีผู้อื่นแก้ไขรายการนี้แล้ว รวมข้อมูลล่าสุดให้แล้ว ตรวจสอบแล้วกดบันทึกอีกครั้ง');
  };

  const handleSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await onSave(draft, files, { baseUpdatedAt: base.updatedAt });
      if (result?.conflict) mergeLatest(result.conflict);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const specialPositionChoices = [...new Set([...(specialPositionOptions || []), draft.specialPosition].filter(Boolean))];

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <section className="editor-modal" role="dialog" aria-modal="true" aria-labelledby="editor-title">
        <div className="modal-header">
          <div><div className="eyebrow">{sourceCatalog[category].label} / {sheet}</div><h2 id="editor-title">{isNew ? 'เพิ่มรายการใหม่' : 'แก้ไขรายการ'}</h2></div>
          <button className="close-button" onClick={onClose} disabled={saving}>×</button>
        </div>
        {(mergeNotice || changedByOthers) && (
          <div className="editor-conflict-banner" role="status">
            <span>{mergeNotice || 'มีผู้อื่นเพิ่งแก้ไขรายการนี้ ข้อมูลที่คุณกรอกยังอยู่ครบ'}</span>
            {changedByOthers && <button type="button" className="secondary-button" onClick={() => { mergeLatest(liveRecord); }}>รวมข้อมูลล่าสุด</button>}
          </div>
        )}
        <div className="editor-grid">
          {columns.map((column) => column.type === 'special-position' ? (
            <label key={column.key} className="full-field special-position-form-field">
              <span>{column.label}</span>
              <div className="special-position-form">
                <SpecialPositionPicker value={draft[column.key] ?? ''} options={specialPositionChoices} onChange={(value) => updateSpecialPosition(column, value)} />
                <div className="special-position-amount-field"><span>จำนวนเงิน / ค่าแรง</span><input type="number" min="0" step="0.01" value={draft[column.key] ? (draft[column.amountKey] ?? 0) : 0} disabled={!draft[column.key]} onChange={(event) => update(column.amountKey, event.target.value, 'currency')} placeholder="กรอกจำนวนเงิน" /></div>
              </div>
            </label>
          ) : (
            <label key={column.key} className={column.key === 'note' ? 'full-field' : ''}>
              <span>{column.label}</span>
              <input type={column.type === 'number' || column.type === 'currency' ? 'number' : 'text'} value={draft[column.key] ?? ''} onChange={(event) => update(column.key, event.target.value, column.type)} placeholder={`กรอก${column.label}`} />
            </label>
          ))}
          <label className="full-field file-field"><span>ไฟล์แนบ</span><input type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files || []))} /><small>ไฟล์ใหม่จะถูกอัปโหลดไป Firebase Storage เมื่อกดบันทึก</small>{draft.attachments?.length > 0 && <div className="attachment-list">{draft.attachments.map((attachment) => <a key={attachment.path || attachment.url || attachment.name} href={attachment.url || '#'} target="_blank" rel="noreferrer">{attachment.name}</a>)}</div>}{files.length > 0 && <small>เลือกไฟล์ใหม่แล้ว {files.length} ไฟล์</small>}</label>
        </div>
        <div className="modal-footer"><button className="secondary-button" onClick={onClose} disabled={saving}>ยกเลิก</button><button className="primary-button" onClick={handleSave} disabled={saving}>{saving ? 'กำลังบันทึก...' : 'บันทึกข้อมูล'}</button></div>
      </section>
    </div>
  );
}

export default App;
