import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { AVAILABLE_SKINS, mapV1Event, mapV2Event, resolveSkin, startVisualizer, type Visualizer, type VisualizerAction } from "../core"
import { FakeWebSocket, installFakeWebSocket, tempDir, tick } from "./helpers"

let handles: Visualizer[] = []
const start = (options: Partial<Parameters<typeof startVisualizer>[0]> = {}) => {
  const viz = startVisualizer({ directory: tempDir(), startServer: () => true, ...options })
  handles.push(viz)
  return viz
}
beforeEach(installFakeWebSocket)
afterEach(() => {
  handles.forEach((h) => h.dispose())
  handles = []
})

const ev = (sessionID: string, type: string, register: boolean, payload?: Record<string, unknown>): VisualizerAction => ({ kind: "event", sessionID, type, register, ...(payload && { payload }) })

describe("mapV2Event", () => {
  // Event names below were captured from a real OpenCode 2.0.20 run: session.created, inbox.*, execution.started,
  // instructions.updated, step.started, step.failed, execution.failed. No session.status was emitted.
  test("execution.started registers a character and means busy", () => {
    expect(mapV2Event({ type: "session.execution.started", data: { sessionID: "s1" } })).toEqual([ev("s1", "session.status", true, { status: { type: "busy" } })])
  })
  test("execution.succeeded / interrupted / session.idle all mean idle, without registering", () => {
    for (const type of ["session.execution.succeeded", "session.execution.interrupted", "session.idle"]) {
      expect(mapV2Event({ type, data: { sessionID: "s1" } })).toEqual([ev("s1", "session.idle", false)])
    }
  })
  test("execution.failed shows the error and then sends the character off", () => {
    expect(mapV2Event({ type: "session.execution.failed", data: { sessionID: "s1" } })).toEqual([ev("s1", "session.error", false), ev("s1", "session.idle", false)])
  })
  test("session.status is still honoured: busy/retry register, idle does not", () => {
    for (const type of ["busy", "retry"]) {
      expect(mapV2Event({ type: "session.status", data: { sessionID: "s1", status: { type } } })).toEqual([ev("s1", "session.status", true, { status: { type } })])
    }
    expect(mapV2Event({ type: "session.status", data: { sessionID: "s1", status: { type: "idle" } } })).toEqual([ev("s1", "session.status", false, { status: { type: "idle" } })])
  })
  test("rename and delete", () => {
    expect(mapV2Event({ type: "session.renamed", data: { sessionID: "s1", title: "Fix bug" } })).toEqual([{ kind: "rename", sessionID: "s1", title: "Fix bug" }])
    expect(mapV2Event({ type: "session.deleted", data: { sessionID: "s1" } })).toEqual([{ kind: "remove", sessionID: "s1" }])
  })
  test("ignores unrelated events and events without a session", () => {
    for (const type of ["session.created", "session.step.started", "session.step.failed", "session.text.delta", "provider.updated"]) {
      expect(mapV2Event({ type, data: { sessionID: "s1" } })).toEqual([])
    }
    expect(mapV2Event({ type: "session.idle" })).toEqual([])
    expect(mapV2Event({ type: "session.renamed", data: { sessionID: "s1" } })).toEqual([])
  })
})

describe("mapV1Event", () => {
  test("status / idle / error", () => {
    expect(mapV1Event({ type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } })).toEqual([ev("s1", "session.status", true, { status: { type: "busy" } })])
    expect(mapV1Event({ type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } })).toEqual([ev("s1", "session.status", false, { status: { type: "idle" } })])
    expect(mapV1Event({ type: "session.idle", properties: { sessionID: "s1" } })).toEqual([ev("s1", "session.idle", false)])
    expect(mapV1Event({ type: "session.error", properties: { sessionID: "s1" } })).toEqual([ev("s1", "session.error", false)])
  })
  test("session.error without a sessionID is ignored", () => {
    expect(mapV1Event({ type: "session.error", properties: {} })).toEqual([])
  })
  test("updated carries the title, deleted removes", () => {
    expect(mapV1Event({ type: "session.updated", properties: { info: { id: "s1", title: "T" } } })).toEqual([{ kind: "rename", sessionID: "s1", title: "T" }])
    expect(mapV1Event({ type: "session.deleted", properties: { info: { id: "s1" } } })).toEqual([{ kind: "remove", sessionID: "s1" }])
  })
  test("ignores events the frontend does not use", () => {
    expect(mapV1Event({ type: "message.updated", properties: {} })).toEqual([])
  })
})

describe("resolveSkin", () => {
  test("is stable per session and never writes into the project directory", () => {
    const dir = tempDir()
    const skin = resolveSkin(dir, "ses_1")
    expect(AVAILABLE_SKINS).toContain(skin)
    expect(resolveSkin(dir, "ses_1")).toBe(skin)
    expect(existsSync(join(dir, ".opencode"))).toBe(false)
  })
  test("different sessions spread across skins", () => {
    const dir = tempDir()
    const skins = new Set(Array.from({ length: 40 }, (_, i) => resolveSkin(dir, `ses_${i}`)))
    expect(skins.size).toBeGreaterThan(2)
  })
  test("a project can pin a skin with .opencode/viz-skin.json", () => {
    const dir = tempDir()
    mkdirSync(join(dir, ".opencode"))
    writeFileSync(join(dir, ".opencode", "viz-skin.json"), JSON.stringify({ skin: "person4" }))
    expect(resolveSkin(dir, "anything")).toBe("person4")
  })
  test("an invalid pinned skin is ignored", () => {
    const dir = tempDir()
    mkdirSync(join(dir, ".opencode"))
    writeFileSync(join(dir, ".opencode", "viz-skin.json"), JSON.stringify({ skin: "../../etc" }))
    expect(AVAILABLE_SKINS).toContain(resolveSkin(dir, "x"))
  })
})

describe("session registry", () => {
  test("a session gets a character only when an event asks for one", async () => {
    const viz = start()
    await tick()
    const ws = FakeWebSocket.instances[0]
    expect(ws.url).toContain("localhost")

    viz.sendEvent("s1", "session.idle") // unknown session, no register -> dropped
    expect(ws.sent).toEqual([])

    viz.sendEvent("s1", "session.status", { status: { type: "busy" } }, { register: true, directory: "/work/proj" })
    expect(ws.sent[0]).toMatchObject({ type: "register", instanceId: "s1", cwd: "/work/proj" })
    expect(AVAILABLE_SKINS).toContain(ws.sent[0].skin)
    expect(ws.sent[1]).toEqual({ type: "event", instanceId: "s1", event: { type: "session.status", status: { type: "busy" } } })

    viz.sendEvent("s1", "session.idle") // known now -> forwarded
    expect(ws.sent[2].event.type).toBe("session.idle")
  })

  test("two sessions in the same directory are two characters on one socket", async () => {
    const viz = start()
    await tick()
    const dir = tempDir()
    viz.sendEvent("a", "tool.execute.before", { tool: "grep" }, { register: true, directory: dir })
    viz.sendEvent("b", "tool.execute.before", { tool: "edit" }, { register: true, directory: dir })
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].sent.filter((m) => m.type === "register").map((m) => m.instanceId)).toEqual(["a", "b"])
  })

  test("title is looked up once on creation and sent as a title message", async () => {
    const viz = start()
    await tick()
    let lookups = 0
    const resolveTitle = async () => (++lookups, "Fix the login bug")
    viz.sendEvent("s1", "session.status", {}, { register: true, resolveTitle })
    viz.sendEvent("s1", "tool.execute.before", {}, { register: true, resolveTitle })
    await tick()
    expect(lookups).toBe(1)
    expect(FakeWebSocket.instances[0].sent).toContainEqual({ type: "title", instanceId: "s1", title: "Fix the login bug" })
  })

  test("a failing title lookup does not break the session", async () => {
    const viz = start()
    await tick()
    viz.sendEvent("s1", "session.status", {}, { register: true, resolveTitle: async () => { throw new Error("nope") } })
    await tick()
    viz.sendEvent("s1", "session.idle")
    expect(FakeWebSocket.instances[0].sent.some((m) => m.event?.type === "session.idle")).toBe(true)
  })

  test("setTitle updates a known session, skips unchanged titles and unknown sessions", async () => {
    const viz = start()
    await tick()
    viz.setTitle("ghost", "x")
    viz.sendEvent("s1", "session.status", {}, { register: true })
    viz.setTitle("s1", "New title")
    viz.setTitle("s1", "New title")
    expect(FakeWebSocket.instances[0].sent.filter((m) => m.type === "title")).toEqual([{ type: "title", instanceId: "s1", title: "New title" }])
  })

  test("dedupeKey drops repeats (same event reaching several plugin instances)", async () => {
    const viz = start()
    await tick()
    for (let i = 0; i < 3; i++) viz.sendEvent("s1", "session.status", {}, { register: true, dedupeKey: "event:e1" })
    expect(FakeWebSocket.instances[0].sent.filter((m) => m.type === "event")).toHaveLength(1)
  })

  test("removeSession unregisters; later events for it are dropped until it registers again", async () => {
    const viz = start()
    await tick()
    viz.sendEvent("s1", "session.status", {}, { register: true })
    viz.removeSession("s1")
    viz.removeSession("s1") // idempotent
    viz.sendEvent("s1", "session.idle")
    const sent = FakeWebSocket.instances[0].sent
    expect(sent.filter((m) => m.type === "unregister")).toEqual([{ type: "unregister", instanceId: "s1" }])
    expect(sent.some((m) => m.event?.type === "session.idle")).toBe(false)
  })

  test("idle sessions leave after idleRemoveMs; activity keeps them", async () => {
    // Generous margins (TTL = 6x the keep-alive interval) so a loaded machine cannot make this flaky.
    const viz = start({ idleRemoveMs: 300, sweepIntervalMs: 25 })
    await tick()
    for (const id of ["active", "quiet"]) {
      viz.sendEvent(id, "session.status", { status: { type: "busy" } }, { register: true })
      viz.sendEvent(id, "session.idle")
    }
    for (let i = 0; i < 16; i++) {
      await tick(50)
      viz.sendEvent("active", "session.idle") // any event keeps "active" fresh
    }
    const unregistered = FakeWebSocket.instances[0].sent.filter((m) => m.type === "unregister").map((m) => m.instanceId)
    expect(unregistered).toEqual(["quiet"])
  })

  test("a session that is still working is not swept after the idle timeout (review M5)", async () => {
    const viz = start({ idleRemoveMs: 100, sweepIntervalMs: 20 })
    await tick()
    viz.sendEvent("long-task", "session.status", { status: { type: "busy" } }, { register: true })
    await tick(400) // 4x the idle timeout, no events (e.g. a subagent or long build is running)
    expect(FakeWebSocket.instances[0].sent.some((m) => m.type === "unregister")).toBe(false)
    viz.sendEvent("long-task", "session.idle") // now finished and quiet
    await tick(300)
    expect(FakeWebSocket.instances[0].sent.filter((m) => m.type === "unregister")).toHaveLength(1)
  })

  test("a late title lookup does not overwrite a newer rename (review m2)", async () => {
    const viz = start()
    await tick()
    let release!: (t: string) => void
    viz.sendEvent("s1", "session.status", {}, { register: true, resolveTitle: () => new Promise<string>((r) => (release = r)) })
    viz.setTitle("s1", "Renamed meanwhile")
    release("Old lookup result")
    await tick()
    expect(FakeWebSocket.instances[0].sent.filter((m) => m.type === "title").map((m) => m.title)).toEqual(["Renamed meanwhile"])
  })

  test("a title lookup resolving after the session was removed does nothing", async () => {
    const viz = start()
    await tick()
    let release!: (t: string) => void
    viz.sendEvent("s1", "session.status", {}, { register: true, resolveTitle: () => new Promise<string>((r) => (release = r)) })
    viz.removeSession("s1")
    release("Too late")
    await tick()
    expect(FakeWebSocket.instances[0].sent.some((m) => m.type === "title")).toBe(false)
  })

  test("the register message carries the busy flag so a new server shows mid-run sessions as working (review m9)", async () => {
    const viz = start()
    await tick()
    viz.sendEvent("s1", "tool.execute.before", { tool: "bash" }, { register: true })
    expect(FakeWebSocket.instances[0].sent[0]).toMatchObject({ type: "register", instanceId: "s1", active: true })
  })

  test("ids that are not non-empty strings never create a character", async () => {
    const viz = start()
    await tick()
    viz.sendEvent(undefined as any, "tool.execute.before", {}, { register: true })
    viz.sendEvent("", "tool.execute.before", {}, { register: true })
    expect(FakeWebSocket.instances[0].sent).toEqual([])
  })

  test("the same tool-call id in two sessions is not treated as a duplicate (review m3)", async () => {
    const viz = start()
    await tick()
    viz.sendEvent("s1", "tool.execute.before", {}, { register: true, dedupeKey: "before:s1:call_0" })
    viz.sendEvent("s2", "tool.execute.before", {}, { register: true, dedupeKey: "before:s2:call_0" })
    expect(FakeWebSocket.instances[0].sent.filter((m) => m.type === "event")).toHaveLength(2)
  })
})

describe("connection lifecycle", () => {
  test("handles share one connection; it closes when the last one is released", async () => {
    const a = start()
    const b = start()
    await tick()
    expect(FakeWebSocket.instances).toHaveLength(1)
    a.dispose()
    expect(FakeWebSocket.instances[0].closed).toBe(false)
    b.dispose()
    expect(FakeWebSocket.instances[0].closed).toBe(true)
  })

  test("sessions are re-announced, with their titles, after reconnecting to a new server", async () => {
    let starts = 0
    const viz = start({ startServer: () => (++starts, true) })
    await tick()
    viz.sendEvent("s1", "session.status", {}, { register: true, directory: "/p", resolveTitle: async () => "My chat" })
    await tick()
    FakeWebSocket.instances[0].close()
    await tick(2600) // reconnect delay is 1000ms + up to 500ms jitter
    expect(starts).toBe(2) // leader election retried
    const second = FakeWebSocket.instances[1]
    expect(second.sent[0]).toMatchObject({ type: "register", instanceId: "s1", cwd: "/p", title: "My chat" })
  })

  test("a throwing startServer does not break startup and is logged", async () => {
    const dir = tempDir()
    start({ directory: dir, startServer: () => { throw new Error("boom") } })
    await tick()
    expect(FakeWebSocket.instances.length).toBe(1)
    expect(existsSync(join(dir, ".opencode", "ocv-debug.log"))).toBe(true)
    expect(readFileSync(join(dir, ".opencode", "ocv-debug.log"), "utf-8")).toContain("Failed to start server: Error: boom")
  })

  test("dispose prevents reconnects", async () => {
    const viz = start()
    await tick()
    viz.dispose()
    viz.dispose() // idempotent
    await tick(1800)
    expect(FakeWebSocket.instances.length).toBe(1)
  })

  test("dispose then start again gives a fresh hub (nothing stale)", async () => {
    const first = start()
    await tick()
    first.sendEvent("s1", "session.status", {}, { register: true })
    first.dispose()
    const again = start()
    await tick()
    expect(FakeWebSocket.instances).toHaveLength(2)
    again.sendEvent("s1", "session.idle") // unknown to the fresh hub -> dropped
    expect(FakeWebSocket.instances[1].sent).toEqual([])
  })

  test("never holds two sockets: a slow server that comes up later yields exactly one live connection (review m4)", async () => {
    const viz = start()
    await tick(2500) // several reconnect cycles
    const live = FakeWebSocket.instances.filter((w) => !w.closed)
    expect(live.length).toBeLessThanOrEqual(1)
    viz.dispose()
    expect(FakeWebSocket.instances.every((w) => w.closed)).toBe(true)
  })
})

describe("old servers (protocol < 2, review m11)", () => {
  test("a server that never answers hello is treated as legacy: all sessions share one process-wide character", async () => {
    FakeWebSocket.ack = false
    const viz = start()
    await tick(1700) // hello timeout
    viz.sendEvent("a", "session.status", { status: { type: "busy" } }, { register: true, directory: "/p" })
    viz.sendEvent("b", "tool.execute.before", { tool: "grep" }, { register: true, directory: "/p" })
    viz.removeSession("a") // unregister is not understood by old servers
    const sent = FakeWebSocket.instances[0].sent
    expect(sent.filter((m) => m.type === "register")).toHaveLength(1)
    expect(sent.filter((m) => m.type === "register")[0].instanceId).toMatch(/^oc-/)
    expect(sent.some((m) => m.type === "unregister" || m.type === "title")).toBe(false)
    expect(sent.filter((m) => m.type === "event").every((m) => m.instanceId === sent[0].instanceId)).toBe(true)
  })

  test("sessions created while the handshake is pending are announced once it settles", async () => {
    const viz = start()
    viz.sendEvent("a", "tool.execute.before", {}, { register: true }) // before the socket even opens
    await tick(50)
    expect(FakeWebSocket.instances[0].sent[0]).toMatchObject({ type: "register", instanceId: "a", active: true })
  })
})
