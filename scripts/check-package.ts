import { strict as assert } from "node:assert"
import { join } from "node:path"
import pkg from "../package.json"

for (const [name, version] of Object.entries(pkg.optionalDependencies)) {
  const platform = name.replace(/^crisp-tui-/, "")
  const manifest = await Bun.file(join(import.meta.dir, "../packages", platform, "package.json")).json()
  assert.equal(name, manifest.name)
  assert.equal(version, pkg.version, `${name} dependency version must match the launcher`)
  assert.equal(manifest.version, pkg.version, `${name} version must match the launcher`)
  assert.equal(platform, `${manifest.os[0]}-${manifest.cpu[0]}`)
}
