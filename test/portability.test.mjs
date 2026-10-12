/**
 * dsh-github-login 的可移植性 / 可用性回归测试。
 *
 * 由来（两条真实缺陷）：
 *   1. `lib/index.mjs` 的候选路径里混进了作者本机路径（盘符字面量），
 *      别的机器、别的平台永远命中不了 —— **别人装了用不了**的直接原因之一；
 *   2. 就算删掉那条路径，新用户也没有任何"怎么拿到登录工具"的路径：
 *      npm 包里不带 exe，README 里只写了"本机存在 exe 时直接启动"。
 *
 * 因此本文件把三件事钉死（都是**可失败**断言，不是说明性文字）：
 *   ① 入库的源码与产物里不得出现机器专用绝对路径（白名单**逐条**登记，不做整文件豁免）；
 *   ② 候选列表每一项都能由规则推导（不含盘符字面量），且 API 返回的候选确实落在可推导根下；
 *   ③ 自动下载的 sha256 校验**不匹配必须拒用**，且可疑产物不得落地。
 *
 * 另附身份一致性回归（沿用 1.0.1 的判据，一条不删）。
 *
 * 运行：npm test（零依赖，只用 node:test + node:assert + 本地 HTTP 服务器）
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY_RELATIVE = 'lib/index.mjs'
/**
 * 入口文件的 URL，用来拼进隔离子进程的源码。
 * 必须走 pathToFileURL：Windows 的盘符路径在 ESM 里不是合法 specifier
 * （ERR_UNSUPPORTED_ESM_URL_SCHEME）。
 */
const ENTRY_IMPORT_URL = pathToFileURL(join(PACKAGE_ROOT, ENTRY_RELATIVE)).href

/** 本插件唯一合法的身份名。 */
const EXPECTED_NAME = 'dsh-github-login'

/** 官方 scope：第三方插件不可能发布在该 scope 下，出现即回归。 */
const FORBIDDEN_SCOPE = '@deepseek-ai/'

/**
 * 机器专用绝对路径的判据。
 * 盘符形式要求 `X:` 后面紧跟 `\` 或 `/`（排除 `https://` 这类 URL scheme）；
 * 另加 POSIX 家目录前缀。
 */
const MACHINE_PATH_PATTERNS = [
  { label: '盘符绝对路径', re: /(^|[^A-Za-z0-9+.-])[A-Za-z]:[\\/]/u },
  { label: 'POSIX 家目录', re: /\/(?:home|Users)\/[A-Za-z0-9._-]/u },
]

/**
 * 白名单：**逐条**登记（文件 + 行内容判据 + 原因），不做整文件豁免。
 * 当前为空 —— README 的调用示例已改成真实拼路径的写法，不再有"路径"字面量。
 * 以后要放行，必须写清是哪个文件的哪一行、为什么它不是运行时路径；
 * 断言会同时检查"登记过就必须命中"（白名单烂掉也不许悄悄留着）。
 */
const MACHINE_PATH_ALLOWLIST = []

/**
 * 必须扫描的入库文件（显式清单）。
 * 断言 ①-c 会核对"仓库根下所有入库存档都在清单里"，新增文件想绕过断言①就会红。
 */
const SHIPPED_FILES = [
  'lib/index.mjs',
  'main.js',
  'preload.js',
  'renderer/github-login.html',
  'cordis.patch.yml',
  'package.json',
  'package-lock.json',
  'README.md',
  '.npmrc',
  '.gitignore',
  'test/identity.test.mjs',
  'test/portability.test.mjs',
]

/** 仓库根下不参与断言①的条目（各自写明原因）。 */
const SCAN_SKIP = {
  'node_modules': '依赖目录，不是本仓库产物',
  '.git': '版本库内部数据',
  'dist': '构建产物目录（exe 二进制，属发布资产不入库）',
  '.release-notes.md': '上一版遗留的临时发布说明，未入库且不含机器路径',
}

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

/** 跑一个外部命令并收回 stdout/stderr（异步，理由同 runIsolated）。 */
function runCommand(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { shell: true, ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', fail)
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
}

/**
 * 在隔离子进程里跑一段脚本，返回它打印的 JSON（环境干净、只带调度相关的变量）。
 *
 * 必须是**异步** spawn：断言③ 的本地分发服务器就跑在本进程的事件循环上，
 * 用 spawnSync 会把父进程钉死，子进程的下载请求永远等不到响应（实测挂死）。
 */
function runIsolated(script, env) {
  const childEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: env.DSH_HOME,
    USERPROFILE: env.DSH_HOME,
    ...env,
  }
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', script], {
      cwd: PACKAGE_ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', fail)
    child.on('close', (code) => {
      try {
        assert.equal(code, 0, `隔离子进程失败（code=${code}）：\n${stderr}`)
        const lines = String(stdout).trim().split(/\r?\n/u).filter(Boolean)
        const last = lines[lines.length - 1]
        assert.ok(last, `隔离子进程没有输出：\n${stdout}\n--- stderr ---\n${stderr}`)
        done(JSON.parse(last.replace(/^[^{]*/u, '')))
      } catch (error) {
        fail(new Error(`${error.message}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`))
      }
    })
  })
}

function makeIsoHome(label) {
  return mkdtempSync(join(tmpdir(), `dsh-gl-${label}-`))
}

// ── 身份一致性（1.0.1 既有判据，一条不删）──────────────────────────────────

test('package.json.name 是本插件的真实包名', () => {
  const pkg = readPackageJson()
  assert.equal(pkg.name, EXPECTED_NAME)
})

test('入口导出 name == package.json.name == cordis.patch.yml entry name（上一 bug 的判据）', async () => {
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

test('version 三处一致：package.json == package-lock.json（根）== 本版发布号', () => {
  const pkg = readPackageJson()
  const lock = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package-lock.json'), 'utf8'))
  assert.equal(pkg.version, '1.0.2', '本版发布号应为 1.0.2')
  assert.equal(lock.version, pkg.version, 'package-lock.json 顶层 version 与 package.json 不一致')
  assert.equal(lock.packages?.['']?.version, pkg.version, 'package-lock.json 根包 version 与 package.json 不一致')
})

// ── 断言 ①：机器专用绝对路径必须为零 ────────────────────────────────────────

test('① 入库源码与文档里不得出现机器专用绝对路径（白名单逐条登记，无整文件豁免）', () => {
  const offenders = []
  const usedAllowlist = new Set()

  for (const relativePath of SHIPPED_FILES) {
    const full = join(PACKAGE_ROOT, relativePath)
    if (!existsSync(full)) continue
    for (const line of readFileSync(full, 'utf8').split(/\r?\n/u)) {
      for (const { label, re } of MACHINE_PATH_PATTERNS) {
        if (!re.test(line)) continue
        const hit = MACHINE_PATH_ALLOWLIST.find(
          (entry) => entry.file === relativePath && line.includes(entry.lineIncludes),
        )
        if (hit) {
          usedAllowlist.add(`${hit.file}::${hit.lineIncludes}`)
          continue
        }
        offenders.push(`[${label}] ${relativePath}: ${line.trim()}`)
      }
    }
  }

  assert.deepEqual(offenders, [], `发现机器专用绝对路径：\n${offenders.join('\n')}`)

  // 白名单条目必须真的被用到：否则说明规则漂移，白名单可能在假性放行别的东西。
  for (const entry of MACHINE_PATH_ALLOWLIST) {
    assert.ok(
      usedAllowlist.has(`${entry.file}::${entry.lineIncludes}`),
      `白名单条目已失效（未命中任何行）：${entry.file} / ${entry.lineIncludes}`,
    )
  }
})

test('①-b npm 包实际入包文件里不得出现机器专用绝对路径，且不得含 exe', async () => {
  const result = await runCommand('npm', ['pack', '--dry-run', '--json'], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, npm_config_loglevel: 'silent' },
  })
  assert.equal(result.code, 0, `npm pack --dry-run 失败：\n${result.stderr || ''}`)
  const parsed = JSON.parse(result.stdout)
  const files = parsed?.[0]?.files?.map((file) => file.path) ?? []
  assert.ok(files.length > 0, 'npm pack --dry-run 没有列出任何文件')

  // 74MB 的 exe 绝不能进 npm 包（体积 / 每次安装都不划算）。
  const bundledExe = files.filter((file) => file.toLowerCase().endsWith('.exe'))
  assert.deepEqual(bundledExe, [], `npm 包里不该出现 exe：${bundledExe.join(', ')}`)

  const offenders = []
  for (const file of files) {
    const full = join(PACKAGE_ROOT, file)
    if (!existsSync(full) || statSync(full).isDirectory()) continue
    if (!/\.(?:mjs|js|json|yml|yaml|md|html)$/u.test(file)) continue
    for (const line of readFileSync(full, 'utf8').split(/\r?\n/u)) {
      if (MACHINE_PATH_PATTERNS.some(({ re }) => re.test(line))) {
        offenders.push(`${file}: ${line.trim()}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `入包文件里发现机器专用绝对路径：\n${offenders.join('\n')}`)
})

test('①-c 仓库根下没有"清单外仍未扫描"的入库条目（新增文件无法绕过断言①）', () => {
  const files = readdirSync(PACKAGE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !(name in SCAN_SKIP))
  const missing = files.filter((name) => !SHIPPED_FILES.includes(name))
  assert.deepEqual(
    missing,
    [],
    `以下条目没有被断言①扫描（请加进 SHIPPED_FILES 或写清跳过原因）：\n${missing.join('\n')}`,
  )
  // 目录条目逐个点名：新增目录必须显式决定"扫 or 说明为什么不扫"。
  const dirs = readdirSync(PACKAGE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !(name in SCAN_SKIP))
  assert.deepEqual(
    dirs.sort(),
    ['build', 'lib', 'renderer', 'test'],
    `仓库根目录集合变了，请连同断言①的扫描清单一起复核：${dirs.join(', ')}`,
  )
})

test('①-d 入库测试文件自身也不含机器专用绝对路径（不许"测试文件豁免"）', () => {
  const offenders = []
  for (const name of ['test/identity.test.mjs', 'test/portability.test.mjs']) {
    for (const line of readFileSync(join(PACKAGE_ROOT, name), 'utf8').split(/\r?\n/u)) {
      for (const { label, re } of MACHINE_PATH_PATTERNS) {
        if (re.test(line)) offenders.push(`[${label}] ${name}: ${line.trim()}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `测试文件里写了机器专用绝对路径（要把它们当"反例"记录时，用变量拼，别写死）：\n${offenders.join('\n')}`,
  )
})

// ── 断言 ②：候选列表每一项都能由规则推导 ────────────────────────────────────

test('② 候选每项都由规则推导：源码无路径字面量，API 返回值全落在可推导根下', async () => {
  const source = readFileSync(join(PACKAGE_ROOT, ENTRY_RELATIVE), 'utf8')
  for (const { label, re } of MACHINE_PATH_PATTERNS) {
    assert.ok(!re.test(source), `${ENTRY_RELATIVE} 源码里出现了${label}字面量`)
  }
  // 直接钉住那条本机路径：它曾真实存在，是本次缺陷的原始形态。
  // 注意用变量拼出来 —— 本文件自己也要能通过断言①（写死字面量会把自己扫红）。
  const drive = 'D'
  const legacyPaths = [`${drive}:/dsh/dsh-github-login`, `${drive}:\\dsh\\dsh-github-login`]
  for (const needle of legacyPaths) {
    assert.ok(!source.includes(needle), `${ENTRY_RELATIVE} 仍含作者本机路径 ${needle}`)
  }
  assert.ok(
    !/['"`][A-Za-z]:[\\/]/u.test(source),
    `${ENTRY_RELATIVE} 里存在盘符路径字符串字面量`,
  )

  const isoHome = makeIsoHome('candidates')
  const override = join(isoHome, 'from-env', 'DSH-GitHub-Login.exe')
  try {
    const out = await runIsolated(
      `const mod = await import(${JSON.stringify(ENTRY_IMPORT_URL)})
       const fs = await import('node:fs')
       const path = await import('node:path')
       const home = process.env.DSH_HOME
       const roots = [home, path.join(home, 'dsh-github-login'), fs.realpathSync(${JSON.stringify(PACKAGE_ROOT)})]
       const candidates = mod.loginToolCandidates()
       const inside = (candidate, root) => candidate === root || candidate.startsWith(root + path.sep)
       console.log(JSON.stringify({
         candidates,
         override: process.env.DSH_GITHUB_LOGIN_EXE,
         roots,
         escaped: candidates.filter((c) => !roots.some((r) => inside(c, r))),
       }))`,
      { DSH_HOME: isoHome, DSH_GITHUB_LOGIN_EXE: override },
    )

    const roots = out.roots.map((root) => resolve(root))
    assert.deepEqual(
      out.escaped,
      [],
      `候选不在任何可推导根下（说明来自字面量而不是规则）：\n${out.escaped.join('\n')}`,
    )
    // 结构固定：1 个环境变量 + 4 个规则位（DSH_HOME 两位、插件安装目录两位）。
    assert.equal(out.candidates.length, 5, `候选数量应为 5，实际 ${out.candidates.length}`)
    // 环境变量覆盖必须被尊重（用户自己放的 exe 也应当能用）。
    assert.ok(
      out.candidates.includes(resolve(override)),
      `DSH_GITHUB_LOGIN_EXE 指定的路径没有进候选：${override}`,
    )
  } finally {
    rmSync(isoHome, { recursive: true, force: true })
  }
})

test('②-b 没有环境变量覆盖时，候选全部落在 DSH_HOME 或插件安装目录下', async () => {
  const isoHome = makeIsoHome('candidates2')
  try {
    const out = await runIsolated(
      `const mod = await import(${JSON.stringify(ENTRY_IMPORT_URL)})
       console.log(JSON.stringify({ candidates: mod.loginToolCandidates(), home: process.env.DSH_HOME }))`,
      { DSH_HOME: isoHome },
    )
    assert.equal(out.candidates.length, 4, `无覆盖时应为 4 项，实际 ${out.candidates.length}`)
    const allowedRoots = [resolve(isoHome), resolve(PACKAGE_ROOT)]
    for (const candidate of out.candidates) {
      const path = resolve(candidate)
      assert.ok(
        allowedRoots.some((root) => path === root || path.startsWith(root + sep)),
        `候选逃出了可推导根：${candidate}`,
      )
    }
    // 与 1.0.1 的落盘位置保持兼容（老用户把 exe 放在 dist/ 下仍然能用）。
    assert.ok(
      out.candidates.some((candidate) => candidate.endsWith(join('dsh-github-login', 'dist', 'DSH-GitHub-Login.exe'))),
      '应保留 <DSH_HOME>/dsh-github-login/dist/ 这一兼容落点',
    )
  } finally {
    rmSync(isoHome, { recursive: true, force: true })
  }
})

// ── 断言 ③：自动下载的 sha256 门禁 ──────────────────────────────────────────

/** 起一个本地分发服务器，同时托管 exe 与 .sha256，返回基址与关闭函数。 */
async function startDistributionServer(payload, sha256Text) {
  const requests = []
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    requests.push(path)
    if (path.endsWith('.sha256')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(sha256Text)
      return
    }
    if (path.endsWith('.exe')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(payload)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}/download`,
    requests,
    close: () => new Promise((done) => server.close(done)),
  }
}

/** 在隔离子进程里跑一次 ensureLoginTool，回报结果与落盘事实。 */
function runEnsure(isoHome, baseUrl) {
  return runIsolated(
    `const mod = await import(${JSON.stringify(ENTRY_IMPORT_URL)})
     const fs = await import('node:fs')
     const path = await import('node:path')
     const dir = path.join(process.env.DSH_HOME, 'dsh-github-login')
     const target = path.join(dir, 'DSH-GitHub-Login.exe')
     const part = target + '.part'
     const result = await mod.ensureLoginTool()
     console.log(JSON.stringify({
       result,
       leftover: result.error && result.error.includes('未能删除') ? result.error : null,
       targetExists: fs.existsSync(target),
       partExists: fs.existsSync(part),
       partStat: fs.existsSync(part) ? fs.statSync(part).size : null,
       dirEntries: fs.existsSync(dir) ? fs.readdirSync(dir) : [],
       listed: mod.findLoginTool(),
     }))`,
    {
      DSH_HOME: isoHome,
      DSH_GITHUB_LOGIN_RELEASE_BASE_URL: baseUrl,
      // 指到一个不存在的路径：确保不会因为"本机已有"而短路掉下载分支。
      DSH_GITHUB_LOGIN_EXE: join(isoHome, 'nope', 'DSH-GitHub-Login.exe'),
    },
  )
}

test('③ 自动下载：sha256 匹配才启用；不匹配必须拒用且不留任何产物', async (t) => {
  const payload = Buffer.from(`fake-portable-exe-${'x'.repeat(4096)}`, 'utf8')
  const goodSha = createHash('sha256').update(payload).digest('hex')

  await t.test('匹配 → 下载、校验通过、原子落地', async () => {
    const server = await startDistributionServer(payload, `${goodSha}  DSH-GitHub-Login.exe\n`)
    const isoHome = makeIsoHome('ok')
    try {
      const out = await runEnsure(isoHome, server.baseUrl)
      assert.equal(out.result.ready, true, `应当就绪：${JSON.stringify(out.result)}`)
      assert.equal(out.result.downloaded, true, '首次获取应标记为 downloaded')
      assert.equal(out.result.sha256, goodSha, '回报的 sha256 应等于发布方给的校验和')
      assert.equal(out.result.bytes, payload.length, '回报的字节数应等于实际下载长度')
      assert.equal(out.targetExists, true, '校验通过后应落盘')
      assert.equal(out.partExists, false, '临时 .part 必须清理')
      assert.equal(out.listed, join(isoHome, 'dsh-github-login', 'DSH-GitHub-Login.exe'))
      assert.deepEqual(out.dirEntries, ['DSH-GitHub-Login.exe'], `落盘目录只应有正式文件：${out.dirEntries}`)
    } finally {
      rmSync(isoHome, { recursive: true, force: true })
      await server.close()
    }
  })

  await t.test('不匹配 → 拒绝启用，正式文件与 .part 都不得存在', async () => {
    const badSha = goodSha.replace(/^./u, goodSha[0] === '0' ? '1' : '0')
    assert.notEqual(badSha, goodSha, '构造的坏哈希必须与好哈希不同')
    const server = await startDistributionServer(payload, `${badSha}  DSH-GitHub-Login.exe\n`)
    const isoHome = makeIsoHome('bad')
    try {
      const out = await runEnsure(isoHome, server.baseUrl)
      assert.equal(out.result.ready, false, `校验和不符时不得就绪：${JSON.stringify(out.result)}`)
      assert.match(String(out.result.error), /校验不一致/u, `失败原因应点明校验和不符：${out.result.error}`)
      assert.equal(out.targetExists, false, '校验和不符的文件绝不能落到正式路径')
      assert.equal(out.partExists, false, '校验和不符的 .part 必须删除')
      assert.deepEqual(out.dirEntries, [], `落盘目录必须干净：${out.dirEntries}`)
      assert.equal(out.listed, null, 'findLoginTool 不得把未通过校验的文件当可用工具')
    } finally {
      rmSync(isoHome, { recursive: true, force: true })
      await server.close()
    }
  })

  await t.test('校验和文件本身格式不对 → 直接失败，不下载 exe', async () => {
    const server = await startDistributionServer(payload, 'not-a-sha256-line\n')
    const isoHome = makeIsoHome('badfmt')
    try {
      const out = await runEnsure(isoHome, server.baseUrl)
      assert.equal(out.result.ready, false, '校验和格式不可识别时必须失败')
      assert.match(String(out.result.error), /格式无法识别/u)
      assert.equal(out.targetExists, false)
      // 没有可信基准就不该去拉 exe：只允许请求过 .sha256。
      assert.deepEqual(server.requests, ['/download/DSH-GitHub-Login.exe.sha256'], `不应请求 exe：${server.requests.join(', ')}`)
    } finally {
      rmSync(isoHome, { recursive: true, force: true })
      await server.close()
    }
  })
})

test('③-d 校验和文件解析：只认标准 sha256sum 格式，坏格式必须抛', async () => {
  const mod = await import(new URL(`../${ENTRY_RELATIVE}`, import.meta.url))
  const hex = 'a'.repeat(64)
  // 标准格式（sha256sum 输出，可能带 * 二进制标记、可能 CRLF）
  assert.equal(mod.parseSha256File(`${hex}  DSH-GitHub-Login.exe\n`), hex)
  assert.equal(mod.parseSha256File(`\n${hex.toUpperCase()} *DSH-GitHub-Login.exe\r\n`), hex, '应兼容大写与 CRLF')
  // 坏格式：长度不对 / 不是十六进制 / 空内容 —— 一律抛，绝不返回一个"看起来像哈希"的值
  for (const bad of [`${'a'.repeat(63)}  x.exe`, `zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz  x.exe`, '', '   ', null]) {
    assert.throws(() => mod.parseSha256File(bad, 'test'), /格式无法识别/u, `坏格式应抛错：${String(bad).slice(0, 20)}`)
  }
})

test('③-b 自动获取不可用时，必须给出可照做的指引（不许静默失败）', async () => {
  const isoHome = makeIsoHome('hint')
  try {
    const out = await runIsolated(
      `const mod = await import(${JSON.stringify(ENTRY_IMPORT_URL)})
       console.log(JSON.stringify({ state: mod.toolState(), hint: mod.manualHint('网络不可用') }))`,
      {
        DSH_HOME: isoHome,
        DSH_GITHUB_LOGIN_RELEASE_BASE_URL: 'http://127.0.0.1:1/download',
        DSH_GITHUB_LOGIN_EXE: join(isoHome, 'nope', 'DSH-GitHub-Login.exe'),
      },
    )
    assert.equal(out.state.available, false, '隔离 HOME 下不该凭空"可用"')
    assert.equal(out.state.downloading, false)
    assert.equal(out.state.candidates.length, 5)
    // 指引必须能照着做：下载地址、校验和地址、落盘路径、以及覆盖用的环境变量名。
    assert.match(out.hint, /DSH-GitHub-Login\.exe/u)
    assert.match(out.hint, /\.sha256/u)
    assert.match(out.hint, /DSH_GITHUB_LOGIN_EXE/u)
    assert.match(out.hint, /DSH_GITHUB_LOGIN_RELEASE_BASE_URL/u)
    assert.ok(out.hint.includes(out.state.installDir), '指引里应含实际落盘目录')
  } finally {
    rmSync(isoHome, { recursive: true, force: true })
  }
})

test('③-c 本机已放好 exe（环境变量指向）→ 直接用，不触发下载', async () => {
  const isoHome = makeIsoHome('preexisting')
  const provided = join(isoHome, 'my-tools', 'DSH-GitHub-Login.exe')
  try {
    mkdirSync(dirname(provided), { recursive: true })
    writeFileSync(provided, 'stub', 'utf8')
    const out = await runIsolated(
      `const mod = await import(${JSON.stringify(ENTRY_IMPORT_URL)})
       const fs = await import('node:fs')
       const found = mod.findLoginTool()
       const checked = fs.existsSync(found)
       const result = await mod.ensureLoginTool()
       console.log(JSON.stringify({ found, checked, result }))`,
      {
        DSH_HOME: isoHome,
        DSH_GITHUB_LOGIN_EXE: provided,
        // 故意的死地址：一旦走下载就必然失败 —— 用来证明"已有则不下载"。
        DSH_GITHUB_LOGIN_RELEASE_BASE_URL: 'http://127.0.0.1:1/download',
      },
    )
    assert.equal(out.found, provided)
    assert.equal(out.checked, true)
    assert.equal(out.result.ready, true)
    assert.equal(out.result.downloaded, false, '本机已有工具时不得再下载')
  } finally {
    rmSync(isoHome, { recursive: true, force: true })
  }
})
