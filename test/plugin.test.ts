import { beforeEach, describe, expect, test } from "bun:test"
import { FakeWebSocket, installFakeWebSocket, tempDir, tick } from "./helpers"

// The real server module is used (no mocking: Bun's mock.module is process-wide and would leak into server.test.ts).
// It binds the random OCV_PORT from test/setup.ts, never the default port.
const plugin = (await import("../index")).default

beforeEach(installFakeWebSocket)

const sent = () => FakeWebSocket.instances.flatMap((w) => w.sent)
const byType = (type: string) => sent().filter((m) => m.type === type)
const events = () => byType("event").map((m) => ({ id: m.instanceId, ...m.event }))

/** Builds a fake V2 plugin context; `push` feeds the server-wide event stream. */
function v2Context(opts: { directory?: string; titles?: Record<string, string> } = {}) {
  const hooks: Record<string, (e: any) => void> = {}
  const queue: any[] = []
  let wake: (() => void) | null = null
  let signal!: AbortSignal
  const lookups: string[] = []
  const ctx = {
    location: { directory: opts.directory ?? tempDir() },
    session: { get: async ({ sessionID }: { sessionID: string }) => (lookups.push(sessionID), { title: opts.titles?.[sessionID] }) },
    event: {
      subscribe: ({ signal: s }: { signal: AbortSignal }) => {
        signal = s
        return (async function* () {
          while (!s.aborted) {
            if (!queue.length) await new Promise<void>((r) => ((wake = r), s.addEventListener("abort", () => r())))
            while (queue.length) yield queue.shift()
          }
        })()
      },
    },
    tool: { hook: async (name: string, fn: (e: any) => void) => void (hooks[name] = fn) },
  }
  return {
    ctx,
    hooks,
    lookups,
    push: (e: any) => (queue.push(e), wake?.()),
    signal: () => signal,
  }
}

describe("default export shape", () => {
  test("satisfies the V2 definition contract (object with id + setup)", () => {
    expect(typeof plugin).toBe("object")
    expect(plugin.id.length).toBeGreaterThan(0)
    expect(typeof plugin.setup).toBe("function")
  })
  test("exposes the V1 server() entrypoint", () => {
    expect(typeof plugin.server).toBe("function")
  })
})

describe("V2 adapter", () => {
  test("one character per session, labelled with the session title", async () => {
    const t = v2Context({ titles: { s1: "Fix login", s2: "Write docs" } })
    const cleanup = await plugin.setup(t.ctx as any)
    await tick()

    t.push({ id: "e1", type: "session.execution.started", data: { sessionID: "s1" } })
    t.push({ id: "e2", type: "session.execution.started", data: { sessionID: "s2" } })
    await tick()

    expect(byType("register").map((m) => m.instanceId)).toEqual(["s1", "s2"])
    expect(byType("title")).toEqual([
      { type: "title", instanceId: "s1", title: "Fix login" },
      { type: "title", instanceId: "s2", title: "Write docs" },
    ])
    cleanup()
  })

  test("translates events and tool hooks per session, ignoring unknown sessions", async () => {
    const t = v2Context()
    const cleanup = await plugin.setup(t.ctx as any)
    await tick()

    t.push({ id: "e0", type: "session.idle", data: { sessionID: "ghost" } }) // never active -> ignored
    t.push({ id: "e1", type: "session.execution.started", data: { sessionID: "s1" } })
    t.push({ id: "e2", type: "session.text.delta", data: { sessionID: "s1" } })
    t.push({ id: "e3", type: "session.execution.succeeded", data: { sessionID: "s1" } })
    await tick()
    t.hooks["execute.before"]({ tool: "read", sessionID: "s1", id: "c1" })
    t.hooks["execute.after"]({ tool: "read", sessionID: "s1", id: "c1" })

    expect(events()).toEqual([
      { id: "s1", type: "session.status", status: { type: "busy" } },
      { id: "s1", type: "session.idle" },
      { id: "s1", type: "tool.execute.before", tool: "read" },
      { id: "s1", type: "tool.execute.after", tool: "read" },
    ])
    cleanup()
  })

  test("a failed run shows the error, then the character is sent off (two actions from one event)", async () => {
    const t = v2Context()
    const cleanup = await plugin.setup(t.ctx as any)
    await tick()
    t.push({ id: "f1", type: "session.execution.started", data: { sessionID: "s1" } })
    t.push({ id: "f2", type: "session.execution.failed", data: { sessionID: "s1" } })
    await tick()
    expect(events().map((e) => e.type)).toEqual(["session.status", "session.error", "session.idle"])
    cleanup()
  })

  test("a tool call from a session with no prior status still creates its character", async () => {
    const t = v2Context()
    const cleanup = await plugin.setup(t.ctx as any)
    await tick()
    t.hooks["execute.before"]({ tool: "bash", sessionID: "sub1", id: "c9" })
    expect(byType("register").map((m) => m.instanceId)).toEqual(["sub1"])
    cleanup()
  })

  test("rename updates the label; delete removes the character", async () => {
    const t = v2Context()
    const cleanup = await plugin.setup(t.ctx as any)
    await tick()
    t.push({ id: "e1", type: "session.execution.started", data: { sessionID: "s1" } })
    t.push({ id: "e2", type: "session.renamed", data: { sessionID: "s1", title: "Better title" } })
    t.push({ id: "e3", type: "session.deleted", data: { sessionID: "s1" } })
    await tick()
    expect(byType("title").at(-1)).toEqual({ type: "title", instanceId: "s1", title: "Better title" })
    expect(byType("unregister")).toEqual([{ type: "unregister", instanceId: "s1" }])
    cleanup()
  })

  test("the same event delivered to two plugin instances (two projects, one process) is handled once", async () => {
    const a = v2Context()
    const b = v2Context()
    const cleanA = await plugin.setup(a.ctx as any)
    const cleanB = await plugin.setup(b.ctx as any)
    await tick()
    const e = { id: "shared-1", type: "session.execution.started", data: { sessionID: "s1" } }
    a.push(e)
    b.push(e)
    a.hooks["execute.before"]({ tool: "grep", sessionID: "s1", id: "call-1" })
    b.hooks["execute.before"]({ tool: "grep", sessionID: "s1", id: "call-1" })
    await tick()
    expect(FakeWebSocket.instances).toHaveLength(1) // one shared connection
    expect(byType("register")).toHaveLength(1)
    expect(events()).toHaveLength(2) // one status + one tool event, not four
    cleanA()
    cleanB()
  })

  test("unloading the last instance aborts the stream and closes the connection", async () => {
    const t = v2Context()
    const cleanup = await plugin.setup(t.ctx as any)
    await tick()
    cleanup()
    expect(t.signal().aborted).toBe(true)
    expect(FakeWebSocket.instances[0].closed).toBe(true)
  })
})

describe("V1 adapter", () => {
  const v1Client = (titles: Record<string, string> = {}) => ({ session: { get: async ({ path }: any) => ({ data: { title: titles[path.id] } }) } })

  test("registers sessions from events and tool hooks, with titles", async () => {
    const dir = tempDir()
    const hooks: any = await (plugin.server as any)({ directory: dir, client: v1Client({ s1: "Refactor", s2: "Review PR" }) })
    await tick()

    await hooks.event({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } } })
    await hooks.event({ event: { type: "message.part.updated", properties: {} } }) // unused
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s2" })
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "s2" })
    await hooks.event({ event: { type: "session.updated", properties: { info: { id: "s1", title: "Refactor v2" } } } })
    await tick()

    expect(byType("register").map((m) => ({ id: m.instanceId, cwd: m.cwd }))).toEqual([
      { id: "s1", cwd: dir },
      { id: "s2", cwd: dir },
    ])
    expect(events()).toEqual([
      { id: "s1", type: "session.status", status: { type: "busy" } },
      { id: "s2", type: "tool.execute.before", tool: "bash" },
      { id: "s2", type: "tool.execute.after", tool: "bash" },
    ])
    expect(byType("title")).toContainEqual({ type: "title", instanceId: "s1", title: "Refactor v2" })
    expect(byType("title")).toContainEqual({ type: "title", instanceId: "s2", title: "Review PR" })
    await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } })
    expect(byType("unregister")).toEqual([{ type: "unregister", instanceId: "s1" }])
    await hooks.dispose()
    expect(FakeWebSocket.instances.every((w) => w.closed)).toBe(true)
  })

  test("dispose is idempotent and a reload (dispose + start again) gets a fresh connection", async () => {
    const first: any = await (plugin.server as any)({ directory: tempDir(), client: v1Client() })
    await tick()
    await first.dispose()
    await first.dispose()
    const second: any = await (plugin.server as any)({ directory: tempDir(), client: v1Client() })
    await tick()
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[0].closed).toBe(true)
    expect(FakeWebSocket.instances[1].closed).toBe(false)
    await second.dispose()
  })
})

describe("exception safety (review m8)", () => {
  test("a throwing session lookup or a malformed event does not end the V2 event stream", async () => {
    const t = v2Context()
    t.ctx.session.get = async () => { throw new Error("lookup failed") }
    const cleanup = await plugin.setup(t.ctx as any)
    await tick()
    t.push({ id: "bad", type: "session.execution.started", data: null }) // malformed
    t.push({ id: "e1", type: "session.execution.started", data: { sessionID: "s1" } })
    t.push({ id: "e2", type: "session.execution.succeeded", data: { sessionID: "s1" } })
    await tick()
    expect(events().map((e) => e.type)).toEqual(["session.status", "session.idle"])
    cleanup()
  })

  test("a failing tool hook registration cleans up the subscription and the connection (no leaked refcount)", async () => {
    const t = v2Context()
    t.ctx.tool.hook = async () => { throw new Error("hook rejected") }
    await expect(plugin.setup(t.ctx as any)).rejects.toThrow("hook rejected")
    await tick()
    expect(t.signal().aborted).toBe(true)
    expect(FakeWebSocket.instances.every((w) => w.closed)).toBe(true)
  })

  test("the event stream is re-opened after it ends unexpectedly", async () => {
    let subscriptions = 0
    const t = v2Context()
    const original = t.ctx.event.subscribe
    t.ctx.event.subscribe = (o: any) => {
      subscriptions++
      if (subscriptions === 1) return (async function* () { throw new Error("stream dropped") })()
      return original(o)
    }
    const cleanup = await plugin.setup(t.ctx as any)
    await tick(1300)
    expect(subscriptions).toBeGreaterThanOrEqual(2)
    t.push({ id: "e1", type: "session.execution.started", data: { sessionID: "s1" } })
    await tick()
    expect(byType("register").map((m) => m.instanceId)).toEqual(["s1"])
    cleanup()
  })

  test("V1 hooks never throw, even if the client or the hub misbehaves", async () => {
    const client = { session: { get: async () => { throw new Error("boom") } } }
    const hooks: any = await (plugin.server as any)({ directory: tempDir(), client })
    await tick()
    await expect(hooks.event({ event: null })).resolves.toBeUndefined()
    await expect(hooks.event({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } } })).resolves.toBeUndefined()
    await expect(hooks["tool.execute.before"]({})).resolves.toBeUndefined()
    await expect(hooks["tool.execute.after"](undefined)).resolves.toBeUndefined()
    await hooks.dispose()
  })

  test("tool hooks without a call id are not deduplicated away", async () => {
    const t = v2Context()
    const cleanup = await plugin.setup(t.ctx as any)
    await tick()
    t.hooks["execute.before"]({ tool: "read", sessionID: "s1" })
    t.hooks["execute.before"]({ tool: "grep", sessionID: "s1" })
    expect(events().map((e) => e.tool)).toEqual(["read", "grep"])
    cleanup()
  })
})

