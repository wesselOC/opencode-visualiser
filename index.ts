// OpenCode Visualizer — plugin entrypoint.
//
// One default export serves both plugin APIs (see https://opencode.ai/v2/docs/build/plugins/migrate-v1):
//   - OpenCode 2.x reads `id` + `setup(ctx)`  (V2 plugin API)
//   - OpenCode 1.x calls `server(input)`      (V1 plugin API, object form)
// Each adapter only translates its API's events/hooks into calls on the shared core (./core.ts).
// One character is shown per *session*, labelled with the session title.
import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import { startVisualizer, mapV1Event, mapV2Event, type Visualizer, type VisualizerAction } from "./core"
import { startServer } from "./visualizer/ocv-server"

interface Extras {
  directory: string
  resolveTitle: (sessionID: string) => Promise<string | undefined>
  dedupeKey?: string
}

function dispatch(viz: Visualizer, actions: VisualizerAction[], { directory, resolveTitle, dedupeKey }: Extras) {
  actions.forEach((action, i) => dispatchOne(viz, action, { directory, resolveTitle, dedupeKey: dedupeKey && `${dedupeKey}#${i}` }))
}

function dispatchOne(viz: Visualizer, action: VisualizerAction, { directory, resolveTitle, dedupeKey }: Extras) {
  switch (action.kind) {
    case "event":
      viz.sendEvent(action.sessionID, action.type, action.payload, { register: action.register, directory, resolveTitle: () => resolveTitle(action.sessionID), dedupeKey })
      break
    case "rename":
      viz.setTitle(action.sessionID, action.title)
      break
    case "remove":
      viz.removeSession(action.sessionID)
      break
  }
}

// Structural subset of the OpenCode 2.x plugin context (`@opencode/plugin`) that this plugin uses. Declared locally
// so the V2 SDK (and its dependency tree) is not needed to build or test this package.
interface V2Context {
  location: { directory: string }
  session: { get(input: { sessionID: string }): Promise<{ title?: string }> }
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<{ type: string; id?: string }> }
  tool: { hook(name: "execute.before" | "execute.after", handler: (event: { tool: string; sessionID: string; id: string }) => void): Promise<unknown> }
}

interface V2Definition {
  id: string
  setup(ctx: V2Context): Promise<() => void>
}

// ─── OpenCode 2.x ───────────────────────────────────────────────────

const RESUBSCRIBE_DELAY_MS = 1000

const v2: V2Definition = {
  id: "psinetron-opencode-visualizer",
  async setup(ctx) {
    const directory = ctx.location.directory
    const viz = startVisualizer({ directory, startServer })
    const abort = new AbortController()
    const resolveTitle = async (sessionID: string) => (await ctx.session.get({ sessionID })).title
    const cleanup = () => {
      abort.abort()
      viz.dispose()
    }

    try {
      // The visualizer is decoration: nothing it does may throw into OpenCode, and a dropped event stream is re-opened.
      void (async () => {
        while (!abort.signal.aborted) {
          try {
            for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
              try {
                dispatch(viz, mapV2Event(event as Parameters<typeof mapV2Event>[0]), { directory, resolveTitle, dedupeKey: event.id && `event:${event.id}` })
              } catch {}
            }
          } catch {}
          if (!abort.signal.aborted) await new Promise((r) => setTimeout(r, RESUBSCRIBE_DELAY_MS))
        }
      })()

      const toolHook = (phase: "before" | "after") => (event: { tool: string; sessionID: string; id: string }) => {
        try {
          // The call id is only unique per provider/turn, so scope it to the session; without an id, do not dedupe.
          const dedupeKey = event.id ? `${phase}:${event.sessionID}:${event.id}` : undefined
          dispatch(viz, [{ kind: "event", sessionID: event.sessionID, type: `tool.execute.${phase}`, payload: { tool: event.tool }, register: true }], { directory, resolveTitle, dedupeKey })
        } catch {}
      }
      await ctx.tool.hook("execute.before", toolHook("before"))
      await ctx.tool.hook("execute.after", toolHook("after"))
    } catch (e) {
      cleanup() // do not leak the subscription or the shared-connection refcount when setup fails partway
      throw e
    }

    return cleanup
  },
}

// ─── OpenCode 1.x ───────────────────────────────────────────────────

const v1: V1Plugin = async ({ directory, client }) => {
  const viz = startVisualizer({ directory, startServer })
  const extras: Extras = {
    directory,
    resolveTitle: async (id) => ((await client.session.get({ path: { id } })) as { data?: { title?: string } }).data?.title,
  }
  // A hook that throws can break the user's session, so every path is exception-safe.
  const safe = (fn: () => void) => {
    try {
      fn()
    } catch {}
  }
  const tool = (phase: "before" | "after") => async (input: { tool: string; sessionID: string }) =>
    safe(() => dispatch(viz, [{ kind: "event", sessionID: input.sessionID, type: `tool.execute.${phase}`, payload: { tool: input.tool }, register: true }], extras))

  return {
    event: async ({ event }) => safe(() => dispatch(viz, mapV1Event(event as Parameters<typeof mapV1Event>[0]), extras)),
    "tool.execute.before": tool("before"),
    "tool.execute.after": tool("after"),
    // Called when OpenCode unloads or reloads the plugin; without it every reload would leak a reference to the shared connection.
    dispose: async () => safe(() => viz.dispose()),
  }
}

export default { ...v2, server: v1 }
