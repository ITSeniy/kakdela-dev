import { describe, expect, it, vi } from 'vitest'

vi.mock('./redis.js', () => ({ redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') } }))

import { extractPreviewableUrls, isBlockedIp } from './link-preview.js'

describe('isBlockedIp — SSRF блок-лист', () => {
  it('блокирует loopback и приватные IPv4', () => {
    for (const ip of ['127.0.0.1', '0.0.0.0', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true)
    }
  })

  it('блокирует loopback/ULA/link-local и mapped IPv6', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true)
    }
  })

  it('блокирует IPv6 transition-диапазоны (NAT64/6to4/Teredo)', () => {
    for (const ip of [
      '64:ff9b::7f00:1',        // NAT64 well-known, внутри 127.0.0.1
      '64:ff9b:1::1',           // NAT64 local-use
      '2002:7f00:1::1',         // 6to4, внутри 127.0.0.1
      '2001::1',                // Teredo (сжатая форма)
      '2001:0:0:0:0:0:0:1',     // Teredo (развёрнутая форма)
      '2001:0000:4136:e378:8000:63bf:3fff:fdd2', // Teredo-адрес целиком
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true)
    }
  })

  it('не путает Teredo с обычными глобальными 2001::/16', () => {
    for (const ip of ['2001:4860:4860::8888', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(isBlockedIp(ip), ip).toBe(false)
    }
  })

  it('пропускает публичные адреса', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(isBlockedIp(ip), ip).toBe(false)
    }
  })

  it('мусор считает заблокированным (fail-closed)', () => {
    for (const ip of ['::ffff:7f00:1', '::ffff:a00:1', '[::1]', '2001:db8::1', '192.0.2.1', 'fe80::1%eth0']) {
      expect(isBlockedIp(ip), ip).toBe(true)
    }
    for (const ip of ['not-an-ip', '', '999.999.999.999', '10']) {
      expect(isBlockedIp(ip), ip).toBe(true)
    }
  })
})

describe('extractPreviewableUrls', () => {
  it('находит ссылки и обрезает хвостовую пунктуацию', () => {
    expect(extractPreviewableUrls('смотри https://example.com/page, круто!')).toEqual(['https://example.com/page'])
  })

  it('игнорирует markdown-картинки (гифки/скриншоты)', () => {
    expect(extractPreviewableUrls('![](https://media.giphy.com/x.gif)')).toEqual([])
  })

  it('уважает подавление <https://…>', () => {
    expect(extractPreviewableUrls('тихо <https://example.com>')).toEqual([])
  })

  it('пропускает ссылки внутри кода', () => {
    expect(extractPreviewableUrls('`https://example.com` и ```\nhttps://b.com\n```')).toEqual([])
  })

  it('дедуп и лимит в 3 ссылки', () => {
    const text = 'https://a.com https://a.com https://b.com https://c.com https://d.com'
    expect(extractPreviewableUrls(text)).toEqual(['https://a.com', 'https://b.com', 'https://c.com'])
  })
})
