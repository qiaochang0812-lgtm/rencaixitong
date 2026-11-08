// ============================================================
// 安卓桥接：把桌面版「人才证书与业绩管理系统」接到手机上。
//   1) 读取台账，为 合同 / 注册证 / 三类人员证 三路到期排本地推送；
//   2) 把 CSV / 加密备份导出改成系统“保存/分享”面板（WebView 的 a[download] 常常不生效）。
// 只在 Capacitor 原生环境生效；浏览器里自动跳过，不影响原桌面版。
// ============================================================

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

const STORAGE_KEY = 'talentCertificateSystem.v2';
const CHANNEL = 'talent-cert';
const DEFAULT_ALERT_DAYS = 30;
const MAX_NOTIFICATIONS = 200;

/* ---------------- 日期工具（与 app.js 保持同一套规则） ---------------- */

function pad(n) {
  return String(n).padStart(2, '0');
}

function toISO(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function parseDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
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

function addMonthsClamped(dateValue, months) {
  const start = parseDate(dateValue);
  const monthCount = Math.max(0, Math.round(Number(months) || 0));
  if (!start || !monthCount) return '';
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const day = start.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + monthCount + 1, 0)).getUTCDate();
  return toISO(new Date(Date.UTC(year, month + monthCount, Math.min(day, lastDay))));
}

function computeContractExpiry(record) {
  if (record?.registrationDate && Number(record?.contractMonths) > 0) {
    return addMonthsClamped(record.registrationDate, record.contractMonths);
  }
  return record?.contractExpiryDate || '';
}

function shiftDays(iso, delta) {
  const target = parseDate(iso);
  if (!target) return '';
  return toISO(new Date(target.getTime() + delta * 86400000));
}

/** 该日历日期的本地时间早上 9 点。 */
function at9(iso) {
  const target = parseDate(iso);
  if (!target) return null;
  return new Date(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 9, 0, 0);
}

function hashId(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (Math.abs(h) % 2000000000) + 1;
}

/* ---------------- 数据读取 ---------------- */

function loadLedger() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { records: [], alertDays: DEFAULT_ALERT_DAYS };
    const parsed = JSON.parse(raw);
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    const alertDays = Number(parsed.settings?.alertDays) || DEFAULT_ALERT_DAYS;
    return { records, alertDays };
  } catch {
    return { records: [], alertDays: DEFAULT_ALERT_DAYS };
  }
}

/* ---------------- 到期推送排期 ---------------- */

let scheduleChain = Promise.resolve();

/** 排期串行执行：保存、回前台等事件连续触发时，不会出现 cancel / schedule 交错。 */
function scheduleReminders() {
  scheduleChain = scheduleChain.then(doScheduleReminders, doScheduleReminders);
  return scheduleChain;
}

async function doScheduleReminders() {
  if (!Capacitor.isNativePlatform()) return 'web';
  try {
    const { records, alertDays } = loadLedger();

    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') return 'denied';

    if (Capacitor.getPlatform() === 'android') {
      await LocalNotifications.createChannel({
        id: CHANNEL,
        name: '证书与合同到期提醒',
        importance: 4,
        visibility: 1,
        vibration: true,
      });
    }

    // 先清掉旧的，再按当前台账重排，改日期/删除后不会留下过期提醒
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length > 0) {
      await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
    }

    const now = Date.now();
    const list = [];
    for (const record of records.filter((r) => !r.deletedAt)) {
      const expiries = [
        { kind: 'contract', type: '合同', iso: computeContractExpiry(record) },
        { kind: 'registration', type: '注册证', iso: record.regExpiryDate },
        { kind: 'three', type: '三类人员证', iso: record.threeExpiryDate },
      ];
      for (const item of expiries) {
        if (!item.iso) continue;
        const days = remainingDays(item.iso);
        if (days === null) continue;
        const points = [
          { iso: shiftDays(item.iso, -alertDays), label: `还有 ${alertDays} 天到期` },
          { iso: shiftDays(item.iso, -7), label: '一周后到期' },
          { iso: item.iso, label: '今天到期' },
        ];
        for (const point of points) {
          const when = at9(point.iso);
          if (!when || when.getTime() <= now) continue;
          const name = String(record.name || '').trim() || '未命名';
          const cert = String(record.certificateType || '').trim() || '未分类证书';
          list.push({
            id: hashId(`${record.id}:${item.kind}:${point.iso}`),
            title: `${item.type}${point.label}`,
            body: `${name} · ${cert} · 到期日 ${point.iso}`,
            channelId: CHANNEL,
            schedule: { at: when, allowWhileIdle: true },
          });
        }
      }
    }

    list.sort((a, b) => a.schedule.at.getTime() - b.schedule.at.getTime());
    if (list.length > 0) {
      await LocalNotifications.schedule({ notifications: list.slice(0, MAX_NOTIFICATIONS) });
    }
    return 'ok';
  } catch {
    return 'error';
  }
}

async function requestReminderPermission() {
  if (!Capacitor.isNativePlatform()) return 'web';
  try {
    let perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') perm = await LocalNotifications.requestPermissions();
    if (perm.display !== 'granted') return 'denied';
    return await scheduleReminders();
  } catch {
    return 'error';
  }
}

/* ---------------- 导出桥 ---------------- */

async function nativeSave(content, filename) {
  try {
    const data = typeof content === 'string' ? content : await content.text();
    const file = await Filesystem.writeFile({
      path: filename,
      data,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    await Share.share({ title: filename, url: file.uri, dialogTitle: '保存文件' });
  } catch {
    // 用户取消分享也算处理过了，不再回退到 WebView 下载
  }
}

/* ---------------- 初始化 ---------------- */

export function initBridge() {
  const native = Capacitor.isNativePlatform();
  window.__nativeSave = native ? nativeSave : null;
  if (!native) return;

  // 首次启动：请求通知权限并排期
  void requestReminderPermission();

  // 应用回到前台时重排（跨天 / 数据可能被外部改动）
  void App.addListener('appStateChange', (state) => {
    if (state.isActive) void scheduleReminders();
  });

  // 安卓返回键：先关弹层 → 再回首页 → 最后才退出应用
  void App.addListener('backButton', () => {
    if (window.__handleBack?.()) return;
    void App.exitApp();
  });

  // 台账每次保存后重排
  window.addEventListener('talent:changed', () => void scheduleReminders());
}
