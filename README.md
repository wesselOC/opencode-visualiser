# 👾 psinetron-opencode-visualizer

[![MIT License](https://img.shields.io/github/license/psinetron/opencode-visualiser)](https://github.com/psinetron/opencode-visualiser/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/psinetron/opencode-visualiser.svg)](https://github.com/psinetron/opencode-visualiser/stargazers)
[![NPM Version](https://img.shields.io/npm/v/psinetron-opencode-visualizer.svg)](https://www.npmjs.com/package/psinetron-opencode-visualizer)

**Turning raw OpenCode terminal logs into cozy 2D pixel office chaos.** Watch your agents work, idle, and celebrate success in a bustling virtual office.

---

## 🔥 Witness the Chaos

<img src="images/cover.png" width="100%" alt="OpenCode Visualizer" />

<!--
THIS IS THE MOST IMPORTANT PART FOR HYPE.
When you create your video-demo for X.com (MP4), convert it to a small GIF (e.g., using CapCut or online converters like ezgif) and place it here.

For example, uncomment the line below when you have a GIF in your repo:

<img src="visualizer-demo.gif" width="100%" alt="OpenCode Visualizer Demo" />

*Placeholder for the awesome video demo you are going to record. It should show the JSON logs in the terminal transforming into the pixel art office.*
-->

---

## ✨ Features

- **Real-time Visualization:** Watch your OpenCode agents move around their office as they execute tools, search files, and write code.
- **Cozy Pixel Art Aesthetic:** A calming, gamified view of complex AI orchestration.
- **Multi-Agent Support:** Visualizes multiple agents (Explore, Scout, etc.) simultaneously in the same shared office space.
- **Customization (Skins):** Each character gets a skin automatically; pin one per project with `.opencode/viz-skin.json`.
- **Unique Agent Animations:** Each of the 5 characters has its own set of unique idle, walk, work, and reaction animations.
- **Zero Friction Launch:** No dependencies to install — runs on the Bun runtime bundled with OpenCode. Launches a cross-platform, isolated Chrome "app" window using native OS calls. No heavy Electron needed.

---

## 🚀 Installation

No prerequisites — OpenCode ships with the Bun runtime, which handles plugin installation and execution automatically. You do **not** need to install Bun separately.

### Via CLI (recommended)

```sh
opencode plugin psinetron-opencode-visualizer
```

This installs the plugin from npm and registers it in your project's `opencode.json`. Add `--global` (or `-g`) to install it across all projects, or `--force` (or `-f`) to replace an existing version.

## Via OpenCode UI

1. Press `Control+P` (`Ctrl+P` on Windows/Linux) to open the command palette
2. Select **Install plugin**
3. Enter the package name: `psinetron-opencode-visualizer`

OpenCode will install the plugin and automatically add it to your project's `opencode.json`.

### Manual configuration

Add the plugin name to your OpenCode config. The key differs between OpenCode major versions:

| OpenCode | Config file | Key |
|----------|-------------|-----|
| 2.x | `opencode.json` / `opencode.jsonc` | `plugins` |
| 1.x (1.16+) | `opencode.json` | `plugin` |

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["psinetron-opencode-visualizer"]
}
```

For OpenCode 1.x use `"plugin"` instead of `"plugins"`. OpenCode downloads and caches the package from npm automatically on next startup.

### From local files (development)

If you've cloned this repo and want to run from source, point the plugin entry at your clone:

```json
// OpenCode 2.x — the entry must be the directory containing package.json
{ "plugins": ["/path/to/opencode-visualiser"] }

// OpenCode 1.x — point at the entry file
{ "plugin": ["/path/to/opencode-visualiser/index.ts"] }
```

Alternatively, copy `index.ts`, `core.ts` and the `visualizer/` folder into `.opencode/plugins/` — OpenCode auto-loads plugins placed there.

> **Note:** OpenCode 2.x rejects plugins that only implement the 1.x API ("Plugin must export a default definition with an id and an effect or setup function"). Versions of this package before 1.1.0 are 1.x-only; upgrade with `opencode plugin psinetron-opencode-visualizer --force`.

### After installation

Start (or restart) OpenCode. The plugin spins up a local server on `http://localhost:5173` and opens a Chrome app window automatically. If the browser doesn't open, visit the URL manually.

Every **chat session** gets its own pixel-art character, labelled at its desk with the session's title (so two chats in the same project, or a subagent's session, are two characters). A character appears when its session starts working, walks to a desk while it works, and goes for coffee when it finishes. Idle characters don't stand still: they leave the coffee machine, wander the rest area, scratch and yawn. A character walks out when its session is deleted or has been quiet for 10 minutes (a session that is still working is never removed for being quiet).

The office has five desks and five skins, so at most five characters are shown; further sessions wait in line and walk in as others leave.

If the instance hosting the server is closed, a surviving instance picks up the server role automatically — no interruption. Characters are decoration only: nothing here can affect your OpenCode session.

---

## 🔄 Updating

To update to the latest version, first try reinstalling with the `--force` flag:

```sh
opencode plugin psinetron-opencode-visualizer --force
```

If the old version still persists after that, OpenCode's package cache is stale. Clear it manually and restart:

```sh
rm -rf ~/.cache/opencode/packages/psinetron-opencode-visualizer
rm -rf ~/.cache/opencode/packages/psinetron-opencode-visualizer@latest
```

On Windows (PowerShell):

```powershell
Remove-Item -Recurse -Force ~\.cache\opencode\packages\psinetron-opencode-visualizer
Remove-Item -Recurse -Force ~\.cache\opencode\packages\psinetron-opencode-visualizer@latest
```

Then restart OpenCode — it will re-download the latest version from npm on startup.

---

## 🎨 Customization (Skins)

Skins are assigned automatically and the office makes sure characters look different. To pin a skin for every session in a project, create `.opencode/viz-skin.json` yourself:

```json
{ "skin": "person3" }
```

The plugin only ever reads this file; it never writes into your project.

Available skins: `person1`, `person2`, `person3`, `person4`, `person5`.

---

## Support the project

If plugin helps streamline your workflow, consider supporting the project. There are several ways you can help:

**1. Give it a Star**
The easiest way to support EchoesVault is to click the **Star** 🌟 button at the top of this repository. It helps more developers discover the tool and encourages further development.

**2. Direct Sponsorship**
Click the **Sponsor** button at the top of this repository (next to the Star button) to open the sponsorship dialog and choose how you'd like to support the development directly.

**3. OpenCode GO Subscription**
EchoesVault is built on top of [OpenCode](https://opencode.ai/go?ref=EZW07YHVTG). By subscribing to **OpenCode GO**, you unlock unlimited agent usage. Using [this referral link](https://opencode.ai/go?ref=EZW07YHVTG) gives you a $5 discount on your subscription and helps fund my work at the same time.

---

## 📜 License

MIT License. See LICENSE for more information. Built, not bought, by psinetron.

---

## 🧪 Development

```sh
npm install
npm test        # bun test — unit tests for the shared core and both adapters
```

`index.ts` default-exports one object that serves both plugin APIs: OpenCode 2.x reads `id` + `setup(ctx)`, OpenCode 1.x calls `server()`. Each adapter only translates its version's events and hooks into calls on the shared `core.ts` (server connection, leader election, skins). See the [V1→V2 plugin migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1).

> `tui.ts` (the `/visualizer` command) currently targets the OpenCode 1.x TUI plugin API only.

**Architecture.** `core.ts` holds one connection per process (shared by every project the OpenCode 2.x service hosts), the session registry and event de-duplication. `visualizer/ocv-server.ts` is the WebSocket hub, `visualizer/office.js` is the DOM-free simulation (state machine, idle life, message handling), and `visualizer/index.html` only renders. `shared.ts` holds what the plugin and server must agree on (port, protocol version, busy/idle rules); it is the only file both import.

**Environment variables** (mainly for development and tests): `OCV_PORT` changes the port (default `5173`), `OCV_NO_BROWSER=1` stops the server from opening a browser window, and `OCV_SHUTDOWN_MS` changes how long an unused standalone server lingers.

**Protocol.** Plugin → server: `hello`, `register {instanceId, cwd, skin, title, active}`, `title`, `event`, `unregister`. Server → frontend: `state.sync`, `instance.added`, `instance.title`, `instance.event`, `instance.removed`. Servers older than protocol 2 don't answer `hello`; the plugin then falls back to a single shared character so mixed versions keep working.
