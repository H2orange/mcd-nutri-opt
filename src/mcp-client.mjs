/**
 * 麦当劳 MCP 客户端
 *
 * 关键设计：菜单查询的调用次数是 O(商品数 × 2)，必须做磁盘缓存。
 * 缓存键为 storeCode + 场景，TTL 6 小时（营业时间变化不频繁）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MCP_URL = 'https://mcp.mcd.cn'
const CACHE_DIR = join(ROOT, 'cache')
const TTL_MS = 6 * 60 * 60 * 1000

let sessionId = null

export function loadToken() {
  const envPath = join(ROOT, '.env')
  if (!existsSync(envPath)) return process.env.MCD_MCP_TOKEN || null
  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((l) => l.trim() && !l.startsWith('#'))
  return line ? line.trim() : process.env.MCD_MCP_TOKEN || null
}

async function rpc(method, params, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
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
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`)
  if (res.status === 202 || !text.trim()) return { result: {} }

  const payload =
    text.startsWith('event:') || text.startsWith('data:')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('')
      : text

  return payload ? JSON.parse(payload) : { result: {} }
}

/** MCP 返回的 text 里包了一层说明，需拆出真实业务 body */
function unwrap(res) {
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

export async function connect(token) {
  await rpc(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcd-nutri-opt', version: '0.1.0' },
    },
    token,
  )
  await rpc('notifications/initialized', {}, token)
  return true
}

export async function callTool(name, args, token) {
  const res = await rpc('tools/call', { name, arguments: args }, token)
  return unwrap(res)
}

// ---------- 缓存 ----------

function cachePath(key) {
  return join(CACHE_DIR, `${key}.json`)
}

export function cacheGet(key) {
  const p = cachePath(key)
  if (!existsSync(p)) return null
  try {
    const obj = JSON.parse(readFileSync(p, 'utf8'))
    if (Date.now() - obj.at > TTL_MS) return null
    return obj.value
  } catch {
    return null
  }
}

export function cacheSet(key, value) {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cachePath(key), JSON.stringify({ at: Date.now(), value }, null, 2), 'utf8')
}

// ---------- 业务封装 ----------

/**
 * 查找门店
 * 注意：searchType=1 是"我的收藏"，新账号为空，必须用 searchType=2 + city + keyword
 */
export async function findStores({ city, keyword, beType = 1 }, token) {
  const key = `stores-${beType}-${city}-${keyword}`
  const hit = cacheGet(key)
  if (hit) return hit

  const body = await callTool(
    'query-nearby-stores',
    { beType, searchType: 2, city, keyword },
    token,
  )
  if (!body?.success) throw new Error(body?.message || '门店查询失败')

  const stores = (body.data ?? []).map((s) => ({
    storeCode: s.storeCode,
    storeName: s.storeName,
    address: s.address,
    distance: s.distance,
    businessStatus: s.businessStatus,
    hours: `${s.businessStartTime}-${s.businessEndTime}`,
  }))
  cacheSet(key, stores)
  return stores
}

/** 拉取门店菜单分类结构（只有 code + tags，无名称无价格） */
export async function fetchMenu(storeCode, { orderType = 1, beType = 1 } = {}, token) {
  const key = `menu-${storeCode}-${orderType}-${beType}`
  const hit = cacheGet(key)
  if (hit) return hit

  const body = await callTool(
    'query-meals',
    { storeCode, orderType, beType },
    token,
  )
  if (!body?.success) throw new Error(body?.message || '菜单查询失败')

  const categories = (body.data?.categories ?? []).map((c) => ({
    name: c.name.replace(/\n/g, ' '),
    codes: [...new Set((c.meals ?? []).map((m) => m.code))],
    tags: Object.fromEntries((c.meals ?? []).map((m) => [m.code, m.tags ?? []])),
  }))
  cacheSet(key, categories)
  return categories
}

/**
 * 逐个查详情拿名称。
 * 必须保留 rounds 字段——套餐拆解依赖它，默认搭配由 choices[].isDefault 标记。
 */
export async function fetchDetails(storeCode, codes, { orderType = 1, beType = 1 } = {}, token) {
  const out = []
  for (const code of codes) {
    const key = `detail-${storeCode}-${code}-${orderType}-${beType}`
    let hit = cacheGet(key)
    if (!hit) {
      const body = await callTool(
        'query-meal-detail',
        { storeCode, orderType, beType, code },
        token,
      )
      hit = body?.success ? body.data : null
      if (hit) cacheSet(key, hit)
    }
    if (hit?.name) {
      out.push({
        code,
        name: hit.name,
        rounds: hit.rounds ?? [],
        supportModify: !!hit.supportModify,
      })
    }
  }
  return out
}

/** 探测真实到手价（单位：分 → 元） */
export async function fetchPrice(
  storeCode,
  items,
  { orderType = 1, beType = 1 } = {},
  token,
) {
  const body = await callTool(
    'calculate-price',
    { storeCode, orderType, beType, items, needTableware: false },
    token,
  )
  if (!body?.success) throw new Error(body?.message || '算价失败')
  return {
    priceYuan: (body.data.price ?? 0) / 100,
    originalYuan: (body.data.originalPrice ?? 0) / 100,
    discountYuan: (body.data.discount ?? 0) / 100,
    productList: body.data.productList ?? [],
  }
}

/**
 * 把整单优惠按比例分摊到各单品，得到单品真实成本。
 * 整单优惠（如满减）在多商品场景下没有官方分摊口径，
 * 这里采用"按原价比例"分摊，并把舍入余数补给金额最大的项，保证求和精确。
 */
export function allocateDiscount(productList, discountYuan) {
  const totalSub = productList.reduce((s, p) => s + (p.subtotal ?? 0), 0)
  if (!discountYuan || !totalSub) {
    return productList.map((p) => ({ ...p, netSubtotalYuan: (p.subtotal ?? 0) / 100 }))
  }

  // 最大金额的项承担舍入余数
  let biggestIdx = 0
  productList.forEach((p, i) => {
    if ((p.subtotal ?? 0) > (productList[biggestIdx].subtotal ?? 0)) biggestIdx = i
  })

  const out = []
  let allocated = 0

  productList.forEach((p, i) => {
    const gross = (p.subtotal ?? 0) / 100
    const share =
      i === biggestIdx
        ? Math.round((discountYuan - allocated) * 100) / 100
        : Math.round(discountYuan * ((p.subtotal ?? 0) / totalSub) * 100) / 100
    allocated = Math.round((allocated + share) * 100) / 100
    out.push({ ...p, grossSubtotalYuan: gross, netSubtotalYuan: Math.max(0, gross - share) })
  })

  return out
}
