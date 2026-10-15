import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

/** The real WebSocket, captured before any test replaces the global with a fake. */
export const RealWebSocket = globalThis.WebSocket

/** Minimal stand-in for the global WebSocket that records everything sent and lets tests drive it. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly OPEN = 1
  /** Set to false to simulate a server that predates per-session characters (it never answers `hello`). */
  static ack = true
  readyState = 0
  sent: any[] = []
  hellos = 0
  closed = false
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((m: unknown) => void) | null = null

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      if (this.closed) return
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    })
  }
  send(data: string) {
    const message = JSON.parse(data)
    if (message.type === "hello") {
      this.hellos++
      if (FakeWebSocket.ack) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "hello.ack", protocol: 2 }) }))
      return
    }
    this.sent.push(message)
  }
  close() {
    this.closed = true
    this.readyState = 3
    queueMicrotask(() => this.onclose?.())
  }
}

export function installFakeWebSocket() {
  FakeWebSocket.instances = []
  FakeWebSocket.ack = true
  ;(globalThis as any).WebSocket = FakeWebSocket
}

export const tempDir = () => mkdtempSync(join(tmpdir(), "ocv-test-"))
export const registered = (ws: FakeWebSocket) => ws.sent.filter((m) => m.type === "register")
export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
