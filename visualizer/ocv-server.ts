// ocv-server.ts — WebSocket server for OpenCode Visualizer
// Can run standalone (bun ocv-server.ts) or be imported in-process
import { join } from "path"
import { existsSync } from "fs"
import { platform } from "os"
import { SERVER_PORT, PROTOCOL_VERSION, nextActive } from "../shared"
export { nextActive }

interface PluginClient {
  instanceId: string
  /** Identity of the owning socket (Bun's ServerWebSocket); only ever compared, never called. */
  ws: unknown
  cwd: string
  skin: string
  title: string
  /** Last known busy/idle state, so a frontend that connects mid-run can start its characters at work. */
  active: boolean
  connectedAt: number
}

interface FrontendClient {
  ws: WebSocket
}

const pluginClients = new Map<string, PluginClient>()
// Every connected plugin socket, including ones that currently host no session. The shutdown timer must look at
// sockets, not sessions: a plugin with zero live sessions is still connected and will register new ones.
const pluginSockets = new Set<unknown>()

const MAX_CLIENTS = 200
const MAX_ID = 128
const MAX_TEXT = 300
/** Untrusted input: only strings, bounded in length. */
const text = (v: unknown, max = MAX_TEXT): string => (typeof v === "string" ? v.slice(0, max) : "")
const idOf = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= MAX_ID ? v : undefined)
const frontendClients = new Set<FrontendClient>()

function broadcast(data: Record<string, unknown>) {
  const msg = JSON.stringify(data)
  for (const client of frontendClients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      try { client.ws.send(msg) } catch {}
    }
  }
}

function trySpawn(cmd: string[], label: string): boolean {
  try {
    const proc = Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] })
    serverLog(`[ocv-server] Browser launched via ${label} (PID=${proc.pid})`)
    return true
  } catch (e) {
    serverLog(`[ocv-server] Failed to launch browser via ${label}: ${e}`)
    return false
  }
}

let browserLaunched = false

function openBrowser() {
  if (browserLaunched || process.env.OCV_NO_BROWSER) return
  browserLaunched = true
  const url = `http://localhost:${SERVER_PORT}`
  const os = platform()

  setTimeout(() => {
    if (frontendClients.size > 0) {
      serverLog("[ocv-server] Frontend already connected, skipping browser launch")
      return
    }
    serverLog(`[ocv-server] Attempting to open browser on ${os}...`)

    if (os === "darwin") {
      const launched =
        trySpawn(["open", "-n", "-a", "Google Chrome", "--args", `--app=${url}`, "--window-size=1024,768"], "Google Chrome") ||
        trySpawn(["open", "-n", "-a", "Chromium", "--args", `--app=${url}`, "--window-size=1024,768"], "Chromium") ||
        trySpawn(["open", url], "default browser")
      if (!launched) serverLog("[ocv-server] Could not open any browser. Open manually: " + url)
    } else if (os === "win32") {
      const launched =
        trySpawn(["cmd.exe", "/c", "start", "chrome", `--app=${url}`, "--window-size=1024,768"], "chrome") ||
        trySpawn(["cmd.exe", "/c", "start", "", url], "default browser")
      if (!launched) serverLog("[ocv-server] Could not open any browser. Open manually: " + url)
    } else {
      const launched =
        trySpawn(["google-chrome", `--app=${url}`, "--window-size=1024,768"], "google-chrome") ||
        trySpawn(["chromium-browser", `--app=${url}`, "--window-size=1024,768"], "chromium-browser") ||
        trySpawn(["xdg-open", url], "xdg-open")
      if (!launched) serverLog("[ocv-server] Could not open any browser. Open manually: " + url)
    }
  }, 3000)
}

let shutdownTimer: ReturnType<typeof setTimeout> | null = null
let server: ReturnType<typeof Bun.serve> | null = null

function resetShutdownTimer() {
  if (shutdownTimer) clearTimeout(shutdownTimer)
  shutdownTimer = setTimeout(() => {
    if (pluginSockets.size === 0 && frontendClients.size === 0) {
      // stop(true) also drops any lingering sockets so their plugins notice and re-elect a leader.
      server?.stop(true)
      // Clear the reference so startServer() can re-bind on a later call
      // (e.g. when a surviving instance takes over as the leader).
      server = null
      browserLaunched = false
      // Only exit if running standalone, not in-process
      if (isStandalone) process.exit(0)
    }
  }, Number(process.env.OCV_SHUTDOWN_MS) || 300_000)
}

/** Browsers always send Origin on WebSocket handshakes; plugins and tests (non-browser clients) send none. */
export function originAllowed(origin: string | null): boolean {
  if (!origin) return true
  try {
    const u = new URL(origin)
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && Number(u.port || (u.protocol === "https:" ? 443 : 80)) === SERVER_PORT
  } catch {
    return false
  }
}

const VISUALIZER_DIR = join(import.meta.dir)

export function startServer(): boolean {
  if (server) return true
  try {
    server = Bun.serve({
      port: SERVER_PORT,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket" && !originAllowed(req.headers.get("origin"))) {
          // Any web page can open a WebSocket to localhost; only the visualizer page itself (and non-browser clients) may.
          return new Response("Forbidden", { status: 403 })
        }
        if (server!.upgrade(req)) return
        try {
          const url = new URL(req.url)
          const pathname = url.pathname === "/" ? "/index.html" : url.pathname
          const filePath = join(VISUALIZER_DIR, pathname)
          if (existsSync(filePath)) {
            return new Response(Bun.file(filePath), {
              headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
            })
          }
          return new Response("Not found", { status: 404 })
        } catch {
          return new Response("<h1>Server error</h1>", {
            headers: { "Content-Type": "text/html" },
            status: 500,
          })
        }
      },
      websocket: {
        open(_ws) {},
        message(ws, message) {
          let data: Record<string, unknown>
          try { data = JSON.parse(message as string) } catch { return }
          if (typeof data !== "object" || data === null) return

          switch (data.type) {
            case "hello": {
              // Protocol handshake (v2+). Servers older than this ignore the message, which is how plugins detect them.
              pluginSockets.add(ws)
              ws.send(JSON.stringify({ type: "hello.ack", protocol: PROTOCOL_VERSION }))
              resetShutdownTimer()
              break
            }
            case "register": {
              const id = idOf(data.instanceId)
              if (!id) return
              pluginSockets.add(ws)
              if (!pluginClients.has(id) && pluginClients.size >= MAX_CLIENTS) return // a local client cannot grow the table without bound
              // A re-register (reconnect, new leader) may arrive from a new socket before the old one's close is seen;
              // the new socket wins and the old socket's later close will not touch this entry (close checks ownership).
              const client: PluginClient = {
                instanceId: id,
                ws,
                cwd: text(data.cwd),
                skin: text(data.skin, 20),
                title: text(data.title),
                active: data.active === true,
                connectedAt: Date.now(),
              }
              pluginClients.set(id, client)
              broadcast({ type: "instance.added", instanceId: id, cwd: client.cwd, skin: client.skin, title: client.title })
              ws.send(JSON.stringify({ type: "registered", protocol: PROTOCOL_VERSION }))
              if (client.active) broadcast({ type: "instance.event", instanceId: id, event: { type: "session.status", status: { type: "busy" } } })
              openBrowser()
              resetShutdownTimer()
              break
            }
            case "frontend.register": {
              frontendClients.add({ ws })
              const instances = [...pluginClients.values()].map((c) => ({
                instanceId: c.instanceId,
                cwd: c.cwd,
                skin: c.skin,
                title: c.title,
                active: c.active,
              }))
              ws.send(JSON.stringify({ type: "state.sync", instances }))
              break
            }
            // The messages below act on a character, so only the socket that registered it may send them.
            case "unregister": {
              const id = idOf(data.instanceId)
              if (id && pluginClients.get(id)?.ws === ws) {
                pluginClients.delete(id)
                broadcast({ type: "instance.removed", instanceId: id })
              }
              break
            }
            case "title": {
              const id = idOf(data.instanceId)
              const client = id ? pluginClients.get(id) : undefined
              if (id && client?.ws === ws) {
                client.title = text(data.title)
                broadcast({ type: "instance.title", instanceId: id, title: client.title })
              }
              break
            }
            case "event": {
              const id = idOf(data.instanceId)
              const client = id ? pluginClients.get(id) : undefined
              if (id && client?.ws === ws && typeof data.event === "object" && data.event !== null) {
                client.active = nextActive(client.active, data.event as { type?: string; status?: unknown })
                broadcast({ type: "instance.event", instanceId: id, event: data.event })
              }
              break
            }
          }
        },
        close(ws) {
          pluginSockets.delete(ws)
          for (const [id, client] of [...pluginClients]) {
            if (client.ws === ws) {
              pluginClients.delete(id)
              broadcast({ type: "instance.removed", instanceId: id })
            }
          }
          for (const client of frontendClients) {
            if (client.ws === ws) {
              frontendClients.delete(client)
              break
            }
          }
          resetShutdownTimer()
        },
      },
    })

    serverLog(`[ocv-server] Listening on http://localhost:${SERVER_PORT}`)
    return true
  } catch (e) {
    serverLog(`[ocv-server] Failed to start server on port ${SERVER_PORT}: ${e}`)
    return false
  }
}

// Detect if running standalone (bun ocv-server.ts) vs imported
const isStandalone = import.meta.main === true

function serverLog(msg: string) {
  if (isStandalone) console.log(msg)
}

if (isStandalone) {
  if (!startServer()) {
    console.error(`[ocv-server] Port ${SERVER_PORT} may already be in use`)
    process.exit(1)
  }
}
