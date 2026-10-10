// 通用 MCP 调用器: node scripts/call.mjs <toolName> '<jsonArgs>' [--brief]
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function token() {
  const env = readFileSync(join(ROOT, '.env'), 'utf8')
  const t = env.split('\n').find((l) => l.trim() && !l.startsWith('#'))
  if (!t) throw new Error('.env 中未找到 Token')
  return t.trim()
}

let sessionId = null

async function rpc(method, params) {
  const headers = {
    Authorization: `Bearer ${token()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId

  const res = await fetch('https://mcp.mcd.cn', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  })

  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid

  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`)

  const payload =
    text.startsWith('event:') || text.startsWith('data:')
      ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
      : text

  if (!payload) return { result: {} }
  return JSON.parse(payload)
}

// MCP 返回的 text 里包了一层 "## Original Response" + JSON，需拆出真实 body
export function unwrap(res) {
  const sc = res?.result?.structuredContent
  if (sc) return sc
  const text = res?.result?.content?.[0]?.text
  if (!text) return null
  const idx = text.indexOf('## Original Response')
  const body = idx >= 0 ? text.slice(idx).split('\n').slice(1).join('\n').trim() : text
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

async function main() {
  const [, , toolName, argsJson] = process.argv
  if (!toolName) {
    console.error('用法: node scripts/call.mjs <toolName> \'<jsonArgs>\'')
    process.exit(1)
  }

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcd-nutri-opt', version: '0.1.0' },
  })
  await rpc('notifications/initialized', {})

  const args = argsJson ? JSON.parse(argsJson) : {}
  const res = await rpc('tools/call', { name: toolName, arguments: args })
  const body = unwrap(res)

  writeFileSync(join(ROOT, `probe-${toolName}.json`), JSON.stringify(body, null, 2), 'utf8')

  const s = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  console.log(s.length > 6000 ? s.slice(0, 6000) + `\n...[截断，完整见 probe-${toolName}.json]` : s)
}

main().catch((e) => {
  console.error('ERROR:', e.message)
  process.exit(1)
})
