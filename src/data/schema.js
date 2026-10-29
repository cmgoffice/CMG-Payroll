const commonPayrollColumns = [
  { key: 'sequence', label: 'ลำดับ', type: 'number', editable: false },
  { key: 'employeeId', label: 'หมายเลขพนักงาน', type: 'text' },
  { key: 'firstName', label: 'ชื่อจริง', type: 'text' },
  { key: 'lastName', label: 'นามสกุล', type: 'text' },
  { key: 'department', label: 'แผนก', type: 'text' },
  { key: 'position', label: 'ตำแหน่ง', type: 'text' },
  { key: 'normalDays', label: 'วันทำงานปกติ', type: 'number' },
  { key: 'overtime15', label: 'OT 1.5', type: 'number' },
  { key: 'overtime2Sunday', label: 'OT 2 อาทิตย์', type: 'number' },
  { key: 'overtime2Holiday', label: 'OT 2 วันหยุด', type: 'number' },
  { key: 'holidayHours', label: 'OT ชม.วันหยุด', type: 'number' },
  { key: 'travelFormula', label: 'สูตรคิดค่าเดินทาง', type: 'number', editable: false },
  { key: 'dailyRate', label: 'อัตราค่าแรง', type: 'currency', editable: false },
  { key: 'travelRate', label: 'ค่าเดินทาง', type: 'mixed', editable: false },
  { key: 'positionAllowance', label: 'ค่าตำแหน่ง', type: 'currency', editable: false },
  { key: 'phoneAllowance', label: 'ค่าโทรศัพท์', type: 'currency', editable: false },
  { key: 'overtimeRate15', label: 'อัตรา OT 1.5', type: 'currency', editable: false },
  { key: 'regularWage', label: 'ค่าแรงปกติ', type: 'currency', editable: false },
  { key: 'overtime15Amount', label: 'ยอด OT 1.5', type: 'currency', editable: false },
  { key: 'overtime2SundayAmount', label: 'ยอด OT 2 วันอาทิตย์', type: 'currency', editable: false },
  { key: 'overtime2HolidayAmount', label: 'ยอด OT 2 วันหยุด', type: 'currency', editable: false },
  { key: 'holidayHoursAmount', label: 'ยอด OT ชม.วันหยุด', type: 'currency', editable: false },
  { key: 'positionPhoneTotal', label: 'ค่าตำแหน่ง/โทรศัพท์', type: 'currency', editable: false },
  { key: 'travelAmount', label: 'ยอดค่าเดินทาง', type: 'currency', editable: false },
  { key: 'contractWork', label: 'งานเหมา', type: 'currency' },
  { key: 'wageDrop', label: 'ค่าแรงตก', type: 'currency' },
  { key: 'deduction', label: 'หักเงิน', type: 'currency' },
  { key: 'socialSecurity', label: 'ประกันสังคม', type: 'currency', editable: false },
  { key: 'netTotal', label: 'รวมยอดสุทธิ', type: 'currency', editable: false },
  { key: 'note', label: 'หมายเหตุ', type: 'text' },
];

const supplyPayrollColumns = commonPayrollColumns
  .filter((column) => !['positionAllowance', 'phoneAllowance', 'positionPhoneTotal', 'socialSecurity'].includes(column.key))
  .map((column) => {
    if (column.key === 'holidayHours') return { ...column, label: 'OT 3 ชม.วันหยุด' };
    if (column.key === 'holidayHoursAmount') return { ...column, label: 'ยอด OT 3 ชม.วันหยุด' };
    return column;
  });

const rateColumns = [
  { key: 'employeeId', label: 'รหัสพนักงาน', type: 'text' },
  { key: 'firstName', label: 'ชื่อ', type: 'text' },
  { key: 'lastName', label: 'นามสกุล', type: 'text' },
  { key: 'department', label: 'แผนก', type: 'text' },
  { key: 'position', label: 'ตำแหน่ง', type: 'text' },
  { key: 'dailyRateYear69', label: 'ค่าแรงปี 69', type: 'currency' },
  { key: 'travelRate', label: 'อัตราค่าเดินทาง', type: 'mixed' },
  { key: 'positionAllowance', label: 'อัตราค่าตำแหน่ง', type: 'currency' },
  { key: 'phoneAllowance', label: 'ค่าโทรศัพท์', type: 'currency' },
  { key: 'welfareSupport', label: 'สวัสดิการช่วยเหลือ', type: 'currency' },
  { key: 'status', label: 'สถานะ', type: 'text' },
];

const supplyRateColumns = rateColumns.filter((column) => !['phoneAllowance', 'welfareSupport'].includes(column.key));

export const sourceCatalog = {
  payroll: {
    id: 'payroll',
    label: 'ค่าแรงรายงวด',
    sourceFile: 'ไฟล์ค่าแรง มีวันหยุด ปี 2569.xlsx',
    collection: 'CMG-Payroll/root/payroll',
    tabs: {
      DC: {
        label: 'DC',
        sourceSheet: 'DC ',
        headerRow: 6,
        dataStartRow: 7,
        sourceRows: 68,
        columns: commonPayrollColumns,
        description: 'ค่าแรงพนักงานรายวันของชุด DC พร้อมรายการ OT และเงินหัก',
      },
      SUPPLY: {
        label: 'SUPPLY',
        sourceSheet: 'SUPPLY',
        headerRow: 6,
        dataStartRow: 7,
        sourceRows: 68,
        columns: supplyPayrollColumns,
        description: 'ค่าแรงพนักงานรายวันของชุด SUPPLY',
      },
      ซอ: {
        label: 'ซอ',
        sourceSheet: 'ซอ',
        headerRow: 6,
        dataStartRow: 7,
        sourceRows: 133,
        columns: supplyPayrollColumns,
        description: 'ค่าแรงพนักงานรายวันของชุด ซอ',
      },
    },
  },
  rates: {
    id: 'rates',
    label: 'อัตราค่าแรง',
    sourceFile: 'อัตราค่าแรง.xlsx',
    collection: 'CMG-Payroll/root/rates',
    tabs: {
      DC: {
        label: 'DC',
        sourceSheet: 'DC',
        headerRow: 2,
        dataStartRow: 3,
        sourceRows: 314,
        columns: rateColumns,
        description: 'ทะเบียนพนักงานและอัตราค่าแรงของชุด DC',
      },
      SUPPLY: {
        label: 'SUPPLY',
        sourceSheet: 'SUPPLY',
        headerRow: 1,
        dataStartRow: 2,
        sourceRows: 440,
        columns: supplyRateColumns,
        description: 'ทะเบียนพนักงานและอัตราค่าแรงของชุด SUPPLY',
      },
    },
  },
};

export const menuItems = [
  { id: 'rates', label: 'อัตราค่าแรง', shortLabel: 'อัตรา' },
  { id: 'payroll', label: 'ค่าแรงรายงวด', shortLabel: 'ค่าแรง' },
  { id: 'overview', label: 'ภาพรวม', shortLabel: 'ภาพรวม' },
];

export const formatCurrency = (value) => {
  if (value === null || value === undefined || value === '') return '-';
  const number = Number(value);
  if (Number.isNaN(number)) return String(value);
  return new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 }).format(number);
};

export const formatCell = (value, type = 'text') => {
  if (value === null || value === undefined || value === '') return '-';
  if (type === 'currency') return formatCurrency(value);
  if (type === 'number') return formatCurrency(value);
  return String(value);
};
