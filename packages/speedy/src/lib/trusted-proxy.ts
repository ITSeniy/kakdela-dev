import ipaddr from 'ipaddr.js'

/** Only the immediate reverse proxies belong here; never client networks. */
export function parseTrustedProxy(value: string): false | string[] {
  if (value === 'false' || value === 'auto' || !value.trim()) return false
  if (value === 'true') throw new Error('TRUST_PROXY=true is unsafe; configure explicit proxy IPs/CIDRs')
  const proxies = value.split(',').map((item) => item.trim())
  for (const proxy of proxies) {
    try {
      if (proxy.includes('/')) {
        const [, prefix] = ipaddr.parseCIDR(proxy)
        if (prefix === 0) throw new Error('blanket trust')
      } else if (!ipaddr.isValid(proxy)) throw new Error('invalid IP')
    } catch { throw new Error('TRUST_PROXY must be a comma-separated IP/CIDR allowlist, without /0') }
  }
  return proxies
}
