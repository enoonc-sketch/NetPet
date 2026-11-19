// 宠物窗口几何：纯函数（不依赖 Electron，可单元测试）。
// 根因：旧版启动时直接用上次保存的 S.bounds，拖动也不钳制；
// 换显示器 / 改分辨率 / 拔掉副屏后，宠物可能落在当前所有工作区之外，
// 窗口还在、进程还在，但屏幕上什么都看不到，看起来就是“一会有一会没”。
export interface WorkArea { x: number; y: number; width: number; height: number }
export interface PetRect { x: number; y: number; width: number; height: number }

export function petSize(compact: boolean) { return compact ? { w: 96, h: 100 } : { w: 170, h: 190 }; }

/** 默认位置：主显示器工作区右下角，留 20px 边距。 */
export function defaultPetBounds(wa: WorkArea, w: number, h: number): PetRect {
  return { x: wa.x + wa.width - w - 20, y: wa.y + wa.height - h - 20, width: w, height: h };
}

const MIN_VISIBLE = 40; // 至少留 40px 在屏幕内，否则算“看不见”

/** 把保存/拖动得到的位置钳制到当前显示器：有 ≥40px 可见就地钳制，否则回默认右下角。 */
export function clampPetBounds(b: any, w: number, h: number, displays: { workArea: WorkArea }[]): PetRect {
  const fallback: WorkArea = (displays[0] && displays[0].workArea) || { x: 0, y: 0, width: 1920, height: 1080 };
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return defaultPetBounds(fallback, w, h);
  const rect: PetRect = { x: Math.round(b.x), y: Math.round(b.y), width: w, height: h };
  for (const d of displays) {
    const wa = d.workArea;
    const ox = Math.min(rect.x + rect.width, wa.x + wa.width) - Math.max(rect.x, wa.x);
    const oy = Math.min(rect.y + rect.height, wa.y + wa.height) - Math.max(rect.y, wa.y);
    if (ox >= MIN_VISIBLE && oy >= MIN_VISIBLE) {
      return {
        x: Math.min(Math.max(rect.x, wa.x + MIN_VISIBLE - rect.width), wa.x + wa.width - MIN_VISIBLE),
        y: Math.min(Math.max(rect.y, wa.y + MIN_VISIBLE - rect.height), wa.y + wa.height - MIN_VISIBLE),
        width: w, height: h
      };
    }
  }
  return defaultPetBounds(fallback, w, h);
}
