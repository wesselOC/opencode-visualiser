// Guards against shipping a package whose entry point imports a file that is not published (it would load fine in a
// checkout and fail on install, on both OpenCode 1.x and 2.x).
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { dirname, join, relative, resolve } from "path"

const root = resolve(import.meta.dir, "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"))

const published = (rel: string) => (pkg.files as string[]).some((f) => (f.endsWith("/") ? rel.startsWith(f) : rel === f))
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]))

describe("published package", () => {
  test("every relative import of a published source file resolves to a published file", () => {
    const sources = [...(pkg.files as string[]).flatMap((f) => (f.endsWith("/") ? walk(join(root, f)) : [join(root, f)]))].filter((f) => /\.(ts|js)$/.test(f))
    expect(sources.length).toBeGreaterThan(0)
    const missing: string[] = []
    for (const file of sources) {
      for (const m of readFileSync(file, "utf-8").matchAll(/(?:import|export)\s[^;"']*?\sfrom\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)) {
        const spec = m[1] ?? m[2]
        const base = resolve(dirname(file), spec)
        const target = [base, `${base}.ts`, `${base}.js`, join(base, "index.ts")].find((c) => existsSync(c) && statSync(c).isFile())
        const rel = target ? relative(root, target) : undefined
        if (!rel || !published(rel)) missing.push(`${relative(root, file)} imports ${spec} -> ${rel ?? "NOT FOUND"}`)
      }
    }
    expect(missing).toEqual([])
  })

  test("the page's script tags point at published files", () => {
    const html = readFileSync(join(root, "visualizer/index.html"), "utf-8")
    for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) expect(published(`visualizer/${m[1]}`)).toBe(true)
  })

  test("entry points exist", () => {
    for (const e of Object.values(pkg.exports as Record<string, string>)) expect(existsSync(join(root, e))).toBe(true)
  })
})
