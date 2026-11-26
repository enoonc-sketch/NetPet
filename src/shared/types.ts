export type PetStateName = 'IDLE' | 'HAPPY' | 'SLEEP' | 'TIRED' | 'HOT' | 'SWEAT' | 'WARNING' | 'DOWNLOAD' | 'UPLOAD';
export interface PState { state: PetStateName; label: string; paused: boolean; dnd: boolean; online: boolean | null; internet?: 'ok' | 'portal' | 'fail' | null; focus?: 'focus' | 'break' | null }
export interface Speed { rx: number | null; tx: number | null; online?: boolean | null }
export interface Sample { cpu: number; used: number; total: number; pct: number; temp: number | null }
export interface Runtime { paused: boolean; dnd: boolean; passthrough: boolean; userHidden?: boolean; fsHidden?: boolean; state?: PetStateName }
export interface Look { palette: string; acc: string }
export interface SettingsEvent { pet?: string; compact?: boolean; lang?: 'zh' | 'en'; look?: Look }
export interface FocusState { phase: 'idle' | 'focus' | 'break'; running: boolean; remainMs: number; endsAt: number | null; totalMs: number; cfg: { focusMin: number; breakMin: number }; today: { n: number; min: number } }
export interface SettingsView {
  privacy: Record<string, boolean>; memTrim?: { auto: boolean; threshold: number; skipFg: boolean; sched?: number; exclude?: string[] }; quota?: { gb: number; notified: number; month: string }; remind?: { sit: number; water: number }; newProc?: { on: boolean; learnUntil: number; count: number }; anim: Record<string, boolean>; alwaysOnTop: boolean; retentionDays: number; memAlert: number;
  pet: string; compact: boolean; safe: boolean; autostart: boolean; hasLock: boolean; packaged: boolean; onboarded: boolean; version: string; dataDir: string;
  hotkey?: string; hotkeyOk?: boolean;
  // 1.5.0
  language?: 'auto' | 'zh' | 'en'; lang?: 'zh' | 'en';
  speedAlert?: { on: boolean; lowKB: number; lowSec: number; highMB: number; highSec: number; cooldownMin: number };
  look?: Look; focus?: { focusMin: number; breakMin: number }; weekly?: { on: boolean; last: string };
  diskAuto?: { on: boolean; last: number; lastTry: number }; defSched?: { on: boolean; last: number; lastTry: number };
  power?: { guard: boolean; threshold: number; coolMax: number; saver: boolean; saverPct: number }; powerBackup?: { at: number } | null; powerAuto?: { cooling: boolean; saver: boolean };
  procHotkey?: string; procHotkeyOk?: boolean;
}
export interface PetStatus { userHidden: boolean; fsHidden: boolean; fullscreenHide: boolean; bounds: { x: number; y: number; width: number; height: number } | null; visible: boolean }
export interface JunkScan { id: string; name: string; desc: string; size: number; files: number; skipped: string[] }
export interface JunkClean { id: string; freed: number; deletedFiles: number; skippedFiles: number; dirsRemoved: number; ok: boolean; error?: string }
export interface StartupItem { id: string; src: string; srcName: string; scope: 'user' | 'machine'; name: string; command: string; enabled: boolean; flagged: boolean; exe: string; canToggle: boolean }
export type HealthStatus = 'ok' | 'warn' | 'bad' | 'unknown';
export interface HealthItem { id: string; title: string; status: HealthStatus; detail: string; evidence: string; advice: string; list?: string[] }
export interface HealthReport { items: HealthItem[]; score: number | null; at: number; disabled?: boolean }
export type { DayTraffic, TrafficReport } from './report';
/** on() 返回取消订阅函数（1.4.0 起）。 */
export type Unsubscribe = () => void;
export interface NetpetApi {
  on(ch: 'speed', cb: (d: Speed) => void): Unsubscribe;
  on(ch: 'sample', cb: (d: Sample) => void): Unsubscribe;
  on(ch: 'pstate', cb: (d: PState) => void): Unsubscribe;
  on(ch: 'settings', cb: (d: SettingsEvent) => void): Unsubscribe;
  on(ch: 'runtime', cb: (d: Runtime) => void): Unsubscribe;
  on(ch: 'goto', cb: (d: string) => void): Unsubscribe;
  on(ch: 'vpn', cb: (d: any) => void): Unsubscribe;
  on(ch: 'focus', cb: (d: FocusState) => void): Unsubscribe;
  send(ch: string, d?: unknown): void;
  invoke<T = any>(ch: string, d?: unknown): Promise<T>;
}
declare global { interface Window { netpet: NetpetApi } }
