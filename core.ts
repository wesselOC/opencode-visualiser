// core.ts — OpenCode-version-agnostic part of the visualizer plugin.
//
// Owns the connection to the visualizer server (WebSocket client, leader election, reconnects), which
// sessions currently have a character, skin selection, and debug logging. It knows nothing about the
// OpenCode plugin API: the V1 and V2 adapters in index.ts translate their hooks/events into the calls below.
//
// One character represents one *session* (not one project directory), so several chats in the same project,
// and subagent sessions, each get their own character.
import { join } from "path"
import { readFileSync, mkdirSync, appendFileSync, existsSync } from "fs"
import { SERVER_PORT, nextActive, isActiveStatus } from "./shared"

export { SERVER_PORT }
export const AVAILABLE_SKINS = ["person1", "person2", "person3", "person4", "person5"]

/** A session's character leaves the office after this long without activity (busy sessions get BUSY_TTL_FACTOR times longer). */
export const DEFAULT_IDLE_REMOVE_MS = 10 * 60_000
const BUSY_TTL_FACTOR = 12 // a run that never reports idle must not keep a character forever
const SWEEP_INTERVAL_MS = 30_000
const MAX_SEEN_KEYS = 2000
const HELLO_TIMEOUT_MS = 1500

export interface VisualizerOptions {
  /** Directory of the first plugin instance; used for the debug log and as the default session directory. */
  directory: string
  /** Starts the in-process visualizer server. Returns false when the port is taken (another instance leads). */
  startServer: () => boolean
  idleRemoveMs?: number
  sweepIntervalMs?: number
}

export interface SendOptions {
  /** Create the session's character if it has none. Without this, events for unknown sessions are dropped. */
  register?: boolean
  /** Directory the session works in (skin preference and fallback label). Defaults to the plugin's directory. */
  directory?: string
  /** Looks up the session title once, when the character is created. */
  resolveTitle?: () => Promise<string | undefined>
  /**
   * Drops the call if the same key was seen before. The V2 service shares one process between projects, so the same
   * event can reach several plugin instances.
   */
  dedupeKey?: string
}

export interface Visualizer {
  sendEvent(sessionID: string, eventType: string, payload?: Record<string, unknown>, options?: SendOptions): void
  setTitle(sessionID: string, title: string): void
  removeSession(sessionID: string): void
  /** Releases this handle. The shared connection closes when the last handle is released. */
  dispose(): void
}

/**
 * Picks a skin for a session. A project can pin skins by putting `{"skin": "person3"}` in `.opencode/viz-skin.json`
 * (read only: this plugin never writes into project directories, which may belong to another project in the shared V2
 * service). Otherwise the choice is derived from the session ID so it is stable; the frontend resolves clashes.
 */
export function resolveSkin(directory: string, sessionID = ""): string {
  try {
    const data = JSON.parse(readFileSync(join(directory, ".opencode", "viz-skin.json"), "utf-8"))
    if (data.skin && AVAILABLE_SKINS.includes(data.skin)) return data.skin
  } catch {}
  let hash = 0
  for (const ch of sessionID) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return AVAILABLE_SKINS[hash % AVAILABLE_SKINS.length]
}

interface SessionState {
  directory: string
  skin: string
  title?: string
  busy: boolean
  lastActivity: number
}

interface Hub extends Omit<Visualizer, "dispose"> {
  close(): void
}

/** Connection state: `pending` until the server answers the hello handshake (or times out and is treated as legacy). */
type Mode = "disconnected" | "pending" | "session" | "legacy"

function createHub({ directory: hubDirectory, startServer, idleRemoveMs = DEFAULT_IDLE_REMOVE_MS, sweepIntervalMs = SWEEP_INTERVAL_MS }: VisualizerOptions): Hub {
  const logPath = join(hubDirectory, ".opencode", "ocv-debug.log")
  const sessions = new Map<string, SessionState>()
  const seen = new Set<string>()
  const legacyId = `oc-${process.pid}-${Math.random().toString(36).substring(2, 10)}`

  let closed = false
  let ws: WebSocket | null = null
  let mode: Mode = "disconnected"
  let helloTimer: ReturnType<typeof setTimeout> | null = null
  let legacyRegistered = false

  const log = (msg: string) => {
    try {
      // Never recreate a project directory that no longer exists (the first project may have been removed).
      if (!existsSync(hubDirectory)) return
      mkdirSync(join(hubDirectory, ".opencode"), { recursive: true })
      appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`)
    } catch {}
  }

  const tryStartServer = (): boolean => {
    try {
      const ok = startServer()
      log(ok ? `[plugin] Server running on port ${SERVER_PORT}` : `[plugin] Server not started (port ${SERVER_PORT} in use — another instance is the leader)`)
      return ok
    } catch (e) {
      log(`[plugin] Failed to start server: ${e}`)
      return false
    }
  }

  const rawSend = (message: Record<string, unknown>) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(message))
    } catch {}
  }

  /**
   * Sends a per-session message. Against a server that predates per-session characters (no hello.ack), all sessions
   * share the single process-wide character that older versions of this plugin used, and unregister/title are dropped.
   */
  const post = (message: Record<string, unknown>) => {
    if (mode === "pending" || mode === "disconnected") return // flushed when the handshake resolves
    if (mode === "session") return rawSend(message)
    switch (message.type) {
      case "register":
        if (!legacyRegistered) {
          legacyRegistered = true
          rawSend({ type: "register", instanceId: legacyId, cwd: message.cwd, skin: message.skin })
        }
        break
      case "event":
        if (legacyRegistered) rawSend({ ...message, instanceId: legacyId })
        break
    }
  }

  const registerMessage = (id: string, s: SessionState) => ({ type: "register", instanceId: id, cwd: s.directory, skin: s.skin, title: s.title, active: s.busy })

  /** Announces every live session on a fresh server (after a reconnect or leader change). */
  const flush = () => {
    legacyRegistered = false
    for (const [id, s] of sessions) post(registerMessage(id, s))
  }

  const settle = (resolved: "session" | "legacy") => {
    if (helloTimer) clearTimeout(helloTimer)
    helloTimer = null
    mode = resolved
    if (resolved === "legacy") log("[plugin] Server predates per-session characters; using one shared character")
    flush()
  }

  /** One connection attempt. Resolves when the socket closes after having been open; rejects if it never opened. */
  const connectOnce = (): Promise<"closed"> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://localhost:${SERVER_PORT}`)
      let opened = false

      const timeout = setTimeout(() => {
        socket.close()
        reject(new Error("Connection timeout"))
      }, 3000)

      socket.onopen = () => {
        clearTimeout(timeout)
        if (closed || ws) {
          // Disposed meanwhile, or (defensively) another socket is already live: never hold two.
          socket.close()
          return reject(new Error(closed ? "Disposed" : "Already connected"))
        }
        opened = true
        ws = socket
        mode = "pending"
        rawSend({ type: "hello" })
        helloTimer = setTimeout(() => settle("legacy"), HELLO_TIMEOUT_MS)
      }

      socket.onmessage = (e) => {
        try {
          const m = JSON.parse(String(e.data))
          if (m.type === "hello.ack" && mode === "pending") settle("session")
        } catch {}
      }

      socket.onerror = () => {
        clearTimeout(timeout)
        socket.close()
      }

      socket.onclose = () => {
        clearTimeout(timeout)
        if (ws === socket) {
          ws = null
          mode = "disconnected"
          if (helloTimer) clearTimeout(helloTimer)
          helloTimer = null
        }
        if (opened) resolve("closed")
        else reject(new Error("Connection failed"))
      }
    })

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  /**
   * The only place connections are made, so at most one socket exists. When the server goes away every surviving
   * instance races to bind the port (leader election: one wins, the rest get EADDRINUSE and stay clients); random
   * jitter avoids a thundering herd. Retries forever with a capped delay.
   */
  void (async () => {
    tryStartServer()
    let failures = 0
    while (!closed) {
      try {
        await connectOnce()
        log(`[plugin] Connection to server lost; electing a leader`)
        failures = 0
        await sleep(1000 + Math.floor(Math.random() * 500))
        if (closed) break
        tryStartServer()
      } catch (e) {
        failures++
        if (closed) break
        if (failures === 20) log(`[plugin] Still cannot connect after 20 attempts: ${e} — is the daemon running on ws://localhost:${SERVER_PORT}?`)
        if (failures % 5 === 0) tryStartServer()
        await sleep(Math.min(300 * failures, 3000))
        continue
      }
      // connected, then lost: loop and reconnect; flush happens when the new handshake settles
    }
  })()

  const removeSession = (id: string) => {
    if (!sessions.delete(id)) return
    post({ type: "unregister", instanceId: id })
  }

  const setTitle = (id: string, title: string) => {
    const s = sessions.get(id)
    if (!s || !title || s.title === title) return
    s.title = title
    post({ type: "title", instanceId: id, title })
  }

  const alreadySeen = (key: string): boolean => {
    if (seen.has(key)) return true
    seen.add(key)
    if (seen.size > MAX_SEEN_KEYS) seen.delete(seen.values().next().value as string)
    return false
  }

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [id, s] of [...sessions]) {
      const ttl = s.busy ? idleRemoveMs * BUSY_TTL_FACTOR : idleRemoveMs
      if (now - s.lastActivity > ttl) removeSession(id)
    }
  }, sweepIntervalMs)
  ;(sweep as { unref?: () => void }).unref?.()

  return {
    sendEvent(sessionID, eventType, payload = {}, options = {}) {
      if (!sessionID || typeof sessionID !== "string") return
      if (options.dedupeKey && alreadySeen(options.dedupeKey)) return
      let s = sessions.get(sessionID)
      if (!s) {
        if (!options.register) return
        const directory = options.directory || hubDirectory
        s = { directory, skin: resolveSkin(directory, sessionID), busy: false, lastActivity: Date.now() }
        sessions.set(sessionID, s)
        options
          .resolveTitle?.()
          .then((title) => {
            // Never overwrite a title that a rename event already delivered while the lookup was in flight.
            if (title && sessions.get(sessionID) && !sessions.get(sessionID)!.title) setTitle(sessionID, title)
          })
          .catch(() => {})
        s.busy = nextActive(false, { type: eventType, ...payload })
        post(registerMessage(sessionID, s))
      } else {
        s.busy = nextActive(s.busy, { type: eventType, ...payload })
      }
      s.lastActivity = Date.now()
      post({ type: "event", instanceId: sessionID, event: { type: eventType, ...payload } })
    },
    setTitle,
    removeSession,
    close() {
      closed = true
      clearInterval(sweep)
      if (helloTimer) clearTimeout(helloTimer)
      helloTimer = null
      try {
        ws?.close()
      } catch {}
      ws = null
      mode = "disconnected"
      sessions.clear()
    },
  }
}

let shared: Hub | null = null
let refs = 0

/**
 * Starts (or joins) the process-wide visualizer connection. Never throws and never blocks the caller: plugin
 * startup must not wait on the network. The V2 service loads the plugin once per project location in a single
 * process, so all handles share one connection and one session registry. Options come from the first caller.
 */
export function startVisualizer(options: VisualizerOptions): Visualizer {
  if (!shared) shared = createHub(options)
  const hub = shared
  refs++
  let released = false
  return {
    sendEvent: hub.sendEvent,
    setTitle: hub.setTitle,
    removeSession: hub.removeSession,
    dispose() {
      if (released) return
      released = true
      if (--refs === 0) {
        hub.close()
        shared = null
      }
    },
  }
}

// ─── Event mapping ──────────────────────────────────────────────────

export type VisualizerAction =
  | { kind: "event"; sessionID: string; type: string; payload?: Record<string, unknown>; register: boolean }
  | { kind: "rename"; sessionID: string; title: string }
  | { kind: "remove"; sessionID: string }

const isActive = isActiveStatus

const sessionEvent = (sessionID: string, type: string, register: boolean, payload?: Record<string, unknown>): VisualizerAction => ({ kind: "event", sessionID, type, register, ...(payload && { payload }) })

/**
 * Maps an OpenCode V2 server event to what the visualizer needs. The frontend reads V1-shaped messages
 * (`session.status` { status }, `session.idle`, `session.error`), so those shapes are kept.
 *
 * V2 signals activity through the execution lifecycle (`session.execution.started` → `succeeded` / `failed` /
 * `interrupted`); `session.status` is honoured too in case a build emits it. Only busy/retry activity creates
 * a character, so idle/error events for a session we never saw are ignored.
 */
export function mapV2Event(event: { type: string; data?: { sessionID?: string; status?: unknown; title?: string } }): VisualizerAction[] {
  const sessionID = event.data?.sessionID
  if (!sessionID) return []
  switch (event.type) {
    case "session.execution.started":
      return [sessionEvent(sessionID, "session.status", true, { status: { type: "busy" } })]
    case "session.status":
      return [sessionEvent(sessionID, "session.status", isActive(event.data?.status), { status: event.data?.status })]
    case "session.execution.succeeded":
    case "session.execution.interrupted":
    case "session.idle":
      return [sessionEvent(sessionID, "session.idle", false)]
    case "session.execution.failed":
      // Show the error, then send the character off like any other finished run.
      return [sessionEvent(sessionID, "session.error", false), sessionEvent(sessionID, "session.idle", false)]
    case "session.renamed":
      return event.data?.title ? [{ kind: "rename", sessionID, title: event.data.title }] : []
    case "session.deleted":
      return [{ kind: "remove", sessionID }]
    default:
      return []
  }
}

/** Same as mapV2Event for OpenCode 1.x events, whose payloads live in `properties`. */
export function mapV1Event(event: { type: string; properties?: { sessionID?: string; status?: unknown; info?: { id?: string; title?: string } } }): VisualizerAction[] {
  const p = event.properties
  switch (event.type) {
    case "session.status":
      return p?.sessionID ? [sessionEvent(p.sessionID, "session.status", isActive(p.status), { status: p.status })] : []
    case "session.idle":
      return p?.sessionID ? [sessionEvent(p.sessionID, "session.idle", false)] : []
    case "session.error":
      return p?.sessionID ? [sessionEvent(p.sessionID, "session.error", false)] : []
    case "session.updated":
      return p?.info?.id && p.info.title ? [{ kind: "rename", sessionID: p.info.id, title: p.info.title }] : []
    case "session.deleted":
      return p?.info?.id ? [{ kind: "remove", sessionID: p.info.id }] : []
    default:
      return []
  }
}
