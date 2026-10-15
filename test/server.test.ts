// Protocol test against the real visualizer server (ocv-server.ts) on the random OCV_PORT from test/setup.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { SERVER_PORT } from "../shared"
import { join } from "path"
import { RealWebSocket, tick } from "./helpers"

const { startServer, originAllowed } = await import("../visualizer/ocv-server")
const { nextActive } = await import("../shared")

type Msg = Record<string, any>
function connect(): Promise<{ ws: WebSocket; got: Msg[]; send: (m: Msg) => void }> {
  return new Promise((resolve, reject) => {
    const ws = new RealWebSocket(`ws://127.0.0.1:${SERVER_PORT}`)
    const got: Msg[] = []
    ws.onmessage = (e) => got.push(JSON.parse(e.data as string))
    ws.onopen = () => resolve({ ws, got, send: (m) => ws.send(JSON.stringify(m)) })
    ws.onerror = () => reject(new Error("connect failed"))
  })
}

let frontend: Awaited<ReturnType<typeof connect>>
beforeAll(async () => {
  expect(startServer()).toBe(true)
  frontend = await connect()
  frontend.send({ type: "frontend.register" })
  await tick(50)
})
afterAll(() => frontend.ws.close())

const frontendTypes = () => frontend.got.map((m) => m.type)

describe("visualizer server protocol", () => {
  test("serves the frontend page", async () => {
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("<canvas")
  })

  test("one socket can host several characters; titles and unregister are broadcast", async () => {
    const plugin = await connect()
    plugin.send({ type: "register", instanceId: "s1", cwd: "/p", skin: "person1", title: "First chat" })
    plugin.send({ type: "register", instanceId: "s2", cwd: "/p", skin: "person2" })
    plugin.send({ type: "title", instanceId: "s2", title: "Second chat" })
    plugin.send({ type: "event", instanceId: "s1", event: { type: "session.idle" } })
    await tick(50)

    expect(frontend.got.filter((m) => m.type === "instance.added").map((m) => [m.instanceId, m.title])).toEqual([
      ["s1", "First chat"],
      ["s2", ""],
    ])
    expect(frontend.got).toContainEqual({ type: "instance.title", instanceId: "s2", title: "Second chat" })
    expect(frontend.got).toContainEqual({ type: "instance.event", instanceId: "s1", event: { type: "session.idle" } })

    // A late-joining frontend gets everyone, with current titles.
    const late = await connect()
    late.send({ type: "frontend.register" })
    await tick(50)
    const sync = late.got.find((m) => m.type === "state.sync")!
    expect(sync.instances.map((i: Msg) => [i.instanceId, i.title])).toEqual([["s1", "First chat"], ["s2", "Second chat"]])
    late.ws.close()

    plugin.send({ type: "unregister", instanceId: "s1" })
    await tick(50)
    expect(frontend.got).toContainEqual({ type: "instance.removed", instanceId: "s1" })

    // Closing the socket must remove *all* remaining characters on it (was: only the first).
    frontend.got.length = 0
    plugin.ws.close()
    await tick(100)
    expect(frontend.got.filter((m) => m.type === "instance.removed").map((m) => m.instanceId)).toEqual(["s2"])
  })

  test("closing a socket with three characters removes all three", async () => {
    const plugin = await connect()
    for (const id of ["a", "b", "c"]) plugin.send({ type: "register", instanceId: id, cwd: "/p", skin: "person1" })
    await tick(50)
    frontend.got.length = 0
    plugin.ws.close()
    await tick(100)
    expect(frontend.got.filter((m) => m.type === "instance.removed").map((m) => m.instanceId).sort()).toEqual(["a", "b", "c"])
  })

  test("a plugin cannot unregister, retitle or send events for characters owned by another socket (review m1)", async () => {
    const owner = await connect()
    const other = await connect()
    owner.send({ type: "register", instanceId: "mine", cwd: "/p", skin: "person1", title: "Mine" })
    await tick(50)
    frontend.got.length = 0
    other.send({ type: "unregister", instanceId: "mine" })
    other.send({ type: "title", instanceId: "mine", title: "Hijacked" })
    other.send({ type: "event", instanceId: "mine", event: { type: "session.idle" } })
    await tick(50)
    expect(frontend.got.filter((m) => ["instance.removed", "instance.title", "instance.event"].includes(m.type))).toEqual([])
    const late = await connect()
    late.send({ type: "frontend.register" })
    await tick(50)
    expect(late.got.find((m) => m.type === "state.sync")!.instances.find((i: Msg) => i.instanceId === "mine")).toMatchObject({ title: "Mine" })
    late.ws.close()
    owner.ws.close()
    other.ws.close()
    await tick(50)
  })

  test("input is validated: non-string fields are dropped, long ones capped, bad ids ignored", async () => {
    const plugin = await connect()
    plugin.send({ type: "register", instanceId: "v1", cwd: { evil: true }, skin: 7, title: "x".repeat(5000) })
    plugin.send({ type: "register", instanceId: 123, cwd: "/p" })
    plugin.send({ type: "register", instanceId: "", cwd: "/p" })
    plugin.send({ type: "register", instanceId: "i".repeat(500), cwd: "/p" })
    plugin.send("not an object" as any)
    await tick(50)
    const added = frontend.got.filter((m) => m.type === "instance.added" && m.instanceId === "v1")[0]
    expect(added.cwd).toBe("")
    expect(added.skin).toBe("")
    expect(added.title.length).toBe(300)
    expect(frontend.got.filter((m) => m.type === "instance.added").map((m) => m.instanceId)).toEqual(["v1"])
    plugin.ws.close()
    await tick(50)
  })

  test("hello is answered with the protocol version; register replies carry it too", async () => {
    const plugin = await connect()
    plugin.send({ type: "hello" })
    plugin.send({ type: "register", instanceId: "h1", cwd: "/p", skin: "person1" })
    await tick(50)
    expect(plugin.got).toContainEqual({ type: "hello.ack", protocol: 2 })
    expect(plugin.got.find((m) => m.type === "registered")).toMatchObject({ protocol: 2 })
    plugin.ws.close()
    await tick(50)
  })

  test("a register with active:true makes a late joiner start the character at work (review m9)", async () => {
    const plugin = await connect()
    plugin.send({ type: "register", instanceId: "mid-run", cwd: "/p", skin: "person1", active: true })
    await tick(50)
    const late = await connect()
    late.send({ type: "frontend.register" })
    await tick(50)
    expect(late.got.find((m) => m.type === "state.sync")!.instances.find((i: Msg) => i.instanceId === "mid-run")).toMatchObject({ active: true })
    late.ws.close()
    plugin.ws.close()
    await tick(50)
  })

  test("a re-register from a new socket takes the character over; the old socket's late close does not remove it", async () => {
    const oldSock = await connect()
    const newSock = await connect()
    oldSock.send({ type: "register", instanceId: "moved", cwd: "/p", skin: "person1" })
    await tick(30)
    newSock.send({ type: "register", instanceId: "moved", cwd: "/p", skin: "person1" })
    await tick(30)
    frontend.got.length = 0
    oldSock.ws.close()
    await tick(80)
    expect(frontend.got.filter((m) => m.type === "instance.removed")).toEqual([])
    newSock.ws.close()
    await tick(50)
  })

  test("browser WebSocket connections from other origins are rejected", async () => {
    expect(originAllowed(null)).toBe(true) // plugins/tests send no Origin
    expect(originAllowed(`http://localhost:${SERVER_PORT}`)).toBe(true)
    expect(originAllowed(`http://127.0.0.1:${SERVER_PORT}`)).toBe(true)
    expect(originAllowed("https://evil.example")).toBe(false)
    expect(originAllowed("http://localhost:9999")).toBe(false)
    expect(originAllowed("null")).toBe(false)
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/`, { headers: { upgrade: "websocket", origin: "https://evil.example" } })
    expect(res.status).toBe(403)
  })
})

describe("nextActive", () => {
  test("busy and retry mean working; idle, error mean not", () => {
    expect(nextActive(false, { type: "session.status", status: { type: "busy" } })).toBe(true)
    expect(nextActive(false, { type: "session.status", status: { type: "retry" } })).toBe(true)
    expect(nextActive(true, { type: "session.status", status: { type: "idle" } })).toBe(false)
    expect(nextActive(true, { type: "session.idle" })).toBe(false)
    expect(nextActive(true, { type: "session.error" })).toBe(false)
  })
  test("tool events never flip the state (a late tool report after an idle must not mark the session busy again)", () => {
    expect(nextActive(false, { type: "tool.execute.before" })).toBe(false)
    expect(nextActive(false, { type: "tool.execute.after" })).toBe(false)
    expect(nextActive(true, { type: "tool.execute.before" })).toBe(true)
    expect(nextActive(true, { type: "something.else" })).toBe(true)
    expect(nextActive(false, { type: "something.else" })).toBe(false)
    expect(nextActive(true, undefined)).toBe(true)
  })
})

// Review M2: the auto-shutdown timer must count connected plugin *sockets*, not live sessions. Runs the server as its own
// process (standalone mode exits when it shuts down), with a short timer.
describe("auto-shutdown (review M2)", () => {
  const port = 41000 + Math.floor(Math.random() * 3000)
  const open = () =>
    new Promise<{ ws: WebSocket; send: (m: Msg) => void }>((resolve, reject) => {
      const ws = new RealWebSocket(`ws://127.0.0.1:${port}`)
      ws.onopen = () => resolve({ ws, send: (m) => ws.send(JSON.stringify(m)) })
      ws.onerror = () => reject(new Error("connect failed"))
    })

  test("stays up while a plugin is connected with zero sessions, and stops after it disconnects", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../visualizer/ocv-server.ts")], {
      env: { ...process.env, OCV_PORT: String(port), OCV_SHUTDOWN_MS: "400", OCV_NO_BROWSER: "1" },
      stdout: "ignore",
      stderr: "ignore",
    })
    let exited = false
    void proc.exited.then(() => (exited = true))
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${port}/`); break } catch { await tick(100) }
    }

    const plugin = await open()
    plugin.send({ type: "hello" })
    plugin.send({ type: "register", instanceId: "only", cwd: "/p", skin: "person1" })
    await tick(100)
    plugin.send({ type: "unregister", instanceId: "only" }) // zero sessions, but the plugin is still connected
    await tick(1200) // three times the shutdown timer
    expect(exited).toBe(false)
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200)

    // Re-arm: a later register must still work on the live server.
    plugin.send({ type: "register", instanceId: "again", cwd: "/p", skin: "person1" })
    await tick(100)
    plugin.ws.close()
    await tick(1500)
    expect(exited).toBe(true) // nobody connected any more -> it shuts down
    proc.kill()
  }, 15000)
})

describe("limits", () => {
  test("the number of characters one server tracks is bounded", async () => {
    const plugin = await connect()
    for (let i = 0; i < 400; i++) plugin.send({ type: "register", instanceId: `bulk${i}`, cwd: "/p", skin: "person1" })
    await tick(300)
    const late = await connect()
    late.send({ type: "frontend.register" })
    await tick(100)
    expect(late.got.find((m) => m.type === "state.sync")!.instances.filter((i: Msg) => i.instanceId.startsWith("bulk")).length).toBeLessThanOrEqual(200)
    late.ws.close()
    plugin.ws.close()
    await tick(100)
  })
})
