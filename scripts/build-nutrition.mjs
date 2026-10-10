/**
 * 从麦当劳 MCP 拉取营养数据，构建内置数据集。
 *
 * data/nutrition.json 已存在时默认跳过网络请求（用 --force 强制刷新）。
 * 注意：不依赖任何临时文件，可独立运行。
 *
 * 用法:
 *   node scripts/build-nutrition.mjs          # 有缓存则跳过并校验
 *   node scripts/build-nutrition.mjs --force  # 强制重新拉取
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseNutrition } from '../src/nutrition.mjs'
import * as mcp from '../src/mcp-client.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'data/nutrition.json')
const force = process.argv.includes('--force')

async function fetchRaw(token) {
  await mcp.connect(token)
  const body = await mcp.callTool('list-nutrition-foods', {}, token)
  if (!body?.success) throw new Error(body?.message || '拉取失败')
  return { raw: body.data, datetime: body.datetime }
}

// 关键条目校验：数值错了会直接导致求解器给出错误建议
const EXPECT = {
  巨无霸: { energyKcal: 513, protein: 27 },
  麦辣鸡腿汉堡: { energyKcal: 485, protein: 24 },
  板烧鸡腿堡: { energyKcal: 391, protein: 23 },
  中薯条: { energyKcal: 289, protein: 4 },
  无糖可口可乐中杯: { energyKcal: 0, protein: 0 },
}

function validate(items) {
  let failed = 0
  for (const [name, want] of Object.entries(EXPECT)) {
    const got = items.find((i) => i.productName === name)
    if (!got) {
      console.error(`  x 缺失: ${name}`)
      failed++
    } else if (got.energyKcal !== want.energyKcal || got.protein !== want.protein) {
      console.error(
        `  x 数值不符: ${name} 期望 ${want.energyKcal}kcal/${want.protein}g，实际 ${got.energyKcal}kcal/${got.protein}g`,
      )
      failed++
    } else {
      console.log(`  ✓ ${name} = ${got.energyKcal}kcal / 蛋白 ${got.protein}g`)
    }
  }

  // 回归：description 混入商品名时不得错位
  const trap = items.find((i) => i.productName === '纯悦')
  if (trap && trap.nutritionDescription === '能量约清水1杯') {
    console.log(`  ✓ description 混坑样本解析正确: 纯悦 → "${trap.nutritionDescription}"`)
  } else {
    console.error('  x description 混坑解析错误:', JSON.stringify(trap))
    failed++
  }
  return failed
}

async function main() {
  if (!force && existsSync(OUT)) {
    const cur = JSON.parse(readFileSync(OUT, 'utf8'))
    console.log(`data/nutrition.json 已存在（${cur._meta?.total} 条，${cur._meta?.fetchedAt}），跳过拉取。`)
    console.log('如需刷新请加 --force\n')
    console.log('关键条目校验：')
    const failed = validate(cur.items)
    if (failed > 0) {
      console.error(`\n${failed} 项校验失败，请用 --force 重新拉取数据`)
      process.exit(1)
    }
    console.log('\n校验通过')
    return
  }

  const token = mcp.loadToken()
  if (!token) {
    console.error('未找到 MCD_MCP_TOKEN。请在 .env 写入 Token，或先用现有 data/nutrition.json。')
    process.exit(1)
  }

  console.log('从麦当劳 MCP 拉取营养数据…')
  const fetched = await fetchRaw(token)
  const items = parseNutrition(fetched.raw)

  console.log(`\n解析出 ${items.length} 条`)
  console.log('关键条目校验：')
  const failed = validate(items)
  if (failed > 0) {
    console.error(`\n${failed} 项校验失败，已中止写入`)
    process.exit(1)
  }

  // 去重（MCP 原始数据有重复项，如 小杯玉米杯 / 纯牛奶 各出现两次）
  const seen = new Map()
  for (const it of items) if (!seen.has(it.productName)) seen.set(it.productName, it)
  const deduped = [...seen.values()]

  const withDensity = deduped.map((i) => ({
    ...i,
    // 每100kcal 的蛋白克数，同热量下越高越"划算"
    proteinDensity: Number(((i.protein / (i.energyKcal || 1)) * 100).toFixed(3)),
  }))

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        _meta: {
          source: "list-nutrition-foods (McDonald's MCP Server)",
          fetchedAt: fetched.datetime,
          total: withDensity.length,
          note: '数据版权归麦当劳中国所有，本仓库仅用于技术演示',
        },
        items: withDensity,
      },
      null,
      2,
    ),
    'utf8',
  )

  console.log(
    `\n去重后 ${withDensity.length} 条（原始 ${items.length} 条，重复 ${items.length - withDensity.length} 条）`,
  )
  console.log('已写入 data/nutrition.json')
}

main().catch((e) => {
  console.error('ERROR:', e.message)
  process.exit(1)
})