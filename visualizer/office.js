// office.js — the visualizer's simulation: constants, path finding, agent state machine, idle life and server messages.
// No DOM access, so it can run in the browser (loaded by index.html as a classic script) and in tests (see test/office.test.ts).
// Rendering, asset loading and the WebSocket live in index.html.
// ============================================================
// CONSTANTS
// ============================================================
const W = 640, H = 480

const SPAWN_POINT = { x: 330, y: 120 }
const REST_AREA = { x1: 240, y1: 190, x2: 400, y2: 230 }

const DESKS = [
  { deskX: 125, deskY: 220, agentX: 145, agentY: 175 },
  { deskX: 125, deskY: 325, agentX: 145, agentY: 280 },
  { deskX: 125, deskY: 430, agentX: 145, agentY: 395 },
  { deskX: 325, deskY: 325, agentX: 345, agentY: 280 },
  { deskX: 325, deskY: 430, agentX: 345, agentY: 395 },
]

const COFFEE_TABLES = [
  { x: 550, y: 250 },
  { x: 550, y: 420 },
]

const COFFEE_SPOTS = [
  { x: 500, y: 210 }, { x: 545, y: 195 }, { x: 590, y: 210 },
  { x: 500, y: 365 }, { x: 545, y: 350 }, { x: 590, y: 365 },
]

const WALK_SPEED = 80 // px/sec

const VERT_CORRIDORS = [220, 450]

const SKINS = {
  person1: {
    base: "person1/person1",
    anims: {
      idle:    { folder: "idle", frames: 4, dirs: ["south"] },
      walk:    { folder: "walk", frames: 6, dirs: ["south","east","north","west"] },
      sit:     { folder: "sit", frames: 7, dirs: ["south"] },
      work:    { folder: "work", frames: 6, dirs: ["south"] },
      error:   { folder: "error", frames: 6, dirs: ["south"] },
      coffee:  { folder: "coffee", frames: 6, dirs: ["south"] },
      scratch: { folder: "scratch", frames: 6, dirs: ["south"] },
      yawn:    { folder: "yawn", frames: 7, dirs: ["south"] },
    }
  },
  person2: {
    base: "person2/person2",
    anims: {
      idle:    { folder: "idle", frames: 4, dirs: ["south"] },
      walk:    { folder: "walk", frames: 6, dirs: ["south","east","north","west"] },
      sit:     { folder: "sit", frames: 7, dirs: ["south"] },
      work:    { folder: "work", frames: 8, dirs: ["south"] },
      coffee:  { folder: "coffee", frames: 7, dirs: ["south"] },
      scratch: { folder: "scratch", frames: 6, dirs: ["south"] },
      yawn:    { folder: "yawn", frames: 13, dirs: ["south"] },
    }
  },
  person3: {
    base: "person3/person3",
    anims: {
      idle:    { folder: "idle", frames: 4, dirs: ["south"] },
      walk:    { folder: "walk", frames: 6, dirs: ["south","east","north","west"] },
      sit:     { folder: "sit", frames: 7, dirs: ["south"] },
      work:    { folder: "work", frames: 6, dirs: ["south"] },
      coffee:  { folder: "coffee", frames: 13, dirs: ["south"] },
      scratch: { folder: "scratch", frames: 6, dirs: ["south"] },
      yawn:    { folder: "yawn", frames: 12, dirs: ["south"] },
    }
  },
  person4: {
    base: "person4/person4",
    anims: {
      idle:    { folder: "idle", frames: 4, dirs: ["south"] },
      walk:    { folder: "walk", frames: 6, dirs: ["south","east","north","west"] },
      sit:     { folder: "sit", frames: 7, dirs: ["south"] },
      work:    { folder: "work", frames: 6, dirs: ["south"] },
      coffee:  { folder: "coffee", frames: 9, dirs: ["south"] },
      scratch: { folder: "scratch", frames: 7, dirs: ["south"] },
      yawn:    { folder: "yawn", frames: 8, dirs: ["south"] },
    }
  },
  person5: {
    base: "person5/person5",
    anims: {
      idle:    { folder: "idle", frames: 4, dirs: ["south"] },
      walk:    { folder: "walk", frames: 6, dirs: ["south","east","north","west"] },
      sit:     { folder: "sit", frames: 7, dirs: ["south"] },
      work:    { folder: "work", frames: 7, dirs: ["south"] },
      coffee:  { folder: "coffee", frames: 11, dirs: ["south"] },
      scratch: { folder: "scratch", frames: 12, dirs: ["south"] },
      yawn:    { folder: "yawn", frames: 9, dirs: ["south"] },
    }
  },
}

const WORK_ACTIONS = ["scratch", "yawn"]

const ANIM_FPS = 6

// ============================================================
// PATH FINDING
// ============================================================
function findPath(fromX, fromY, toX, toY, viaRestArea = false, direct = false) {
  if (!direct && !viaRestArea) {
    const inRest = fromX >= REST_AREA.x1 - 30 && fromX <= REST_AREA.x2 + 30
                && fromY >= REST_AREA.y1 - 20 && fromY <= REST_AREA.y2 + 20
    if (inRest) direct = true
  }
  if (direct) {
    return [{x:fromX, y:fromY}, {x:toX, y:toY}]
  }
  const path = [{x:fromX, y:fromY}]
  let cx = fromX, cy = fromY

  function goH(tx) { if (Math.abs(tx - cx) > 1) { path.push({x:tx, y:cy}); cx = tx } }
  function goV(ty) { if (Math.abs(ty - cy) > 1) { path.push({x:cx, y:ty}); cy = ty } }

  if (viaRestArea) {
    const corridor = VERT_CORRIDORS.reduce((a,b) => Math.abs(a-cx) < Math.abs(b-cx) ? a : b)
    goH(corridor)
    const restY = REST_AREA.y1 + Math.random() * (REST_AREA.y2 - REST_AREA.y1)
    goV(restY)
    const targetCorridor = toX > 450 ? 450 : 220
    goH(targetCorridor)
    goV(toY)
    goH(toX)
  } else {
    const corridor = VERT_CORRIDORS.reduce((a,b) => Math.abs(a-cx) < Math.abs(b-cx) ? a : b)
    if (Math.abs(toX - cx) > 30 || Math.abs(toY - cy) > 30) {
      goH(corridor)
      goV(toY)
      goH(toX)
    } else {
      goH(toX)
      goV(toY)
    }
  }

  if (cx !== toX || cy !== toY) {
    path.push({x:toX, y:toY})
  }
  return path
}

function randomRestPos() {
  const pad = 20
  return {
    x: REST_AREA.x1 + pad + Math.random() * (REST_AREA.x2 - REST_AREA.x1 - pad*2),
    y: REST_AREA.y1 + pad + Math.random() * (REST_AREA.y2 - REST_AREA.y1 - pad*2),
  }
}

// ============================================================
// AGENT
// ============================================================
let agentIdCounter = 0
const agents = []
const reservedCoffeeSpots = new Set()
const MAX_AGENTS = 5
const MAX_WAITING = 50
let idleCounter = 0 // ordinal of when a character last became idle; the smallest has been idle the longest
// Sessions that registered while the office was full, in arrival order. They are admitted as characters leave.
const waiting = new Map()

// Everything below that comes from the server is untrusted: only bounded strings are accepted.
const str = (v, max = 300) => (typeof v === "string" ? v.slice(0, max) : "")

function getFreeDeskIndex() {
  const used = new Set(agents.filter(a => a.deskIndex >= 0).map(a => a.deskIndex))
  for (let i = 0; i < DESKS.length; i++) {
    if (!used.has(i)) return i
  }
  return -1
}

function getFreeCoffeeSpot() {
  for (let i = 0; i < COFFEE_SPOTS.length; i++) {
    if (!reservedCoffeeSpots.has(i)) return i
  }
  return -1
}

function createAgent(instanceId, cwd, skin, title, active) {
  cwd = str(cwd); title = str(title); skin = str(skin, 20)
  const existing = agents.find(a => a.instanceId === instanceId)
  if (existing) {
    if (title) existing.title = title
    if (existing.leaving) reviveAgent(existing)
    return existing
  }
  if (agents.length >= MAX_AGENTS) {
    if (!waiting.has(instanceId) && waiting.size >= MAX_WAITING) waiting.delete(waiting.keys().next().value)
    waiting.set(instanceId, { cwd, skin, title, active: !!active })
    evictIdleForBusyWaiting()
    return null
  }
  waiting.delete(instanceId)
  const id = agentIdCounter++
  const skinIds = Object.keys(SKINS)
  const usedSkins = new Set(agents.map(a => a.skinId))
  if (skin && SKINS[skin] && !usedSkins.has(skin)) {
    // Provided skin is valid and free — use it
  } else {
    skin = skinIds.find(s => !usedSkins.has(s))
    if (!skin) {
      skin = skinIds[Math.floor(Math.random() * skinIds.length)]
    }
  }
  localStorage.setItem('viz-last-skin', skin)
  const a = {
    id, instanceId, cwd, title,
    skinId: skin,
    state: "spawning",
    x: SPAWN_POINT.x, y: SPAWN_POINT.y,
    opacity: 0,
    animKey: "idle",
    animFrame: 0, animTimer: 0,
    direction: "south",
    path: [],
    pathIndex: 0,
    pathProgress: 0,
    deskIndex: -1,
    coffeeSpot: -1,
    spawnOrder: agents.length,
    coffeeHoldTimer: 0,
    exitingAfterRest: false,
    leaving: false,
    pendingWork: !!active, // joined mid-run: go straight to work once they have walked in
    finishAfterError: false,
    idleSince: ++idleCounter,
    workActionTimer: 3 + Math.random() * 7,
    workActionAnim: null,
    workActionReverse: false,
    workReverse: false,
    coffeeReverse: false,
    coffeeStay: 0,
    restTimer: 3 + Math.random() * 5,
    restAction: null,
    restReverse: false,
  }
  agents.push(a)
  console.log(`[viz] Agent ${id} spawning`)
  return a
}

// Brings a character back that was on its way out (its session registered again before it left the office).
function reviveAgent(a) {
  a.leaving = false
  a.exitingAfterRest = false
  if (a.state === "walking_to_exit" || a.state === "exiting") {
    const pos = randomRestPos()
    a.state = "walking"
    a.goalState = "rest_area"
    a.path = findPath(a.x, a.y, pos.x, pos.y)
    a.pathIndex = 0
    a.pathProgress = 0
  }
}

// Fills free slots from the waiting list (called whenever a character has left).
function admitWaiting() {
  // Sessions that are working are shown before idle ones; otherwise arrival order.
  const queue = [...waiting].sort((x, y) => Number(y[1].active) - Number(x[1].active))
  for (const [instanceId, w] of queue) {
    if (agents.length >= MAX_AGENTS) break
    waiting.delete(instanceId)
    createAgent(instanceId, w.cwd, w.skin, w.title, w.active)
  }
}

// A session that is working while the office is full of idle characters must not wait up to 10 minutes: send the one
// that has been idle longest home. Characters that are working (or about to) are never evicted.
function evictIdleForBusyWaiting() {
  if (agents.length < MAX_AGENTS) return
  if (![...waiting.values()].some(w => w.active)) return
  if (agents.some(a => a.leaving)) return // a slot is already on its way
  const idle = agents.filter(a => !a.leaving && !a.pendingWork && a.deskIndex < 0 && ["rest_area", "coffee", "walking_to_coffee", "standing", "walking"].includes(a.state))
  if (!idle.length) return
  idle.sort((x, y) => x.idleSince - y.idleSince)
  removeAgent(idle[0].instanceId)
}

function clearRestAction(a) {
  a.restAction = null
  a.restReverse = false
}

function removeAgent(instanceId) {
  waiting.delete(instanceId)
  const a = agents.find(a => a.instanceId === instanceId)
  if (!a || a.leaving) return // already on its way out: a repeated remove (e.g. state.sync) must not restart the walk
  a.leaving = true
  a.pendingWork = false
  a.finishAfterError = false
  clearRestAction(a)
  // Release resources
  if (a.coffeeSpot >= 0) reservedCoffeeSpots.delete(a.coffeeSpot)
  a.deskIndex = -1
  a.coffeeSpot = -1
  // Walk to rest area first, then exit
  const restPos = randomRestPos()
  a.state = "walking"
  a.goalState = "rest_area"
  a.exitingAfterRest = true
  a.path = findPath(a.x, a.y, restPos.x, restPos.y)
  a.pathIndex = 0
  a.pathProgress = 0
}

// ---- Idle life: nobody stands still forever --------------------------------
const COFFEE_STAY_RANGE = [15, 35]   // seconds spent at the coffee machine before leaving
const REST_PAUSE_RANGE = [3, 8]     // seconds between idle actions in the rest area
const rand = (lo, hi) => lo + Math.random() * (hi - lo)

function leaveCoffee(a) {
  clearRestAction(a)
  if (a.coffeeSpot >= 0) { reservedCoffeeSpots.delete(a.coffeeSpot); a.coffeeSpot = -1 }
  a.restTimer = rand(...REST_PAUSE_RANGE)
  const pos = randomRestPos()
  a.state = "walking"
  a.goalState = "rest_area"
  a.path = findPath(a.x, a.y, pos.x, pos.y)
  a.pathIndex = 0
  a.pathProgress = 0
}

// Called when an agent in the rest area has been idle long enough: scratch, yawn, wander, or go for coffee.
function pickRestAction(a) {
  a.restTimer = rand(...REST_PAUSE_RANGE)
  const r = Math.random()
  if (r < 0.2 && getFreeCoffeeSpot() >= 0) {
    assignAgentCoffee(a)
  } else if (r < 0.6) {
    const pos = randomRestPos()
    a.state = "walking"
    a.goalState = "rest_area"
    a.path = findPath(a.x, a.y, pos.x, pos.y, false, true)
    a.pathIndex = 0
    a.pathProgress = 0
  } else {
    const options = WORK_ACTIONS.filter(k => SKINS[a.skinId].anims[k])
    if (!options.length) return
    a.restAction = options[Math.floor(Math.random() * options.length)]
    a.restReverse = false
    a.animFrame = 0
    a.animTimer = 0
  }
}

// Plays a one-shot idle action forward, then back, then returns to the idle loop.
function stepRestAction(a, dt) {
  const def = SKINS[a.skinId].anims[a.restAction]
  a.animKey = a.restAction
  a.direction = "south"
  a.animTimer += dt
  while (a.animTimer >= 1 / ANIM_FPS) {
    a.animTimer -= 1 / ANIM_FPS
    if (a.restReverse) {
      a.animFrame--
      if (a.animFrame < 0) {
        a.restAction = null
        a.restReverse = false
        a.animKey = "idle"
        a.animFrame = 0
        a.animTimer = 0
        a.restTimer = rand(...REST_PAUSE_RANGE)
        return
      }
    } else {
      a.animFrame++
      if (a.animFrame >= def.frames) {
        a.restReverse = true
        a.animFrame = Math.max(0, def.frames - 2)
      }
    }
  }
}

function assignAgentWork(a) {
  if (a.leaving) return // on its way out: the session is gone
  a.finishAfterError = false // the run continues: do not send the character off when the error animation ends
  if (a.state === "working" || a.state === "sitting" || a.state === "error") return
  clearRestAction(a)
  // Still fading in at the door (a session registers and starts work in the same instant): start once it has walked in.
  if (a.state === "spawning") { a.pendingWork = true; return }
  if (a.state === "walking_to_desk") return

  // If still walking to rest area, defer work assignment
  if (a.state === "walking" && a.goalState === "rest_area") {
    a.pendingWork = true
    return
  }

  // Release coffee spot if any
  if (a.coffeeSpot >= 0) { reservedCoffeeSpots.delete(a.coffeeSpot); a.coffeeSpot = -1 }

  // Get a desk
  if (a.deskIndex < 0) {
    a.deskIndex = getFreeDeskIndex()
  }
  if (a.deskIndex < 0) return // no free desks

  const desk = DESKS[a.deskIndex]
  const destX = a.skinId !== "person1" ? desk.deskX : desk.agentX
  const destY = desk.agentY

  const fromRest = a.state === "rest_area"
  // Approach desk from the side: first go to offset point, then walk horizontally to desk
  const approachX = desk.deskX < 200 ? destX + 25 : destX - 25

  a.state = "walking_to_desk"
  a.path = findPath(a.x, a.y, approachX, destY, false, fromRest)
  a.path.push({ x: destX, y: destY })
  a.pathIndex = 0
  a.pathProgress = 0
  console.log(`[viz] Agent ${a.id} walking to desk ${a.deskIndex}`)
}

// The run ended: cancel work that was only queued, let an error animation play out, then send the character off.
function finishWork(a) {
  a.pendingWork = false
  if (a.leaving) return
  a.idleSince = ++idleCounter
  switch (a.state) {
    case "error":
      a.finishAfterError = true // the error animation finishes first
      break
    case "working":
    case "sitting":
      a.state = "standing"
      a.animFrame = SKINS[a.skinId].anims["sit"].frames - 1
      a.animTimer = 0
      break
    case "walking_to_desk": {
      a.deskIndex = -1
      const restPos = randomRestPos()
      a.state = "walking"
      a.goalState = "rest_area"
      a.path = findPath(a.x, a.y, restPos.x, restPos.y, false, true)
      a.pathIndex = 0
      a.pathProgress = 0
      break
    }
    default:
      // spawning, walking, rest_area, coffee, standing, exiting...: nothing to cancel or interrupt (idle life takes over)
      break
  }
}

function endError(a) {
  a.state = "working"
  if (a.finishAfterError) {
    a.finishAfterError = false
    finishWork(a)
  }
}

function assignAgentCoffee(a) {
  if (a.state === "coffee" || a.state === "walking_to_coffee") return

  const spotIdx = getFreeCoffeeSpot()
  if (spotIdx < 0) return // no free spots

  reservedCoffeeSpots.add(spotIdx)
  a.coffeeSpot = spotIdx

  const spot = COFFEE_SPOTS[spotIdx]
  const viaRest = a.deskIndex >= 0 && a.deskIndex <= 2
  const fromRest = a.state === "rest_area"

  a.state = "walking_to_coffee"
  a.path = findPath(a.x, a.y, spot.x, spot.y, viaRest, fromRest)
  a.pathIndex = 0
  a.pathProgress = 0
  console.log(`[viz] Agent ${a.id} walking to coffee spot ${spotIdx}`)
}

function updateAgent(a, dt) {
  // A character removed (or revived) while still fading in must not stay half-transparent.
  if (a.opacity < 1 && a.state !== "spawning" && a.state !== "exiting") a.opacity = Math.min(1, a.opacity + dt * 2)
  // State transitions
  switch (a.state) {
    case "spawning":
      a.opacity = Math.min(1, a.opacity + dt * 2)
      if (a.opacity >= 1) {
        const pos = randomRestPos()
        a.state = "walking"
        a.path = [{x:a.x, y:a.y}, pos]
        a.pathIndex = 0
        a.pathProgress = 0
        a.goalState = "rest_area"
        a.opacity = 1
      }
      break

    case "rest_area":
      if (a.restAction) {
        stepRestAction(a, dt)
      } else {
        a.animKey = "idle"
        a.direction = "south"
        a.restTimer -= dt
        if (a.restTimer <= 0) pickRestAction(a)
      }
      break

    case "walking":
    case "walking_to_desk":
    case "walking_to_coffee":
    case "walking_to_exit":
      a.animKey = "walk"
      break

    case "sitting":
      a.animKey = "sit"
      a.direction = "south"
      a.animTimer += dt
      while (a.animTimer >= 1 / ANIM_FPS) {
        a.animTimer -= 1 / ANIM_FPS
        a.animFrame++
        if (a.animFrame >= SKINS[a.skinId].anims["sit"].frames) {
          a.animFrame = 0; a.animTimer = 0
          a.state = "working"
        }
      }
      break

    case "working":
      if (a.workActionAnim) {
        a.animKey = a.workActionAnim
        a.direction = "south"
        a.animTimer += dt
        while (a.animTimer >= 1 / ANIM_FPS) {
          a.animTimer -= 1 / ANIM_FPS
          if (a.workActionReverse) {
            a.animFrame--
            if (a.animFrame < 0) {
              a.animFrame = 0
              a.animTimer = 0
              a.animKey = "work"
              a.workActionAnim = null
              a.workActionReverse = false
              a.workActionTimer = 3 + Math.random() * 7
              break
            }
          } else {
            a.animFrame++
            if (a.animFrame >= SKINS[a.skinId].anims[a.workActionAnim].frames) {
              a.workActionReverse = true
              a.animFrame = SKINS[a.skinId].anims[a.workActionAnim].frames - 2
              if (a.animFrame < 0) { a.animFrame = 0; a.workActionReverse = false }
              break
            }
          }
        }
      } else {
        a.workActionTimer -= dt
        if (a.workActionTimer <= 0) {
          a.workActionAnim = WORK_ACTIONS[Math.floor(Math.random() * WORK_ACTIONS.length)]
          a.animFrame = 0
          a.animTimer = 0
          a.workActionReverse = false
          a.animKey = a.workActionAnim
        } else {
          a.animKey = "work"
          a.direction = "south"
          const def = SKINS[a.skinId].anims["work"]
          a.animTimer += dt
          while (a.animTimer >= 1 / ANIM_FPS) {
            a.animTimer -= 1 / ANIM_FPS
            if (a.workReverse) {
              a.animFrame--
              if (a.animFrame < 0) { a.animFrame = 1; a.workReverse = false }
            } else {
              a.animFrame++
              if (a.animFrame >= def.frames) { a.animFrame = def.frames - 2; a.workReverse = true }
            }
          }
        }
      }
      break

    case "error":
      a.animKey = "error"
      a.direction = "south"
      const errDef = SKINS[a.skinId].anims["error"]
      if (!errDef) { endError(a); break }
      a.animTimer += dt
      while (a.animTimer >= 1 / ANIM_FPS) {
        a.animTimer -= 1 / ANIM_FPS
        a.animFrame++
        if (a.animFrame >= errDef.frames) {
          a.animFrame = 0; a.animTimer = 0
          endError(a)
          break
        }
      }
      break

    case "standing":
      a.animKey = "sit"
      a.direction = "south"
      a.animTimer += dt
      while (a.animTimer >= 1 / ANIM_FPS) {
        a.animTimer -= 1 / ANIM_FPS
        a.animFrame--
        if (a.animFrame < 0) {
          a.animFrame = 0; a.animTimer = 0
          // Release coffee spot reservation if we already have one
          // (it was reserved in assignAgentCoffee or in idle handler)
          if (a.coffeeSpot < 0) {
            const spotIdx = getFreeCoffeeSpot()
            if (spotIdx >= 0) {
              reservedCoffeeSpots.add(spotIdx)
              a.coffeeSpot = spotIdx
            }
          }
          if (a.coffeeSpot >= 0) {
            const spot = COFFEE_SPOTS[a.coffeeSpot]
            const viaRest = a.deskIndex >= 0 && a.deskIndex <= 2
            a.state = "walking_to_coffee"
            a.path = findPath(a.x, a.y, spot.x, spot.y, viaRest)
            a.pathIndex = 0; a.pathProgress = 0
          } else {
            a.state = "rest_area"
          }
        }
      }
      break

    case "coffee":
      a.animKey = "coffee"
      a.direction = "south"
      const coffeeDef = SKINS[a.skinId].anims["coffee"]
      a.coffeeStay -= dt
      if (a.coffeeStay <= 0) { leaveCoffee(a); break }
      if (a.coffeeHoldTimer > 0) {
        a.coffeeHoldTimer -= dt
        if (a.coffeeHoldTimer <= 0) {
          a.coffeeHoldTimer = 0
          a.animTimer = 0
        }
      } else {
        a.animTimer += dt
        while (a.animTimer >= 1 / ANIM_FPS) {
          a.animTimer -= 1 / ANIM_FPS
          if (a.coffeeReverse) {
            a.animFrame--
            if (a.animFrame < 0) {
              a.animFrame = 0
              a.coffeeReverse = false
              a.coffeeHoldTimer = 2.0
              a.animTimer = 0
              break
            }
          } else {
            a.animFrame++
            if (a.animFrame >= coffeeDef.frames) {
              a.coffeeReverse = true
              a.animFrame = coffeeDef.frames - 2
              if (a.animFrame < 0) { a.animFrame = 0; a.coffeeReverse = false }
              break
            }
          }
        }
      }
      break

    case "exiting":
      a.opacity = Math.max(0, a.opacity - dt * 2)
      if (a.opacity <= 0) {
        const idx = agents.indexOf(a)
        if (idx >= 0) agents.splice(idx, 1)
        if (a.coffeeSpot >= 0) reservedCoffeeSpots.delete(a.coffeeSpot)
        admitWaiting()
      }
      break
  }

  // Movement along path
  while (a.path && a.path.length > 1 && a.pathIndex < a.path.length - 1) {
    const from = a.path[a.pathIndex]
    const to = a.path[a.pathIndex + 1]
    const dx = to.x - from.x
    const dy = to.y - from.y
    const segLen = Math.sqrt(dx*dx + dy*dy)
    if (segLen < 0.1) {
      a.x = to.x
      a.y = to.y
      a.pathIndex++
      a.pathProgress = 0
      continue
    }
    a.pathProgress += (WALK_SPEED * dt) / segLen
    if (a.pathProgress >= 1) {
      a.x = to.x
      a.y = to.y
      a.pathIndex++
      a.pathProgress = 0
      if (a.pathIndex >= a.path.length - 1) {
        const goal = a.path[a.pathIndex]
        a.x = goal.x
        a.y = goal.y
        a.path = []
        switch (a.state) {
          case "walking": if (a.goalState === "rest_area") {
            if (a.exitingAfterRest) {
              a.exitingAfterRest = false
              a.state = "walking_to_exit"
              a.path = findPath(a.x, a.y, SPAWN_POINT.x, SPAWN_POINT.y, false, true)
              a.pathIndex = 0
              a.pathProgress = 0
            } else {
              a.state = "rest_area"
              if (a.pendingWork) { a.pendingWork = false; assignAgentWork(a) }
            }
          } else {
            a.state = "rest_area"
          } break
          case "walking_to_desk": a.state = "sitting"; a.animFrame = 0; a.animTimer = 0; break
          case "walking_to_coffee": a.state = "coffee"; a.animFrame = 0; a.animTimer = 0; a.coffeeHoldTimer = 2.0; a.coffeeReverse = false; a.coffeeStay = rand(...COFFEE_STAY_RANGE); break
          case "walking_to_exit": a.state = "exiting"; break
        }
        break
      }
      continue
    }
    a.x = from.x + dx * a.pathProgress
    a.y = from.y + dy * a.pathProgress
    if (Math.abs(dx) > Math.abs(dy)) {
      a.direction = dx > 0 ? "east" : "west"
    } else {
      a.direction = dy > 0 ? "south" : "north"
    }
    a.animKey = "walk"
    break
  }

  // Animation frame (skip for sit/stand/error/coffee/working — they manage their own frames)
  if (a.state !== "sitting" && a.state !== "standing" && a.state !== "error" && a.state !== "coffee" && a.state !== "working" && !(a.state === "rest_area" && a.restAction)) {
    const def = SKINS[a.skinId].anims[a.animKey]
    if (def) {
      a.animTimer += dt
      while (a.animTimer >= 1 / ANIM_FPS) {
        a.animTimer -= 1 / ANIM_FPS
        a.animFrame = (a.animFrame + 1) % def.frames
      }
    }
  }

  // Cap opacity
  a.opacity = Math.max(0, Math.min(1, a.opacity))

}

// Word-wraps text into at most maxLines lines of maxWidth px (as reported by `measure`), ending the last line with "…"
// if text was cut. Input is capped, so the cost per label is bounded.
function wrapLabel(text, maxWidth, maxLines, measure) {
  if (typeof text !== "string") return []
  const fits = (t) => measure(t) <= maxWidth
  // Tokens are words; a word longer than a line is split into continuation chunks (joined without a space).
  const tokens = []
  for (const word of text.slice(0, 160).split(/\s+/).filter(Boolean)) {
    let rest = Array.from(word) // code points, so surrogate pairs are never split
    let first = true
    while (rest.length > 1 && !fits(rest.join(""))) {
      let n = rest.length - 1
      while (n > 1 && !fits(rest.slice(0, n).join(""))) n--
      tokens.push({ t: rest.slice(0, n).join(""), cont: !first })
      rest = rest.slice(n)
      first = false
    }
    tokens.push({ t: rest.join(""), cont: !first })
  }
  const lines = []
  let cur = ""
  let used = 0
  for (const tok of tokens) {
    const test = cur ? cur + (tok.cont ? "" : " ") + tok.t : tok.t
    if (fits(test)) { cur = test; used++; continue }
    if (lines.length + 1 >= maxLines) break // cur is the last line we have room for
    lines.push(cur)
    cur = tok.t
    used++
  }
  if (cur) lines.push(cur)
  if (used < tokens.length && lines.length) {
    let last = Array.from(lines[lines.length - 1])
    while (last.length > 1 && !fits(last.join("") + "…")) last.pop()
    lines[lines.length - 1] = last.join("").trimEnd() + "…"
  }
  return lines
}

// Applies one message from the visualizer server to the office. Pure state changes; no DOM.
function applyMessage(data) {
  if (typeof data !== "object" || data === null) return
  const instanceId = typeof data.instanceId === "string" ? data.instanceId : ""
  switch (data.type) {
    case "state.sync": {
      const instances = Array.isArray(data.instances) ? data.instances.filter(i => i && typeof i.instanceId === "string") : []
      const syncIds = new Set(instances.map(i => i.instanceId))
      for (const a of [...agents]) {
        if (!syncIds.has(a.instanceId)) removeAgent(a.instanceId)
      }
      for (const id of [...waiting.keys()]) if (!syncIds.has(id)) waiting.delete(id)
      for (const inst of instances) {
        const existing = agents.find(a => a.instanceId === inst.instanceId)
        if (!existing) createAgent(inst.instanceId, inst.cwd, inst.skin, inst.title, inst.active)
        else {
          if (inst.title) existing.title = str(inst.title)
          if (existing.leaving) reviveAgent(existing) // e.g. the server was away long enough for everyone to be sent home
          if (inst.active) assignAgentWork(existing)
        }
      }
      break
    }
    case "instance.added":
      if (instanceId) createAgent(instanceId, data.cwd, data.skin, data.title)
      break
    case "instance.title": {
      const ag = agents.find(a => a.instanceId === instanceId)
      if (ag) ag.title = str(data.title)
      else if (waiting.has(instanceId)) waiting.get(instanceId).title = str(data.title)
      break
    }
    case "instance.removed":
      removeAgent(instanceId)
      break
    case "instance.event": {
      const evt = data.event
      if (typeof evt !== "object" || evt === null) break
      const a = agents.find(a => a.instanceId === instanceId)
      if (!a) {
        // Keep the busy flag of a session that is waiting for a slot, so it starts at work when admitted.
        const w = waiting.get(instanceId)
        if (w) {
          if (evt.type === "session.idle" || evt.type === "session.error") w.active = false
          else if (evt.type === "session.status") w.active = evt.status?.type === "busy" || evt.status?.type === "retry" || evt.status === "busy"
          else if (evt.type === "tool.execute.before") w.active = true
          if (w.active) evictIdleForBusyWaiting()
        }
        break
      }
      switch (evt.type) {
        case "session.status": {
          const st = evt.status?.type || evt.status
          if (st === "busy" || st === "retry") assignAgentWork(a)
          else finishWork(a)
          break
        }
        case "session.idle":
          finishWork(a)
          break
        case "session.error":
          if (a.state === "working") {
            a.state = "error"
            a.animFrame = 0
            a.animTimer = 0
          }
          break
        case "tool.execute.before": // not .after: a tool can report in late, after its run was interrupted
          if (a.state === "rest_area" || a.state === "coffee" || a.state === "walking_to_coffee" || a.state === "walking" || a.state === "spawning") {
            if (a.coffeeSpot >= 0) { reservedCoffeeSpots.delete(a.coffeeSpot); a.coffeeSpot = -1 }
            assignAgentWork(a)
          }
          break
      }
      break
    }
  }
}
