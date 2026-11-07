'use strict';

/* =========================================================
   人才证书与业绩管理系统
   零依赖离线版：数据保存在当前浏览器，本文件不连接外部服务。
   ========================================================= */

const STORAGE_KEY = 'talentCertificateSystem.v2';
const DATA_VERSION = 2;
const LOG_GENESIS = 'GENESIS';
const SESSION_REVEAL_MS = 30000;
const DEFAULT_ALERT_DAYS = 30;
const DEFAULT_CERT_TYPES = [
  '二级机电带B',
  '二级市政+中工',
  'C证处理',
  '结构中工',
  '电气中工',
  '二级房建B',
  '二级房建市政B',
  '一级房建市政造价B',
  '二级市政B+市政中工',
  '二级市政B+一级土建造价',
  '一级房建+二级市政B',
  '二级房建+市政B',
  '二级机电+水利+双B',
  '安全员'
];

const PAGE_META = {
  dashboard: { eyebrow: '业务总览', title: '首页看板', subtitle: '合同、回款、业绩进度与到期预警实时看板' },
  ledger: { eyebrow: '数据台账', title: '详细台账', subtitle: '维护人才、证书、价格与负责人信息' }
};

const HEADER_ALIASES = {
  adjustmentDate: ['调证日期', '日期', '业务日期'],
  name: ['人才姓名', '人才名字', '姓名', '人才'],
  phone: ['手机号', '手机号码', '电话', '联系电话', '手机'],
  departmentPersonal: ['人才部', '人才部门', '人才归属部'],
  departmentEnterprise: ['企业部', '企业部门', '企业归属部'],
  certificateType: ['证书类型', '证书类别', '证书'],
  receivePrice: ['收证价', '收证价格', '收入价'],
  issuePrice: ['出证价', '出证价格', '出证售价'],
  contractMonths: ['合同有效期', '合同有效期（月）', '合同有效期月', '合同期限', '合同月数', '有效期月数'],
  contractExpiryDate: ['合同到期日', '合同到期日期', '合同有效期到期日'],
  paymentAmount: ['回款', '回款金额', '已回款'],
  paymentDate: ['回款日期', '回款时间'],
  registrationDate: ['注册证办结日期', '注册证办理日期', '办结日期', '注册证一年期限'],
  regExpiryDate: ['注册证有效期', '注册证到期日期', '注册证到期时间', '到期时间'],
  threeExpiryDate: ['三类人员证有效期', '三类人员证到期日期', '资格证到期时间', 'B证到期时间'],
  owner: ['负责人', '经办人', '归属人'],
  remarks: ['备注', '说明', '其他说明']
};

const state = {
  initialized: false,
  records: [],
  settings: {},
  logs: [],
  vault: null,
  sessionKey: null,
  lastAuthAt: 0,
  activePage: 'dashboard',
  filters: {
    search: '',
    certificateType: '',
    status: 'all',
    owner: '',
    dateFrom: '',
    dateTo: '',
    focusId: ''
  },
  page: 1,
  pageSize: 20,
  revealedPhones: new Map(),
  modal: null,
  authResolver: null
};

/* ---------------- 通用工具 ---------------- */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function deepClone(value) {
  if (value === undefined || value === null) return value;
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = String(value).replace(/[,\s￥¥]/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : fallback;
}

function roundMoney(value) {
  return Math.round((safeNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function formatMoney(value, withSymbol = true) {
  const number = safeNumber(value, 0);
  const text = new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: Number.isInteger(number) ? 0 : 2,
    maximumFractionDigits: 2
  }).format(number);
  return withSymbol ? `¥${text}` : text;
}

function formatCompactMoney(value) {
  const number = safeNumber(value, 0);
  if (Math.abs(number) >= 10000) return `¥${(number / 10000).toFixed(number % 10000 === 0 ? 0 : 1)}万`;
  return formatMoney(number);
}

function nowText() {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function localIsoDate(date = new Date()) {
  const pad = (v) => String(v).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function currentMonthKey(date = new Date()) {
  return localIsoDate(date).slice(0, 7);
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 20000 && serial < 80000) {
      const date = new Date(Date.UTC(1899, 11, 30));
      date.setUTCDate(date.getUTCDate() + Math.floor(serial));
      return date;
    }
  }
  const match = text.match(/^(\d{4})[./-](\d{1,2})(?:[./-](\d{1,2}))?/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3] || '1');
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return date;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
}

function normalizeDateInput(value) {
  const date = parseDate(value);
  return date ? date.toISOString().slice(0, 10) : '';
}

function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function remainingDays(dateValue) {
  const target = parseDate(dateValue);
  if (!target) return null;
  return Math.ceil((target.getTime() - todayUtc().getTime()) / 86400000);
}

function formatDisplayDate(value) {
  const date = parseDate(value);
  if (!date) return '—';
  const pad = (v) => String(v).padStart(2, '0');
  return `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())}`;
}

function formatShortMonth(monthKey) {
  const [, month] = monthKey.split('-');
  return `${Number(month)}月`;
}

function monthRange(count, endDate = new Date()) {
  const result = [];
  const year = endDate.getFullYear();
  const month = endDate.getMonth();
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(year, month - offset, 1);
    result.push(currentMonthKey(date));
  }
  return result;
}

function addMonthsClamped(dateValue, months) {
  const start = parseDate(dateValue);
  const monthCount = Math.max(0, Math.round(safeNumber(months, 0)));
  if (!start || !monthCount) return '';
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const day = start.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + monthCount + 1, 0)).getUTCDate();
  const result = new Date(Date.UTC(year, month + monthCount, Math.min(day, lastDay)));
  return result.toISOString().slice(0, 10);
}

function computeContractExpiry(record) {
  if (record?.registrationDate && safeNumber(record?.contractMonths, 0) > 0) {
    return addMonthsClamped(record.registrationDate, record.contractMonths);
  }
  return normalizeDateInput(record?.contractExpiryDate);
}

function contractRemainingDays(record) {
  return remainingDays(computeContractExpiry(record));
}

function recordPaymentDate(record) {
  return normalizeDateInput(record?.paymentDate || record?.adjustmentDate);
}

function normalizePhone(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const cleaned = text.replace(/[\s\-()]/g, '');
  return cleaned.replace(/[^\d+]/g, '');
}

function isMaskedPhone(value) {
  return /[*＊•]/.test(String(value || ''));
}

function maskPhone() {
  return '•••••••';
}

function debounce(fn, wait = 220) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/* ---------------- 加密与安全 ---------------- */

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function ensureWebCrypto() {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前浏览器未启用 Web Crypto。请使用“启动系统.bat”通过 localhost 打开，或改用最新版 Edge/Chrome。');
  }
}

async function deriveKey(password, saltBase64, iterations) {
  ensureWebCrypto();
  const encoder = new TextEncoder();
  const sourceKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: base64ToBytes(saltBase64), iterations, hash: 'SHA-256' },
    sourceKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptText(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(String(text));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(encrypted)) };
}

async function decryptText(key, payload) {
  if (!payload?.iv || !payload?.data) throw new Error('加密数据不完整');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(payload.iv) },
    key,
    base64ToBytes(payload.data)
  );
  return new TextDecoder().decode(plain);
}

async function createVault(password) {
  ensureWebCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltBase64 = bytesToBase64(salt);
  const iterations = 210000;
  const key = await deriveKey(password, saltBase64, iterations);
  const verifier = await encryptText(key, 'TALENT_CERT_VAULT_OK');
  state.vault = {
    version: 1,
    salt: saltBase64,
    iterations,
    verifier,
    createdAt: nowText(),
    updatedAt: nowText()
  };
  state.sessionKey = key;
  state.lastAuthAt = Date.now();
}

async function unlockVault(password) {
  if (!state.vault) return false;
  try {
    const key = await deriveKey(password, state.vault.salt, state.vault.iterations);
    const text = await decryptText(key, state.vault.verifier);
    if (text !== 'TALENT_CERT_VAULT_OK') return false;
    state.sessionKey = key;
    state.lastAuthAt = Date.now();
    return true;
  } catch {
    state.sessionKey = null;
    return false;
  }
}

async function encryptPhoneValue(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return { phoneCipher: '', phoneIv: '' };
  if (!state.sessionKey) throw new Error('安全会话尚未解锁');
  const payload = await encryptText(state.sessionKey, normalized);
  return { phoneCipher: payload.data, phoneIv: payload.iv };
}

async function decryptPhoneValue(record) {
  if (!record?.phoneCipher || !record?.phoneIv) return '';
  if (!state.sessionKey) throw new Error('安全会话尚未解锁');
  return decryptText(state.sessionKey, { data: record.phoneCipher, iv: record.phoneIv });
}

/* ---------------- 数据持久化 ---------------- */

function defaultSettings() {
  return {
    alertDays: DEFAULT_ALERT_DAYS,
    certificateTypes: [...DEFAULT_CERT_TYPES],
    owners: [],
    monthlyPlans: {}
  };
}

function normalizeRecord(record = {}) {
  const adjustmentDate = normalizeDateInput(record.adjustmentDate);
  const registrationDate = normalizeDateInput(record.registrationDate);
  const rawContractMonths = Math.round(safeNumber(record.contractMonths, registrationDate ? 12 : 0));
  const contractMonths = rawContractMonths ? Math.min(36, Math.max(1, rawContractMonths)) : (registrationDate ? 12 : 0);
  const importedContractExpiry = normalizeDateInput(record.contractExpiryDate);
  const contractExpiryDate = registrationDate && contractMonths
    ? addMonthsClamped(registrationDate, contractMonths)
    : importedContractExpiry;
  const paymentAmount = roundMoney(record.paymentAmount || 0);
  const paymentDate = normalizeDateInput(record.paymentDate || (paymentAmount > 0 ? adjustmentDate : ''));
  return {
    id: String(record.id || `record-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    sourceRow: record.sourceRow || null,
    adjustmentDate,
    name: String(record.name || '').trim(),
    phoneCipher: String(record.phoneCipher || ''),
    phoneIv: String(record.phoneIv || ''),
    departmentPersonal: String(record.departmentPersonal || '').trim(),
    departmentEnterprise: String(record.departmentEnterprise || '').trim(),
    certificateType: String(record.certificateType || '').trim(),
    receivePrice: roundMoney(record.receivePrice || 0),
    issuePrice: roundMoney(record.issuePrice || 0),
    paymentAmount,
    paymentDate,
    registrationDate,
    contractMonths,
    contractExpiryDate,
    regExpiryDate: normalizeDateInput(record.regExpiryDate),
    threeExpiryDate: normalizeDateInput(record.threeExpiryDate),
    owner: String(record.owner || '').trim(),
    remarks: String(record.remarks || '').trim(),
    createdAt: String(record.createdAt || nowText()),
    updatedAt: String(record.updatedAt || nowText()),
    deletedAt: record.deletedAt || null
  };
}
function ensureSettingsOptions() {
  const typeSet = new Set([...DEFAULT_CERT_TYPES, ...(state.settings.certificateTypes || [])]);
  state.records.forEach((record) => {
    if (record.certificateType) typeSet.add(record.certificateType);
  });
  const ownerSet = new Set((state.settings.owners || []).filter(Boolean));
  state.records.forEach((record) => {
    if (record.owner) ownerSet.add(record.owner);
  });
  state.settings.certificateTypes = Array.from(typeSet).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  state.settings.owners = Array.from(ownerSet).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function saveState() {
  try {
    const payload = {
      version: DATA_VERSION,
      records: state.records,
      settings: state.settings,
      logs: state.logs,
      vault: state.vault
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent('talent:changed'));
  } catch (error) {
    console.error(error);
    showToast('本地保存失败，请检查浏览器存储空间。', 'error');
  }
}

async function logHash(baseEntry) {
  ensureWebCrypto();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableStringify(baseEntry)));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function appendLog(action, recordId = '', details = '') {
  const previous = state.logs.length ? state.logs[state.logs.length - 1].hash : LOG_GENESIS;
  const base = {
    id: `log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: nowText(),
    operator: '本地管理员',
    action,
    recordId: recordId || '',
    details: typeof details === 'string' ? details : deepClone(details),
    prevHash: previous
  };
  const entry = { ...base, hash: await logHash(base) };
  state.logs.push(entry);
  return entry;
}

async function verifyLogChain() {
  let previous = LOG_GENESIS;
  for (const entry of state.logs) {
    if (entry.prevHash !== previous) return { ok: false, brokenAt: entry.id || previous };
    const { hash, ...base } = entry;
    const expected = await logHash(base);
    if (hash !== expected) return { ok: false, brokenAt: entry.id || previous };
    previous = hash;
  }
  return { ok: true };
}

async function loadState() {
  let raw = localStorage.getItem(STORAGE_KEY);
  let parsed = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('台账格式不正确');
    } catch (error) {
      // 本地数据损坏：先原样备份到另一个键，避免直接丢失，再用空台账启动
      console.error(error);
      try {
        localStorage.setItem(`${STORAGE_KEY}.corrupt-${Date.now()}`, raw);
      } catch (backupError) {
        console.error(backupError);
      }
      localStorage.removeItem(STORAGE_KEY);
      raw = null;
      parsed = null;
      setTimeout(() => showToast('本地台账读取失败，已备份损坏数据并重新初始化，请用备份文件恢复。', 'error'), 600);
    }
  }
  if (raw && parsed) {
    const seedByRow = new Map((window.LEGACY_SEED?.records || []).map((record) => [record.sourceRow, record]));
    state.records = Array.isArray(parsed.records) ? parsed.records.map((record) => {
      const normalized = normalizeRecord(record);
      const legacy = seedByRow.get(normalized.sourceRow);
      if (legacy) {
        if (!record.paymentAmount && legacy.paymentAmount) {
          normalized.paymentAmount = roundMoney(legacy.paymentAmount);
          normalized.paymentDate = normalizeDateInput(legacy.paymentDate || normalized.adjustmentDate);
        }
        if (!record.contractMonths && legacy.contractMonths) normalized.contractMonths = legacy.contractMonths;
        normalized.contractExpiryDate = computeContractExpiry(normalized);
      }
      return normalized;
    }) : [];
    state.settings = { ...defaultSettings(), ...(parsed.settings || {}) };
    state.settings.monthlyPlans = { ...(parsed.settings?.monthlyPlans || {}) };
    delete state.settings.performanceFactor;
    state.logs = Array.isArray(parsed.logs) ? parsed.logs : [];
    state.vault = parsed.vault || null;
    ensureSettingsOptions();
    saveState();
    return;
  }

  const seed = window.LEGACY_SEED || { records: [], sourceFile: '' };
  state.records = Array.isArray(seed.records) ? seed.records.map(normalizeRecord) : [];
  state.settings = defaultSettings();
  state.logs = [];
  state.vault = null;
  ensureSettingsOptions();
  await appendLog('系统初始化', '', '创建本地加密台账数据库');
  if (state.records.length) {
    await appendLog('历史数据导入', '', `从 ${seed.sourceFile || '原有 Excel'} 初始化 ${state.records.length} 条记录`);
  }
  saveState();
}
/* ---------------- 业务计算 ---------------- */

function departmentFactor(personal, enterprise) {
  const personalText = String(personal === undefined || personal === null ? '' : personal).trim();
  const enterpriseText = String(enterprise === undefined || enterprise === null ? '' : enterprise).trim();
  return personalText === enterpriseText ? 1 : 0.5;
}

function performanceFactor(record) {
  return departmentFactor(record && record.departmentPersonal, record && record.departmentEnterprise);
}

function businessValue(record) {
  const factor = performanceFactor(record);
  return roundMoney((safeNumber(record.issuePrice) - safeNumber(record.receivePrice)) * factor);
}

function warningEventsForRecord(record) {
  const threshold = safeNumber(state.settings.alertDays, DEFAULT_ALERT_DAYS);
  const events = [];
  const defs = [
    { type: '合同', kind: 'contract', field: 'contractExpiryDate' },
    { type: '注册证', kind: 'registration', field: 'regExpiryDate' },
    { type: '三类人员证', kind: 'three', field: 'threeExpiryDate' }
  ];
  for (const def of defs) {
    const days = def.type === '合同' ? contractRemainingDays(record) : remainingDays(record[def.field]);
    if (days === null || days >= threshold) continue;
    events.push({
      recordId: record.id,
      name: record.name,
      certificateType: record.certificateType || '未分类证书',
      documentType: def.type,
      kind: def.kind,
      expiryDate: record[def.field],
      days,
      owner: record.owner || '未指定'
    });
  }
  return events;
}

function getAllWarningEvents() {
  return state.records
    .filter((record) => !record.deletedAt)
    .flatMap(warningEventsForRecord)
    .sort((a, b) => a.days - b.days || a.name.localeCompare(b.name, 'zh-CN'));
}

function recordStatus(record) {
  if (record.deletedAt) return { key: 'deleted', label: '已删除' };
  const warnings = warningEventsForRecord(record);
  if (warnings.length) return { key: 'warning', label: '⚠️ 即将过期' };
  if (!computeContractExpiry(record) && !record.regExpiryDate && !record.threeExpiryDate) return { key: 'pending', label: '待完善日期' };
  return { key: 'normal', label: '正常' };
}

function remainingCell(days, kind = 'general') {
  if (days === null) return '<span class="muted">—</span>';
  const threshold = safeNumber(state.settings.alertDays, DEFAULT_ALERT_DAYS);
  const kindClass = { contract: 'contract-warning', three: 'three-warning', registration: 'reg-warning' }[kind] || '';
  if (days < 0) return `<span class="day-badge ${kindClass || 'expired'} expired">已过期 ${Math.abs(days)} 天</span>`;
  if (days < threshold) return `<span class="day-badge ${kindClass || 'soon'}">${days} 天</span>`;
  return `<span class="day-badge normal">${days} 天</span>`;
}

function phoneCell(record) {
  if (!record.phoneCipher) return '<span class="muted">未录入</span>';
  const revealed = state.revealedPhones.get(record.id);
  if (revealed && revealed.until > Date.now()) {
    return `<span class="phone-visible">${escapeHtml(revealed.value)}</span>
      <button class="row-button" data-action="hide-phone" data-record-id="${escapeHtml(record.id)}">隐藏</button>`;
  }
  return `<button class="phone-hidden" data-action="reveal-phone" data-record-id="${escapeHtml(record.id)}" title="验证后查看手机号">
    <span>${maskPhone()}</span><span>查看</span>
  </button>`;
}

/* ---------------- 页面渲染 ---------------- */

function renderAll() {
  renderPageChrome();
  renderDashboard();
  renderLedger();
  renderSecurityStatus();
}

function renderPageChrome() {
  const meta = PAGE_META[state.activePage] || PAGE_META.dashboard;
  $('#page-eyebrow').textContent = meta.eyebrow;
  $('#page-title').textContent = meta.title;
  $('#page-subtitle').textContent = meta.subtitle;
  $$('.nav-item[data-page]').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === state.activePage);
  });
  $$('.page').forEach((page) => {
    page.classList.toggle('active', page.id === `page-${state.activePage}`);
  });
}

function renderSecurityStatus() {
  const dot = $('#security-dot');
  const label = $('#security-label');
  if (!state.vault) {
    dot.classList.remove('ready');
    label.textContent = '安全中心未初始化';
  } else if (state.sessionKey) {
    dot.classList.add('ready');
    label.textContent = '安全会话已解锁';
  } else {
    dot.classList.remove('ready');
    label.textContent = '安全会话已锁定';
  }
}

function renderDashboard() {
  const monthKey = currentMonthKey();
  const monthLabel = `${monthKey.replace('-', '年')}月`;
  const plan = safeNumber(state.settings.monthlyPlans?.[monthKey], 0);
  const monthRecords = state.records.filter((record) => !record.deletedAt && record.adjustmentDate?.startsWith(monthKey));
  const actual = monthRecords.reduce((sum, record) => sum + businessValue(record), 0);
  const monthlyPayment = state.records
    .filter((record) => !record.deletedAt && recordPaymentDate(record).startsWith(monthKey))
    .reduce((sum, record) => sum + safeNumber(record.paymentAmount), 0);
  const monthlySigning = monthRecords.reduce((sum, record) => sum + safeNumber(record.issuePrice), 0);
  const percent = plan > 0 ? (actual / plan) * 100 : 0;
  const warnings = getAllWarningEvents();
  const activeRecords = state.records.filter((record) => !record.deletedAt);

  $('#dashboard-month-label').textContent = `${monthLabel} · 合同、回款、业绩与到期风险实时计算`;
  const planInput = $('#monthly-plan-input');
  if (planInput && document.activeElement !== planInput) planInput.value = plan || '';
  $('#metric-actual').textContent = formatMoney(actual);
  $('#metric-monthly-contracts').textContent = monthRecords.length;
  $('#metric-monthly-payment').textContent = formatMoney(monthlyPayment);
  $('#metric-monthly-signing').textContent = formatMoney(monthlySigning);
  $('#metric-warning-count').textContent = warnings.length;
  $('#metric-alert-days').textContent = state.settings.alertDays;
  $('#metric-progress-text').textContent = plan > 0 ? `${percent.toFixed(percent >= 100 ? 1 : 0)}%` : '0%';
  $('#metric-progress-bar').style.width = `${Math.min(Math.max(percent, 0), 100)}%`;
  $('#metric-progress-bar').classList.toggle('over', percent >= 100);
  $('#metric-progress-note').textContent = plan > 0
    ? `已完成 ${formatMoney(actual)} / 计划 ${formatMoney(plan)}`
    : '请先输入并保存当月计划业绩';

  renderTrendChart();
  renderCertificateDistribution(activeRecords);
  renderWarningList(warnings);
}

function renderTrendChart() {
  const container = $('#trend-chart');
  const months = monthRange(6);
  const values = months.map((month) => state.records
    .filter((record) => !record.deletedAt && record.adjustmentDate?.startsWith(month))
    .reduce((sum, record) => sum + businessValue(record), 0));
  const max = Math.max(...values, 1);
  container.innerHTML = months.map((month, index) => {
    const value = values[index];
    const height = value > 0 ? Math.max(8, Math.round((value / max) * 100)) : 2;
    const isCurrent = month === currentMonthKey();
    return `<div class="bar-column${isCurrent ? ' current' : ''}" title="${escapeHtml(formatMoney(value))}">
      <span class="bar-value">${escapeHtml(formatCompactMoney(value))}</span>
      <div class="bar-track"><div class="bar-fill" style="height:${height}%"></div></div>
      <span class="bar-month">${escapeHtml(formatShortMonth(month))}</span>
    </div>`;
  }).join('');
}

function renderCertificateDistribution(records) {
  const container = $('#cert-distribution');
  if (!records.length) {
    container.innerHTML = '<div class="empty-state"><div><span class="empty-icon">▥</span>暂无证书数据</div></div>';
    return;
  }
  const counts = new Map();
  records.forEach((record) => {
    const key = record.certificateType || '未分类证书';
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = Math.max(...entries.map((entry) => entry[1]), 1);
  container.innerHTML = entries.map(([type, count]) => `
    <div class="distribution-row">
      <div class="distribution-meta">
        <strong title="${escapeHtml(type)}">${escapeHtml(type)}</strong>
        <span>${count} 条 · ${Math.round(count / records.length * 100)}%</span>
      </div>
      <div class="distribution-track"><div class="distribution-fill" style="width:${Math.max(4, count / max * 100)}%"></div></div>
    </div>
  `).join('');
}

function renderWarningList(warnings) {
  const container = $('#warning-list');
  if (!warnings.length) {
    container.innerHTML = `<div class="empty-state">
      <div><span class="empty-icon">✓</span>当前没有 ${escapeHtml(state.settings.alertDays)} 天内到期的证书</div>
    </div>`;
    return;
  }
  container.innerHTML = warnings.map((event) => {
    const dayText = event.days < 0 ? `已过期 ${Math.abs(event.days)} 天` : `剩余 ${event.days} 天`;
    const dayClass = event.kind ? `${event.kind}-warning` : (event.days < 0 ? 'expired' : 'soon');
    return `<button class="warning-item" data-action="jump-record" data-record-id="${escapeHtml(event.recordId)}">
      <span class="warning-person"><strong>${escapeHtml(event.name || '未命名')}</strong><span>${escapeHtml(event.owner)}</span></span>
      <span class="warning-cert" title="${escapeHtml(event.certificateType)}">${escapeHtml(event.certificateType)}</span>
      <span><span class="record-status ${event.kind || 'warning'}">${escapeHtml(event.documentType)}</span></span>
      <span class="warning-days ${dayClass}">${escapeHtml(dayText)}</span>
      <span class="muted">到期日 ${escapeHtml(formatDisplayDate(event.expiryDate))}</span>
      <span class="warning-arrow">›</span>
    </button>`;
  }).join('');
}
function populateFilterOptions() {
  const typeSelect = $('#filter-type');
  const ownerSelect = $('#filter-owner');
  const typeValue = state.filters.certificateType;
  const ownerValue = state.filters.owner;
  const types = Array.from(new Set(state.records.map((record) => record.certificateType).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const owners = Array.from(new Set(state.records.map((record) => record.owner).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  typeSelect.innerHTML = `<option value="">全部类型</option>${types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('')}`;
  ownerSelect.innerHTML = `<option value="">全部负责人</option>${owners.map((owner) => `<option value="${escapeHtml(owner)}">${escapeHtml(owner)}</option>`).join('')}`;
  typeSelect.value = typeValue;
  ownerSelect.value = ownerValue;
}

function getFilteredRecords() {
  if (state.filters.focusId) {
    return state.records.filter((record) => record.id === state.filters.focusId);
  }

  const search = state.filters.search.trim().toLocaleLowerCase('zh-CN');
  return state.records
    .filter((record) => {
      const isDeleted = Boolean(record.deletedAt);
      if (state.filters.status === 'deleted') {
        if (!isDeleted) return false;
      } else {
        if (isDeleted) return false;
        const warnings = warningEventsForRecord(record);
        if (state.filters.status === 'warning' && !warnings.length) return false;
        if (state.filters.status === 'normal' && warnings.length) return false;
      }
      if (state.filters.certificateType && record.certificateType !== state.filters.certificateType) return false;
      if (state.filters.owner && record.owner !== state.filters.owner) return false;
      if (state.filters.dateFrom && (!record.adjustmentDate || record.adjustmentDate < state.filters.dateFrom)) return false;
      if (state.filters.dateTo && (!record.adjustmentDate || record.adjustmentDate > state.filters.dateTo)) return false;
      if (search) {
        const haystack = [
          record.id,
          record.name,
          record.departmentPersonal,
          record.departmentEnterprise,
          record.certificateType,
          record.owner,
          record.remarks
        ].join(' ').toLocaleLowerCase('zh-CN');
        if (!haystack.includes(search)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const dateA = a.adjustmentDate || '';
      const dateB = b.adjustmentDate || '';
      if (dateA !== dateB) {
        if (!dateA) return 1;
        if (!dateB) return -1;
        return dateB.localeCompare(dateA);
      }
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
}

function pageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = new Set([1, total, current - 1, current, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((page) => pages.add(page));
  if (current >= total - 2) [total - 3, total - 2, total - 1].forEach((page) => pages.add(page));
  const sorted = Array.from(pages).filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const result = [];
  sorted.forEach((page, index) => {
    if (index && page - sorted[index - 1] > 1) result.push('ellipsis');
    result.push(page);
  });
  return result;
}

function renderLedger() {
  populateFilterOptions();
  const records = getFilteredRecords();
  const total = records.length;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  state.page = Math.min(Math.max(1, state.page), totalPages);
  const start = (state.page - 1) * state.pageSize;
  const pageRecords = records.slice(start, start + state.pageSize);
  const tbody = $('#ledger-table-body');

  $('#ledger-count').textContent = state.filters.focusId
    ? `定位结果：${total} 条`
    : `共 ${total} 条 · 当前第 ${state.page}/${totalPages} 页`;
  $('#ledger-formula-note').textContent = '业绩 =（出证价 - 收证价）× 业绩系数（人才部与企业部相同为 1，不同为 0.5）';

  if (!pageRecords.length) {
    tbody.innerHTML = `<tr><td colspan="23"><div class="empty-state"><div><span class="empty-icon">⌕</span>没有符合筛选条件的记录</div></div></td></tr>`;
  } else {
    tbody.innerHTML = pageRecords.map(renderLedgerRow).join('');
  }
  renderPagination(totalPages);
  renderFocusBanner();
}

function renderLedgerRow(record) {
  const status = recordStatus(record);
  const contractDays = contractRemainingDays(record);
  const regDays = remainingDays(record.regExpiryDate);
  const threeDays = remainingDays(record.threeExpiryDate);
  const deleted = Boolean(record.deletedAt);
  const actionButtons = deleted
    ? `<button class="row-button" data-action="restore-record" data-record-id="${escapeHtml(record.id)}">恢复</button>`
    : `<button class="row-button" data-action="edit-record" data-record-id="${escapeHtml(record.id)}">编辑</button>
       <button class="row-button danger" data-action="delete-record" data-record-id="${escapeHtml(record.id)}">删除</button>`;
  return `<tr id="row-${escapeHtml(record.id)}" class="${deleted ? 'deleted' : ''}">
    <td>${escapeHtml(formatDisplayDate(record.adjustmentDate))}</td>
    <td class="name-cell"><strong>${escapeHtml(record.name || '未命名')}</strong>${record.sourceRow ? `<span>原表第 ${escapeHtml(record.sourceRow)} 行</span>` : ''}</td>
    <td class="phone-cell">${phoneCell(record)}</td>
    <td>${escapeHtml(record.departmentPersonal || '—')}</td>
    <td>${escapeHtml(record.departmentEnterprise || '—')}</td>
    <td>${escapeHtml(record.certificateType || '—')}</td>
    <td class="number-cell money-cell">${escapeHtml(formatMoney(record.receivePrice))}</td>
    <td class="number-cell money-cell">${escapeHtml(formatMoney(record.issuePrice))}</td>
    <td class="number-cell money-cell">${escapeHtml(formatMoney(record.paymentAmount))}</td>
    <td>${escapeHtml(formatDisplayDate(record.paymentDate))}</td>
    <td class="number-cell money-cell" title="业绩系数 ×${performanceFactor(record)}">${escapeHtml(formatMoney(businessValue(record)))}</td>
    <td>${escapeHtml(formatDisplayDate(record.registrationDate))}</td>
    <td class="number-cell">${record.contractMonths ? `${escapeHtml(record.contractMonths)} 个月` : '—'}</td>
    <td>${escapeHtml(formatDisplayDate(computeContractExpiry(record)))}</td>
    <td class="number-cell">${remainingCell(contractDays, 'contract')}</td>
    <td>${escapeHtml(formatDisplayDate(record.regExpiryDate))}</td>
    <td class="number-cell">${remainingCell(regDays, 'registration')}</td>
    <td>${escapeHtml(formatDisplayDate(record.threeExpiryDate))}</td>
    <td class="number-cell">${remainingCell(threeDays, 'three')}</td>
    <td><span class="record-status ${status.key}">${escapeHtml(status.label)}</span></td>
    <td>${escapeHtml(record.owner || '未指定')}</td>
    <td class="remark-cell" title="${escapeHtml(record.remarks || '')}">${escapeHtml(record.remarks || '—')}</td>
    <td class="actions-cell"><div class="row-actions">${actionButtons}</div></td>
  </tr>`;
}

function renderPagination(totalPages) {
  const pages = pageNumbers(state.page, totalPages);
  const html = [
    `<button class="page-button" data-action="page-prev" ${state.page <= 1 ? 'disabled' : ''}>‹</button>`,
    ...pages.map((page) => page === 'ellipsis'
      ? '<span class="muted">…</span>'
      : `<button class="page-button ${page === state.page ? 'active' : ''}" data-action="go-page" data-page="${page}">${page}</button>`),
    `<button class="page-button" data-action="page-next" ${state.page >= totalPages ? 'disabled' : ''}>›</button>`
  ].join('');
  $('#pagination').innerHTML = html;
}

function renderFocusBanner() {
  const banner = $('#ledger-focus-banner');
  if (!state.filters.focusId) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  const record = state.records.find((item) => item.id === state.filters.focusId);
  banner.hidden = false;
  banner.innerHTML = `<span>已定位到：<strong>${escapeHtml(record?.name || '未知记录')}</strong> · ${escapeHtml(record?.certificateType || '')}</span>
    <button class="text-button" data-action="clear-focus">清除定位</button>`;
}

function jumpToRecord(recordId) {
  state.filters.focusId = recordId;
  state.activePage = 'ledger';
  state.page = 1;
  renderAll();
  requestAnimationFrame(() => {
    const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(recordId) : recordId.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    const row = $(`#row-${safeId}`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}
/* ---------------- 弹窗与安全交互 ---------------- */

function showToast(message, type = 'success', timeout = 3200) {
  const root = $('#toast-root');
  const icon = type === 'error' ? '!': type === 'warning' ? '!' : '✓';
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${escapeHtml(message)}</span>`;
  root.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(6px)';
    setTimeout(() => toast.remove(), 180);
  }, timeout);
}

function openModal({ title, subtitle = '', content = '', footer = '', size = '', closeDisabled = false, onOpen = null }) {
  const root = $('#modal-root');
  state.modal = { closeDisabled, onOpen };
  root.innerHTML = `<div class="modal-backdrop" id="modal-backdrop">
    <section class="modal ${size}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-header">
        <div><h2 id="modal-title">${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>
        ${closeDisabled ? '' : '<button class="modal-close" type="button" data-action="close-modal" aria-label="关闭">×</button>'}
      </header>
      <div class="modal-body">${content}</div>
      ${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}
    </section>
  </div>`;
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => $('#modal-backdrop')?.classList.add('visible'));
  if (typeof onOpen === 'function') onOpen();
}

function closeModal(force = false) {
  if (!state.modal || (state.modal.closeDisabled && !force)) return;
  const root = $('#modal-root');
  root.querySelector('#modal-backdrop')?.classList.remove('visible');
  if (state.authResolver) {
    state.authResolver(false);
    state.authResolver = null;
  }
  state.modal = null;
  document.body.style.overflow = '';
  setTimeout(() => {
    if (!state.modal) root.innerHTML = '';
  }, 180);
}

function requestPassword(title = '安全验证', message = '请输入管理密码后继续。') {
  return new Promise((resolve) => {
    if (!state.vault) {
      showToast('请先初始化安全密码。', 'warning');
      resolve(false);
      return;
    }
    state.authResolver = resolve;
    openModal({
      title,
      subtitle: '敏感信息二次验证',
      size: 'small',
      content: `<form id="auth-form" class="form-grid" autocomplete="off">
        <div class="form-group span-3">
          <div class="security-box"><span class="security-box-icon">⌾</span><span>${escapeHtml(message)}</span></div>
        </div>
        <div class="form-group span-3">
          <label for="auth-password">管理密码</label>
          <input id="auth-password" name="password" type="password" required autocomplete="current-password" autofocus>
          <div class="form-error" id="auth-error" hidden></div>
        </div>
      </form>`,
      footer: '<button class="button subtle" type="button" data-action="close-modal">取消</button><button class="button primary" type="submit" form="auth-form">验证</button>'
    });
  });
}

function openSetupVault() {
  openModal({
    title: '初始化安全密码',
    subtitle: '用于加密手机号，并在每次查看时进行二次验证',
    size: 'small',
    content: `<form id="setup-vault-form" class="form-grid" autocomplete="off">
      <div class="form-group span-3">
        <div class="security-box"><span class="security-box-icon">🔐</span><span>系统不会保存明文密码。密码至少 6 位，请妥善保管；忘记密码后，已加密手机号无法恢复。</span></div>
      </div>
      <div class="form-group span-3">
        <label for="setup-password">管理密码</label>
        <input id="setup-password" name="password" type="password" minlength="6" required autocomplete="new-password">
      </div>
      <div class="form-group span-3">
        <label for="setup-password-confirm">确认密码</label>
        <input id="setup-password-confirm" name="confirmPassword" type="password" minlength="6" required autocomplete="new-password">
      </div>
      <div class="form-error" id="setup-error" hidden></div>
    </form>`,
    footer: '<button class="button subtle" type="button" data-action="close-modal">稍后设置</button><button class="button primary" type="submit" form="setup-vault-form">创建安全中心</button>'
  });
}

function openSecurityCenter() {
  if (!state.vault) {
    openSetupVault();
    return;
  }
  if (!state.sessionKey) {
    requestPassword('进入安全设置', '验证成功后可管理密码、备份与日志。').then((ok) => {
      if (ok) openSettingsModal();
    });
    return;
  }
  openSettingsModal();
}

function openSettingsModal() {
  const certificates = (state.settings.certificateTypes || []).join('\n');
  const owners = (state.settings.owners || []).join('\n');
  openModal({
    title: '系统设置',
    subtitle: '计算规则、选项维护、数据备份与安全操作',
    size: 'large',
    content: `<form id="settings-form">
      <div class="settings-grid">
        <section class="settings-section">
          <h3>计算与预警规则</h3>
          <p>修改后首页与台账将立即重新计算。</p>
          <div class="form-group">
            <label for="settings-alert-days">提前预警天数</label>
            <input id="settings-alert-days" name="alertDays" type="number" min="1" max="365" value="${escapeHtml(state.settings.alertDays)}" required>
          </div>
          <div class="form-group">
            <label>业绩系数（自动计算）</label>
            <span class="form-help">人才部与企业部相同时系数为 1，不同时为 0.5；业绩 =（出证价 - 收证价）× 系数，无需手工设置。</span>
          </div>
        </section>
        <section class="settings-section">
          <h3>安全与维护</h3>
          <p>手机号仅以 AES-GCM 密文形式保存在本机。</p>
          <div class="security-box"><span class="security-box-icon">⌾</span><span>当前安全会话：<strong>${state.sessionKey ? '已解锁' : '已锁定'}</strong>。导出加密备份不需要密码，恢复后使用原密码解锁。</span></div>
          <div class="settings-actions">
            <button class="button ghost small" type="button" data-action="change-password">修改密码</button>
            <button class="button ghost small" type="button" data-action="export-backup">导出加密备份</button>
            <button class="button ghost small" type="button" data-action="trigger-restore">恢复备份</button>
            <button class="button subtle small" type="button" data-action="open-logs">查看操作日志</button>
          </div>
          <input id="restore-backup-input" type="file" accept=".json,application/json" hidden>
        </section>
        <section class="settings-section">
          <h3>证书类型选项</h3>
          <p>每行一个，新增记录时会出现在下拉建议中。</p>
          <div class="form-group"><textarea id="settings-cert-types" name="certificateTypes" spellcheck="false">${escapeHtml(certificates)}</textarea></div>
        </section>
        <section class="settings-section">
          <h3>负责人选项</h3>
          <p>每行一个，用于预警责任归属与筛选。</p>
          <div class="form-group"><textarea id="settings-owners" name="owners" spellcheck="false">${escapeHtml(owners)}</textarea></div>
        </section>
      </div>
    </form>`,
    footer: '<span class="footer-left">设置保存在当前浏览器</span><button class="button subtle" type="button" data-action="close-modal">取消</button><button class="button primary" type="submit" form="settings-form">保存设置</button>'
  });
}

async function openLogsModal() {
  const verification = await verifyLogChain();
  const statusClass = verification.ok ? 'ok' : 'bad';
  const statusText = verification.ok ? '哈希链验证通过，未发现日志篡改' : '警告：日志哈希链不连续，可能被外部修改';
  const entries = [...state.logs].reverse();
  const content = `<div class="chain-status ${statusClass}"><span>${verification.ok ? '✓' : '!'}</span><span>${statusText}</span></div>
    <div class="log-list">${entries.length ? entries.map((entry) => `
      <div class="log-item">
        <span class="log-time">${escapeHtml(entry.timestamp)}</span>
        <span class="log-action">${escapeHtml(entry.action)}</span>
        <span class="log-detail">${escapeHtml(typeof entry.details === 'string' ? entry.details : JSON.stringify(entry.details))}${entry.recordId ? ` · 记录 ${escapeHtml(entry.recordId)}` : ''}</span>
      </div>`).join('') : '<div class="empty-state">暂无操作日志</div>'}</div>`;
  openModal({
    title: '操作日志',
    subtitle: `共 ${state.logs.length} 条，按时间倒序显示`,
    size: 'large',
    content,
    footer: '<button class="button ghost" type="button" data-action="export-logs">导出日志 CSV</button><button class="button primary" type="button" data-action="close-modal">关闭</button>'
  });
}
/* ---------------- 台账编辑 ---------------- */

function recordFormValue(record, key) {
  const value = record?.[key];
  return value === null || value === undefined ? '' : String(value);
}

function openRecordModal(recordId = '') {
  if (!state.vault) {
    showToast('请先初始化安全密码，再维护台账。', 'warning');
    openSetupVault();
    return;
  }
  const record = recordId ? state.records.find((item) => item.id === recordId) : null;
  if (recordId && !record) {
    showToast('未找到对应记录。', 'error');
    return;
  }
  const isEdit = Boolean(record);
  const certificateOptions = (state.settings.certificateTypes || [])
    .map((value) => `<option value="${escapeHtml(value)}"></option>`).join('');
  const ownerOptions = (state.settings.owners || [])
    .map((value) => `<option value="${escapeHtml(value)}"></option>`).join('');
  const currentPhoneText = record?.phoneCipher ? '当前手机号已加密保存。留空保持不变。' : '手机号将加密保存，默认显示为掩码。';
  const contractMonthsValue = Math.min(36, Math.max(1, Math.round(safeNumber(record?.contractMonths, 12)) || 12));
  const contractMonthOptions = Array.from({ length: 36 }, (_, index) => index + 1)
    .map((value) => `<option value="${value}" ${value === contractMonthsValue ? 'selected' : ''}>${value} 个月</option>`).join('');

  const content = `<form id="record-form" class="form-grid" autocomplete="off">
    <div class="form-group">
      <label for="record-adjustment-date">调证日期</label>
      <input id="record-adjustment-date" name="adjustmentDate" type="date" value="${escapeHtml(isEdit ? recordFormValue(record, 'adjustmentDate') : localIsoDate())}">
    </div>
    <div class="form-group">
      <label for="record-name">人才姓名 *</label>
      <input id="record-name" name="name" type="text" required value="${escapeHtml(recordFormValue(record, 'name'))}" placeholder="请输入姓名">
    </div>
    <div class="form-group">
      <label for="record-phone">手机号</label>
      <div style="display:flex;gap:7px">
        <input id="record-phone" name="phone" type="tel" inputmode="tel" value="" placeholder="${record?.phoneCipher ? '已加密，输入新号码可替换' : '请输入手机号'}">
        ${record?.phoneCipher ? '<button class="button subtle small" type="button" data-action="fill-current-phone">查看当前</button>' : ''}
      </div>
      <span class="form-help">${currentPhoneText}</span>
    </div>
    <div class="form-group">
      <label for="record-department-personal">人才部</label>
      <input id="record-department-personal" name="departmentPersonal" type="text" value="${escapeHtml(recordFormValue(record, 'departmentPersonal'))}">
    </div>
    <div class="form-group">
      <label for="record-department-enterprise">企业部</label>
      <input id="record-department-enterprise" name="departmentEnterprise" type="text" value="${escapeHtml(recordFormValue(record, 'departmentEnterprise'))}">
    </div>
    <div class="form-group">
      <label for="record-certificate-type">证书类型</label>
      <input id="record-certificate-type" name="certificateType" type="text" list="certificate-type-options" value="${escapeHtml(recordFormValue(record, 'certificateType'))}" placeholder="选择或直接输入">
      <datalist id="certificate-type-options">${certificateOptions}</datalist>
    </div>
    <div class="form-group">
      <label for="record-receive-price">收证价（元）</label>
      <input id="record-receive-price" name="receivePrice" type="number" min="0" step="0.01" value="${escapeHtml(recordFormValue(record, 'receivePrice'))}" placeholder="0.00">
    </div>
    <div class="form-group">
      <label for="record-issue-price">出证价（元）</label>
      <input id="record-issue-price" name="issuePrice" type="number" min="0" step="0.01" value="${escapeHtml(recordFormValue(record, 'issuePrice'))}" placeholder="0.00">
    </div>
    <div class="form-group">
      <label for="record-payment-amount">回款金额（元）</label>
      <input id="record-payment-amount" name="paymentAmount" type="number" min="0" step="0.01" value="${escapeHtml(recordFormValue(record, 'paymentAmount'))}" placeholder="0.00">
    </div>
    <div class="form-group">
      <label for="record-payment-date">回款日期</label>
      <input id="record-payment-date" name="paymentDate" type="date" value="${escapeHtml(recordFormValue(record, 'paymentDate') || (isEdit ? '' : localIsoDate()))}">
    </div>
    <div class="form-group">
      <label for="record-owner">负责人</label>
      <input id="record-owner" name="owner" type="text" list="owner-options" value="${escapeHtml(recordFormValue(record, 'owner'))}" placeholder="选择或直接输入">
      <datalist id="owner-options">${ownerOptions}</datalist>
    </div>
    <div class="form-group">
      <label for="record-registration-date">注册证办结日期</label>
      <input id="record-registration-date" name="registrationDate" type="date" value="${escapeHtml(recordFormValue(record, 'registrationDate'))}">
    </div>
    <div class="form-group">
      <label for="record-contract-months">合同有效期（月）</label>
      <select id="record-contract-months" name="contractMonths">
        <option value="">请选择</option>
        ${contractMonthOptions}
      </select>
      <span class="form-help">支持 1–36 个月，以注册证办结日期为起点自动计算</span>
    </div>
    <div class="form-group">
      <label for="record-contract-expiry-date">合同到期日</label>
      <input id="record-contract-expiry-date" name="contractExpiryDate" type="date" value="${escapeHtml(recordFormValue(record, 'contractExpiryDate'))}" readonly tabindex="-1">
      <span class="form-help">根据注册证办结日期和合同月数自动生成</span>
    </div>
    <div class="form-group">
      <label for="record-reg-expiry-date">注册证有效期</label>
      <input id="record-reg-expiry-date" name="regExpiryDate" type="date" value="${escapeHtml(recordFormValue(record, 'regExpiryDate'))}">
    </div>
    <div class="form-group">
      <label for="record-three-expiry-date">三类人员证有效期</label>
      <input id="record-three-expiry-date" name="threeExpiryDate" type="date" value="${escapeHtml(recordFormValue(record, 'threeExpiryDate'))}">
    </div>
    <div class="form-group span-3">
      <label for="record-remarks">备注</label>
      <textarea id="record-remarks" name="remarks" placeholder="费用说明、续签情况或其他需要跟踪的信息">${escapeHtml(recordFormValue(record, 'remarks'))}</textarea>
      ${record?.phoneCipher ? '<label class="checkbox-line"><input type="checkbox" name="clearPhone"> 清空已保存的手机号</label>' : ''}
    </div>
    <div class="form-group span-3">
      <div class="security-box"><span class="security-box-icon">🔒</span><span>手机号在提交时加密；若当前安全会话已锁定，系统会要求验证管理密码。</span></div>
    </div>
    <div class="calc-preview expanded span-3">
      <div><span>业绩</span><strong id="preview-business">¥0</strong></div>
      <div><span>合同到期日</span><strong id="preview-contract">待完善</strong></div>
      <div><span>合同 / 注册证剩余</span><strong id="preview-days">— / —</strong></div>
      <div><span>三类证剩余</span><strong id="preview-three-days">—</strong></div>
    </div>
  </form>`;

  openModal({
    title: isEdit ? '编辑证书记录' : '新增证书记录',
    subtitle: isEdit ? `正在编辑：${record.name || '未命名'}` : '日期可直接点击日历选择，计算字段将自动更新',
    size: 'xlarge',
    content,
    footer: '<span class="footer-left">带 * 为必填项</span><button class="button subtle" type="button" data-action="close-modal">取消</button><button class="button primary" type="submit" form="record-form">保存记录</button>',
    onOpen: () => {
      const form = $('#record-form');
      form.dataset.recordId = recordId || '';
      updateRecordPreview();
      $('#record-name')?.focus();
    }
  });
}
function formText(form, name) {
  return String(form.elements.namedItem(name)?.value || '').trim();
}

function updateRecordPreview() {
  const form = $('#record-form');
  if (!form) return;
  const receive = safeNumber(formText(form, 'receivePrice'));
  const issue = safeNumber(formText(form, 'issuePrice'));
  const factor = departmentFactor(formText(form, 'departmentPersonal'), formText(form, 'departmentEnterprise'));
  const registrationDate = formText(form, 'registrationDate');
  const contractMonths = safeNumber(formText(form, 'contractMonths'), 0);
  const contractExpiryDate = addMonthsClamped(registrationDate, contractMonths);
  const regExpiryDate = formText(form, 'regExpiryDate');
  const threeExpiryDate = formText(form, 'threeExpiryDate');
  const contractField = form.elements.namedItem('contractExpiryDate');
  if (contractField) contractField.value = contractExpiryDate || '';
  const contractDays = remainingDays(contractExpiryDate);
  const regDays = remainingDays(regExpiryDate);
  const threeDays = remainingDays(threeExpiryDate);
  $('#preview-business').textContent = formatMoney((issue - receive) * factor);
  $('#preview-contract').textContent = contractExpiryDate
    ? `${formatDisplayDate(contractExpiryDate)}（${contractDays} 天）`
    : '待完善';
  $('#preview-days').textContent = `${contractDays === null ? '—' : `${contractDays} 天`} / ${regDays === null ? '—' : `${regDays} 天`}`;
  $('#preview-three-days').textContent = threeDays === null ? '—' : `${threeDays} 天`;
}
/* ---------------- CSV 导入 ---------------- */

function openImportModal() {
  openModal({
    title: '从 CSV 导入数据',
    subtitle: '兼容 Excel / WPS 导出的 UTF-8 CSV 文件',
    size: 'large',
    content: `<form id="import-form" class="form-grid">
      <div class="form-group span-3">
        <div class="import-guide">
          <strong>推荐表头：</strong><code>调证日期, 人才姓名, 手机号, 人才部, 企业部, 证书类型, 收证价, 出证价, 回款金额, 回款日期, 注册证办结日期, 合同有效期, 注册证有效期, 三类人员证有效期, 负责人, 备注</code><br>
          日期可使用 <code>2026-09-14</code>、<code>2026.9.14</code> 或 Excel 日期序列；不需要的列可省略。
        </div>
      </div>
      <div class="form-group span-3">
        <label>选择 CSV 文件</label>
        <div class="file-drop"><input id="import-file" name="file" type="file" accept=".csv,text/csv" required><span>在 Excel/WPS 中另存为“CSV UTF-8（逗号分隔）”</span></div>
      </div>
      <div class="form-group span-3">
        <label class="checkbox-line"><input id="import-include-phone" name="includePhone" type="checkbox"> CSV 中包含明文手机号，导入时立即加密</label>
        <span class="form-help">若勾选，导入前需要验证或输入安全密码。明文手机号不会写入浏览器存储。</span>
      </div>
      <div class="form-error" id="import-error" hidden></div>
    </form>`,
    footer: '<button class="button subtle" type="button" data-action="close-modal">取消</button><button class="button primary" type="submit" form="import-form">开始导入</button>'
  });
}
/* ---------------- CSV 解析与导出 ---------------- */

function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => String(value).trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => String(value).trim() !== '')) rows.push(row);
  if (rows[0]?.[0]?.toLowerCase().startsWith('sep=')) rows.shift();
  return rows;
}

function normalizeHeader(value) {
  return String(value || '').replace(/[\s\u3000_\-()（）]/g, '').toLowerCase();
}

function buildHeaderMap(headerRow) {
  const aliasLookup = new Map();
  Object.entries(HEADER_ALIASES).forEach(([field, aliases]) => {
    aliases.forEach((alias) => aliasLookup.set(normalizeHeader(alias), field));
  });
  const map = {};
  headerRow.forEach((header, index) => {
    const field = aliasLookup.get(normalizeHeader(header));
    if (field && map[field] === undefined) map[field] = index;
  });
  return map;
}

function csvValue(row, index) {
  return index === undefined ? '' : String(row[index] ?? '').trim();
}

function csvCell(value) {
  let text = String(value ?? '');
  const looksNumeric = /^-?\d+(\.\d+)?$/.test(text);
  if (!looksNumeric && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function buildCsv(headers, rows) {
  return `\uFEFF${headers.map(csvCell).join(',')}\r\n${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function downloadBlob(content, filename, type) {
  // 安卓 App 内：优先用系统“保存/分享”面板导出，WebView 里 a[download] 常常不生效
  if (window.__nativeSave) {
    window.__nativeSave(content, filename, type);
    return;
  }
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importCsvFile(file, includePhone) {
  if (!file) throw new Error('请选择 CSV 文件');
  const text = await file.text();
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV 中没有可导入的数据行');
  const headerMap = buildHeaderMap(rows[0]);
  if (headerMap.name === undefined) throw new Error('未找到“人才姓名”列，请检查表头');
  if (includePhone && !state.vault) throw new Error('请先在安全设置中创建管理密码');
  if (includePhone && !state.sessionKey) {
    const password = window.prompt('导入包含手机号，请输入管理密码：');
    if (password === null) throw new Error('已取消导入');
    if (!(await unlockVault(password))) throw new Error('密码验证失败');
  }

  const imported = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const name = csvValue(row, headerMap.name);
    if (!name) continue;
    let phoneCipher = '';
    let phoneIv = '';
    if (includePhone && headerMap.phone !== undefined) {
      const phone = csvValue(row, headerMap.phone);
      if (phone && !isMaskedPhone(phone)) {
        const encrypted = await encryptPhoneValue(phone);
        phoneCipher = encrypted.phoneCipher;
        phoneIv = encrypted.phoneIv;
      }
    }
    imported.push(normalizeRecord({
      id: `import-${Date.now()}-${rowIndex}-${Math.random().toString(16).slice(2)}`,
      sourceRow: rowIndex + 1,
      adjustmentDate: csvValue(row, headerMap.adjustmentDate),
      name,
      phoneCipher,
      phoneIv,
      departmentPersonal: csvValue(row, headerMap.departmentPersonal),
      departmentEnterprise: csvValue(row, headerMap.departmentEnterprise),
      certificateType: csvValue(row, headerMap.certificateType),
      receivePrice: csvValue(row, headerMap.receivePrice),
      issuePrice: csvValue(row, headerMap.issuePrice),
      paymentAmount: csvValue(row, headerMap.paymentAmount),
      paymentDate: csvValue(row, headerMap.paymentDate),
      contractMonths: csvValue(row, headerMap.contractMonths),
      contractExpiryDate: csvValue(row, headerMap.contractExpiryDate),
      registrationDate: csvValue(row, headerMap.registrationDate),
      regExpiryDate: csvValue(row, headerMap.regExpiryDate),
      threeExpiryDate: csvValue(row, headerMap.threeExpiryDate),
      owner: csvValue(row, headerMap.owner),
      remarks: csvValue(row, headerMap.remarks)
    }));
  }
  if (!imported.length) throw new Error('未解析到有效记录，请确认“人才姓名”列有内容');
  state.records.push(...imported);
  ensureSettingsOptions();
  await appendLog('CSV 导入', '', `文件 ${file.name}，新增 ${imported.length} 条记录，手机号${includePhone ? '已加密' : '未导入'}`);
  saveState();
  renderAll();
  closeModal(true);
  showToast(`已导入 ${imported.length} 条记录`);
}

function exportLedgerCsv() {
  const active = getFilteredRecords().filter((record) => !record.deletedAt);
  const headers = ['调证日期', '人才姓名', '手机号', '人才部', '企业部', '证书类型', '收证价', '出证价', '回款金额', '回款日期', '业绩', '注册证办结日期', '合同有效期（月）', '合同到期日', '合同到期天数', '注册证有效期', '注册证到期天数', '三类人员证有效期', '三类到期天数', '状态提醒', '负责人', '备注'];
  const rows = active.map((record) => [
    formatDisplayDate(record.adjustmentDate),
    record.name,
    record.phoneCipher ? maskPhone() : '',
    record.departmentPersonal,
    record.departmentEnterprise,
    record.certificateType,
    record.receivePrice,
    record.issuePrice,
    record.paymentAmount,
    formatDisplayDate(record.paymentDate),
    businessValue(record),
    formatDisplayDate(record.registrationDate),
    record.contractMonths,
    formatDisplayDate(computeContractExpiry(record)),
    contractRemainingDays(record) ?? '',
    formatDisplayDate(record.regExpiryDate),
    remainingDays(record.regExpiryDate) ?? '',
    formatDisplayDate(record.threeExpiryDate),
    remainingDays(record.threeExpiryDate) ?? '',
    recordStatus(record).label,
    record.owner,
    record.remarks
  ]);
  downloadBlob(buildCsv(headers, rows), `人才证书台账_${localIsoDate()}.csv`, 'text/csv;charset=utf-8');
  showToast(`已导出 ${rows.length} 条记录（手机号已掩码）`);
}

function exportLogsCsv() {
  const headers = ['时间', '操作人', '操作', '记录ID', '详情', '前一哈希', '当前哈希'];
  const rows = state.logs.map((entry) => [
    entry.timestamp,
    entry.operator,
    entry.action,
    entry.recordId,
    typeof entry.details === 'string' ? entry.details : JSON.stringify(entry.details),
    entry.prevHash,
    entry.hash
  ]);
  downloadBlob(buildCsv(headers, rows), `操作日志_${localIsoDate()}.csv`, 'text/csv;charset=utf-8');
  showToast(`已导出 ${rows.length} 条日志`);
}
/* ---------------- 记录增删改与手机号查看 ---------------- */

async function saveRecordFromForm(form) {
  const recordId = form.dataset.recordId || '';
  const existing = recordId ? state.records.find((item) => item.id === recordId) : null;
  const name = formText(form, 'name');
  if (!name) throw new Error('请填写人才姓名');

  const clearPhone = Boolean(form.elements.namedItem('clearPhone')?.checked);
  const phoneInput = formText(form, 'phone');
  let phoneCipher = existing?.phoneCipher || '';
  let phoneIv = existing?.phoneIv || '';

  if (clearPhone) {
    phoneCipher = '';
    phoneIv = '';
  } else if (phoneInput) {
    if (!state.vault) throw new Error('请先创建安全密码，再录入手机号');
    if (!state.sessionKey) {
      const password = window.prompt('保存手机号需要验证管理密码：');
      if (password === null) throw new Error('已取消保存');
      if (!(await unlockVault(password))) throw new Error('密码验证失败');
    }
    const encryptedPhone = await encryptPhoneValue(phoneInput);
    if (!normalizePhone(phoneInput)) throw new Error('手机号格式无效，请检查后重试');
    phoneCipher = encryptedPhone.phoneCipher;
    phoneIv = encryptedPhone.phoneIv;
  }

  const now = nowText();
  const record = normalizeRecord({
    id: existing?.id || `record-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sourceRow: existing?.sourceRow || null,
    adjustmentDate: formText(form, 'adjustmentDate'),
    name,
    phoneCipher,
    phoneIv,
    departmentPersonal: formText(form, 'departmentPersonal'),
    departmentEnterprise: formText(form, 'departmentEnterprise'),
    certificateType: formText(form, 'certificateType'),
    receivePrice: formText(form, 'receivePrice'),
    issuePrice: formText(form, 'issuePrice'),
    paymentAmount: formText(form, 'paymentAmount'),
    paymentDate: formText(form, 'paymentDate'),
    contractMonths: formText(form, 'contractMonths'),
    contractExpiryDate: formText(form, 'contractExpiryDate'),
    registrationDate: formText(form, 'registrationDate'),
    regExpiryDate: formText(form, 'regExpiryDate'),
    threeExpiryDate: formText(form, 'threeExpiryDate'),
    owner: formText(form, 'owner'),
    remarks: formText(form, 'remarks'),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    deletedAt: existing?.deletedAt || null
  });

  if (existing) {
    const index = state.records.findIndex((item) => item.id === existing.id);
    state.records[index] = record;
    await appendLog('修改记录', record.id, `修改 ${record.name} 的台账信息`);
  } else {
    state.records.push(record);
    await appendLog('新增记录', record.id, `新增 ${record.name} · ${record.certificateType || '未填写证书类型'}`);
  }
  ensureSettingsOptions();
  saveState();
  renderAll();
  closeModal(true);
  showToast(existing ? '记录已更新' : '记录已新增');
}
async function deleteRecord(recordId) {
  const record = state.records.find((item) => item.id === recordId);
  if (!record) return;
  if (!window.confirm(`确定将“${record.name}”移入已删除记录吗？操作日志会保留。`)) return;
  record.deletedAt = nowText();
  record.updatedAt = nowText();
  await appendLog('删除记录', record.id, `将 ${record.name} 移入已删除记录`);
  saveState();
  renderAll();
  showToast('记录已移入已删除列表', 'warning');
}

async function restoreRecord(recordId) {
  const record = state.records.find((item) => item.id === recordId);
  if (!record) return;
  record.deletedAt = null;
  record.updatedAt = nowText();
  await appendLog('恢复记录', record.id, `恢复 ${record.name} 的台账记录`);
  saveState();
  renderAll();
  showToast('记录已恢复');
}

async function revealPhone(recordId) {
  const record = state.records.find((item) => item.id === recordId);
  if (!record?.phoneCipher) return;
  const verified = await requestPassword('查看手机号', '此操作会记录在操作日志中，明文仅显示 30 秒。');
  if (!verified) return;
  try {
    const phone = await decryptPhoneValue(record);
    state.revealedPhones.set(record.id, { value: phone, until: Date.now() + SESSION_REVEAL_MS });
    await appendLog('查看手机号', record.id, `查看 ${record.name} 的手机号（明文未写入日志）`);
    saveState();
    renderLedger();
    setTimeout(() => {
      const current = state.revealedPhones.get(record.id);
      if (current && current.until <= Date.now()) {
        state.revealedPhones.delete(record.id);
        renderLedger();
      }
    }, SESSION_REVEAL_MS + 100);
  } catch (error) {
    showToast(error.message || '手机号解密失败', 'error');
  }
}

function hidePhone(recordId) {
  state.revealedPhones.delete(recordId);
  renderLedger();
}

async function fillCurrentPhone() {
  const form = $('#record-form');
  const recordId = form?.dataset.recordId;
  const record = state.records.find((item) => item.id === recordId);
  if (!record?.phoneCipher) return;
  const password = window.prompt('查看当前手机号需要验证管理密码：');
  if (password === null) return;
  if (!(await unlockVault(password))) {
    showToast('密码验证失败', 'error');
    return;
  }
  try {
    const phone = await decryptPhoneValue(record);
    form.elements.namedItem('phone').value = phone;
    await appendLog('查看手机号', record.id, `在编辑表单中查看 ${record.name} 的手机号（明文未写入日志）`);
    saveState();
    showToast('已填入当前手机号，可直接修改');
  } catch (error) {
    showToast(error.message || '手机号解密失败', 'error');
  }
}
/* ---------------- 设置、备份与密码维护 ---------------- */

async function saveSettingsFromForm(form) {
  const alertDays = Math.max(1, Math.round(safeNumber(formText(form, 'alertDays'), DEFAULT_ALERT_DAYS)));
  const certificateTypes = formText(form, 'certificateTypes').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const owners = formText(form, 'owners').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  state.settings.alertDays = alertDays;
  state.settings.certificateTypes = Array.from(new Set([...DEFAULT_CERT_TYPES, ...certificateTypes]));
  state.settings.owners = Array.from(new Set(owners));
  ensureSettingsOptions();
  await appendLog('修改设置', '', `预警天数=${alertDays}`);
  saveState();
  renderAll();
  closeModal(true);
  showToast('系统设置已保存');
}

async function saveMonthlyPlan() {
  const monthKey = currentMonthKey();
  const value = Math.max(0, safeNumber($('#monthly-plan-input').value, 0));
  state.settings.monthlyPlans[monthKey] = value;
  await appendLog('设置月度计划', '', `${monthKey} 计划业绩=${value}`);
  saveState();
  renderDashboard();
  showToast(`已保存 ${monthKey} 计划业绩`);
}

function exportEncryptedBackup() {
  const payload = {
    version: DATA_VERSION,
    exportedAt: nowText(),
    records: state.records,
    settings: state.settings,
    logs: state.logs,
    vault: state.vault
  };
  downloadBlob(JSON.stringify(payload, null, 2), `人才证书系统加密备份_${localIsoDate()}.json`, 'application/json;charset=utf-8');
  showToast('加密备份已导出');
}

async function restoreEncryptedBackup(file) {
  if (!file) return;
  const text = await file.text();
  const payload = JSON.parse(text);
  if (!Array.isArray(payload.records) || !payload.settings) throw new Error('备份文件结构无效');
  if (!window.confirm(`确定恢复备份吗？当前 ${state.records.length} 条记录将被备份中的 ${payload.records.length} 条记录替换。`)) return;
  state.records = payload.records.map(normalizeRecord);
  state.settings = { ...defaultSettings(), ...(payload.settings || {}) };
  state.settings.monthlyPlans = { ...(payload.settings?.monthlyPlans || {}) };
  state.logs = Array.isArray(payload.logs) ? payload.logs : [];
  state.vault = payload.vault || null;
  state.sessionKey = null;
  state.revealedPhones.clear();
  ensureSettingsOptions();
  await appendLog('恢复备份', '', `从 ${file.name} 恢复 ${state.records.length} 条记录`);
  saveState();
  renderAll();
  closeModal(true);
  showToast('备份已恢复，安全会话已锁定');
}

async function beginChangePassword() {
  const verified = await requestPassword('修改管理密码', '先验证当前密码，再设置新的管理密码。');
  if (!verified) return;
  openModal({
    title: '设置新管理密码',
    subtitle: '修改后，已有手机号会使用新密码重新加密',
    size: 'small',
    content: `<form id="change-password-form" class="form-grid" autocomplete="off">
      <div class="form-group span-3"><label for="new-password">新密码</label><input id="new-password" name="newPassword" type="password" minlength="6" required autocomplete="new-password"></div>
      <div class="form-group span-3"><label for="new-password-confirm">确认新密码</label><input id="new-password-confirm" name="confirmPassword" type="password" minlength="6" required autocomplete="new-password"></div>
      <div class="form-error" id="change-password-error" hidden></div>
    </form>`,
    footer: '<button class="button subtle" type="button" data-action="close-modal">取消</button><button class="button primary" type="submit" form="change-password-form">确认修改</button>'
  });
}

async function changePasswordFromForm(form) {
  const newPassword = formText(form, 'newPassword');
  const confirmPassword = formText(form, 'confirmPassword');
  if (newPassword.length < 6) throw new Error('新密码至少 6 位');
  if (newPassword !== confirmPassword) throw new Error('两次输入的新密码不一致');
  if (!state.sessionKey) throw new Error('安全会话已锁定，请重新验证');

  const phonePlain = new Map();
  for (const record of state.records) {
    if (record.phoneCipher) phonePlain.set(record.id, await decryptPhoneValue(record));
  }
  await createVault(newPassword);
  for (const record of state.records) {
    if (!phonePlain.has(record.id)) continue;
    const encrypted = await encryptPhoneValue(phonePlain.get(record.id));
    record.phoneCipher = encrypted.phoneCipher;
    record.phoneIv = encrypted.phoneIv;
  }
  await appendLog('修改安全密码', '', `重新加密 ${phonePlain.size} 个手机号`);
  saveState();
  renderAll();
  closeModal(true);
  showToast('管理密码已修改，手机号已重新加密');
}
/* ---------------- 事件处理 ---------------- */

function setFormError(id, message) {
  const element = $(`#${id}`);
  if (!element) return;
  element.textContent = message || '';
  element.hidden = !message;
}

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  try {
    if (form.id === 'setup-vault-form') {
      const password = formText(form, 'password');
      const confirmPassword = formText(form, 'confirmPassword');
      if (password.length < 6) throw new Error('密码至少 6 位');
      if (password !== confirmPassword) throw new Error('两次输入的密码不一致');
      await createVault(password);
      await appendLog('初始化安全中心', '', '创建本地 AES-GCM 加密密钥');
      saveState();
      renderSecurityStatus();
      closeModal(true);
      showToast('安全中心已创建，当前会话已解锁');
      return;
    }

    if (form.id === 'auth-form') {
      const password = formText(form, 'password');
      const ok = await unlockVault(password);
      if (!ok) {
        setFormError('auth-error', '密码验证失败，请重新输入。');
        form.elements.namedItem('password').select();
        return;
      }
      const resolver = state.authResolver;
      state.authResolver = null;
      closeModal(true);
      if (resolver) resolver(true);
      renderSecurityStatus();
      return;
    }

    if (form.id === 'record-form') {
      await saveRecordFromForm(form);
      return;
    }

    if (form.id === 'settings-form') {
      await saveSettingsFromForm(form);
      return;
    }

    if (form.id === 'change-password-form') {
      await changePasswordFromForm(form);
      return;
    }

    if (form.id === 'import-form') {
      const file = form.elements.namedItem('file')?.files?.[0];
      const includePhone = Boolean(form.elements.namedItem('includePhone')?.checked);
      await importCsvFile(file, includePhone);
      return;
    }
  } catch (error) {
    const errorTarget = form.id === 'auth-form' ? 'auth-error'
      : form.id === 'setup-vault-form' ? 'setup-error'
      : form.id === 'import-form' ? 'import-error'
      : form.id === 'change-password-form' ? 'change-password-error'
      : '';
    if (errorTarget) setFormError(errorTarget, error.message || String(error));
    else showToast(error.message || String(error), 'error', 4500);
  }
});
document.addEventListener('click', async (event) => {
  const actionElement = event.target.closest('[data-action]');
  if (!actionElement) {
    if (event.target.id === 'modal-backdrop') closeModal();
    return;
  }
  const action = actionElement.dataset.action;
  const recordId = actionElement.dataset.recordId || '';

  try {
    switch (action) {
      case 'navigate':
        state.activePage = actionElement.dataset.page || 'dashboard';
        state.filters.focusId = '';
        renderAll();
        break;
      case 'add-record':
        openRecordModal();
        break;
      case 'edit-record':
        openRecordModal(recordId);
        break;
      case 'delete-record':
        await deleteRecord(recordId);
        break;
      case 'restore-record':
        await restoreRecord(recordId);
        break;
      case 'reveal-phone':
        await revealPhone(recordId);
        break;
      case 'hide-phone':
        hidePhone(recordId);
        break;
      case 'fill-current-phone':
        await fillCurrentPhone();
        break;
      case 'jump-record':
        jumpToRecord(recordId);
        break;
      case 'clear-focus':
        state.filters.focusId = '';
        renderLedger();
        break;
      case 'show-all-warnings':
        state.filters.focusId = '';
        state.filters.status = 'warning';
        state.activePage = 'ledger';
        state.page = 1;
        $('#filter-status').value = 'warning';
        renderAll();
        break;
      case 'page-prev':
        state.page = Math.max(1, state.page - 1);
        renderLedger();
        break;
      case 'page-next':
        state.page += 1;
        renderLedger();
        break;
      case 'go-page':
        state.page = safeNumber(actionElement.dataset.page, 1);
        renderLedger();
        break;
      case 'reset-filters':
        Object.assign(state.filters, { search: '', certificateType: '', status: 'all', owner: '', dateFrom: '', dateTo: '', focusId: '' });
        state.page = 1;
        $('#filter-search').value = '';
        $('#filter-status').value = 'all';
        $('#filter-date-from').value = '';
        $('#filter-date-to').value = '';
        renderLedger();
        break;
      case 'save-plan':
        await saveMonthlyPlan();
        break;
      case 'import-csv':
        openImportModal();
        break;
      case 'export-csv':
        exportLedgerCsv();
        break;
      case 'export-logs':
        exportLogsCsv();
        break;
      case 'open-settings':
        openSettingsModal();
        break;
      case 'open-security':
        openSecurityCenter();
        break;
      case 'open-logs':
        await openLogsModal();
        break;
      case 'lock-vault':
        state.sessionKey = null;
        state.revealedPhones.clear();
        renderSecurityStatus();
        renderLedger();
        showToast('安全会话已锁定', 'warning');
        break;
      case 'change-password':
        await beginChangePassword();
        break;
      case 'export-backup':
        exportEncryptedBackup();
        break;
      case 'trigger-restore':
        $('#restore-backup-input')?.click();
        break;
      case 'close-modal':
        closeModal();
        break;
      default:
        break;
    }
  } catch (error) {
    console.error(error);
    showToast(error.message || '操作失败', 'error', 4500);
  }
});
const updateSearchDebounced = debounce(() => {
  state.filters.search = $('#filter-search').value.trim();
  state.filters.focusId = '';
  state.page = 1;
  renderLedger();
}, 220);

document.addEventListener('input', (event) => {
  if (event.target.id === 'filter-search') updateSearchDebounced();
  if (event.target.closest('#record-form')) updateRecordPreview();
});

document.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.id === 'filter-type') {
    state.filters.certificateType = target.value;
    state.filters.focusId = '';
    state.page = 1;
    renderLedger();
  } else if (target.id === 'filter-status') {
    state.filters.status = target.value;
    state.filters.focusId = '';
    state.page = 1;
    renderLedger();
  } else if (target.id === 'filter-owner') {
    state.filters.owner = target.value;
    state.filters.focusId = '';
    state.page = 1;
    renderLedger();
  } else if (target.id === 'filter-date-from' || target.id === 'filter-date-to') {
    state.filters.dateFrom = $('#filter-date-from').value;
    state.filters.dateTo = $('#filter-date-to').value;
    state.filters.focusId = '';
    state.page = 1;
    renderLedger();
  } else if (target.id === 'page-size') {
    state.pageSize = safeNumber(target.value, 20);
    state.page = 1;
    renderLedger();
  } else if (target.id === 'restore-backup-input' && target.files?.[0]) {
    try {
      await restoreEncryptedBackup(target.files[0]);
    } catch (error) {
      showToast(error.message || '备份恢复失败', 'error', 5000);
    } finally {
      target.value = '';
    }
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.modal) closeModal();
});

/* ---------------- 启动 ---------------- */

async function initApp() {
  try {
    $('#today-label').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
    document.body.dataset.renderDate = localIsoDate();
    setInterval(() => {
      const nextDate = localIsoDate();
      if (document.body.dataset.renderDate !== nextDate) {
        document.body.dataset.renderDate = nextDate;
        $('#today-label').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
        renderAll();
      }
    }, 60000);
    window.addEventListener('focus', () => {
      const nextDate = localIsoDate();
      if (document.body.dataset.renderDate !== nextDate) {
        document.body.dataset.renderDate = nextDate;
        renderAll();
      }
    });
    await loadState();
    renderAll();
    state.initialized = true;
    $('#boot-overlay').classList.add('hidden');
    if (!state.vault) {
      setTimeout(() => openSetupVault(), 380);
    }
  } catch (error) {
    console.error(error);
    $('#boot-overlay').innerHTML = `<div class="boot-card"><strong>系统载入失败</strong><span>${escapeHtml(error.message || String(error))}</span><span>请重启应用；若仍失败，请更新「Android System WebView」或 Chrome 后重试。</span></div>`;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp, { once: true });
} else {
  initApp();
}