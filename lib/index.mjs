/**
 * @deepseek-ai/dsh-github-login —— DSH 宿主端插件。
 *
 * 与独立登录工具共享同一份令牌文件（~/.dsh/github-auth.json），
 * 为生态内其他插件/页面提供环回接口：
 *   GET  /github-auth/status  登录状态（只含 login，绝不下发令牌）
 *   POST /github-auth/open    唤起登录工具窗口（找到 exe 则启动，否则给提示）
 *
 * 在无 webServer 的组合（如 headless profile）里静默不注册。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

export const name = 'dsh-github-login'
export const inject = []

function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
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

function loginToolCandidates() {
  const list = [
    join(dshHome(), 'dsh-github-login', 'dist', 'DSH-GitHub-Login.exe'),
    'D:/dsh/dsh-github-login/dist/DSH-GitHub-Login.exe',
  ]
  return list.filter((candidate) => existsSync(candidate))
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
  // Wait for webServer: a mount-time ctx.get() may run before the host builds it.
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
        if (url.pathname === '/github-auth/open' && (req.method ?? 'GET') === 'POST') {
          const tools = loginToolCandidates()
          if (tools.length > 0) {
            const child = spawn(tools[0], [], { detached: true, stdio: 'ignore', windowsHide: false })
            child.unref()
            sendJson(res, 200, { ok: true, launched: tools[0] })
          } else {
            sendJson(res, 200, { ok: true, launched: false, hint: '未找到登录工具 exe；请从 https://github.com/Noob-stupid/dsh-github-login 获取' })
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
