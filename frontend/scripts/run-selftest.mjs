/**
 * 离线核验包核心规则自测（不依赖浏览器 / IndexedDB）：
 *   node scripts/run-selftest.mjs
 * 通过 esbuild 把 TS 打包到内存，桩掉 ../db 后执行断言。
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const DB_STUB = `
  export const db = {};
`;

const result = await build({
  entryPoints: [path.join(root, 'scripts/selftest-sync.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [
    {
      name: 'stub-db',
      setup(b) {
        b.onResolve({ filter: /(^|\/)\.\.\/db$/ }, () => ({
          path: 'virtual:db',
          namespace: 'stub',
        }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: DB_STUB,
          loader: 'js',
        }));
      },
    },
  ],
});

const code = result.outputFiles[0].text;
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64');
const mod = await import(dataUrl);
await mod.runSelfTest();
console.log('selftest ok');
