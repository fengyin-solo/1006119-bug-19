// 领域测试运行器：tsc 编译（CommonJS，规避 ESM 无扩展名解析）→ Node 运行 → 清理。
const { spawnSync } = require('node:child_process')
const { rmSync, existsSync } = require('node:fs')
const path = require('node:path')

const root = __dirname
const outDir = path.join(root, '.tmp-test')
rmSync(outDir, { recursive: true, force: true })
const { mkdirSync, writeFileSync } = require('node:fs')
mkdirSync(outDir, { recursive: true })
// 上级 package.json 是 type:module；编译产物是 CommonJS，这里覆盖回去。
writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }))

const tsc = spawnSync(
  process.execPath,
  [
    path.join(root, '..', 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(root, 'progress-domain-test.ts'),
    '--outDir', outDir,
    '--target', 'ES2020',
    '--module', 'CommonJS',
    '--moduleResolution', 'Node',
    '--strict', 'false',
    '--skipLibCheck',
    '--esModuleInterop',
  ],
  { stdio: 'inherit' },
)
if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1)
}

const built = path.join(outDir, 'scripts', 'progress-domain-test.js')
if (!existsSync(built)) {
  console.error('未找到编译产物：', built)
  process.exit(1)
}

try {
  require(built)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
