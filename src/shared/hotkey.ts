// 显示/隐藏宠物的全局快捷键（1.4.0）。只允许从固定列表里选，避免界面传入任意字符串注册成奇怪的组合键。
// 主进程和设置页共用；纯函数，可单元测试。
export interface HotkeyChoice { id: string; label: string }
/** id 即 Electron Accelerator 字符串；空字符串 = 关闭快捷键。 */
export const HOTKEYS: HotkeyChoice[] = [
  { id: '', label: '关闭' },
  { id: 'Ctrl+Alt+P', label: 'Ctrl + Alt + P（默认）' },
  { id: 'Ctrl+Alt+N', label: 'Ctrl + Alt + N' },
  { id: 'Ctrl+Alt+H', label: 'Ctrl + Alt + H' },
  { id: 'Ctrl+Shift+P', label: 'Ctrl + Shift + P' },
  { id: 'Alt+Shift+P', label: 'Alt + Shift + P' }
];
export const DEFAULT_HOTKEY = 'Ctrl+Alt+P';
/** 1.5.0：打开“任务管理器”页的全局快捷键，默认关闭（''）。 */
export const PROC_HOTKEYS: HotkeyChoice[] = [
  { id: '', label: '关闭' },
  { id: 'Ctrl+Alt+M', label: 'Ctrl + Alt + M' },
  { id: 'Ctrl+Alt+K', label: 'Ctrl + Alt + K' },
  { id: 'Ctrl+Shift+M', label: 'Ctrl + Shift + M' },
  { id: 'Alt+Shift+M', label: 'Alt + Shift + M' }
];
export function normalizeProcHotkey(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const hit = PROC_HOTKEYS.find((h) => h.id.toLowerCase() === s.toLowerCase());
  return hit ? hit.id : null;
}
/** 列表里有就原样返回（含空字符串 = 关闭）；不认识的值返回 null（调用方应忽略这次修改）。 */
export function normalizeHotkey(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const hit = HOTKEYS.find((h) => h.id.toLowerCase() === s.toLowerCase());
  return hit ? hit.id : null;
}
