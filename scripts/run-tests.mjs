// Node 20 兼容的轻量测试入口：用本地 TypeScript 将用例与被测模块编译为
// CommonJS 后调用 node:test，避免依赖 --experimental-strip-types。
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = join(tmpdir(), `sologsb-test-${process.pid}`);
const runnerTs = join(work, 'src', 'run-test.ts');
const out = join(work, 'out');

rmSync(work, { recursive: true, force: true });
mkdirSync(dirname(runnerTs), { recursive: true });
cpSync(join(root, 'lib'), join(work, 'src', 'lib'), { recursive: true });
cpSync(join(root, 'scripts', 'split-merge.test.mts'), runnerTs);

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) {
  console.error('未找到本地 TypeScript，请先执行 npm install。');
  process.exit(1);
}

execFileSync(
  process.execPath,
  [
    tsc,
    join(work, 'src', 'lib', 'data.ts'),
    join(work, 'src', 'lib', 'editor.ts'),
    join(work, 'src', 'lib', 'types.ts'),
    runnerTs,
    '--rootDir', join(work, 'src'),
    '--outDir', out,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--moduleResolution', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ],
  { stdio: 'inherit', cwd: root }
);

// 显式指定的入口文件会被平铺到 out 根；修正其指向 lib 的相对 require
const compiledTest = join(out, 'run-test.js');
const source = readFileSync(compiledTest, 'utf8');
writeFileSync(compiledTest, source.replaceAll(/require\(("|')\.\.\/lib\//g, "require($1./lib/"));

try {
  execFileSync(process.execPath, ['--test', compiledTest], { stdio: 'inherit' });
} finally {
  rmSync(work, { recursive: true, force: true });
}
