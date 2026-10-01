#!/usr/bin/env node
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { constants } from "node:os"

const require = createRequire(import.meta.url)
const pkg = require("../package.json")
const platformPackage = `crisp-tui-${process.platform}-${process.arch}`
try {
  if (!Object.hasOwn(pkg.optionalDependencies, platformPackage)) {
    throw new Error(`Unsupported platform: ${process.platform}/${process.arch}. crisp-tui supports macOS and Linux on x64 and arm64.`)
  }
  if (process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime) {
    throw new Error("This crisp-tui package requires glibc on Linux; musl/Alpine is not supported yet.")
  }
  let executable
  try {
    const installed = require(`${platformPackage}/package.json`)
    if (installed.version !== pkg.version) throw new Error("Version mismatch")
    executable = require.resolve(`${platformPackage}/bin/crisp-tui`)
  } catch {
    throw new Error(`Missing ${platformPackage}@${pkg.version}. Reinstall crisp-tui with optional dependencies enabled (npm install --include=optional crisp-tui@${pkg.version}).`)
  }
  const child = spawn(executable, process.argv.slice(2), {
    stdio: "inherit",
    env: { ...process.env, CRISP_TUI_NODE: process.execPath, CRISP_TUI_CRISPCTL: require.resolve("crispctl/dist/index.js") },
  })
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"]
  const handlers = signals.map(signal => { const handler = () => child.kill(signal); process.on(signal, handler); return handler })
  const cleanup = () => signals.forEach((signal, i) => process.off(signal, handlers[i]))
  child.once("error", () => {
    cleanup()
    console.error(JSON.stringify({ ok: false, error: "Could not start the crisp-tui executable. Reinstall the package and check executable permissions." }))
    process.exitCode = 1
  })
  child.once("exit", (code, signal) => {
    cleanup()
    process.exitCode = code ?? (128 + (constants.signals[signal] || 1))
  })
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Could not start crisp-tui" }))
  process.exitCode = 1
}
