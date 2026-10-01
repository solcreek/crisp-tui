import { chmod, copyFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { build } from "./build"
import "./check-package"

const root = join(import.meta.dir, "..")
const platform = `${process.platform}-${process.arch}`
const destination = join(root, "packages", platform)
if (!await Bun.file(join(destination, "package.json")).exists()) throw new Error(`Unsupported build platform: ${platform}`)
await build()
await mkdir(join(destination, "bin"), { recursive: true })
await copyFile(join(root, "dist", `crisp-tui-${platform}`), join(destination, "bin/crisp-tui"))
await chmod(join(destination, "bin/crisp-tui"), 0o755)
await copyFile(join(root, "LICENSE"), join(destination, "LICENSE"))
console.log(`Prepared npm platform package: crisp-tui-${platform}`)
