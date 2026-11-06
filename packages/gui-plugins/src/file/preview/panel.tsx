import { Show, createSignal, onMount } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { Tooltip } from "@opencode/ui/tooltip"
import { usePlugin, type MountedSession } from "@opencode/plugin/gui"
import type File from "../index"
import type { PreviewModel, PreviewStatus } from "./model"

const STATUS = {
  pending: "preview.status.pending",
  installing: "preview.status.installing",
  starting_vite: "preview.status.starting_vite",
  ready: "preview.status.ready",
  failed: "preview.status.failed",
  stopped: "preview.status.stopped",
} as const satisfies Record<PreviewStatus, string>

const DOT = {
  pending: "bg-v2-text-text-faint",
  installing: "bg-v2-state-fg-info",
  starting_vite: "bg-v2-state-fg-info",
  ready: "bg-v2-state-fg-success",
  failed: "bg-v2-state-fg-danger",
  stopped: "bg-v2-text-text-faint",
} as const satisfies Record<PreviewStatus, string>

/**
 * ghz: The preview tab. It starts the workspace's Vite dev server on first display, shows it in an iframe, and
 * reports the lifecycle through the fixed status strip.
 */
export function PreviewPanel(props: { session: MountedSession; model: PreviewModel }) {
  const ctx = usePlugin<typeof File>()
  const state = () => props.model.state(props.session)
  const busy = () => state().status === "installing" || state().status === "starting_vite" || props.model.busy(props.session)
  const status = () => ctx.t(STATUS[state().status])
  let frame: HTMLIFrameElement | undefined

  // ghz: Tracks whether stop/cancel is in-flight; buttons are disabled while a port is being reclaimed so the user
  // cannot start again before the old dev server has truly died.
  const [busyAction, setBusyAction] = createSignal(false)

  // ghz: The preview never starts on its own. Opening the tab only scans the workspace so the empty state can say
  // why the preview has not started; the user presses Start to install and launch.
  onMount(() => {
    void props.model.probe(props.session)
  })

  const hint = () => {
    if (state().status === "pending") {
      if (state().reason === "no-project") return ctx.t("preview.hint.noProject")

      if (state().reason === "no-vite") return ctx.t("preview.hint.noVite")

      return ctx.t("preview.hint.checking")
    }

    if (state().status === "installing") return ctx.t("preview.hint.install")

    if (state().status === "starting_vite") return ctx.t("preview.hint.starting")

    if (state().status === "failed") return ctx.t("preview.hint.failed")

    if (state().status === "stopped") return ctx.t(state().cancelled ? "preview.hint.cancelled" : "preview.hint.stopped")

    return undefined
  }

  // ghz: Reassigning `src` is the one reliable reload for a cross-origin frame; `contentWindow` is not reachable.
  const reload = () => {
    if (frame) frame.src = frame.src
  }

  const openExternal = () => {
    const url = state().url

    if (url) ctx.system.openExternal(url)
  }

  // ghz: stop/cancel await the dev server's port to be freed; keep every button disabled during the wait so the
  // user cannot start again before the old dev server has truly died.
  const action = async (fn: () => Promise<void>) => {
    setBusyAction(true)

    try {
      await fn()
    } finally {
      setBusyAction(false)
    }
  }

  const stopAndAwait = () => action(() => props.model.stop(props.session))
  const cancelAndAwait = () => action(() => props.model.cancel(props.session))

  return (
    <div class="flex size-full min-h-0 flex-col bg-v2-background-bg-base">
      <div class="h-11 shrink-0 flex items-center gap-2 px-3 border-b-[0.5px] border-v2-border-border-muted">
        <Show when={busy() || busyAction()} fallback={<span class={`size-1.5 shrink-0 rounded-full ${DOT[state().status]}`} aria-hidden="true" />}>
          <Loader class="shrink-0" />
        </Show>
        <span
          class="truncate text-[13px] font-[440] leading-[var(--line-height-compact)] text-v2-text-text-muted"
          role="status"
          aria-live="polite"
        >
          {status()}
        </span>
        <div class="ms-auto flex shrink-0 items-center gap-1">
          <Show when={state().status === "ready"}>
            <Tooltip placement="top" value={ctx.t("preview.action.reload")}>
              <IconButton
                variant="ghost-muted"
                size="large"
                aria-label={ctx.t("preview.action.reload")}
                onClick={reload}
                icon={<Icon name="outline-rotate-clockwise" />}
              />
            </Tooltip>
            <Tooltip placement="top" value={ctx.t("preview.action.openExternal")}>
              <IconButton
                variant="ghost-muted"
                size="large"
                aria-label={ctx.t("preview.action.openExternal")}
                onClick={openExternal}
                icon={<Icon name="outline-arrow-up-right" />}
              />
            </Tooltip>
            <Tooltip placement="top" value={ctx.t("preview.action.stop")}>
              <IconButton
                variant="ghost-muted"
                size="large"
                aria-label={ctx.t("preview.action.stop")}
                disabled={busyAction()}
                onClick={stopAndAwait}
                icon={<Icon name="outline-xmark" />}
              />
            </Tooltip>
          </Show>
          <Show when={state().status === "installing"}>
            <Button size="small" variant="ghost" disabled={busyAction()} onClick={cancelAndAwait}>
              {ctx.t("preview.action.cancel")}
            </Button>
          </Show>
          <Show when={state().status === "starting_vite"}>
            <Button size="small" variant="ghost" disabled={busyAction()} onClick={stopAndAwait}>
              {ctx.t("preview.action.cancel")}
            </Button>
          </Show>
          <Show when={state().status === "failed"}>
            <Button size="small" variant="outline" onClick={() => props.model.start(props.session)}>
              {ctx.t("preview.action.retry")}
            </Button>
          </Show>
          <Show when={state().status === "stopped"}>
            <Button size="small" variant="outline" onClick={() => props.model.start(props.session)}>
              {ctx.t("preview.action.start")}
            </Button>
          </Show>
          <Show when={state().status === "pending"}>
            <Button size="small" variant="outline" onClick={() => props.model.start(props.session)}>
              {ctx.t("preview.action.start")}
            </Button>
          </Show>
        </div>
      </div>
      <div class="relative min-h-0 flex-1">
        <Show when={state().status === "ready" ? state().url : undefined}>
          {(url) => (
            <iframe
              ref={(element) => (frame = element)}
              title={ctx.t("preview.frame")}
              src={url()}
              class="absolute inset-0 size-full border-0 bg-white"
            />
          )}
        </Show>
        <Show when={state().status !== "ready"}>
          <div class="flex size-full flex-col items-center justify-center gap-2 p-6 text-center text-text-weak">
            <Show when={busy() || busyAction()} fallback={<Icon name="globe" size="large" class="mb-2 shrink-0" />}>
              <Loader class="mb-2" />
            </Show>
            <div class="text-[13px] font-medium leading-[var(--line-height-compact)] text-text-strong">{status()}</div>
            <div class="max-w-[360px] text-13-regular leading-[var(--line-height-base)]">{hint()}</div>
            <Show when={state().error}>
              {(error) => (
                <pre class="mt-2 max-h-40 w-full max-w-[420px] overflow-auto rounded-md border border-v2-border-border-muted bg-surface-base p-2 text-start font-mono text-12-regular whitespace-pre-wrap break-words">
                  {error()}
                </pre>
              )}
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
