/**
 * 插件身份一致性回归测试。
 *
 * 背景：0.1.0 的 package.json 用了无 scope 的 `dsh-github-login`，而入口导出的
 * `name` 与 cordis.patch.yml 的 entry `name` 却写成 `@deepseek-ai/dsh-github-login`。
 * 宿主端加载器是按【entry 声明的名字】去 import 的，而 `dsh plugin add` 是按
 * 【package.json 的 name】建目录的 —— 两者不一致就必然 `Cannot find package`，
 * 整个 profile 启动失败。本测试把这三处名字钉成同一个值。
 *
 * 另外两条是本 bug 的伴生判据：
 *   - 绝不允许再用官方 `@deepseek-ai/*` scope（那是根因）；
 *   - lib/ 里不允许出现机器专用硬编码路径（作者本机盘符路径那种形态）。
 *
 * 运行：npm test（零依赖，只用 node:test + node:assert）
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 本插件唯一合法的身份名。 */
const EXPECTED_NAME = 'dsh-github-login'

/** 官方 scope：第三方插件不可能发布在该 scope 下，出现即回归。 */
const FORBIDDEN_SCOPE = '@deepseek-ai/'

function readPackageJson() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
}

/** package.json 的 exports["."] 声明的入口相对路径（不带 "./" 前缀）。 */
function entryRelativePath(pkg) {
  const entry = pkg.exports?.['.']
  assert.equal(typeof entry, 'string', 'package.json 的 exports["."] 必须是字符串入口路径')
  return entry.replace(/^\.\//, '')
}

/**
 * 极简解析：取 cordis.patch.yml 里 list 形式 entry 的 `name`。
 * 本文件只有 4 行、结构固定（- insert: / - id: / name:），不值得为此引入 YAML 依赖。
 */
function patchEntryName(patchFile) {
  const text = readFileSync(join(PACKAGE_ROOT, patchFile), 'utf8')
  const insertLines = text.split(/\r?\n/).filter((line) => /^\s*-\s*insert:\s*$/.test(line))
  assert.equal(
    insertLines.length,
    1,
    `cordis.patch.yml 期望恰好一段 list 形式的 "- insert:"，实际 ${insertLines.length} 段`,
  )
  const names = text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*name:\s*(.+?)\s*$/)?.[1])
    .filter((value) => typeof value === 'string' && value.length > 0)
  assert.equal(names.length, 1, `cordis.patch.yml 期望恰好一个 name: 字段，实际 ${names.length} 个`)
  return names[0].replace(/^(['"])(.*)\1$/, '$2')
}

function walkFiles(dir) {
  const found = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) found.push(...walkFiles(full))
    else found.push(full)
  }
  return found
}

test('package.json.name 是本插件的真实包名', () => {
  const pkg = readPackageJson()
  assert.equal(pkg.name, EXPECTED_NAME)
})

test('入口导出 name == package.json.name == cordis.patch.yml entry name（本 bug 的判据）', async () => {
  const pkg = readPackageJson()
  const entry = entryRelativePath(pkg)
  const exportedName = (await import(new URL(`../${entry}`, import.meta.url))).name
  const patchName = patchEntryName(pkg.dsh?.bundle?.patch ?? 'cordis.patch.yml')

  assert.equal(exportedName, pkg.name, `入口 ${entry} 导出的 name 与 package.json.name 不一致`)
  assert.equal(patchName, pkg.name, 'cordis.patch.yml 的 entry name 与 package.json.name 不一致')
  assert.equal(pkg.name, EXPECTED_NAME)
})

test('三处身份绝不使用官方 @deepseek-ai/* scope', async () => {
  const pkg = readPackageJson()
  const entry = entryRelativePath(pkg)
  const exportedName = (await import(new URL(`../${entry}`, import.meta.url))).name
  const patchName = patchEntryName(pkg.dsh?.bundle?.patch ?? 'cordis.patch.yml')

  for (const [label, value] of [['package.json.name', pkg.name], ['入口导出 name', exportedName], ['cordis.patch.yml entry name', patchName]]) {
    assert.ok(
      !String(value).startsWith(FORBIDDEN_SCOPE),
      `${label} 不得使用官方 scope：${value}`,
    )
  }
})

test('exports["."] 指向的入口文件真实存在', () => {
  const entry = entryRelativePath(readPackageJson())
  assert.ok(entry.length > 0)
  assert.doesNotThrow(() => statSync(join(PACKAGE_ROOT, entry)), `exports["."] 指向的入口不存在：${entry}`)
})

test('lib/ 内不允许机器专用硬编码路径', () => {
  const libDir = join(PACKAGE_ROOT, 'lib')
  const offenders = []
  for (const file of walkFiles(libDir)) {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      // 盘符路径（形如 盘符 + 冒号 + 斜杠），排除 URL 里的 scheme（如 https://）。
      if (/(^|[^A-Za-z0-9+.-])[A-Za-z]:[\\/]/.test(line)) {
        offenders.push(`${relative(PACKAGE_ROOT, file)}: ${line.trim()}`)
      }
    }
  }
  // 1.0.1 时这里是 t.skip（把缺陷标成"已知问题"）；1.0.2 已把作者本机路径删掉，
  // 改为真断言：再写回任何机器专用路径都必须让测试变红。
  assert.deepEqual(offenders, [], `lib/ 内出现机器专用硬编码路径：\n${offenders.join('\n')}`)
})
