/**
 * @deepseek-ai/dsh-github-login —— DSH 宿主端插件。
 *
 * 与独立登录工具共享同一份令牌文件（~/.dsh/github-auth.json），
 * 为生态内其他插件/页面提供环回接口：
 *   GET  /github-auth/status  登录状态（只含 login，绝不下发令牌）
 *   POST /github-auth/open    确保登录工具就绪并唤起窗口
 *   GET  /github-auth/tool    登录工具自查（在不在、装在哪、下载到哪一步）
 *
 * 「别的用户装完能不能用」是这份文件的头等约束：
 *   · 候选路径**只用可推导规则**拼（DSH_HOME / 插件自身安装目录 / 环境变量覆盖），
 *     绝不出现作者本机的盘符字面量；
 *   · 首次唤起时若本机没有工具，就从 GitHub Release **自动下载**：
 *     边下边算 sha256，**与发布方的 .sha256 不符即拒绝启用**（可疑文件绝不落地）；
 *   · 自动获取失败一律降级成**说得清怎么手动装**的 hint（沿环回接口透传给调用方），
 *     绝不静默失败。
 *
 * 在无 webServer 的组合（如 headless profile）里静默不注册。
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

export const name = 'dsh-github-login'
export const inject = []

/** 登录工具的可执行文件名（Release 资产名与本地落盘名一致）。 */
const EXE_NAME = 'DSH-GitHub-Login.exe'
/** 本仓库 Release 资产的基址（latest 永久指向最新一版）。 */
const DEFAULT_RELEASE_BASE_URL = 'https://github.com/Noob-stupid/dsh-github-login/releases/latest/download'
/** 环境变量：覆盖资产基址（镜像源 / 自建分发站 / 测试用本地服务器）。 */
const RELEASE_BASE_ENV = 'DSH_GITHUB_LOGIN_RELEASE_BASE_URL'
/** 环境变量：直接指定可执行文件绝对路径（放在哪儿都行）。 */
const EXE_ENV = 'DSH_GITHUB_LOGIN_EXE'
/** 自动获取的失败重试上限：网络抖动值得重试，校验和不符不值得（那不是抖动）。 */
const MAX_DOWNLOAD_ATTEMPTS = 3
/** 单次下载的**响应头**超时。74MB 的传输不能设整体超时，但迟迟拿不到响应头必须判失败。 */
const RESPONSE_HEADER_TIMEOUT_MS = 60_000

/** 插件自身安装目录（lib/ 的上一级）：可推导，与机器无关。 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 本进程内正在进行的下载：并发唤起共用一个，不重复下载。 */
let pendingDownload = null

function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/** 自动获取的落点：<DSH_HOME>/dsh-github-login/DSH-GitHub-Login.exe */
function installDir() {
  return join(dshHome(), 'dsh-github-login')
}

function releaseBaseUrl() {
  return process.env[RELEASE_BASE_ENV]?.trim().replace(/\/+$/u, '') || DEFAULT_RELEASE_BASE_URL
}

/**
 * 候选可执行文件位置，**逐项都由规则推导**：
 *   1. 环境变量显式指定（用户自己放的、或分发站给的位置）
 *   2. 自动下载的落点 <DSH_HOME>/dsh-github-login/
 *   3. 老版本留下的嵌套落点 <DSH_HOME>/dsh-github-login/dist/（兼容，仍可推导）
 *   4. 插件自身安装目录（在本仓库源码树里直接跑时命中）
 * 任何一项都不含盘符或家目录字面量。
 */
export function loginToolCandidates() {
  const candidates = []
  const override = process.env[EXE_ENV]?.trim()
  if (override) candidates.push(override)
  candidates.push(
    join(installDir(), EXE_NAME),
    join(installDir(), 'dist', EXE_NAME),
    join(PACKAGE_ROOT, 'dist', EXE_NAME),
    join(PACKAGE_ROOT, EXE_NAME),
  )
  return candidates
}

/** 当前真实可用的登录工具路径；本机没有则 null。 */
export function findLoginTool() {
  return loginToolCandidates().find((candidate) => existsSync(candidate)) ?? null
}

/**
 * 解析 .sha256 文件：标准 `sha256sum` 格式 `<64位十六进制>  <文件名>`。
 * 只认第一个非空行的第一个字段；格式不对直接抛（宁可失败也不拿一个假哈希去校验）。
 */
export function parseSha256File(text, source = 'sha256 文件') {
  const first = String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== '')
  const match = first?.match(/^([0-9a-fA-F]{64})(?:\s|$)/u)
  if (!match) throw new Error(`校验和文件格式无法识别（${source}）`)
  return match[1].toLowerCase()
}

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(RESPONSE_HEADER_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
  return await res.text()
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

/**
 * 下载 exe 到临时文件（同目录 .part）——校验和**不符即删**，绝不 rename 到正式路径。
 * 流式：边收边算 sha256、边写盘，不把 74MB 读进内存。
 */
export async function downloadVerifiedExe(options = {}) {
  const base = (options.baseUrl ?? releaseBaseUrl()).replace(/\/+$/u, '')
  const dir = options.dir ?? installDir()
  const target = join(dir, EXE_NAME)
  const part = `${target}.part`

  // 先取发布方的校验和：拿不到它就没资格下载（没有基准的"校验"是自欺）。
  const shaUrl = `${base}/${EXE_NAME}.sha256`
  const expected = parseSha256File(await fetchText(shaUrl), shaUrl)

  const exeUrl = `${base}/${EXE_NAME}`
  const res = await fetch(exeUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(RESPONSE_HEADER_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
  if (!res.body) throw new Error('下载失败：响应没有数据体')

  mkdirSync(dir, { recursive: true })
  const hash = createHash('sha256')
  const sink = createWriteStream(part)
  let bytes = 0
  let leftover = null
  try {
    const source = Readable.fromWeb(res.body)
    source.on('data', (chunk) => {
      hash.update(chunk)
      bytes += chunk.length
    })
    await pipeline(source, sink)
    const actual = hash.digest('hex').toLowerCase()
    if (bytes === 0) throw new Error('下载得到空文件，已拒绝启用')
    if (actual !== expected) {
      throw new Error(
        `sha256 校验不一致，已拒绝启用该文件：期望 ${expected}，实际 ${actual}（${bytes} 字节）`,
      )
    }
    renameSync(part, target)
    return { path: target, sha256: actual, bytes, source: exeUrl, verifiedAgainst: shaUrl }
  } catch (error) {
    // 可疑/未完成的产物绝不留存：先释放响应体与写流句柄（Windows 上句柄没放开就删不掉），
    // 再带重试地删；删不掉就**如实说**有个残留文件，不假装干净。
    try { await res.body.cancel() } catch {}
    sink.destroy()
    leftover = await removeQuietly(part)
    const suffix = leftover ? `【注意：临时文件未能删除，请手动清理 ${leftover}】` : ''
    const message = error instanceof Error ? error.message : String(error)
    const wrapped = new Error(`${message}${suffix}`)
    wrapped.leftover = leftover
    throw wrapped
  } finally {
    // 成功路径上 sink 已自然关闭；失败路径上再补一刀，确保句柄一定被释放。
    sink.destroy()
  }
}

/**
 * 尽力删除文件，返回"仍存在的路径"（成功则 null）。
 *
 * 用 `unlinkSync` 而不是 `rmSync`：本机实测（Windows）`fs.rmSync(file, {force:true})`
 * 会**静默不删**（不抛错、文件仍在！），`unlinkSync` 才真的删除。
 * 这种"看起来成功其实没删"的行为正是要拦住的东西 —— 可疑产物必须真的不在。
 * 句柄刚写过可能尚未释放，所以带重试；删不掉就把真实原因附在返回值里。
 */
async function removeQuietly(file, attempts = 8) {
  let lastError = null
  for (let i = 0; i < attempts; i += 1) {
    try {
      unlinkSync(file)
      lastError = null
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      lastError = error
    }
    if (!existsSync(file)) return null
    await sleep(60)
  }
  if (existsSync(file)) {
    const reason = lastError?.code ? `（${lastError.code}: ${lastError.message}）` : '（删除未报错但文件仍在）'
    return `${file}${reason}`
  }
  return null
}

/** 这些失败重试同一个地址没有意义（不是网络抖动）：坏基准、坏产物、坏响应。 */
const NON_RETRYABLE = /校验不一致|校验和文件格式无法识别|下载得到空文件|HTTP 4\d\d/u

/** 自动获取登录工具：成功返回结果，失败抛错（由调用方转成给用户的指引）。 */
export async function installLoginTool(options = {}) {
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0
    ? options.attempts
    : MAX_DOWNLOAD_ATTEMPTS
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { ...(await downloadVerifiedExe(options)), attemptsUsed: attempt }
    } catch (error) {
      lastError = error
      if (NON_RETRYABLE.test(String(error?.message ?? ''))) throw error
      if (attempt < attempts) await sleep(attempt * 1000)
    }
  }
  throw lastError ?? new Error('自动获取登录工具失败')
}

/**
 * 保证登录工具可用。
 *   本机已有 → { ready: true, path, downloaded: false }
 *   本机没有 → 走一次自动下载（已经在下载则复用同一个 promise）
 * 调用方拿到 ready:false 时必须把 hint 给用户 —— 不许静默失败。
 */
export async function ensureLoginTool(options = {}) {
  const existing = findLoginTool()
  if (existing) return { ready: true, path: existing, downloaded: false }
  if (pendingDownload) return await pendingDownload

  const run = (async () => {
    try {
      const result = await installLoginTool(options)
      return {
        ready: true,
        path: result.path,
        downloaded: true,
        sha256: result.sha256,
        bytes: result.bytes,
        source: result.source,
        verifiedAgainst: result.verifiedAgainst,
        attemptsUsed: result.attemptsUsed,
      }
    } catch (error) {
      return {
        ready: false,
        path: null,
        downloaded: false,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      // 失败不缓存：用户稍后重试时应当真的再试一次，而不是拿到一个已失败的 promise。
      pendingDownload = null
    }
  })()
  pendingDownload = run
  return await run
}

/** 工具现状：给面板 / 排障用，字段只读、不含令牌。 */
export function toolState() {
  const path = findLoginTool()
  return {
    available: path !== null,
    path,
    candidates: loginToolCandidates(),
    downloading: pendingDownload !== null,
    installDir: installDir(),
    releaseBaseUrl: releaseBaseUrl(),
    envOverride: { exe: EXE_ENV, releaseBaseUrl: RELEASE_BASE_ENV },
  }
}

/** 唤起登录工具窗口（独立进程，detached，关掉宿主也不影响它）。 */
export function launchLoginTool(path) {
  const child = spawn(path, [], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return path
}

/** 自动获取成功后的提示：下一次唤起就会直接开窗口。 */
function readyHint(downloaded) {
  if (!downloaded) return null
  return `登录工具已自动下载并通过 sha256 校验（${findLoginTool() ?? '见 /github-auth/tool'}）；请再点一次登录以打开窗口`
}

/** 自动获取失败 → 给用户一条**能照着做**的路，而不是一句"失败了"。 */
export function manualHint(error) {
  const target = join(installDir(), EXE_NAME)
  const base = releaseBaseUrl()
  return [
    `未能自动获取登录工具（${error}）。`,
    `手动下载：${base}/${EXE_NAME}`,
    `校验和：${base}/${EXE_NAME}.sha256`,
    `放到：${target}`,
    '也可用环境变量 DSH_GITHUB_LOGIN_EXE 指到你已下载的 exe，'
      + '或 DSH_GITHUB_LOGIN_RELEASE_BASE_URL 指定镜像源；放好后重新登录即可。',
  ].join(' ')
}

function authStatus() {
  try {
    const data = JSON.parse(readFileSync(join(dshHome(), 'github-auth.json'), 'utf8'))
    if (data && typeof data.token === 'string' && data.token) {
      return {
        loggedIn: true,
        login: typeof data.login === 'string' && data.login && data.login !== 'unknown' ? data.login : null,
      }
    }
  } catch {}
  return { loggedIn: false, login: null }
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

export function apply(ctx) {
  // Wait for webServer: a mount-time ctx.get() may run before the host builds it,
  // which used to skip route registration entirely (no retry).
  ctx.inject(['webServer'], (hostCtx) => {
    const webServer = hostCtx.get('webServer')
    if (!webServer) return
    hostCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/github-auth',
      handler: async (req, res) => {
        if (!isLoopback(req.socket?.remoteAddress ?? '')) {
          sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://x')
        try {
          if (url.pathname === '/github-auth/status') {
            sendJson(res, 200, { ok: true, ...authStatus() })
            return
          }
          if (url.pathname === '/github-auth/tool') {
            sendJson(res, 200, { ok: true, ...toolState() })
            return
          }
          if (url.pathname === '/github-auth/open' && (req.method ?? 'GET') === 'POST') {
            const tool = await ensureLoginTool()
            if (tool.ready) {
              launchLoginTool(tool.path)
              sendJson(res, 200, {
                ok: true,
                launched: tool.path,
                downloaded: tool.downloaded,
                sha256: tool.sha256 ?? null,
                hint: readyHint(tool.downloaded),
              })
            } else {
              sendJson(res, 200, { ok: true, launched: false, hint: manualHint(tool.error) })
            }
            return
          }
          sendJson(res, 404, { ok: false, error: '未知接口' })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'github-login: routes')
  })
}
