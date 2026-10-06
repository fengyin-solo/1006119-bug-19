#!/usr/bin/env node
// 用 esbuild 即时把 TS 测试打成 ESM bundle 后执行。
// 业务代码里的 '@/' 别名在这里指到 src 目录，和 vite/vue-tsc 的解析保持一致。
import { build } from 'esbuild'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const entry = fileURLToPath(new URL('../scripts/progress.test.ts', import.meta.url))
const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'progress-tests-'))
const outfile = join(dir, 'bundle.mjs')

function resolveWithExtensions(base) {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.vue')]
  return candidates.find((p) => existsSync(p)) ?? null
}

const aliasPlugin = {
  name: 'at-alias',
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const resolved = resolveWithExtensions(join(srcDir, args.path.slice(2)))
      return resolved ? { path: resolved } : undefined
    })
  },
}

try {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile,
    plugins: [aliasPlugin],
  })
  await import(pathToFileURL(outfile).href)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
