import { command, createClient, runner } from "./crispctl"
import type { WebsiteCredentials } from "./onepassword"
import { readOnlyClient } from "./readonly"
import { listen } from "./rtm"

export function credentialEnvironment(credentials: WebsiteCredentials, base = process.env): NodeJS.ProcessEnv {
  return { ...base, CRISPCTL_IDENTIFIER: credentials.identifier, CRISPCTL_KEY: credentials.key,
    CRISPCTL_WEBSITE_ID: credentials.websiteId, CRISPCTL_TIER: "website", CRISPCTL_READ_ONLY: "1" }
}

/** A 1Password session uses the exact same CLI transport as profile-based sessions. */
export function credentialClient(credentials: WebsiteCredentials, prefix = command()) {
  const env = credentialEnvironment(credentials)
  const flags = ["--read-only", "--website", credentials.websiteId]
  const invoke = runner(prefix, flags, env)
  const commands: string[] = []
  const client = readOnlyClient(createClient(args => {
    commands.push(args.slice(0, 2).join(" "))
    return invoke(args)
  }, `website ${credentials.websiteId}`, listen(prefix, flags, env)))
  return { client, commands }
}
