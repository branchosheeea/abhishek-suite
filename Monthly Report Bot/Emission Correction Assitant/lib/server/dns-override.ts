// Optional DNS servers for MongoDB connection-string lookups (mongodb+srv:// SRV and TXT records).
// Set EMISSIONS_DNS_SERVERS=8.8.8.8 (comma-separated IPs) when the network's resolver does not answer SRV queries.
// It changes Node's resolver for this app's process only (dns.resolve*), not the computer's DNS settings.

import { getServers, setServers } from "node:dns"
import { isIP } from "node:net"

let applied: string | undefined

export function applyDnsOverride(value: string | undefined = process.env.EMISSIONS_DNS_SERVERS): string[] {
  const servers = (value ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
  if (servers.length === 0) return getServers()
  const invalid = servers.filter((s) => isIP(s) === 0)
  if (invalid.length) throw new Error(`EMISSIONS_DNS_SERVERS must list IP addresses; not valid: ${invalid.join(", ")}`)
  const key = servers.join(",")
  if (applied !== key) {
    setServers(servers)
    applied = key
  }
  return servers
}
