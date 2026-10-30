import { Route, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { createEffect, createMemo, lazy, type ParentProps, Show, Suspense } from "solid-js"
import { Loader } from "@opencode/ui/loader"
import { Home } from "@/home/route"
import { ServerProvider } from "@/runtime/server/current"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { type DraftTab, useTabs } from "@/shell/tabs/tabs"
import { SessionPanelFrame, SessionRouteFrame } from "@/session/session-frame"
import { LayoutProvider } from "@/shell/state/layout"
import { SettingsSurfaceProvider } from "@/settings/surface"
import Shell from "@/shell/shell"
import { requireServerKey } from "./session"
import { PluginAttachment } from "@/runtime/plugin/root"

export const File = lazy(() => import("@opencode/session-ui/file").then((module) => ({ default: module.File })))

const loadSessionRoute = () => Promise.all([import("@/session/route"), File.preload()]).then(([module]) => module)

const DraftRoute = lazy(() => import("@/new-session/route").then((module) => ({ default: module.DraftRoute })))

const SettingsScreen = lazy(() => import("@/settings/shell").then((module) => ({ default: module.SettingsScreen })))

const ConnectServerScreen = lazy(() =>
  import("@/servers/connect/screen").then((module) => ({ default: module.ConnectServerScreen })),
)

// The dev server and Beta only. Both are fixed at build time, so other builds, prod included, drop the import and never
// contain the lab, its stories or knobs. Beta loads it as its own chunk, only when /components opens.
const ComponentsLab =
  import.meta.env.DEV || import.meta.env.VITE_OPENCODE_CHANNEL === "beta"
    ? lazy(() => import("@/components-lab/lab"))
    : undefined

const TargetSessionRouteContent = lazy(() =>
  loadSessionRoute().then((module) => ({ default: module.TargetSessionRouteContent })),
)

export function preloadRoute(url: string) {
  const pathname = url.split(/[?#]/, 1)[0]

  if (pathname === "/new-session" || pathname === "/new") return DraftRoute.preload().then(() => undefined)

  if (pathname === "/settings") return SettingsScreen.preload().then(() => undefined)

  if (/^\/server\/[^/]+\/session\/[^/]+$/.test(pathname))
    return TargetSessionRouteContent.preload().then(() => undefined)

  return Promise.resolve()
}

export function AppRoutes() {
  return (
    <Route component={AppLayout}>
      {/*ghz:去掉一些不必要的路由，避免用户直接通过ip:port访问*/}
      {/*<Route path="/" component={Home} />*/}
      {/*<Route path="/settings" component={SettingsScreen} />*/}
      <Route
        path="/server/:serverKey/session/:id"
        component={() => (
          <SessionRouteFrame>
            <Suspense
              fallback={
                <div class="flex min-h-0 flex-1 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
                  <SessionPanelFrame raised />
                </div>
              }
            >
              <TargetServerRoute>
                <TargetSessionRouteContent />
              </TargetServerRoute>
            </Suspense>
          </SessionRouteFrame>
        )}
      />
      <Route path="/new-session" component={DraftRoute} />
      <Route path="/new" component={NewSessionRedirect} />
      {ComponentsLab && <Route path="/components" component={ComponentsLab} />}
    </Route>
  )
}

function TargetServerRoute(props: ParentProps) {
  const params = useParams<{ serverKey: string }>()
  const global = useGlobal()

  const connection = createMemo(() =>
    global.servers.list().find((item) => ServerConnection.key(item) === requireServerKey(params.serverKey)),
  )

  return (
    <Show when={connection()} keyed>
      {(connection) => <ServerProvider conn={connection}>{props.children}</ServerProvider>}
    </Show>
  )
}

function AppLayout(props: ParentProps) {
  const servers = useServers()
  const global = useGlobal()

  // A lone server that rejects our credentials (e.g. the web app before pairing) has nothing else to show.
  const signedOut = () => {
    const only = servers.list.length === 1 ? servers.list[0] : undefined

    if (only?.type !== "http") return

    return global.servers.health[ServerConnection.key(only)]?.unauthorized ? only : undefined
  }

  return (
    <Show when={servers.list.length > 0 && !signedOut()} fallback={<ConnectServerScreen url={signedOut()?.http.url} />}>
      <LayoutProvider>
        <SettingsSurfaceProvider>
          <PluginAttachment>
            <Shell>{props.children}</Shell>
          </PluginAttachment>
        </SettingsSurfaceProvider>
      </LayoutProvider>
    </Show>
  )
}

/**
 * URL entry point for opening the new-session page directly.
 *
 * Visiting `/new?directory=<path>` (with `auth_token` in the query string handled by entry.tsx) creates a draft
 * for the first connected server and opens the prompt composer. The directory is required: without it there is
 * nowhere to place the session.
 */
function NewSessionRedirect() {
  const [search] = useSearchParams<{ directory?: string }>()
  const navigate = useNavigate()
  const tabs = useTabs()
  const servers = useServers()

  createEffect(() => {
    const directory = search.directory
    if (!directory) {
      navigate("/")
      return
    }

    // Reuse an existing draft for this directory if one already exists.
    const existing = () =>
      tabs.store.find((tab) => tab.type === "draft" && tab.directory === directory) as DraftTab | undefined
    if (existing()) {
      navigate(`/new-session?draftId=${encodeURIComponent(existing()!.draftID)}`)
      return
    }

    const list = servers.list
    if (!list.length) return

    const first = list[0]
    const key = ServerConnection.key(first)
    const draft = tabs.newDraft({ server: key, directory })
    void draft.then((tab) => {
      navigate(`/new-session?draftId=${encodeURIComponent(tab.draftID)}`)
    })
  })

  return (
    <div class="flex min-h-0 flex-1 items-center justify-center">
      <Loader />
    </div>
  )
}
