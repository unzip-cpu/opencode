import { createStore } from "solid-js/store"
import { Option, Schema } from "effect"
import type { MountedSession } from "@opencode/plugin/gui"

/**
 * ghz: The preview lifecycle shown in the panel.
 *
 * - `pending`: the app exists, the preview has not started.
 * - `installing`: dependencies are installing.
 * - `starting_vite`: the dev server is starting.
 * - `ready`: the dev server answers; the iframe shows it.
 * - `failed`: the dev server could not start, or stopped on its own.
 * - `stopped`: the user closed it.
 */
export type PreviewStatus = "pending" | "installing" | "starting_vite" | "ready" | "failed" | "stopped"

/** ghz: What the preview panel renders for one workspace. */
export type PreviewState = {
  status: PreviewStatus
  /** The URL Vite printed, once `ready`. */
  url?: string
  /** The last output that explains a failure, once `failed`. */
  error?: string
  /** Why the preview has not started, while `pending`. */
  reason?: "no-project" | "no-vite"
  /** The user cancelled while dependencies were installing. */
  cancelled?: boolean
}

/** ghz: The dev server lifecycle for every workspace this window previewed. */
export type PreviewModel = ReturnType<typeof createPreviewModel>

/** ghz: A server client, read from the session each time an action starts. */
type Client = MountedSession["server"]["client"]

/** ghz: The Vite project in a workspace. */
type Project = {
  /** The project directory relative to the workspace root; "" for the root itself. */
  relative: string
  /** The project directory as the shell expects it. */
  directory: string
}

/** ghz: A workspace scan: the Vite project found, if any, and whether any package manifest exists. */
type Scan = { project?: Project; manifest: boolean }

/** ghz: The tags every preview shell carries, so any window can find the same workspace's process on the server. */
type PreviewMetadata = { preview: true; kind: "serve" | "install" | "kill"; directory: string }

/** ghz: One start-to-finish attempt. Aborting it only stops this window watching; explicit stop removes the shells. */
type Run = {
  controller: AbortController
  client: Client
  root: string
  /** How the app reaches its server, so a remote preview is not left on the server's loopback. */
  origin: string
  /** Every shell this run watches, whether it created it or attached to another window's. */
  shells: string[]
  /** The shells this run created; a failure on its own cleans up only these, never another window's server. */
  created: string[]
}

type Result = { ok: boolean; error?: string }

const PENDING: PreviewState = { status: "pending" }

// Vite prints `➜  Local:   http://localhost:5173/`. Newer versions print it without the arrow and with colors.
const LOCAL = /Local:\s+(https?:\/\/[^\s]+)/i

const ANSI = /\u001b\[[0-9;]*m/g

// Where a scaffolded project may sit, the workspace root first.
const CANDIDATES = ["", "src/frontend", "frontend", "app", "client", "web"]

const VITE_CONFIGS = ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.cts"]

const LOG_LIMIT = 8_192

const ERROR_LIMIT = 600

/** ghz: The package manifest fields detection reads; anything else in the file is ignored. */
const Manifest = Schema.Struct({
  scripts: Schema.optional(Schema.Struct({ dev: Schema.optional(Schema.String) })),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))

// ghz: Preview ports live in a high, quiet range: above the common dev ports (3000/5173/8080/…) and below the
// OS ephemeral range (Linux 32768+, Windows/macOS 49152+), so neither other tools nor outgoing connections collide.
const PORT_BASE = 10_000

const PORT_SPAN = 22_768

// Common service ports inside the range; a deterministic skip keeps every user and every restart in agreement.
const RESERVED_PORTS = new Set([11_211, 15_672, 16_379, 25_565, 26_379, 27_017, 28_017])

// ghz: How long to wait after removing a shell for the OS process to exit. The server deletes the shell record
// immediately, so the port is not observable through the API; this covers the usual SIGTERM-to-exit delay.
const STOP_GRACE = 800

// ghz: Global flag for stop/cancel waiting; any window reads this to disable its buttons while a port is reclaimed.
let busyAction = false

const setBusyAction = (value: boolean) => {
  busyAction = value
}

// ghz: 面板会带 session 调用，签名需接受该参数（panel.tsx 保持零改动）
const busy = (_session?: MountedSession) => busyAction
/** ghz: The preview's dev servers, keyed by workspace. The window owns the model for its whole instance. */

export function createPreviewModel(input: { signal: AbortSignal }) {
  const [states, setStates] = createStore<Record<string, PreviewState>>({})
  const runs = new Map<string, Run>()

  const keyOf = (session: MountedSession) => `${session.server.id}\n${session.directory}`

  const state = (session: MountedSession) => states[keyOf(session)] ?? PENDING

  const patch = (key: string, next: Partial<PreviewState>) => setStates(key, next)

  // ghz: Terminates the given shells and gives the OS time to release their ports. Every caller awaits this so a
  // following start does not race a dying process at the same address.
  const kill = async (run: Run, ids: readonly string[]) => {
    run.controller.abort()

    const unique = ids.filter((id, index) => ids.indexOf(id) === index)

    for (const id of unique) {
      const index = run.shells.indexOf(id)

      if (index !== -1) run.shells.splice(index, 1)
    }

    if (unique.length === 0) return

    setBusyAction(true)

    try {
      await Promise.all(unique.map((id) => remove(run.client, run.root, id)))
      // ghz: server 删除 shell 记录是即时的，进程退出却有延迟，`shell.get` 之后已经查不到它了。
      // 固定等一小段时间让端口空出来；真正的端口兜底清理由 release() 里的 killPort 完成。
      await sleep(STOP_GRACE)
    } finally {
      setBusyAction(false)
    }
  }

  // ghz: 只清理仍属于这个 key 的 run，避免旧的收尾把用户刚重启的新 run 一起删掉（dev server 会漏杀）
  const forget = (key: string, run: Run) => {
    if (runs.get(key) === run) runs.delete(key)
  }

  /** ghz: Finds the same workspace's running shell on the server. In a shared deployment every window sees it. */
  const discover = async (client: Client, root: string, project: Project, kind: PreviewMetadata["kind"]) => {
    const list = await client.shell.list({ location: { directory: root } }).then(
      (result) => result.data,
      () => undefined,
    )

    return list?.find(
      (info) =>
        info.status === "running" &&
        info.metadata.preview === true &&
        info.metadata.kind === kind &&
        info.metadata.directory === project.directory,
    )
  }

  /** ghz: Attaches to a preview another window started, so every user shares one dev server and one URL. */
  const adopt = (session: MountedSession, key: string, id: string) => {
    if (runs.has(key)) return

    const run: Run = {
      controller: new AbortController(),
      client: session.server.client,
      root: session.directory,
      origin: session.server.url,
      shells: [id],
      created: [],
    }

    runs.set(key, run)
    patch(key, { status: "starting_vite", url: undefined, error: undefined, reason: undefined, cancelled: false })
    void attach(run, key, id).then(
      () => forget(key, run),
      () => forget(key, run),
    )
  }

  /** ghz: Starts the preview when it has not run yet; a no-op while it runs or once the user stopped it. */
  const ensure = (session: MountedSession) => {
    if (state(session).status === "pending") start(session)
  }

  /** ghz: Scans the workspace for a Vite project without installing or starting anything. The panel calls this on
   * display so the empty state can say why the preview has not started. */
  const probe = async (session: MountedSession) => {
    const key = keyOf(session)

    // ghz: 初始 store 里没有该 key，原来 `!== "pending"` 会直接 return，打开预览页从不做探测
    if ((states[key]?.status ?? "pending") !== "pending") return

    const scan = await detect(session.server.client, session.directory)

    if (input.signal.aborted) return

    if (!scan.project) {
      patch(key, {
        status: "pending",
        url: undefined,
        error: undefined,
        cancelled: false,
        reason: scan.manifest ? "no-vite" : "no-project",
      })

      return
    }

    // ghz: 固定端口上已有服务就直接显示，不安装依赖、不启动第二个 dev server
    const url = previewUrl(session.server.url, session.directory)
    if (await reachable(url)) {
      patch(key, { status: "ready", url, error: undefined, reason: undefined, cancelled: false })
      return
    }

    // ghz: 别人可能已经在同一个工作空间启动了预览；直接接管，别再起第二个 dev server。
    const existing = await discover(session.server.client, session.directory, scan.project, "serve")

    if (input.signal.aborted) return

    if (existing) {
      adopt(session, key, existing.id)

      return
    }

    patch(key, { status: "pending", url: undefined, error: undefined, cancelled: false, reason: undefined })
  }

  /** ghz: Starts a fresh attempt: scans for Vite, installs when needed, then starts the dev server. */
  const start = (session: MountedSession) => {
    const key = keyOf(session)
    const current = states[key]?.status ?? "pending"

    if (current === "installing" || current === "starting_vite" || current === "ready") return

    if (runs.has(key)) return

    const run: Run = {
      controller: new AbortController(),
      client: session.server.client,
      root: session.directory,
      origin: session.server.url,
      shells: [],
      created: [],
    }

    runs.set(key, run)
    void execute(session, key, run).then(
      () => forget(key, run),
      async () => {
        // ghz: 先记录意图再 kill：kill 会 abort，之后判断 aborted 恒为真，状态就会卡在 installing/starting_vite
        const interrupted = run.controller.signal.aborted

        // ghz: 只清理本窗口创建的进程；attach 到的共享 dev server 属于别人，不能因为本地出错就杀掉。
        await kill(run, run.created.slice())
        forget(key, run)

        if (!interrupted) patch(key, { status: "failed", url: undefined, error: undefined })
      },
    )
  }

  /** ghz: 停止的统一收尾。探活复用 / 后端重启后遗留的孤儿 vite 都没有 shell 记录，只靠 kill() 会原样留着；
   * 所以无论有没有 run，都按固定端口再清一次，并等端口真正不通了才返回（panel 靠 await 禁用按钮）。 */
  const release = async (session: MountedSession, key: string) => {
    const run = runs.get(key)

    if (run) {
      await kill(run, run.shells.slice())
      forget(key, run)
    }

    await killPort(session.server.client, session.directory, previewPort(session.directory))

    const url = previewUrl(session.server.url, session.directory)

    for (let index = 0; index < 6 && (await reachable(url)); index++) await sleep(300)
  }

  /** ghz: Closes the preview and kills its dev server. Caller must await this so the port is free for the next start. */
  const stop = async (session: MountedSession) => {
    const key = keyOf(session)

    await release(session, key)

    patch(key, { status: "stopped", url: undefined, error: undefined, reason: undefined, cancelled: false })
  }

  /** ghz: Cancels a run the user interrupted; installing is reported as cancelled, starting as stopped. Caller must await. */
  const cancel = async (session: MountedSession) => {
    const key = keyOf(session)
    const installing = state(session).status === "installing"

    await release(session, key)

    patch(key, { status: "stopped", url: undefined, error: undefined, reason: undefined, cancelled: installing })
  }

  // ghz: 多用户共享一个 service 时，关窗口/刷新不能杀掉别人也在用的 dev server。这里只断开本地监听；
  // 只有显式「停止」或「取消」才会终止进程。
  input.signal.addEventListener(
    "abort",
    () => {
      runs.forEach((run) => run.controller.abort())
      runs.clear()
    },
    { once: true },
  )

  const execute = async (session: MountedSession, key: string, run: Run) => {
    const signal = run.controller.signal
    const scan = await detect(run.client, run.root)

    if (signal.aborted) return

    if (!scan.project) {
      patch(key, {
        status: "pending",
        url: undefined,
        error: undefined,
        cancelled: false,
        reason: scan.manifest ? "no-vite" : "no-project",
      })

      return
    }

    const project = scan.project
    const port = previewPort(run.root)

    // ghz: 端口上已有服务就直接显示，跳过 npm install 与启动
    const url = previewUrl(run.origin, run.root)
    if (await reachable(url)) {
      patch(key, { status: "ready", url, error: undefined, reason: undefined, cancelled: false })
      return
    }

    // ghz: 每次启动都完整跑一次 npm install，保证依赖下载完毕（原来会跳过已有 node_modules）
    patch(key, { status: "installing", url: undefined, error: undefined, reason: undefined, cancelled: false })

    const result = await install(run, project)

    if (signal.aborted) return

    if (!result.ok) {
      patch(key, { status: "failed", url: undefined, error: result.error })

      return
    }

    if (signal.aborted) return

    patch(key, { status: "starting_vite", url: undefined, error: undefined, reason: undefined, cancelled: false })

    await serve(run, project, key, port)
  }

  // ghz: Polls a shell until it leaves `running`, then reports its outcome. Shared by created and attached shells.
  const poll = async (run: Run, id: string): Promise<Result> => {
    let cursor = 0
    let text = ""

    while (!run.controller.signal.aborted) {
      const page = await read(run.client, run.root, id, cursor)

      if (page) {
        cursor = page.cursor
        text = append(text, page.output)
      }

      const current = await status(run.client, run.root, id)

      if (!current) return { ok: false, error: tail(text) }

      if (current.status === "running") {
        await wait(700, run.controller.signal)
        continue
      }

      if (current.status === "exited" && (current.exit ?? 1) === 0) return { ok: true }

      return { ok: false, error: tail(text) }
    }

    return { ok: false }
  }

  const install = async (run: Run, project: Project): Promise<Result> => {
    // ghz: 别人可能已经在装了，直接接管，别重复 `npm install`。
    const existing = await discover(run.client, run.root, project, "install")

    if (existing) {
      run.shells.push(existing.id)

      return await poll(run, existing.id)
    }

    const info = await create(
      run.client,
      run.root,
      "npm install",
      project.directory,
      { preview: true, kind: "install", directory: project.directory } satisfies PreviewMetadata,
    )

    if (run.controller.signal.aborted) {
      void remove(run.client, run.root, info.id)

      return { ok: false }
    }

    run.shells.push(info.id)
    run.created.push(info.id)

    return await poll(run, info.id)
  }

  const serve = async (run: Run, project: Project, key: string, port: number) => {
    const signal = run.controller.signal

    // ghz: 别人可能已经在跑了，直接接管，别再起第二个 dev server。
    const existing = await discover(run.client, run.root, project, "serve")

    if (existing) {
      run.shells.push(existing.id)

      await attach(run, key, existing.id)

      return
    }

    // ghz: 端口由工作空间 uuid 固定，用 --strictPort 禁止 vite 换端口，--host 0.0.0.0 保证远端浏览器可访问。
    // 仍写 preview metadata，别的窗口可以通过 discover 接管，共享不受影响。
    const info = await create(
      run.client,
      run.root,
      `npm run dev -- --host 0.0.0.0 --port ${port} --strictPort`,
      project.directory,
      { preview: true, kind: "serve", directory: project.directory } satisfies PreviewMetadata,
    )

    if (signal.aborted) {
      void remove(run.client, run.root, info.id)

      return
    }

    run.shells.push(info.id)
    run.created.push(info.id)

    await attach(run, key, info.id)
  }

  // ghz: Reads a dev server's log until it prints a URL, then enters `ready` and watches it. Created and attached
  // shells share this; a concurrent user's process is watched the same way.
  const attach = async (run: Run, key: string, id: string) => {
    const signal = run.controller.signal
    let cursor = 0
    let text = ""

    while (!signal.aborted) {
      const page = await read(run.client, run.root, id, cursor)

      if (signal.aborted) return

      if (page) {
        cursor = page.cursor
        text = append(text, page.output)
        const url = LOCAL.exec(strip(text))

        if (url) {
          patch(key, {
            status: "ready",
            url: reach(run.origin, url[1]),
            error: undefined,
            reason: undefined,
            cancelled: false,
          })
          await watch(run, key, id)

          return
        }
      }

      const current = await status(run.client, run.root, id)

      // ghz: 用户可能在轮询期间点了停止；此时 shell 已被删除，结果不能覆盖 stopped
      if (signal.aborted) return

      if (!current) {
        patch(key, { status: "failed", url: undefined, error: tail(text) })

        return
      }

      if (current.status !== "running") {
        const last = await read(run.client, run.root, id, cursor)

        if (last) text = append(text, last.output)
        patch(key, { status: "failed", url: undefined, error: tail(text) })

        return
      }

      await wait(400, signal)
    }
  }

  // ghz: A running dev server can still die, e.g. when a config change fails. The panel must say so.
  const watch = async (run: Run, key: string, id: string) => {
    const signal = run.controller.signal

    while (!signal.aborted) {
      await wait(2_000, signal)

      if (signal.aborted) return

      const current = await status(run.client, run.root, id)

      // ghz: 停止可能发生在这次轮询期间，不能让 stopped 被 failed 覆盖
      if (signal.aborted) return

      if (current?.status === "running") continue

      // ghz: 404 = 别人点了停止；有 exit/output = 真的崩了。两个分支文案不同，不能混为一谈。
      if (!current) {
        patch(key, { status: "stopped", url: undefined, error: undefined, reason: undefined, cancelled: false })

        return
      }

      // ghz: 把导致退出的输出带给用户，而不是一句没有线索的"启动失败"
      const error = await recent(run, id)

      if (signal.aborted) return

      patch(key, { status: "failed", url: undefined, error })

      return
    }
  }

  return { state, ensure, start, stop, cancel, probe, busy }
}

/** ghz: The Vite project in a workspace, scanning a few conventional subdirectories after the root. */
async function detect(client: Client, root: string): Promise<Scan> {
  let manifest = false

  for (const relative of CANDIDATES) {
    const list = await entries(client, root, relative)

    if (!list) continue

    const files = new Map(list.map((entry) => [basename(entry.path), entry.type]))

    if (files.get("package.json") !== "file") continue

    manifest = true

    if (await isVite(client, root, relative, files)) {
      return { manifest, project: { relative, directory: join(root, relative) } }
    }
  }

  return { manifest }
}

/** ghz: A Vite config, or a manifest that depends on Vite, names this directory a Vite project. */
async function isVite(
  client: Client,
  root: string,
  relative: string,
  files: ReadonlyMap<string, "file" | "directory">,
) {
  if (VITE_CONFIGS.some((name) => files.get(name) === "file")) return true

  const text = await readText(client, root, relative ? `${relative}/package.json` : "package.json")

  if (!text) return false

  const manifest = Option.getOrUndefined(decodeManifest(text))

  if (!manifest) return false

  if (manifest.scripts?.dev?.includes("vite")) return true

  return manifest.dependencies?.vite !== undefined || manifest.devDependencies?.vite !== undefined
}

const basename = (path: string) => {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "")

  return normalized.slice(normalized.lastIndexOf("/") + 1)
}

/** ghz: Joins in the workspace's separator style, as the server sees the directory. */
const join = (root: string, relative: string) => {
  if (!relative) return root

  const separator = root.includes("\\") ? "\\" : "/"

  return `${root.replace(/[\\/]+$/, "")}${separator}${relative.replaceAll("/", separator)}`
}

const entries = (client: Client, root: string, path: string) =>
  client.file
    .list({ location: { directory: root }, path: path || undefined })
    .then(
      (result) => result.data,
      () => undefined,
    )

const readText = (client: Client, root: string, path: string) =>
  client.file
    .read({ location: { directory: root }, path })
    .then(
      (bytes) => new TextDecoder().decode(bytes),
      () => undefined,
    )

const create = (client: Client, root: string, command: string, cwd: string, metadata: PreviewMetadata) =>
  client.shell
    .create({ location: { directory: root }, command, cwd, metadata })
    .then((result) => result.data)

const status = (client: Client, root: string, id: string) =>
  client.shell.get({ location: { directory: root }, id }).then(
    (result) => result.data,
    () => undefined,
  )

const read = (client: Client, root: string, id: string, cursor: number) =>
  client.shell.output({ location: { directory: root }, id, cursor, limit: 32_768 }).then(
    (result) => result.data,
    () => undefined,
  )

/** ghz: The last page of a dev server's log, cleaned up for the failure view. */
const recent = async (run: Run, id: string) => {
  const head = await read(run.client, run.root, id, 0)

  if (!head) return undefined

  if (head.size <= 32_768) return tail(head.output)

  const page = await read(run.client, run.root, id, Math.max(0, head.size - 32_768))

  return page ? tail(page.output) : undefined
}

const remove = (client: Client, root: string, id: string) =>
  client.shell.remove({ location: { directory: root }, id }).then(
    () => undefined,
    () => undefined,
  )

/** ghz: 按端口杀掉监听进程。浏览器拿不到服务端 pid，借 shell.create 在服务端跑一次跨平台命令；
 * 脚本用 base64 交给 node -e，避开 cmd / sh 的引号与转义差异，平台判断也落在服务端而不是浏览器。 */
const killPort = async (client: Client, root: string, port: number) => {
  const script = [
    "const cp=require('child_process')",
    "const port=" + port,
    "const ids=new Set()",
    "const win=process.platform==='win32'",
    "if(win){",
    "  let out=''",
    "  try{out=cp.execSync('netstat -ano -p TCP',{stdio:['ignore','pipe','ignore']}).toString()}catch{}",
    "  for(const line of out.split(/\\r?\\n/)){",
    "    const f=line.trim().split(/\\s+/)",
    "    if(f.length>=5&&f[3]==='LISTENING'&&f[1].endsWith(':'+port))ids.add(Number(f[4]))",
    "  }",
    "}else{",
    "  let out=''",
    "  try{out=cp.execSync('lsof -t -iTCP:'+port+' -sTCP:LISTEN',{stdio:['ignore','pipe','ignore']}).toString()}",
    "  catch{try{out=cp.execSync('fuser -n tcp '+port+' 2>/dev/null',{stdio:['ignore','pipe','ignore']}).toString()}catch{}}",
    "  for(const p of out.split(/\\s+/))if(p)ids.add(Number(p))",
    "}",
    "for(const pid of ids){",
    "  if(!Number.isInteger(pid)||pid<=1||pid===process.pid)continue",
    "  try{if(win)cp.execSync('taskkill /F /T /PID '+pid,{stdio:'ignore'});else process.kill(pid,'SIGKILL')}catch{}",
    "  console.log('preview kill port '+port+' pid '+pid)",
    "}",
  ].join("\n")

  try {
    const command = `node -e "eval(Buffer.from('${btoa(script)}','base64').toString('utf8'))"`
    const info = await create(client, root, command, root, {
      preview: true,
      kind: "kill",
      directory: root,
    } satisfies PreviewMetadata)

    for (let index = 0; index < 15; index++) {
      const current = await status(client, root, info.id)

      if (current && current.status !== "running") break

      await sleep(200)
    }

    await remove(client, root, info.id)
  } catch {}
}

const strip = (text: string) => text.replaceAll(ANSI, "")

/** ghz: 工作空间目录名是 32 位 uuid，取前 8 位十六进制直接映射端口：端口只由 uuid 决定，与完整路径、
 * 服务器地址、Vite 项目子目录都无关，因此每次启动都不变。非 uuid 目录保留原哈希兜底。 */
const previewPort = (root: string) => {
  const key = root.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  const name = key.slice(key.lastIndexOf("/") + 1)

  let hash = 0x811c9dc5

  if (/^[0-9a-f]{32}$/.test(name)) {
    hash = Number.parseInt(name.slice(0, 8), 16)
  } else {
    for (let index = 0; index < key.length; index++) {
      hash ^= key.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }

  for (let step = 0; step < PORT_SPAN; step++) {
    const port = PORT_BASE + ((hash + step) % PORT_SPAN)

    if (!RESERVED_PORTS.has(port)) return port
  }

  return PORT_BASE
}

/** ghz: A sleep that ignores the caller's signal; used to give the OS time to release a port after a kill. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** ghz: Vite prints a loopback URL; reach it the way this window reaches its server, so LAN use works too. */
const reach = (server: string, printed: string) => {
  if (!URL.canParse(server) || !URL.canParse(printed)) return printed

  const target = new URL(printed)
  const host = new URL(server).hostname

  if (target.hostname !== "localhost" && target.hostname !== "127.0.0.1" && target.hostname !== "0.0.0.0") return printed

  if (!host || host === "0.0.0.0") return printed

  target.hostname = host

  return target.toString()
}

/** ghz: 预览地址必须是对外 IP:port，不能是 localhost——opencode 部署在服务端，用户用本地浏览器打开。 */
const previewUrl = (origin: string, root: string) => reach(origin, `http://localhost:${previewPort(root)}/`)

/** ghz: 端口探活：no-cors 跨端口请求能连上就说明已有服务在监听，读不到响应体也无妨。 */
const reachable = async (url: string) => {
  try {
    await fetch(url, { mode: "no-cors", signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

const append = (text: string, chunk: string) => {
  const next = text + chunk

  return next.length > LOG_LIMIT ? next.slice(-LOG_LIMIT) : next
}

/** ghz: The tail of a log, cleaned of colors, for the status strip. Empty when the command said nothing. */
const tail = (text: string) => {
  const value = strip(text).trim()

  return value.length > ERROR_LIMIT ? value.slice(-ERROR_LIMIT) : value
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()

    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }

    const timer = setTimeout(finish, ms)

    signal.addEventListener("abort", finish, { once: true })
  })