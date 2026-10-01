import { createHash } from "node:crypto"
import { join } from "node:path"
import pkg from "../package.json"

/** Test the actual npm dependency-selection path before publishing any packages. */
export async function packageRegistry(launcher: string, native: string, platform: string) {
  const manifests = new Map<string, Record<string, unknown>>([[pkg.name, pkg]])
  for (const name of Object.keys(pkg.optionalDependencies)) {
    manifests.set(name, await Bun.file(join(import.meta.dir, "../packages", name.replace(/^crisp-tui-/, ""), "package.json")).json())
  }
  const files = new Map([[pkg.name, launcher], [`crisp-tui-${platform}`, native]])
  const integrity = new Map<string, string>()
  for (const [name, file] of files) integrity.set(name, `sha512-${createHash("sha512").update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("base64")}`)
  const downloaded = new Set<string>()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), name = decodeURIComponent(url.pathname.slice(1))
    if (name.startsWith("tar/")) {
      const key = name.slice(4), file = files.get(key)
      downloaded.add(key)
      return file ? new Response(Bun.file(file)) : new Response("Wrong platform selected", { status: 404 })
    }
    const manifest = manifests.get(name)
    if (manifest) return Response.json({ name, "dist-tags": { latest: pkg.version }, versions: {
      [pkg.version]: { ...manifest, dist: { tarball: `${url.origin}/tar/${name}`, ...(integrity.has(name) ? { integrity: integrity.get(name) } : {}) } },
    } })
    // Dependencies such as crispctl still come from the public npm registry.
    return Response.redirect(`https://registry.npmjs.org${url.pathname}${url.search}`)
  } })
  return { url: server.url.href, downloaded, stop: () => server.stop(true) }
}
