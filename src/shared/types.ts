export type PetStateName = 'IDLE' | 'HAPPY' | 'SLEEP' | 'TIRED' | 'HOT' | 'SWEAT' | 'WARNING' | 'DOWNLOAD' | 'UPLOAD';
export interface PState { state: PetStateName; label: string; paused: boolean; dnd: boolean; online: boolean | null; internet?: 'ok' | 'portal' | 'fail' | null }
export interface Speed { rx: number | null; tx: number | null; online?: boolean | null }
export interface Sample { cpu: number; used: number; total: number; pct: number; temp: number | null }
export interface Runtime { paused: boolean; dnd: boolean; passthrough: boolean; userHidden?: boolean; fsHidden?: boolean; state?: PetStateName }
export interface SettingsEvent { pet?: string; compact?: boolean }
export interface SettingsView {
  privacy: Record<string, boolean>; memTrim?: { auto: boolean; threshold: number; skipFg: boolean }; quota?: { gb: number; notified: number; month: string }; remind?: { sit: number; water: number }; newProc?: { on: boolean; learnUntil: number; count: number }; anim: Record<string, boolean>; alwaysOnTop: boolean; retentionDays: number; memAlert: number;
  pet: string; compact: boolean; safe: boolean; autostart: boolean; hasLock: boolean; packaged: boolean; onboarded: boolean; version: string; dataDir: string;
}
export interface PetStatus { userHidden: boolean; fsHidden: boolean; fullscreenHide: boolean; bounds: { x: number; y: number; width: number; height: number } | null; visible: boolean }
export interface JunkScan { id: string; name: string; desc: string; size: number; files: number; skipped: string[] }
export interface JunkClean { id: string; freed: number; deletedFiles: number; skippedFiles: number; dirsRemoved: number; ok: boolean; error?: string }
export interface StartupItem { id: string; src: string; srcName: string; scope: 'user' | 'machine'; name: string; command: string; enabled: boolean; flagged: boolean; exe: string; canToggle: boolean }
export type HealthStatus = 'ok' | 'warn' | 'bad' | 'unknown';
export interface HealthItem { id: string; title: string; status: HealthStatus; detail: string; evidence: string; advice: string; list?: string[] }
export interface HealthReport { items: HealthItem[]; score: number | null; at: number; disabled?: boolean }
export interface NetpetApi {
  on(ch: 'speed', cb: (d: Speed) => void): void;
  on(ch: 'sample', cb: (d: Sample) => void): void;
  on(ch: 'pstate', cb: (d: PState) => void): void;
  on(ch: 'settings', cb: (d: SettingsEvent) => void): void;
  on(ch: 'runtime', cb: (d: Runtime) => void): void;
  on(ch: 'goto', cb: (d: string) => void): void;
  on(ch: 'vpn', cb: (d: any) => void): void;
  send(ch: string, d?: unknown): void;
  invoke<T = any>(ch: string, d?: unknown): Promise<T>;
}
declare global { interface Window { netpet: NetpetApi } }
