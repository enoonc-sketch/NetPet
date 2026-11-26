// 1.5.0 宠物换装和配色（纯数据 + 纯函数，可单元测试）。配饰的 3D 造型在 src/renderer/pets3d.ts 里用基础几何体搭建。
// 解锁条件只看本机的成长等级和成就；没解锁或不认识的选项一律回到默认值。
export interface WearItem { id: string; emoji: string; level?: number; ach?: string }
export interface Palette extends WearItem { body?: string; belly?: string }
export const PALETTES: Palette[] = [
  { id: 'default', emoji: '🎨' },
  { id: 'mint', emoji: '🌿', body: '#A8E6CF', belly: '#F1FFF8', level: 1 },
  { id: 'sky', emoji: '☁️', body: '#A7D8FF', belly: '#EEF7FF', level: 2 },
  { id: 'lavender', emoji: '💜', body: '#CDB4FF', belly: '#F4EEFF', level: 3 },
  { id: 'sakura', emoji: '🌸', body: '#FFC4D6', belly: '#FFF0F5', level: 4 },
  { id: 'midnight', emoji: '🌙', body: '#5B6A9A', belly: '#D5DCF5', level: 6 },
  { id: 'cocoa', emoji: '🍫', body: '#A47551', belly: '#EBD6C0', ach: 'gb10' },
  { id: 'gold', emoji: '✨', body: '#FFD86B', belly: '#FFF6D6', ach: 'speed10' }
];
export const ACCESSORIES: WearItem[] = [
  { id: 'none', emoji: '🚫' },
  { id: 'hat', emoji: '🎩', level: 2 },
  { id: 'scarf', emoji: '🧣', level: 3 },
  { id: 'glasses', emoji: '👓', level: 5 },
  { id: 'bow', emoji: '🎀', ach: 'week' },
  { id: 'flower', emoji: '🌼', ach: 'focus5' },
  { id: 'crown', emoji: '👑', level: 8 }
];
export interface Look { palette: string; acc: string }
export const DEFAULT_LOOK: Look = { palette: 'default', acc: 'none' };

export function isUnlocked(item, level, achDone) {
  if (!item) return false;
  if (item.level && !(level >= item.level)) return false;
  if (item.ach && !(achDone || []).includes(item.ach)) return false;
  return true;
}
/** 把任意输入变成合法且已解锁的外观；不合法 / 未解锁的部分回到默认。 */
export function sanitizeLook(look, level, achDone) {
  const o = { ...DEFAULT_LOOK };
  if (look && typeof look === 'object') {
    const p = PALETTES.find((x) => x.id === look.palette);
    if (p && isUnlocked(p, level, achDone)) o.palette = p.id;
    const a = ACCESSORIES.find((x) => x.id === look.acc);
    if (a && isUnlocked(a, level, achDone)) o.acc = a.id;
  }
  return o;
}
export const paletteOf = (id) => PALETTES.find((x) => x.id === id) || PALETTES[0];
