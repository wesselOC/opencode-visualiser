// Shared by the plugin core and the visualizer server (and nothing else). Keep it dependency-free.

/**
 * `OCV_PORT` exists so tests (and anyone running a second visualizer) can avoid the default port without
 * touching a visualizer that is already running.
 */
export const SERVER_PORT = Number(process.env.OCV_PORT) || 5173

/**
 * Wire protocol version. 2 = one character per session (`unregister`, `title`, `active` and `registered.protocol`).
 * Servers older than 2 ignore those messages, which the plugin detects from the `registered` reply.
 */
export const PROTOCOL_VERSION = 2

type StatusLike = { type?: string } | string | undefined

/** True for the statuses that mean a session is working. Accepts both `{type}` objects and plain strings. */
export function isActiveStatus(status: unknown): boolean {
  const type = (status as StatusLike & { type?: string })?.type ?? status
  return type === "busy" || type === "retry"
}

/**
 * Whether a session is working after `event`, given whether it was working before. Mirrors what the frontend animates.
 * Tool events deliberately change nothing: a tool can report in after its run was interrupted, and that must not make a
 * finished session look busy again. (A session first seen through a tool call is marked busy when it is created.)
 */
export function nextActive(current: boolean, event: { type?: string; status?: unknown } | undefined): boolean {
  if (!event) return current
  switch (event.type) {
    case "session.idle":
    case "session.error":
      return false
    case "session.status":
      return isActiveStatus(event.status)
    default:
      return current
  }
}
