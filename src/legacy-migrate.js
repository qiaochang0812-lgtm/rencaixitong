/**
 * 旧版数据迁移：只用于把旧版“AES-GCM 加密手机号”一次性转换成明文。
 * 新版不再使用加密；迁移完成后旧密钥信息会被删除，本文件不会再被用到。
 */

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(password, vault) {
  if (!globalThis.crypto?.subtle) throw new Error('当前系统 WebView 不支持解密，请更新 Android System WebView 后重试');
  const source = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: base64ToBytes(vault.salt), iterations: vault.iterations, hash: 'SHA-256' },
    source,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

async function decryptPayload(key, iv, data) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv) }, key, base64ToBytes(data));
  return new TextDecoder().decode(plain);
}

/** 密码正确返回 { ok: true, phones: Map(recordId -> 明文手机号) }，否则 { ok: false }。 */
export async function decryptLegacyPhones(vault, password, records) {
  try {
    const key = await deriveKey(password, vault);
    const check = await decryptPayload(key, vault.verifier.iv, vault.verifier.data);
    if (check !== 'TALENT_CERT_VAULT_OK') return { ok: false };
    const phones = new Map();
    for (const record of records) {
      if (!record.phoneCipher || !record.phoneIv) continue;
      try {
        phones.set(record.id, await decryptPayload(key, record.phoneIv, record.phoneCipher));
      } catch {
        // 单条解密失败时跳过，保留密文以便稍后重试
      }
    }
    return { ok: true, phones };
  } catch (error) {
    if (String(error?.message || '').includes('WebView')) throw error;
    return { ok: false };
  }
}
