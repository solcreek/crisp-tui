if (!process.argv.includes("--read-only") || process.env.CRISPCTL_READ_ONLY !== "1" || process.env.CRISPCTL_KEY !== "fake-secret" || process.env.CRISPCTL_TIER !== "website") {
  console.error(JSON.stringify({ message: "Read-only credentials were not propagated" }))
  process.exit(1)
}
console.log(JSON.stringify([{ session_id: "session_fixture" }]))
