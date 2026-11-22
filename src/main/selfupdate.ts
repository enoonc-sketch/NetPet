// 检查 NetPet 新版本：只在用户点击时请求一次 GitHub 公开接口，不后台检查、不自动下载、不安装。
// 请求：GET https://api.github.com/repos/enoonc-sketch/NetPet/releases/latest（不带任何本机数据；GitHub 会看到你的 IP 和 User-Agent “NetPet/版本号”）。
// 发现新版本时只给出发布页链接，由用户自己在浏览器里下载。
import https from 'node:https';

export const REPO = 'enoonc-sketch/NetPet';
export const API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES = `https://github.com/${REPO}/releases`;

/** 解析版本号 v1.2.3 / 1.2.3-beta.1；无法解析返回 null。 */
export function parseVer(v: string): { n: number[]; pre: string } | null {
  const m = String(v || '').trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.\-]+))?$/);
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3] || 0)], pre: m[4] || '' } : null;
}
/** a > b 返回 1，相等 0，小于 -1；正式版高于同号预发布版。 */
export function cmpVer(a: string, b: string): number {
  const x = parseVer(a), y = parseVer(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i] ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}
/** 只允许打开本仓库在 github.com 上的发布页，防止返回内容里带别的链接。 */
export function safeReleaseUrl(u: any): string {
  try {
    const url = new URL(String(u));
    if (url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.toLowerCase().startsWith(`/${REPO.toLowerCase()}/releases`)) return url.toString();
  } catch (_) {}
  return RELEASES;
}
export interface SelfUpd { ok: boolean; at: number; current: string; latest?: string; newer?: boolean; url?: string; notes?: string; published?: string; error?: string }
/** 把 GitHub 返回的 JSON 变成结果（纯函数，可单元测试）。草稿和预发布版不算。 */
export function interpret(current: string, status: number, j: any): SelfUpd {
  const base = { at: Date.now(), current };
  if (status === 404) return { ...base, ok: false, error: '还没有发布过正式版本。' };
  if (status === 403 || status === 429) return { ...base, ok: false, error: 'GitHub 暂时限制了请求次数，请过一会儿再试。' };
  if (status !== 200 || !j || typeof j !== 'object') return { ...base, ok: false, error: `GitHub 返回异常（${status}）。` };
  if (j.draft || j.prerelease) return { ...base, ok: true, latest: current, newer: false, url: RELEASES };
  const tag = String(j.tag_name || '');
  if (!parseVer(tag)) return { ...base, ok: false, error: '无法识别最新版本号：' + tag.slice(0, 40) };
  return { ...base, ok: true, latest: tag.replace(/^v/, ''), newer: cmpVer(tag, current) > 0, url: safeReleaseUrl(j.html_url),
    notes: String(j.body || '').slice(0, 2000), published: String(j.published_at || '').slice(0, 10) };
}
let inflight: Promise<SelfUpd> | null = null;
export function check(current: string): Promise<SelfUpd> {
  if (inflight) return inflight;
  inflight = new Promise<SelfUpd>((resolve) => {
    let done = false; const fin = (r: SelfUpd) => { if (!done) { done = true; resolve(r); } };
    const req = https.get(API, { timeout: 10000, headers: { 'User-Agent': `NetPet/${current}`, Accept: 'application/vnd.github+json' } }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 200000) body += c; });
      res.on('end', () => { let j: any = null; try { j = JSON.parse(body); } catch (_) {} fin(interpret(current, res.statusCode || 0, j)); });
      res.on('error', () => fin({ ok: false, at: Date.now(), current, error: '读取失败' }));
    });
    req.on('timeout', () => { req.destroy(); fin({ ok: false, at: Date.now(), current, error: '连接 GitHub 超时（可能需要代理）。' }); });
    req.on('error', (e) => fin({ ok: false, at: Date.now(), current, error: '连不上 GitHub：' + e.message }));
  }).finally(() => { setTimeout(() => { inflight = null; }, 0); });
  return inflight;
}
