// Builds the per-employee attendance report (same layout as the HR Excel sample) from the
// first/last scan per day saved under the period.
//
// Rules derived from the sample report:
//  - Mon–Sat shift is 07:30–16:30; Sunday is a rest day (00:00–23:59).
//  - วันปกติ = 1 for a Mon–Sat day with a scan.
//  - OT1.5, วันอาทิตย์ and วันหยุดบริษัท are in hours. OT1.5 = whole hours worked after the shift end (16:30), e.g. out 17:31 → 1, 19:43 → 3.
//  - วันอาทิตย์ = 9 hours (shift length) for a Sunday with a scan.
//  - วันหยุดบริษัท needs a holiday calendar, which does not exist yet, so it stays empty.
export const SHIFT_START = '07:30';
export const SHIFT_END = '16:30';
export const REST_DAY_START = '00:00';
export const REST_DAY_END = '23:59';
export const WORK_DAY_HOURS = 9;
const THAI_WEEKDAYS = ['วันอาทิตย์', 'วันจันทร์', 'วันอังคาร', 'วันพุธ', 'วันพฤหัสบดี', 'วันศุกร์', 'วันเสาร์'];

const toMinutes = (time) => {
  const [hours, minutes] = String(time || '').split(':').map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : null;
};

// YYYY-MM-DD list from start to end inclusive (UTC maths, so no daylight-saving drift).
const datesBetween = (startDate, endDate) => {
  const dates = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  for (let guard = 0; cursor <= end && guard < 400; guard += 1) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
};

export const formatReportDate = (date) => date.split('-').reverse().join('/');

export function buildEmployeeReport(record) {
  const byDate = new Map((record?.days || []).map((day) => [day.date, day]));
  const dates = record?.startDate && record?.endDate ? datesBetween(record.startDate, record.endDate) : [...byDate.keys()].sort();
  const totals = { normal: 0, ot: 0, sunday: 0, holiday: 0 };
  const rows = dates.map((date) => {
    const day = byDate.get(date);
    const weekdayIndex = new Date(`${date}T00:00:00Z`).getUTCDay();
    const isSunday = weekdayIndex === 0;
    const row = {
      date,
      weekday: THAI_WEEKDAYS[weekdayIndex],
      isSunday,
      shiftStart: isSunday ? REST_DAY_START : SHIFT_START,
      shiftEnd: isSunday ? REST_DAY_END : SHIFT_END,
      deviceIn: day?.deviceIn || '',
      deviceOut: day?.deviceOut || '',
      timeIn: day?.checkIn ? day.checkIn.slice(0, 5) : '',
      timeOut: day?.checkOut ? day.checkOut.slice(0, 5) : '',
      normal: 0,
      ot: 0,
      sunday: 0,
      holiday: 0,
    };
    if (day?.checkIn) {
      if (isSunday) row.sunday = WORK_DAY_HOURS;
      else row.normal = 1;
    }
    const out = toMinutes(row.timeOut);
    if (!isSunday && out !== null) row.ot = Math.max(0, Math.floor((out - toMinutes(SHIFT_END)) / 60));
    totals.normal += row.normal;
    totals.ot += row.ot;
    totals.sunday += row.sunday;
    return row;
  });
  return { rows, totals };
}
