// 敏感设置加密：用 Electron safeStorage（Windows 上是 DPAPI，绑定当前 Windows 用户）。
// 加密的键：面板密码哈希（lock）、sing-box 路径（vpn）、VPN 连接前的代理备份（vpnProxyBackup）。
// 存储格式：{"$enc":1,"d":"<base64 密文>"}。加密不可用（极少数系统）时退回明文并在界面上说明。
// 局限：DPAPI 防的是“把数据库拷走到别的电脑/别的账户”，挡不住以你的身份运行的程序。
export const SENSITIVE_KEYS = ['lock', 'vpn', 'vpnProxyBackup'];

export interface Cipher { available(): boolean; encrypt(s: string): Buffer; decrypt(b: Buffer): string }
export const isEnc = (v: any) => !!(v && typeof v === 'object' && v.$enc === 1 && typeof v.d === 'string');

/** 写入前：敏感键加密（纯函数，可注入 Cipher 做单元测试）。null/undefined 不加密。 */
export function seal(key: string, v: any, c: Cipher | null): any {
  if (!SENSITIVE_KEYS.includes(key) || v == null || !c || !c.available()) return v;
  return { $enc: 1, d: c.encrypt(JSON.stringify(v)).toString('base64') };
}
/** 读取后：解密。返回 { value, failed }；解不开（换了电脑/账户）时 value=null、failed=true。 */
export function unseal(key: string, v: any, c: Cipher | null): { value: any; failed: boolean; plain: boolean } {
  if (!isEnc(v)) return { value: v, failed: false, plain: SENSITIVE_KEYS.includes(key) && v != null };
  if (!c || !c.available()) return { value: null, failed: true, plain: false };
  try { return { value: JSON.parse(c.decrypt(Buffer.from(v.d, 'base64'))), failed: false, plain: false }; }
  catch (_) { return { value: null, failed: true, plain: false }; }
}
