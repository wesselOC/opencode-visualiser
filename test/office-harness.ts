// Loads visualizer/office.js (the simulation, no DOM) into an isolated vm context so the state machine can be driven
// deterministically: tests send server messages with `msg()` and advance time with `step()`.
import { readFileSync } from "fs"
import { join } from "path"
import vm from "vm"

export interface Agent {
  instanceId: string
  title: string
  state: string
  animKey: string
  opacity: number
  x: number
  y: number
  deskIndex: number
  coffeeSpot: number
  pendingWork?: boolean
  restAction: string | null
  [k: string]: any
}

export function loadOffice(random: () => number = Math.random) {
  const stored: Record<string, string> = {}
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    localStorage: { setItem: (k: string, v: string) => (stored[k] = v), getItem: (k: string) => stored[k] ?? null },
    Math: Object.assign(Object.create(Math), { random }),
  })
  vm.runInContext(readFileSync(join(import.meta.dir, "../visualizer/office.js"), "utf-8"), context, { filename: "office.js" })
  const run = <T = any>(code: string): T => vm.runInContext(code, context)
  return {
    run,
    agents: (): Agent[] => run("agents"),
    agent: (id: string): Agent | undefined => run("agents").find((a: Agent) => a.instanceId === id),
    reservedCoffeeSpots: (): number[] => run("[...reservedCoffeeSpots]"),
    /** Delivers a server message exactly as index.html's socket handler does. */
    msg: (data: Record<string, unknown>) => run(`applyMessage(${JSON.stringify(data)})`),
    /** Advances the simulation by `seconds` in 50ms frames (same per-agent update order as the page's loop). */
    step(seconds: number, dt = 0.05) {
      for (let t = 0; t < seconds; t += dt) run(`for (let i = agents.length - 1; i >= 0; i--) updateAgent(agents[i], ${dt})`)
    },
    wrapLabel: (text: string, width: number, lines: number, perChar = 6) => run(`wrapLabel(${JSON.stringify(text)}, ${width}, ${lines}, (t) => t.length * ${perChar})`),
  }
}

export const busy = { type: "session.status", status: { type: "busy" } }
export const idle = { type: "session.idle" }
