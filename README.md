<img width="641" height="696" alt="576e3125-a190-4608-a42b-60010b6df02d" src="https://github.com/user-attachments/assets/bb7c1991-9346-4c20-8dc2-5d884515c522" />
<img width="642" height="696" alt="601b77fd-517d-4be4-b2c8-b25a13c3e852" src="https://github.com/user-attachments/assets/45a31794-ab56-4e34-8826-fb362deef3dc" />
<img width="642" height="695" alt="7efef08e-0326-47d3-bfa1-f55427fa6cb4" src="https://github.com/user-attachments/assets/e23560ca-41d3-4a83-bc14-1d20f884cd8a" />

# DSH GitHub Login —— 独立的 GitHub 可视化登录插件

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)



一个零终端的 GitHub 登录小工具：打开窗口 → 生成设备码 → 授权 → 完成。
**设备码流程在窗口内（Chromium 网络栈）执行**，与你的浏览器共用同一网络通道——
浏览器能打开 GitHub，这里就能完成登录，不受终端/代理配置差异影响。

## 安装（DSH 插件模式）

一条命令装进 DSH，并自动启用宿主端插件（提供登录状态接口 + 一键唤起登录窗口）：

```sh
dsh plugin --profile web add github:Noob-stupid/dsh-github-login
```

**装完怎么用**：登录窗口由独立的历史可执行文件承载，但这个 exe **不用你手动找** ——
第一次点"登录 GitHub"时，插件会自己从本仓库 Release 下载它，**边下边校验 SHA-256**，
校验通过才落盘，然后启动窗口：

```
下载地址：https://github.com/Noob-stupid/dsh-github-login/releases/latest/download/DSH-GitHub-Login.exe
落盘位置：<DSH_HOME>/dsh-github-login/DSH-GitHub-Login.exe   （DSH_HOME 缺省 ~/.dsh）
校验和：  同目录的 DSH-GitHub-Login.exe.sha256；不符即拒用，绝不启动可疑文件
```

首次会自动下载（约 71 MB），下载完**提示再点一次登录**就开窗口。自动下载不可用
（网络受限 / 镜像源）时不会静默失败，而是给出一条能照着做的指引，你也可以手动装：

```sh
# 1) 下载 exe 与它的校验和（想校验就先核对 sha256）
#    两个文件都在 Release 页面：https://github.com/Noob-stupid/dsh-github-login/releases/latest
# 2) 放到规范位置
#    Windows: %DSH_HOME%\dsh-github-login\DSH-GitHub-Login.exe   （缺省 %USERPROFILE%\.dsh\...）
#    Linux/macOS: $DSH_HOME/dsh-github-login/DSH-GitHub-Login.exe
# 3) 也可以不复位：用环境变量把路径/镜像源告诉插件
#    DSH_GITHUB_LOGIN_EXE=<你放 exe 的绝对路径>
#    DSH_GITHUB_LOGIN_RELEASE_BASE_URL=<镜像源或自建分发站的 .../latest/download 基址>
```

宿主端环回接口（都只允许本机访问）：

- `GET  /github-auth/status` → `{ok, loggedIn, login}`（只含账号名，绝不下发令牌）
- `POST /github-auth/open`   → 没有工具就先自动下载（校验 sha256）、再唤起窗口；
  拿不到工具时回 `{ok:true, launched:false, hint:"…"}`，hint 就是上面那份手动指引
- `GET  /github-auth/tool`   → 工具自查：在不在、装在哪、候选列表、是否正在下载

> 说明：设备码流程本身（请求设备码、轮询、写令牌、同步 gh）**全部是 JS 实现的**，
> exe 只是承载这套界面的独立窗口；令牌文件与插件共享，所以登录一次两边都认。

独立工具用法（不带 DSH 也行）：下载 Release 里的 `DSH-GitHub-Login.exe` 直接运行。

## 功能

- **窗口内授权**：授权页直接内嵌在窗口里（`<webview>`），带 **前进 / 后退 / 刷新** 按钮，
  也可以一键改用外部浏览器打开；
- 登录成功后令牌保存在 `~/.dsh/github-auth.json`；
- 同时同步进 gh CLI 的 `~/.config/gh/hosts.yml`，**gh 命令行立即可用**（keyring 存在时 gh 以 keyring 优先）；
- 托盘常驻：随时查看账号状态 / 一键退出登录；
- 复用 GitHub CLI 的公开 OAuth client_id（`178c6fc778ccc68e1d6a`），权限范围
  `repo workflow gist read:org`。

## 用法

```sh
npm install        # 安装 electron（已配置国内镜像）
npm start          # 直接运行
npm run dist       # 打包为便携版单文件 exe（dist/DSH-GitHub-Login.exe）
```

## 与 dsh-plugin-hub 配套

[dsh-plugin-hub](https://github.com/Noob-stupid/dsh-plugin-hub)（插件管理面板）会读取
本工具写入的同一份令牌文件：登录后面板的 GitHub 市场显示"已登录 GitHub：<账号>"，
且服务端回退通道自动带认证（搜索配额 10 → 30 次/分钟）。

## 集成到其他应用（如桌面客户端）

把它当作一个独立进程调用即可：登录状态通过同一份文件（`~/.dsh/github-auth.json`）
共享，任何 DSH 生态工具都能读取。可执行文件的规范落点是
`<DSH_HOME>/dsh-github-login/DSH-GitHub-Login.exe`（`DSH_HOME` 缺省为 `~/.dsh`），
自己写的调用方照这个位置拼路径就行：

```js
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const exe = process.env.DSH_GITHUB_LOGIN_EXE // 可选：显式指定 exe 路径
  || join(dshHome, 'dsh-github-login', 'DSH-GitHub-Login.exe')

spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
```

之后用 `gh auth status` 或直接读取 `~/.dsh/github-auth.json` 验证登录状态。

## 原理

GitHub Device Flow：

1. `POST https://github.com/login/device/code` → `user_code` + `device_code`
2. 在窗口内嵌浏览器（或外部浏览器）打开 `https://github.com/login/device`，输入 `user_code` 授权
3. 按 GitHub 给出的 `interval` 轮询 `POST https://github.com/login/oauth/access_token`
4. 拿到 `access_token` → 主进程落盘 + 写入 gh 配置

轮询严格遵循服务器间隔；网络抖动不中断（验证码 15 分钟有效期）；授权成功
即完成，用户名查询是尽力而为的补充。

## 与桌面端的关系

本仓库**只包含登录插件本身**，不包含任何桌面客户端代码。桌面客户端可在本地
集成它（见上）；两者通过令牌文件共享登录状态。

## 帮助 / Help

遇到问题先看这里；仍有疑问请到 [议题](https://github.com/Noob-stupid/dsh-github-login/issues) 提问。

- **点了登录，提示"正在下载登录工具"**：正常现象 —— 首次使用要拉一次约 71 MB 的 exe，
  下完提示"再点一次登录"即可开窗口。
- **自动下载失败**：按提示里的手动指引装（Release 下载 + 放到规范位置），
  或用 `DSH_GITHUB_LOGIN_EXE` / `DSH_GITHUB_LOGIN_RELEASE_BASE_URL` 指路。
  失败原因会原样写在提示里（下载 404 / 校验和不符 / 网络不可达），不会静默。
- **sha256 校验不符**：插件会**拒绝启用**那个文件并把它删掉，绝不启动 ——
  说明拿到的不是我们发布的东西（下载被劫持/镜像源陈旧）。此时请从官方 Release 重下。
- **一直"等待授权"**：轮询与浏览器共用同一网络通道，浏览器能打开 GitHub 就一定能完成；
  提示行会显示轮询次数，卡住时把提示文字发到 Issue。
- **显示 unknown**：授权已成功、令牌已保存，只是用户名查询失败；重启程序后状态页会重试。
- **gh 仍显示未登录**：本工具写入 `~/.config/gh/hosts.yml`；若系统 keyring 里有旧凭证，
  gh 会优先用 keyring——先 `gh auth logout` 清掉旧凭证即可。
- **浏览器打开 GitHub 显示未登录**：gh/DSH 令牌登录与浏览器网页登录是**两套独立会话**——
  本工具认证的是 gh 命令行层（令牌写进 `github-auth.json` 与 `hosts.yml`），并不会登录你的浏览器；
  浏览器需单独登录一次 github.com（或在授权时选"改用外部浏览器打开"，完成授权会顺带登录该浏览器）。
- **如何退出登录**：托盘菜单 `GitHub: <账号> (click to log out)`，或窗口中点"退出登录"。

## License

MIT
