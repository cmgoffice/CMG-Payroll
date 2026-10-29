# CMG Payroll: โครงสร้างข้อมูล Firestore

ไฟล์ Excel ที่แนบมาใช้เป็นต้นแบบโครงสร้างข้อมูลเท่านั้น ไม่ได้ถูกตีความเป็นคำสั่งให้ระบบทำงาน

## โครงสร้างพื้นที่จัดเก็บกลาง

ระบบใช้ collection เดียวร่วมกันทุกผู้ใช้และไม่ใช้ UID เป็นโฟลเดอร์:

```text
CMG-Payroll (collection)
└── root (document)
    ├── rates (subcollection)
    │   └── {documentId}
    └── payroll (subcollection)
        └── {documentId}
```

แอปจะพยายามเข้าสู่ระบบด้วย Firebase Anonymous Authentication เพื่อให้ Rules ที่ต้องการ authentication ทำงานได้ แต่ path ของข้อมูลยังเป็น shared path เดิมสำหรับทุกคน

## เมนูและแท็บ

| เมนู | Collection | แท็บ | แหล่งข้อมูล |
| --- | --- | --- | --- |
| ค่าแรงรายงวด | `CMG-Payroll/root/payroll` | `DC`, `SUPPLY`, `ซอ` | `ไฟล์ค่าแรง มีวันหยุด ปี 2569.xlsx` |
| อัตราค่าแรง | `CMG-Payroll/root/rates` | `DC`, `SUPPLY` | `อัตราค่าแรง.xlsx` |

## Subcollection: `CMG-Payroll/root/rates`

หนึ่งเอกสารต่อพนักงานและชุดงาน โดยใช้ `sheet` แยกแท็บ

```text
sheet: "DC" | "SUPPLY"
employeeId: string
firstName: string
lastName: string
department: string
position: string
dailyRateYear69: number
travelRate: number | string
positionAllowance: number
phoneAllowance: number
welfareSupport: number
status: string
updatedAt: string
attachments: array<object>
```

## Subcollection: `CMG-Payroll/root/payroll`

หนึ่งเอกสารต่อพนักงานต่อรอบค่าแรง โดยใช้ `sheet` แยกแท็บ ปัจจุบันหน้าเว็บรองรับรอบตัวอย่างเดียวและเตรียมฟิลด์ `periodId` ให้เพิ่มต่อได้ในขั้นถัดไป

```text
periodId: string
sheet: "DC" | "SUPPLY" | "ซอ"
sequence: number
employeeId: string
firstName: string
lastName: string
department: string
position: string
normalDays: number
overtime15: number
overtime2Sunday: number
overtime2Holiday: number
holidayHours: number
travelFormula: number
dailyRate: number
travelRate: number | string
positionAllowance: number
phoneAllowance: number
overtimeRate15: number
regularWage: number
overtime15Amount: number
overtime2SundayAmount: number
overtime2HolidayAmount: number
holidayHoursAmount: number
positionPhoneTotal: number
travelAmount: number
contractWork: number
wageDrop: number
deduction: number
socialSecurity: number
netTotal: number
note: string
updatedAt: string
attachments: array<object>
```

## Firebase Storage

ไฟล์ที่แนบจากหน้าต่างเพิ่ม/แก้ไขรายการจะถูกเก็บไว้ที่:

```text
CMG-Payroll/root/{category}/{sheet}/{documentId}/{timestamp}-{fileName}
```

เอกสาร Firestore จะเก็บ metadata ของไฟล์ใน `attachments` เช่น `name`, `size`, `type`, `path`, `url` และ `uploadedAt`

## Master Database: ทะเบียนพนักงาน

ปุ่ม `Sync ข้อมูล` ในเมนู `อัตราค่าแรง` อ่าน Firebase Realtime Database จาก:

```text
CMG-HR-Database/root/employee_data
```

ข้อมูลต้นทางที่นำเข้า ได้แก่ `employeeId`, `firstName`, `lastName`, `department` และ `position` (รองรับชื่อฟิลด์ภาษาไทยตามหัวตารางด้วย) แล้ว upsert เข้า `CMG-Payroll/root/rates` โดยใช้ `employeeId` เป็นตัวจับคู่ ฟิลด์อัตราค่าแรงและสวัสดิการเดิมจะไม่ถูกลบทับเมื่อ Sync

## Collections ที่แนะนำสำหรับเฟสถัดไป

- `payrollPeriods`: เก็บ `periodId`, ช่วงวันที่, โครงการ, จำนวนวันทำงานปกติ และหมายเหตุวันหยุด
- `holidays`: เก็บวันที่และประเภทวันหยุด เพื่อคำนวณวันทำงาน/OT โดยไม่ต้องแก้ข้อมูลพนักงาน
- `users`: เก็บบทบาทผู้ใช้ เช่น `admin`, `payroll`, `viewer`

## การคำนวณหลัก

- ค่าแรงปกติ = `dailyRate × normalDays`
- OT 1.5 = `(dailyRate ÷ 8 × 1.5) × overtime15`
- OT 2 วันอาทิตย์/วันหยุด = `(dailyRate × 2) × จำนวนชั่วโมงหรือวัน`
- รวมสุทธิ = รายได้ทั้งหมด - เงินหัก - ประกันสังคม

สูตรควรย้ายไปไว้ใน Cloud Functions หรือ service layer เมื่อเริ่มใช้ข้อมูลจริง เพื่อให้ผลลัพธ์สอดคล้องกันทุกหน้าจอ
