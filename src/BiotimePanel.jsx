import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { fetchBiotimePunches, saveBiotimeAttendance, subscribeToBiotimeAttendance } from './lib/biotime';
import { buildEmployeeReport, formatReportDate } from './lib/biotimeReport';

const PAGE_SIZE = 50;
const employeeKey = (value) => String(value || '').trim().toLowerCase();
const dateLabel = (value) => (value ? new Date(`${value}T00:00:00`).toLocaleDateString('th-TH', { day: 'numeric', month: 'numeric', year: 'numeric' }) : '-');

// Fetch jobs live outside React state so they keep running (and their result stays
// readable) after the modal is closed or the user leaves this tab.
const jobs = new Map();
const jobListeners = new Set();
const setJob = (periodId, job) => { jobs.set(periodId, job); jobListeners.forEach((listener) => listener()); };
const subscribeJobs = (listener) => { jobListeners.add(listener); return () => jobListeners.delete(listener); };

async function runJob({ period, chosen }) {
  const base = { startedAt: Date.now(), total: chosen.length };
  setJob(period.id, { ...base, status: 'running' });
  try {
    const punches = await fetchBiotimePunches({ startDate: period.startDate, endDate: period.endDate });
    const result = await saveBiotimeAttendance({ period, employees: chosen, punches });
    setJob(period.id, { ...base, status: 'done', finishedAt: Date.now(), message: `บันทึกแล้ว ${result.employees} คน · ${result.days} วันที่มีการสแกน (จากสแกนทั้งหมด ${punches.length} ครั้ง)` });
  } catch (loadError) {
    setJob(period.id, { ...base, status: 'error', finishedAt: Date.now(), message: loadError.message || 'ดึงข้อมูล Biotime ไม่สำเร็จ' });
  }
}

// Biotime tab of a payroll period. "ดึงและบันทึกลง Firebase" opens a modal to pick employees
// from the period's payroll table, then fetches the Biotime scan times for the
// period's Start–End dates, saves it to Firebase and shows the saved rows.
export default function BiotimePanel({ period, employees, PaginationControls }) {
  const [saved, setSaved] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [pickSearch, setPickSearch] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [dismissedAt, setDismissedAt] = useState(0);
  const job = useSyncExternalStore(subscribeJobs, () => jobs.get(period?.id));
  const loading = job?.status === 'running';
  const notice = job?.status === 'done' && job.startedAt !== dismissedAt ? job.message : '';
  const jobError = job?.status === 'error' && job.startedAt !== dismissedAt ? job.message : '';
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState(null);
  const canLoad = Boolean(period?.id && period?.startDate && period?.endDate);

  useEffect(() => {
    setSaved([]);
    setError('');
    return subscribeToBiotimeAttendance({
      periodId: period?.id,
      onData: setSaved,
      onError: (subscribeError) => setError(subscribeError?.code === 'permission-denied' ? 'Firebase ปฏิเสธสิทธิ์การอ่านข้อมูล Biotime' : 'อ่านข้อมูล Biotime จาก Firebase ไม่สำเร็จ'),
    });
  }, [period?.id]);

  const savedById = useMemo(() => new Map(saved.map((item) => [employeeKey(item.employeeId), item])), [saved]);
  const pickList = useMemo(() => {
    const term = pickSearch.trim().toLowerCase();
    return term ? employees.filter((employee) => `${employee.employeeId} ${employee.name}`.toLowerCase().includes(term)) : employees;
  }, [employees, pickSearch]);
  const chosen = useMemo(() => employees.filter((employee) => selected.has(employee.employeeId)), [employees, selected]);
  const allVisibleChecked = pickList.length > 0 && pickList.every((employee) => selected.has(employee.employeeId));

  const toggle = (employeeId) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(employeeId)) next.delete(employeeId); else next.add(employeeId);
    return next;
  });
  const selectVisible = (checked) => setSelected((current) => {
    const next = new Set(current);
    pickList.forEach((employee) => (checked ? next.add(employee.employeeId) : next.delete(employee.employeeId)));
    return next;
  });
  const closeModal = () => setModalOpen(false);

  const load = () => {
    if (loading) return;
    runJob({ period, chosen });
    setSelected(new Set());
    setModalOpen(false);
  };

  const rows = useMemo(() => [...saved].sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId))), [saved]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? rows.filter((row) => `${row.employeeId} ${row.name}`.toLowerCase().includes(term)) : rows;
  }, [rows, search]);
  useEffect(() => setPage(1), [search, saved]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const offset = (currentPage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(offset, offset + PAGE_SIZE);

  const detail = detailId ? saved.find((item) => item.employeeId === detailId) : null;
  if (detail) {
    // Older saved records lack name/department/position, so fill gaps from the period's payroll row.
    const live = employees.find((employee) => employeeKey(employee.employeeId) === employeeKey(detail.employeeId)) || {};
    const record = { ...detail, ...Object.fromEntries(['name', 'firstName', 'lastName', 'department', 'position'].map((key) => [key, detail[key] || live[key] || ''])) };
    return <BiotimeEmployeeReport record={record} onBack={() => setDetailId(null)} />;
  }

  return (
    <>
      <section className="data-panel">
        <div className="data-panel-toolbar">
          <div><h2>การลงเวลา Biotime</h2><p>เวลาสแกนครั้งแรก/ครั้งสุดท้ายของแต่ละวัน{canLoad ? ` · ${dateLabel(period.startDate)} – ${dateLabel(period.endDate)}` : ''} · ข้อมูลที่บันทึกไว้ใน Firebase</p></div>
          <div className="toolbar-controls">
            <div className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ค้นหารหัสหรือชื่อ..." /></div>
            <button type="button" className="primary-button" onClick={() => setModalOpen(true)} disabled={!canLoad}>ดึงและบันทึกลง Firebase</button>
          </div>
        </div>
        {!canLoad && <div className="period-empty"><strong>งวดนี้ยังไม่มีวันที่เริ่มต้น/สิ้นสุด</strong></div>}
        {error && <div className="period-empty"><strong>ดึงข้อมูลไม่สำเร็จ</strong><span>{error}</span></div>}
        {loading && <div className="table-summary"><span>⏳ กำลังดึงเวลา {job.total} คน อยู่เบื้องหลัง · ปิดหน้าต่างหรือสลับแท็บได้ ผลลัพธ์จะแสดงที่นี่เมื่อเสร็จ</span></div>}
        {jobError && <div className="period-empty"><strong>ดึงข้อมูลไม่สำเร็จ</strong><span>{jobError}</span> <button type="button" className="text-button" onClick={() => setDismissedAt(job.startedAt)}>ปิด</button></div>}
        {notice && <div className="table-summary"><span>✅ {notice}</span> <button type="button" className="text-button" onClick={() => setDismissedAt(job.startedAt)}>ปิด</button></div>}
        <div className="table-summary"><span>ทั้งหมด <strong>{filtered.length}</strong> คน · กดที่ชื่อเพื่อดูรายงานรายบุคคล · วันทำงานปกติ/OT ถูกนำไปใช้ในตารางค่าแรงอัตโนมัติ</span></div>
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>No.</th><th>Employee ID</th><th>ชื่อ-นามสกุล</th><th>วันที่มีการสแกน</th><th>ดึงข้อมูลเมื่อ</th></tr></thead>
            <tbody>
              {pageRows.map((row, index) => (
                <tr key={row.employeeId}>
                  <td>{offset + index + 1}</td>
                  <td>{row.employeeId}</td>
                  <td><button type="button" className="text-button" onClick={() => setDetailId(row.employeeId)}>{row.name || row.employeeId}</button></td>
                  <td>{(row.days || []).length} วัน</td>
                  <td>{row.fetchedAt ? new Date(row.fetchedAt).toLocaleString('th-TH') : '-'}</td>
                </tr>
              ))}
              {!pageRows.length && <tr><td colSpan={5}>ยังไม่มีข้อมูลที่บันทึกไว้ · กด “ดึงและบันทึกลง Firebase” เพื่อเลือกพนักงาน</td></tr>}
            </tbody>
          </table>
        </div>
        <PaginationControls currentPage={currentPage} pageCount={pageCount} totalCount={filtered.length} onPageChange={setPage} />
      </section>

      {modalOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeModal()}>
          <section className="editor-modal import-summary-modal" role="dialog" aria-modal="true" aria-labelledby="biotime-pick-title">
            <div className="modal-header">
              <div><div className="eyebrow">BIOTIME</div><h2 id="biotime-pick-title">เลือกพนักงานที่จะดึงเวลา</h2><p className="import-summary-file">รายชื่อจากตารางค่าแรงของงวดนี้ ({employees.length} คน) · ดึงวันที่ {dateLabel(period?.startDate)} – {dateLabel(period?.endDate)}</p></div>
              <button type="button" className="close-button" onClick={closeModal}>×</button>
            </div>
            <div className="import-summary-content">
              <div className="search-box" style={{ width: '100%', marginBottom: 10 }}><span>⌕</span><input value={pickSearch} onChange={(event) => setPickSearch(event.target.value)} placeholder="ค้นหารหัสหรือชื่อ..." /></div>
              {employees.length ? (
                <div className="table-scroll" style={{ maxHeight: '42vh', minHeight: 0 }}>
                  <table className="data-table">
                    <thead><tr><th><input type="checkbox" checked={allVisibleChecked} onChange={(event) => selectVisible(event.target.checked)} aria-label="เลือกทั้งหมดที่แสดง" /></th><th>Employee ID</th><th>ชื่อ-นามสกุล</th><th>สถานะ</th></tr></thead>
                    <tbody>
                      {pickList.map((employee) => {
                        const record = savedById.get(employeeKey(employee.employeeId));
                        return (
                          <tr key={employee.employeeId}>
                            <td><input type="checkbox" checked={selected.has(employee.employeeId)} onChange={() => toggle(employee.employeeId)} aria-label={`เลือก ${employee.employeeId}`} /></td>
                            <td>{employee.employeeId}</td>
                            <td>{employee.name || '-'}</td>
                            <td>{record ? `ดึงแล้ว ${new Date(record.fetchedAt).toLocaleString('th-TH')}` : 'ยังไม่ได้ดึง'}</td>
                          </tr>
                        );
                      })}
                      {!pickList.length && <tr><td colSpan={4}>ไม่พบรายชื่อ</td></tr>}
                    </tbody>
                  </table>
                </div>
              ) : <div className="period-empty"><strong>ยังไม่มีพนักงานในตารางค่าแรงของงวดนี้</strong><span>เพิ่มรายการในแท็บตารางค่าแรงก่อน</span></div>}
              {loading && <p className="confirm-text">กำลังดึงข้อมูลอยู่เบื้องหลัง · รอให้เสร็จก่อนเริ่มรอบใหม่</p>}
            </div>
            <div className="modal-footer">
              <span className="import-summary-file" style={{ marginRight: 'auto' }}>เลือกแล้ว {chosen.length} คน</span>
              <button type="button" className="secondary-button" onClick={closeModal}>ปิด</button>
              <button type="button" className="primary-button" onClick={load} disabled={loading || !chosen.length}>{`ดึงและบันทึกลง Firebase (${chosen.length} คน)`}</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

const num = (value) => (value ? value.toFixed(2) : '-');

// Per-employee report in the layout of the HR sample sheet: one line per date of the period.
function BiotimeEmployeeReport({ record, onBack }) {
  const { rows, totals } = useMemo(() => buildEmployeeReport(record), [record]);
  return (
    <section className="data-panel">
      <div className="data-panel-toolbar">
        <div>
          <button type="button" className="secondary-button period-back-button" onClick={onBack}>← รายชื่อ</button>
          <h2>{record.employeeId} · {record.name || '-'}</h2>
          <p>{record.department || '-'} · {record.position || '-'} · {formatReportDate(record.startDate)} – {formatReportDate(record.endDate)} · วันหยุดบริษัทยังไม่มีข้อมูลปฏิทิน</p>
        </div>
      </div>
      <div className="table-scroll" style={{ maxHeight: 'none' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>หมายเลขพนักงาน</th><th>ชื่อจริง</th><th>นามสกุล</th><th>แผนก</th><th>ตำแหน่ง</th><th>วันที่</th><th>วันทำงาน</th>
              <th>เช็คอิน</th><th>เช็คเอาท์</th><th>อุปกรณ์[เข้า]</th><th>อุปกรณ์[ออก]</th><th>เวลาเข้า</th><th>เวลาออก</th>
              <th>วันปกติ (วัน)</th><th>OT1.5 (ชม.)</th><th>วันอาทิตย์ (ชม.)</th><th>วันหยุดบริษัท (ชม.)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.date} style={row.isSunday ? { background: '#fde4e4' } : undefined}>
                <td>{record.employeeId}</td><td>{record.firstName || '-'}</td><td>{record.lastName || '-'}</td><td>{record.department || '-'}</td><td>{record.position || '-'}</td>
                <td>{formatReportDate(row.date)}</td><td>{row.weekday}</td>
                <td>{row.shiftStart}</td><td>{row.shiftEnd}</td><td>{row.deviceIn || '-'}</td><td>{row.deviceOut || '-'}</td>
                <td><strong>{row.timeIn || '-'}</strong></td><td><strong>{row.timeOut || '-'}</strong></td>
                <td>{num(row.normal)}</td><td>{num(row.ot)}</td><td>{num(row.sunday)}</td><td>{num(row.holiday)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={13}><strong>Statistics</strong></td><td><strong>{totals.normal.toFixed(2)}</strong></td><td><strong>{totals.ot.toFixed(2)}</strong></td><td><strong>{totals.sunday.toFixed(2)}</strong></td><td><strong>{totals.holiday.toFixed(2)}</strong></td></tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
