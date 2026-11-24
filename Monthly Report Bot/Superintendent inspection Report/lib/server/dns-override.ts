// Optional DNS servers for MongoDB connection-string lookups (mongodb+srv:// SRV and TXT records), as in the Emissions
// app (EMISSIONS_DNS_SERVERS). Set SIR_DNS_SERVERS=8.8.8.8 (comma-separated IPs) when the network's resolver does not
// answer SRV queries (the office network). It changes Node's resolver for this process only, not the computer's DNS.

import { getServers, setServers } from "node:dns"
import { isIP } from "node:net"

export function applyDnsOverride(value: string | undefined = process.env.SIR_DNS_SERVERS): string[] {
  const servers = (value ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
  if (servers.length === 0) return getServers()
  const invalid = servers.filter((s) => isIP(s) === 0)
  if (invalid.length) throw new Error(`SIR_DNS_SERVERS must list IP addresses; not valid: ${invalid.join(", ")}`)
  setServers(servers)
  return servers
}
