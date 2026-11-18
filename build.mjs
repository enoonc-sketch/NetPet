// 构建脚本：esbuild 把 TypeScript/React 打包到 out/（主进程、预加载、3 个渲染页面）
import * as esbuild from 'esbuild';
import fs from 'node:fs';
fs.rmSync('out', { recursive: true, force: true });
fs.mkdirSync('out/assets', { recursive: true });
const node = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning' };
await esbuild.build({ ...node, entryPoints: ['src/main/main.ts'], outfile: 'out/main.js', external: ['electron', 'systeminformation'] });
await esbuild.build({ ...node, entryPoints: ['src/main/collector.ts'], outfile: 'out/collector.js', external: ['systeminformation'] });
await esbuild.build({ ...node, entryPoints: ['src/preload/preload.ts'], outfile: 'out/preload.js', external: ['electron'] });
for (const n of ['pet', 'panel', 'dashboard'])
  await esbuild.build({ entryPoints: [`src/renderer/${n}/main.tsx`], outfile: `out/${n}.js`, bundle: true, format: 'iife', platform: 'browser', target: 'chrome128',
    jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' });
for (const f of fs.readdirSync('static')) fs.copyFileSync(`static/${f}`, `out/${f}`);
fs.copyFileSync('assets/icon.png', 'out/assets/icon.png');
if (process.argv.includes('--tests')) await esbuild.build({ ...node, entryPoints: ['tests/unit.ts'], outfile: 'out/unit.cjs' });
console.log('build ok');
