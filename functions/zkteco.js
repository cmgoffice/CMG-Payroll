// Read-only ZKBioTime client. Shared by the Cloud Function and the Vite dev server,
// so credentials (ZK_API_*) only ever live on the server side.
const trimSlash = (value) => String(value || '').replace(/\/+$/, '');

export const readZkConfig = (env = process.env) => ({
  baseUrl: trimSlash(env.ZK_API_BASE_URL),
  username: env.ZK_API_USERNAME,
  password: env.ZK_API_PASSWORD,
});

const requestJson = async (url, options) => {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  } catch (error) {
    const reason = error.cause?.code || error.cause?.message || error.name;
    throw new Error(`เชื่อมต่อ ${new URL(url).origin} ไม่ได้ (${reason}) · ตรวจสอบ URL/พอร์ตใน ZK_API_BASE_URL และว่าเครื่องนี้เข้าถึงเซิร์ฟเวอร์ได้`);
  }
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!response.ok) throw new Error(`ZKBioTime ${response.status}: ${(body && (body.detail || body.non_field_errors?.[0])) || text.slice(0, 120)}`);
  return body;
};

// ZKBioTime 8 issues a real JWT at /jwt-api-token-auth/ (header `JWT <token>`); older builds only
// have /api-token-auth/, whose DRF token is sent as `Token <token>`. Using the wrong prefix gives
// "401 Error decoding signature", so remember which endpoint the token came from.
export const requestZkToken = async ({ baseUrl, username, password }) => {
  if (!baseUrl || !username || !password) throw new Error('ยังไม่ได้ตั้งค่า ZK_API_BASE_URL / ZK_API_USERNAME / ZK_API_PASSWORD');
  const login = (path) => requestJson(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  try {
    const body = await login('/jwt-api-token-auth/');
    if (body?.token) return { scheme: 'JWT', token: body.token };
  } catch (error) {
    if (!/ZKBioTime 404/.test(error.message)) throw error;
  }
  const body = await login('/api-token-auth/');
  if (!body?.token) throw new Error('ZKBioTime ไม่ส่ง token กลับมา');
  return { scheme: 'Token', token: body.token };
};

// startDate / endDate are YYYY-MM-DD. Returns [{ empCode, punchTime, device }] sorted by time.
export const fetchZkTransactions = async ({ config = readZkConfig(), startDate, endDate }) => {
  const { scheme, token } = await requestZkToken(config);
  const headers = { Authorization: `${scheme} ${token}` };
  const punches = [];
  let url = `${config.baseUrl}/iclock/api/transactions/?${new URLSearchParams({
    start_time: `${startDate} 00:00:00`,
    end_time: `${endDate} 23:59:59`,
    page_size: '1000',
  })}`;
  for (let page = 0; url && page < 200; page += 1) {
    const body = await requestJson(url, { headers });
    for (const item of body?.data || []) {
      if (item.emp_code && item.punch_time) punches.push({ empCode: String(item.emp_code).trim(), punchTime: String(item.punch_time), device: String(item.terminal_alias || item.terminal_sn || '').trim() });
    }
    url = body?.next ? (body.next.startsWith('http') ? body.next : `${config.baseUrl}${body.next}`) : null;
  }
  return punches.sort((a, b) => a.punchTime.localeCompare(b.punchTime));
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const validateRange = (startDate, endDate) => DATE_PATTERN.test(startDate || '') && DATE_PATTERN.test(endDate || '') && startDate <= endDate;
