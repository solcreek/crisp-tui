import { resolve, relative } from "node:path"

const root = resolve(import.meta.dir, "..")
const report = await Bun.file(resolve(root, "coverage/lcov.info")).text()
const records = report.split("end_of_record").filter(record => /^SF:/m.test(record))
const covered = new Set<string>()
let lines = 0, hitLines = 0, functions = 0, hitFunctions = 0
for (const record of records) {
  const file = relative(root, resolve(root, /^SF:(.+)$/m.exec(record)![1]!))
  if (!file.startsWith("src/")) throw new Error(`Unexpected coverage input: ${file}`)
  covered.add(file)
  const count = (name: string) => {
    const match = new RegExp(`^${name}:(\\d+)$`, "m").exec(record)
    if (!match) throw new Error(`Missing ${name} in coverage for ${file}`)
    return Number(match[1])
  }
  lines += count("LF"); hitLines += count("LH")
  functions += count("FNF"); hitFunctions += count("FNH")
}
for await (const file of new Bun.Glob("src/**/*.{ts,tsx}").scan({ cwd: root })) {
  // This process wrapper is exercised by the source/binary/installed PTY tests.
  if (file !== "src/index.ts" && !covered.has(file)) throw new Error(`Source file missing from coverage: ${file}`)
}
if (!lines || !functions) throw new Error("Coverage report has no executable source")
const lineRatio = hitLines / lines, functionRatio = hitFunctions / functions
console.log(`Source coverage: ${(lineRatio * 100).toFixed(2)}% lines, ${(functionRatio * 100).toFixed(2)}% functions`)
if (lineRatio < 0.9 || functionRatio < 0.9) throw new Error("Overall source coverage must reach 90% for both lines and functions")
