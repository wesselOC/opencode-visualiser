import { describe, expect, test } from "bun:test"
import { busy, idle, loadOffice } from "./office-harness"

const add = (o: ReturnType<typeof loadOffice>, id: string, extra: Record<string, unknown> = {}) =>
  o.msg({ type: "instance.added", instanceId: id, cwd: "/p", skin: "person1", title: id, ...extra })
const event = (o: ReturnType<typeof loadOffice>, id: string, e: Record<string, unknown>) => o.msg({ type: "instance.event", instanceId: id, event: e })

describe("working and idling", () => {
  test("a session that registers and starts work in the same instant still gets to its desk", () => {
    const o = loadOffice()
    add(o, "a")
    event(o, "a", busy)
    o.step(15)
    expect(o.agent("a")!.state).toBe("working")
    expect(o.agent("a")!.deskIndex).toBeGreaterThanOrEqual(0)
  })

  test("finishing work sends the character to the coffee machine", () => {
    const o = loadOffice()
    add(o, "a")
    event(o, "a", busy)
    o.step(15)
    event(o, "a", idle)
    o.step(15)
    expect(["coffee", "walking_to_coffee"]).toContain(o.agent("a")!.state)
  })

  test("a frontend that joins mid-run (state.sync active:true) starts the character at work", () => {
    const o = loadOffice()
    o.msg({ type: "state.sync", instances: [{ instanceId: "a", cwd: "/p", skin: "person1", title: "A", active: true }, { instanceId: "b", cwd: "/p", skin: "person2", title: "B", active: false }] })
    o.step(15)
    expect(o.agent("a")!.state).toBe("working")
    expect(o.agent("b")!.state).not.toBe("working")
  })
})

// Review M1: queued work must be cancelled when the run ends before the character has even walked in.
describe("pendingWork is cancelled by idle / error (review M1)", () => {
  test("a run that ends while the character is still spawning does not send it to a desk", () => {
    const o = loadOffice()
    add(o, "a")
    event(o, "a", busy) // queued: still fading in
    event(o, "a", idle) // run ended immediately (e.g. missing API key)
    o.step(20)
    expect(o.agent("a")!.state).not.toBe("working")
    expect(o.agent("a")!.deskIndex).toBe(-1)
  })

  test("same for a character walking to the rest area", () => {
    const o = loadOffice()
    add(o, "a")
    o.step(1) // finished fading in, now walking to the rest area
    event(o, "a", busy)
    event(o, "a", idle)
    o.step(20)
    expect(["working", "sitting", "walking_to_desk"]).not.toContain(o.agent("a")!.state)
  })

  test("a queued session.error also cancels", () => {
    const o = loadOffice()
    add(o, "a")
    event(o, "a", busy)
    event(o, "a", { type: "session.error" })
    event(o, "a", idle)
    o.step(20)
    expect(o.agent("a")!.state).not.toBe("working")
  })
})

// Review M3: re-adding a session whose character is leaving must bring it back.
describe("re-adding a character that is leaving (review M3)", () => {
  test("instance.added during the exit walk revives the character", () => {
    const o = loadOffice()
    add(o, "a")
    o.step(5)
    o.msg({ type: "instance.removed", instanceId: "a" })
    o.step(0.5) // leaving, not gone yet
    add(o, "a")
    event(o, "a", busy)
    o.step(30)
    const a = o.agent("a")
    expect(a).toBeDefined()
    expect(a!.opacity).toBe(1)
    expect(a!.state).toBe("working")
  })

  test("removing an already-leaving character is a no-op (state.sync repeats it)", () => {
    const o = loadOffice()
    add(o, "a")
    o.step(5)
    o.msg({ type: "instance.removed", instanceId: "a" })
    o.step(6) // now fading out
    const before = o.agent("a")?.state
    o.msg({ type: "state.sync", instances: [] })
    expect(o.agent("a")?.state).toBe(before)
    o.step(10)
    expect(o.agent("a")).toBeUndefined()
  })
})

// Review M4: the cap is 5 characters; sessions beyond that must appear once a slot frees up.
describe("more sessions than characters (review M4)", () => {
  test("a 6th session is shown as soon as another one leaves", () => {
    const o = loadOffice()
    for (const id of ["a", "b", "c", "d", "e"]) add(o, id)
    add(o, "f")
    expect(o.agent("f")).toBeUndefined()
    o.step(2)
    o.msg({ type: "instance.removed", instanceId: "a" })
    o.step(20) // a has walked out
    expect(o.agent("a")).toBeUndefined()
    expect(o.agent("f")).toBeDefined()
  })

  test("events for a session waiting for a slot do not throw", () => {
    const o = loadOffice()
    for (const id of ["a", "b", "c", "d", "e", "f"]) add(o, id)
    expect(() => event(o, "f", busy)).not.toThrow()
    expect(() => o.msg({ type: "instance.title", instanceId: "f", title: "x" })).not.toThrow()
  })

  test("a waiting session that ends before a slot frees up never appears", () => {
    const o = loadOffice()
    for (const id of ["a", "b", "c", "d", "e", "f"]) add(o, id)
    o.msg({ type: "instance.removed", instanceId: "f" })
    o.msg({ type: "instance.removed", instanceId: "a" })
    o.step(25)
    expect(o.agent("f")).toBeUndefined()
  })
})

// Review m5 / m7: stale rest actions, late events on leaving characters.
describe("state hygiene (review m5, m7)", () => {
  test("work arriving during a rest action clears it", () => {
    const o = loadOffice(() => 0.9) // 0.9 -> scratch/yawn branch in pickRestAction
    add(o, "a")
    o.step(40)
    let guard = 0
    while (!o.agent("a")!.restAction && guard++ < 600) o.step(0.5)
    expect(o.agent("a")!.restAction).not.toBeNull()
    event(o, "a", busy)
    expect(o.agent("a")!.restAction).toBeNull()
  })

  test("a late busy event for a character that is leaving does not leave it invisible", () => {
    const o = loadOffice()
    add(o, "a")
    o.step(5)
    o.msg({ type: "instance.removed", instanceId: "a" })
    o.step(0.3)
    event(o, "a", busy)
    o.step(40)
    const a = o.agent("a")
    expect(a === undefined || a.opacity === 1).toBe(true)
  })

  test("tool events create work for a character that only just spawned", () => {
    const o = loadOffice()
    add(o, "a")
    event(o, "a", { type: "tool.execute.before", tool: "grep" })
    o.step(20)
    expect(o.agent("a")!.state).toBe("working")
  })
})

describe("coffee spots", () => {
  test("a spot is released when the character leaves the coffee machine and when it is removed", () => {
    const o = loadOffice()
    add(o, "a")
    event(o, "a", busy)
    o.step(15)
    event(o, "a", idle)
    o.step(30)
    expect(o.reservedCoffeeSpots().length).toBeLessThanOrEqual(1)
    o.msg({ type: "instance.removed", instanceId: "a" })
    o.step(30)
    expect(o.reservedCoffeeSpots()).toEqual([])
  })
})

describe("idle life", () => {
  test("an idle character does several different things over time", () => {
    const o = loadOffice()
    add(o, "a")
    const seen = new Set<string>()
    for (let i = 0; i < 1200; i++) {
      o.step(0.5)
      const a = o.agent("a")!
      seen.add(a.restAction ? `rest:${a.restAction}` : a.state)
    }
    expect(seen.has("coffee")).toBe(true)
    expect(seen.has("rest_area")).toBe(true)
    expect([...seen].filter((s) => s.startsWith("rest:")).length).toBeGreaterThan(0)
    expect(seen.has("walking")).toBe(true)
  })
})

// Review m1 / m12: labels and untrusted input.
describe("labels and untrusted messages", () => {
  test("wrapLabel: word wrap, ellipsis when cut, exact fit, empty, huge single word", () => {
    const o = loadOffice()
    expect(o.wrapLabel("Fix login", 100, 2)).toEqual(["Fix login"])
    expect(o.wrapLabel("Investigating psinetron-opencode-visualizer plugin failure", 100, 2).at(-1)).toMatch(/…$/)
    expect(o.wrapLabel("a".repeat(16), 96, 2)).toEqual(["a".repeat(16)]) // exactly at the width
    expect(o.wrapLabel("", 100, 2)).toEqual([])
    expect(o.wrapLabel("   ", 100, 2)).toEqual([])
    const huge = o.wrapLabel("x".repeat(5000), 100, 2)
    expect(huge.length).toBeLessThanOrEqual(2)
    expect(huge.at(-1)).toMatch(/…$/)
  })

  test("wrapLabel never splits a word with an inserted space unless the word itself is too long", () => {
    const o = loadOffice()
    const lines = o.wrapLabel("short words only here", 60, 3)
    expect(lines.join(" ")).toBe("short words only here")
  })

  test("non-string titles and cwd from a misbehaving client cannot break labels", () => {
    const o = loadOffice()
    o.msg({ type: "instance.added", instanceId: "a", cwd: { evil: 1 }, skin: "person1", title: 42 })
    o.msg({ type: "instance.title", instanceId: "a", title: { x: 1 } })
    expect(typeof o.agent("a")!.title).toBe("string")
    expect(typeof o.agent("a")!.cwd).toBe("string")
    expect(() => o.wrapLabel(o.agent("a")!.title || o.agent("a")!.cwd, 100, 2)).not.toThrow()
  })
})

describe("error animation (review m6)", () => {
  test("an error plays out before the character is sent off, instead of being cut short by the idle that follows", () => {
    const o = loadOffice()
    add(o, "a", { skin: "person1" }) // person1 has an error animation
    event(o, "a", busy)
    o.step(15)
    expect(o.agent("a")!.state).toBe("working")
    event(o, "a", { type: "session.error" })
    event(o, "a", idle) // V2 sends both for a failed run
    expect(o.agent("a")!.state).toBe("error") // not yet standing
    o.step(0.1)
    expect(o.agent("a")!.animKey).toBe("error")
    o.step(3)
    expect(["standing", "walking_to_coffee", "coffee", "walking"]).toContain(o.agent("a")!.state)
  })

  test("skins without an error animation go straight on", () => {
    const o = loadOffice()
    add(o, "a", { skin: "person2" })
    event(o, "a", busy)
    o.step(15)
    event(o, "a", { type: "session.error" })
    event(o, "a", idle)
    o.step(3)
    expect(["working", "error"]).not.toContain(o.agent("a")!.state)
  })
})

describe("re-adding a character that is leaving, at every stage (review M3)", () => {
  for (const [name, seconds] of [["just removed", 0.1], ["walking out", 1.5], ["fading", 3], ["almost gone", 4.5]] as const) {
    test(`instance.added while it is ${name} (${seconds}s after removal) restores a fully visible character`, () => {
      const o = loadOffice(() => 0.5)
      add(o, "a")
      o.step(5)
      o.msg({ type: "instance.removed", instanceId: "a" })
      o.step(seconds)
      add(o, "a")
      o.step(20)
      const a = o.agent("a")
      expect(a).toBeDefined()
      expect(a!.opacity).toBe(1)
      expect(a!.leaving).toBe(false)
      expect(["exiting", "walking_to_exit"]).not.toContain(a!.state)
    })
  }

  test("a late busy event on a leaving character leaves it leaving, not half-invisible at a desk", () => {
    const o = loadOffice()
    add(o, "a")
    o.step(5)
    o.msg({ type: "instance.removed", instanceId: "a" })
    o.step(2)
    event(o, "a", busy)
    o.step(40)
    expect(o.agent("a")).toBeUndefined() // it left
  })
})

// ── second review ────────────────────────────────────────────────────────────
describe("state.sync revives leaving characters (review N1)", () => {
  test("after the server was away long enough for everyone to be sent home, a fresh state.sync brings them back", () => {
    const o = loadOffice()
    add(o, "a"); add(o, "b")
    event(o, "a", busy)
    o.step(15)
    // frontend disconnect timer fired: everyone is sent home
    o.msg({ type: "state.sync", instances: [] })
    o.step(1)
    expect(o.agent("a")!.leaving).toBe(true)
    // new server announces the live sessions
    o.msg({ type: "state.sync", instances: [{ instanceId: "a", cwd: "/p", skin: "person1", title: "A", active: true }, { instanceId: "b", cwd: "/p", skin: "person2", title: "B", active: false }] })
    o.step(25)
    expect(o.agent("a")).toBeDefined()
    expect(o.agent("a")!.leaving).toBe(false)
    expect(o.agent("a")!.opacity).toBe(1)
    expect(o.agent("a")!.state).toBe("working") // active:true -> back to work
    expect(o.agent("b")).toBeDefined()
    expect(o.agent("b")!.leaving).toBe(false)
  })
})

describe("work after an interrupted run (review N3)", () => {
  test("a tool.execute.after that arrives after the run ended does not send the character back to work", () => {
    const o = loadOffice()
    add(o, "a")
    event(o, "a", busy)
    o.step(15)
    event(o, "a", idle)
    o.step(15)
    expect(["coffee", "walking_to_coffee"]).toContain(o.agent("a")!.state)
    event(o, "a", { type: "tool.execute.after", tool: "bash" }) // the interrupted tool reports in late
    o.step(5)
    expect(o.agent("a")!.state).not.toBe("working")
    expect(o.agent("a")!.state).not.toBe("walking_to_desk")
  })
  test("a tool.execute.before still starts work", () => {
    const o = loadOffice()
    add(o, "a")
    o.step(5)
    event(o, "a", { type: "tool.execute.before", tool: "grep" })
    o.step(15)
    expect(o.agent("a")!.state).toBe("working")
  })
})

describe("finishAfterError is cancelled by new work (review N4)", () => {
  test("busy during the error animation keeps the character at its desk", () => {
    const o = loadOffice()
    add(o, "a", { skin: "person1" })
    event(o, "a", busy)
    o.step(15)
    event(o, "a", { type: "session.error" })
    event(o, "a", idle)
    expect(o.agent("a")!.finishAfterError).toBe(true)
    event(o, "a", busy) // retried / next turn
    o.step(5)
    expect(o.agent("a")!.state).toBe("working")
  })
})

describe("working sessions are not stuck behind idle characters (review N6)", () => {
  const fill = (o: ReturnType<typeof loadOffice>) => {
    for (const id of ["a", "b", "c", "d", "e"]) add(o, id)
    o.step(8)
  }
  test("a waiting session that becomes busy makes an idle character leave, and is the next one admitted", () => {
    const o = loadOffice()
    fill(o)
    add(o, "idle-waiter") // waits first
    add(o, "busy-waiter")
    event(o, "busy-waiter", busy)
    o.step(30)
    expect(o.agent("busy-waiter")).toBeDefined()
    expect(o.agent("idle-waiter")).toBeUndefined() // still waiting: it is not busy
    expect(o.agents().length).toBe(5)
  })
  test("characters that are working are never evicted for a waiting session", () => {
    const o = loadOffice()
    fill(o)
    for (const id of ["a", "b", "c", "d", "e"]) event(o, id, busy)
    o.step(20)
    add(o, "w"); event(o, "w", busy)
    o.step(30)
    expect(o.agent("w")).toBeUndefined()
    expect(o.agents().filter((x) => x.leaving)).toEqual([])
  })
  test("the waiting list is bounded", () => {
    const o = loadOffice()
    fill(o)
    for (let i = 0; i < 500; i++) add(o, `w${i}`)
    expect(o.run("waiting.size")).toBeLessThanOrEqual(50)
  })
})
