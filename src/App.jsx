import { useEffect, useMemo, useState } from 'react';
import { formatCell, formatCurrency, menuItems, sourceCatalog } from './data/schema';
import { isFirebaseConfigured, isMasterDatabaseConfigured } from './lib/firebase';
import { saveDatasetRecord, subscribeToDataset, syncMasterEmployees } from './lib/repository';
import './styles.css';

const emptyDataset = { payroll: {}, rates: {} };

const iconForMenu = {
  overview: '⌂',
  payroll: '฿',
  rates: '▤',
};

const createBlankRecord = (category, sheet) => {
  const record = { sheet };
  sourceCatalog[category].tabs[sheet].columns.forEach((column) => {
    if (column.key === 'sequence') return;
    record[column.key] = column.type === 'number' || column.type === 'currency' ? 0 : '';
  });
  return record;
};

function App() {
  const [activeMenu, setActiveMenu] = useState('overview');
  const [activeTabs, setActiveTabs] = useState({ payroll: 'DC', rates: 'DC' });
  const [datasets, setDatasets] = useState(emptyDataset);
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState(null);
  const [toast, setToast] = useState('');
  const [firebaseError, setFirebaseError] = useState('');
  const [syncingRates, setSyncingRates] = useState(false);

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
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const payrollRows = Object.values(datasets.payroll).flat();
  const rateRows = Object.values(datasets.rates).flat();
  const totalPayroll = payrollRows.reduce((sum, row) => sum + Number(row.netTotal || 0), 0);
  const activeMenuItem = menuItems.find((item) => item.id === activeMenu) || menuItems[0];

  const selectMenu = (menu) => {
    setActiveMenu(menu);
    setSearch('');
  };

  const openEditor = (category, sheet, row = null) => {
    setEditor({ category, sheet, row: row ? { ...row } : createBlankRecord(category, sheet) });
  };

  const saveRecord = async (record, files = []) => {
    const { category, sheet } = editor;
    try {
      const saved = await saveDatasetRecord({ category, sheet, record, files });
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
      console.error('ไม่สามารถบันทึกข้อมูลลง Firebase', error);
      setToast(error?.code === 'permission-denied'
        ? 'บันทึกไม่สำเร็จ: Firebase ปฏิเสธสิทธิ์'
        : 'บันทึกไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อ');
      return false;
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

  const connectionLabel = firebaseError || (isFirebaseConfigured ? 'Firebase พร้อมใช้งาน' : 'โหมดตัวอย่าง');

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">CMG</div>
          <div>
            <div className="brand-name">CMG Payroll</div>
            <div className="brand-subtitle">จัดการค่าแรง</div>
          </div>
        </div>

        <div className="nav-label">เมนูหลัก</div>
        <nav className="main-nav" aria-label="เมนูหลัก">
          {menuItems.map((item) => (
            <button key={item.id} className={`nav-item ${activeMenu === item.id ? 'active' : ''}`} onClick={() => selectMenu(item.id)}>
              <span className="nav-icon">{iconForMenu[item.id]}</span>
              <span>{item.label}</span>
              {item.id !== 'overview' && <span className="nav-count">{Object.keys(sourceCatalog[item.id].tabs).length}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="source-mini-card">
            <div className="source-mini-title">แหล่งข้อมูล</div>
            <div className="source-mini-row"><span className={`status-dot ${firebaseError ? 'error' : ''}`} />{firebaseError ? 'ตรวจสอบ Firebase' : isFirebaseConfigured ? 'เชื่อมต่อ Firebase' : 'โหมดตัวอย่าง'}</div>
            <div className="source-mini-note">ข้อมูลอ้างอิงจากไฟล์ Excel ปี 2569</div>
          </div>
          <div className="user-profile">
            <div className="avatar">A</div>
            <div>
              <div className="user-name">ผู้ดูแลระบบ</div>
              <div className="user-role">Payroll Admin</div>
            </div>
            <span className="more-icon">•••</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb"><span>CMG Payroll</span><span className="breadcrumb-separator">/</span><strong>{activeMenuItem.label}</strong></div>
          <div className="topbar-actions">
            <span className={`connection-pill ${isFirebaseConfigured ? 'connected' : ''} ${firebaseError ? 'error' : ''}`}><span className="status-dot" />{connectionLabel}</span>
            <button className="icon-button" aria-label="การแจ้งเตือน">♢<span className="notification-dot" /></button>
            <div className="top-avatar">A</div>
          </div>
        </header>

        {activeMenu === 'overview' ? (
          <Overview totalPayroll={totalPayroll} payrollRows={payrollRows} rateRows={rateRows} onNavigate={selectMenu} />
        ) : (
          <DatasetView
            category={activeMenu}
            sheet={activeTabs[activeMenu]}
            onSheetChange={(sheet) => setActiveTabs((tabs) => ({ ...tabs, [activeMenu]: sheet }))}
            rows={datasets[activeMenu][activeTabs[activeMenu]] || []}
            search={search}
            setSearch={setSearch}
            onAdd={() => openEditor(activeMenu, activeTabs[activeMenu])}
            onEdit={(row) => openEditor(activeMenu, activeTabs[activeMenu], row)}
            onSync={activeMenu === 'rates' ? syncRates : undefined}
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
          onClose={() => setEditor(null)}
          onSave={saveRecord}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Overview({ totalPayroll, payrollRows, rateRows, onNavigate }) {
  const bySheet = Object.entries(sourceCatalog.payroll.tabs).map(([sheet, config]) => ({
    sheet,
    label: config.label,
    count: payrollRows.filter((row) => row.sheet === sheet).length,
    total: payrollRows.filter((row) => row.sheet === sheet).reduce((sum, row) => sum + Number(row.netTotal || 0), 0),
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

function DatasetView({ category, sheet, onSheetChange, rows, search, setSearch, onAdd, onEdit, onSync, syncing, canSyncMaster }) {
  const config = sourceCatalog[category];
  const tab = config.tabs[sheet];
  const sourceLabel = category === 'rates' ? 'แหล่งข้อมูล Master Database' : 'โครงสร้างจากไฟล์';
  const sourceName = category === 'rates' ? 'CMG-HR-Database/root/employee_data' : config.sourceFile;
  const sourceMeta = category === 'rates' ? 'กด Sync เพื่ออัปเดต' : `${Object.keys(config.tabs).length} แท็บ · ปี 2569`;
  const filteredRows = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) return rows;
    return rows.filter((row) => Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(normalized)));
  }, [rows, search]);

  return (
    <div className="page-content dataset-page">
      <section className="page-heading-row"><div><div className="eyebrow">{category === 'payroll' ? 'PAYROLL PERIODS' : 'EMPLOYEE RATE MASTER'}</div><h1>{config.label}</h1><p className="page-description">{tab.description}</p></div><div className="page-heading-actions">{onSync && <button className="sync-button" onClick={onSync} disabled={syncing} title={canSyncMaster ? 'ดึงข้อมูลพนักงานจาก Master Database' : 'กรุณาตั้งค่า Master Database ในไฟล์ .env'}><span>↻</span> {syncing ? 'กำลัง Sync...' : 'Sync ข้อมูล'}</button>}<button className="primary-button" onClick={onAdd}><span>＋</span> เพิ่มรายการ</button></div></section>
      <div className="source-banner"><span className="source-file-icon">▤</span><div><span className="source-label">{sourceLabel}</span><strong>{sourceName}</strong></div><span className="source-meta">{sourceMeta}</span></div>

      <div className="tabs" role="tablist" aria-label={`แท็บ${config.label}`}>
        {Object.entries(config.tabs).map(([tabId, item]) => <button key={tabId} role="tab" aria-selected={sheet === tabId} className={`tab-button ${sheet === tabId ? 'active' : ''}`} onClick={() => { onSheetChange(tabId); setSearch(''); }}>{item.label}<span className="tab-count">{tabId === sheet ? rows.length : '·'}</span></button>)}
      </div>

      <section className="data-panel">
        <div className="data-panel-toolbar"><div><h2>{tab.label}</h2><p>หัวตารางตรงตามชีตต้นแบบ แถวข้อมูลเริ่มที่แถว {tab.dataStartRow}</p></div><div className="toolbar-controls"><div className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ค้นหาพนักงานหรือข้อมูล..." /></div><button className="filter-button">≡ <span>ตัวกรอง</span></button></div></div>
        <div className="table-summary"><span>แสดง <strong>{filteredRows.length}</strong> จาก {rows.length} รายการ</span><span className="calculated-note"><i /> ช่องสีเทาคือค่าคำนวณจากระบบ</span></div>
        <div className="table-scroll"><DataTable columns={tab.columns} rows={filteredRows} sheet={sheet} onEdit={onEdit} /></div>
        <div className="data-panel-footer"><span>แหล่งข้อมูล: {sourceName} / ชีต {tab.sourceSheet.trim()}</span><span>อัปเดตล่าสุด: {isFirebaseConfigured ? 'Firebase' : 'ข้อมูลตัวอย่าง'}</span></div>
      </section>
    </div>
  );
}

function DataTable({ sheet, columns, rows, onEdit }) {
  return (
    <table className="data-table"><thead><tr>{columns.map((column) => <th key={column.key} className={!column.editable && column.editable !== undefined ? 'calculated-header' : ''}>{column.label}</th>)}<th className="action-header">จัดการ</th></tr></thead><tbody>{rows.length ? rows.map((row) => <tr key={row.id || `${sheet}-${row.sequence}-${row.employeeId}`} onDoubleClick={() => onEdit(row)}>{columns.map((column) => <td key={column.key} className={!column.editable && column.editable !== undefined ? 'calculated-cell' : ''}>{column.key === 'employeeId' ? <strong className="employee-code">{formatCell(row[column.key], column.type)}</strong> : column.key === 'netTotal' || column.key === 'dailyRateYear69' ? <strong>{formatCell(row[column.key], column.type)}</strong> : formatCell(row[column.key], column.type)}</td>)}<td className="action-cell"><button className="row-edit-button" onClick={() => onEdit(row)}>แก้ไข</button></td></tr>) : <tr><td colSpan={columns.length + 1} className="empty-state"><span className="empty-icon">⌁</span><strong>ยังไม่มีข้อมูลในแท็บนี้</strong><span>กด “เพิ่มรายการ” เพื่อเริ่มบันทึกข้อมูล</span></td></tr>}</tbody></table>
  );
}

function RecordEditor({ category, sheet, record, onClose, onSave }) {
  const [draft, setDraft] = useState(record);
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const columns = sourceCatalog[category].tabs[sheet].columns.filter((column) => column.editable !== false && column.key !== 'sequence');
  const isNew = !record.id;

  const update = (key, value, type) => setDraft((current) => ({ ...current, [key]: type === 'number' || type === 'currency' ? (value === '' ? '' : Number(value)) : value }));

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft, files);
    } finally {
      setSaving(false);
    }
  };

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}><section className="editor-modal" role="dialog" aria-modal="true" aria-labelledby="editor-title"><div className="modal-header"><div><div className="eyebrow">{sourceCatalog[category].label} / {sheet}</div><h2 id="editor-title">{isNew ? 'เพิ่มรายการใหม่' : 'แก้ไขรายการ'}</h2></div><button className="close-button" onClick={onClose} disabled={saving}>×</button></div><div className="editor-grid">{columns.map((column) => <label key={column.key} className={column.key === 'note' ? 'full-field' : ''}><span>{column.label}</span><input type={column.type === 'number' || column.type === 'currency' ? 'number' : 'text'} value={draft[column.key] ?? ''} onChange={(event) => update(column.key, event.target.value, column.type)} placeholder={`กรอก${column.label}`} /></label>)}<label className="full-field file-field"><span>ไฟล์แนบ</span><input type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files || []))} /><small>ไฟล์ใหม่จะถูกอัปโหลดไป Firebase Storage เมื่อกดบันทึก</small>{draft.attachments?.length > 0 && <div className="attachment-list">{draft.attachments.map((attachment) => <a key={attachment.path || attachment.url || attachment.name} href={attachment.url || '#'} target="_blank" rel="noreferrer">{attachment.name}</a>)}</div>}{files.length > 0 && <small>เลือกไฟล์ใหม่แล้ว {files.length} ไฟล์</small>}</label></div><div className="modal-footer"><button className="secondary-button" onClick={onClose} disabled={saving}>ยกเลิก</button><button className="primary-button" onClick={handleSave} disabled={saving}>{saving ? 'กำลังบันทึก...' : 'บันทึกข้อมูล'}</button></div></section></div>;
}

export default App;
