import type { CrispClient } from "./types"

export const READ_ONLY_ERROR = "Read-only mode: replies, notes, state changes and mark-read are disabled"
export async function refuseWrite(): Promise<never> { throw new Error(READ_ONLY_ERROR) }

/** Enforce the capability boundary even for callers that bypass UI controls. */
export function readOnlyClient(client: CrispClient): CrispClient {
  return {
    label: client.label, readOnly: true,
    subscribe: client.subscribe,
    list: (page, query) => client.list(page, query),
    get: session => client.get(session),
    messages: session => client.messages(session),
    reply: refuseWrite, state: refuseWrite, read: refuseWrite,
  }
}
