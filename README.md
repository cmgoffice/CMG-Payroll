# CMG Payroll

โครง Vite + React สำหรับระบบบริหารจัดการค่าแรง โดยจัดเมนูตามไฟล์ Excel ต้นแบบและเตรียม Firestore สำหรับจัดเก็บข้อมูล

## เริ่มต้นใช้งาน

```bash
npm install
copy .env.example .env
npm run dev
```

ถ้ายังไม่ใส่ค่า Firebase ระบบจะเปิดด้วยข้อมูลตัวอย่างและบันทึกเฉพาะในหน้าจอ เมื่อใส่ค่า `VITE_FIREBASE_*` ครบ ระบบจะใช้ anonymous authentication เพื่ออ่าน/เขียน Firestore และอัปโหลดไฟล์เข้า Storage อัตโนมัติ ค่าใน `.env` จะไม่ถูก commit เพราะอยู่ใน `.gitignore`

## Sync ทะเบียนพนักงานจาก Master Database

หน้า `อัตราค่าแรง` มีปุ่ม `Sync ข้อมูล` สำหรับอ่านข้อมูลจาก Firestore ของโปรเจกต์ Master Database ที่ collection:

```text
CMG-HR-Database/root/employee_data
```

ค่าการเชื่อมต่อของฐานข้อมูลต้นทางเก็บใน `.env` ด้วย prefix `VITE_MASTERDATABASE_*` ระบบจะแปลงฟิลด์ `รหัสพนักงาน`, `ชื่อตัว`, `ชื่อสกุล`, `ชื่อชุด` (แผนก), `ตำแหน่ง`, `สถานะโครงการ` (โครงการ) และ `สถานะพนักงาน` แล้ว upsert เข้า Firestore ที่ `CMG-Payroll/root/rates` โดยจับคู่ด้วยรหัสพนักงาน

- แท็บ `DC` รับรหัสขึ้นต้น `DC` และ `Intern` ส่วนแท็บ `SUPPLY` รับรหัสขึ้นต้น `SP` รหัสอื่นไม่นำเข้า
- นำเข้าเฉพาะสถานะพนักงาน `ทำงาน` ส่วนรายการที่เคยนำเข้าแล้วแต่เปลี่ยนเป็นสถานะอื่นจะถูกซ่อนจากตาราง
- คอลัมน์ `โครงการ` มาจากฟิลด์ `สถานะโครงการ` (หลายโครงการคั่นด้วย `, `) และบันทึกไว้ในแอปนี้
- การ Sync ครั้งถัดไปจะอัปเดตเฉพาะฟิลด์จากต้นทาง และรักษาฟิลด์อัตราค่าแรง/สวัสดิการที่กรอกไว้ในระบบเดิม

## เปิดให้เครื่องอื่นในวง LAN เข้าใช้งาน

Vite ถูกตั้งค่าให้ listen ทุก network interface แล้ว ให้ดู IPv4 ของเครื่องที่รัน dev แล้วเปิดจากเครื่องอื่นด้วยรูปแบบนี้:

```text
http://<IP-เครื่องที่รัน>:5173
```

ตัวอย่าง `http://192.168.1.25:5173` เครื่องทั้งสองต้องอยู่เครือข่ายเดียวกัน และถ้า Windows Firewall ถาม ให้เลือกอนุญาตเฉพาะเครือข่าย Private

## โครงสร้าง Firebase ที่ใช้งานจริง

ข้อมูลทุกผู้ใช้ รวมถึง anonymous user ใช้พื้นที่เดียวกัน โดยไม่มีโฟลเดอร์ตาม UID:

```text
CMG-Payroll (collection)
└── root (document)
    ├── rates (subcollection)
    │   └── {documentId}
    └── payroll (subcollection)
        └── {documentId}
```

แต่ละเอกสารมี `sheet` เพื่อแยกแท็บ เช่น `DC`, `SUPPLY`, `ซอ` ส่วนไฟล์แนบจะอยู่ใน Storage path `CMG-Payroll/root/{category}/{sheet}/{documentId}/...` และ metadata จะถูกเก็บในฟิลด์ `attachments`

ต้องเปิด Anonymous sign-in ใน Firebase Authentication หาก Rules ของโปรเจกต์กำหนดให้ผู้ใช้ต้อง authenticated

รายละเอียดฟิลด์อยู่ที่ [docs/data-model.md](docs/data-model.md)

## โครงสร้างหน้าจอ

- ภาพรวม: ยอดรวมและทางลัดไปยังข้อมูลหลัก
- ค่าแรงรายงวด: แท็บ `DC`, `SUPPLY`, `ซอ`
- อัตราค่าแรง: แท็บ `DC`, `SUPPLY`
