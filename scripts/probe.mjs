// MCP 探针：拉取麦当劳 MCP 的工具清单与关键工具的真实返回结构。
// 用法: node scripts/probe.mjs <toolName> [jsonArgs]
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MCP_URL = 'https://mcp.mcd.cn'

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

  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  })

  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid

  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`)

  // Streamable HTTP 可能返回 SSE 格式
  const payload = text.startsWith('event:') || text.startsWith('data:')
    ? text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('')
    : text

  // 通知类调用返回 202 空体，属正常情况
  if (!payload) return { result: {} }

  return JSON.parse(payload)
}

async function main() {
  const [, , toolName, argsJson] = process.argv

  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcd-nutri-opt-probe', version: '0.1.0' },
  })
  console.error('initialize ok:', JSON.stringify(init.result?.serverInfo ?? {}))

  await rpc('notifications/initialized', {})

  if (!toolName) {
    const list = await rpc('tools/list', {})
    const tools = list.result?.tools ?? []
    console.error(`\n共 ${tools.length} 个工具:\n`)
    for (const t of tools) {
      console.error(`- ${t.name}: ${(t.description ?? '').split('\n')[0].slice(0, 100)}`)
    }
    writeFileSync(join(ROOT, 'probe-tools.json'), JSON.stringify(tools, null, 2), 'utf8')
    console.error('\n完整 schema 已写入 probe-tools.json')
    return
  }

  const args = argsJson ? JSON.parse(argsJson) : {}
  console.error(`\n调用 ${toolName} ...`)
  const res = await rpc('tools/call', { name: toolName, arguments: args })
  writeFileSync(join(ROOT, `probe-${toolName}.json`), JSON.stringify(res, null, 2), 'utf8')
  console.error(`返回已写入 probe-${toolName}.json`)
  console.log(JSON.stringify(res, null, 2))
}

main().catch((e) => {
  console.error('ERROR:', e.message)
  process.exit(1)
})
