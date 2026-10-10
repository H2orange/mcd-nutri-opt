/**
 * 麦麦最优解 CLI
 *
 * 用法:
 *   npm run demo                                  # 离线演示，无需 Token
 *   npm run solve -- --budget 30 --kcal 800 --protein 25
 *   npm run solve -- --live --city 南京 --keyword 新街口 --budget 30
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Solver, proteinPerYuan } from './solver.mjs'
import { normalizeName } from './nutrition.mjs'
import { NutritionMatcher } from './matcher.mjs'
import * as mcp from './mcp-client.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadNutrition() {
  return JSON.parse(readFileSync(join(ROOT, 'data/nutrition.json'), 'utf8')).items
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) out[key] = true
      else {
        out[key] = next
        i++
      }
    } else out._.push(a)
  }
  return out
}

function constraintsFrom(args) {
  const c = {}
  if (args.budget) c.budget = Number(args.budget)
  if (args.kcal) c.maxKcal = Number(args.kcal)
  if (args.protein) c.minProtein = Number(args.protein)
  if (args.sodium) c.maxSodium = Number(args.sodium)
  if (args.maxitems) c.maxItems = Number(args.maxitems)
  if (args.exclude) c.exclude = String(args.exclude).split(',')
  if (args.only) c.includeKeywords = String(args.only).split(',')
  // --no-strict-slots 关闭品类槽位互斥（门店品类不足时使用）
  if (args['no-strict-slots']) c.strictSlots = false
  return c
}

/**
 * 离线模式：用内置营养数据 + 一份示例价格表。
 * 价格表来源为 2026-10 实测南京新百门店，标注为示例，不冒充实时价格。
 */
const SAMPLE_PRICES = {
  巨无霸: 22.5,
  麦辣鸡腿汉堡: 22.5,
  板烧鸡腿堡: 21.5,
  麦香鸡: 21.0,
  麦香鱼: 23.0,
  '双层吉士汉堡': 26.0,
  '不素之霸双层牛堡': 27.0,
  '双层深海鳕鱼堡': 26.5,
  培根蔬萃双层牛堡: 26.0,
  芝士双层安格斯厚牛堡: 45.0,
  原味板烧鸡腿麦满分: 15.0,
  猪柳蛋麦满分: 19.0,
  烟肉蛋麦满分: 16.0,
  双层猪柳蛋麦满分: 24.0,
  板烧鸡腿炒双蛋堡: 25.0,
  猪柳炒双蛋堡: 24.0,
  中薯条: 9.0,
  大薯条: 12.0,
  小薯条: 6.0,
  麦乐鸡5块: 19.0,
  麦乐鸡4块: 15.0,
  '麦辣鸡腿汉堡套餐': 25.0,
  '麦辣鸡腿汉堡+中薯条': 28.0,
  可乐中杯: 7.0,
  '无糖可口可乐中杯': 7.0,
  '大杯鲜萃咖啡': 10.0,
  '热美式中杯': 10.0,
  '冰美式小杯': 7.0,
  '优品豆浆小杯': 7.0,
  '纯牛奶（盒装）': 8.0,
  '冰牛奶小杯': 9.0,
  圆筒冰淇淋: 6.0,
  奥利奥麦旋风: 13.0,
  香芋派: 7.0,
  菠萝派: 7.0,
  脆薯饼: 7.0,
  '麦麦脆汁鸡-琵琶腿': 15.0,
  '薄皮焦香V翅': 13.0,
  麦麦趣鸡球: 13.0,
}

function buildOfflineItems(nutrition) {
  return nutrition
    .filter((n) => SAMPLE_PRICES[n.productName] !== undefined)
    .map((n) => ({
      code: `offline-${normalizeName(n.productName)}`,
      name: n.productName,
      price: SAMPLE_PRICES[n.productName],
      energyKcal: n.energyKcal,
      protein: n.protein,
      fat: n.fat,
      carbohydrate: n.carbohydrate,
      sodium: n.sodium,
    }))
}

function printResult(result, constraints, source) {
  const { best, pareto, stats, feasible } = result

  console.log('\n' + '='.repeat(58))
  console.log(`求解结果  (${source})`)
  console.log('='.repeat(58))
  console.log(
    `约束: 预算≤${constraints.budget ?? '∞'}元  热量≤${constraints.maxKcal ?? '∞'}kcal  ` +
      `蛋白≥${constraints.minProtein ?? 0}g  钠≤${constraints.maxSodium ?? '∞'}mg`,
  )
  console.log(
    `候选 ${stats.candidates} 项 / ${stats.groups} 个品类 → 枚举 ${stats.combos} 组合 → ` +
      `可行 ${stats.feasible} → 前沿 ${stats.front}，耗时 ${stats.ms}ms`,
  )
  console.log('-'.repeat(58))

  if (!feasible) {
    console.log('\n当前约束下无可行解。试试放宽预算或热量上限。\n')
    return
  }

  if (result.degraded) {
    console.log(`\n⚠ ${result.degraded.reason}`)
    console.log(`  （严格模式仅得 ${result.degraded.strictStats.feasible} 个可行解）`)
  }

  // 标注该结果来自哪种品类策略
  if (result.strategy) {
    console.log(
      `\n策略: ${result.strategy === 'strict' ? '严格品类去重（不重复品类，更符合直觉）' : '宽松模式（允许同品类叠加，性价比更优）'}`,
    )
  }

  const show = (c, title) => {
    console.log(`\n【${title}】`)
    console.log(`  合计 ${c.priceYuan} 元 | ${c.nutrition.energyKcal} kcal |蛋白 ${c.nutrition.protein} g`)
    console.log(`  脂肪 ${c.nutrition.fat} g | 碳水 ${c.nutrition.carbohydrate} g | 钠 ${c.nutrition.sodium} mg`)
    console.log(`  蛋白密度 ${proteinPerYuan(c)} g/元`)
    for (const it of c.items) console.log(`    - ${it.name}  ¥${it.price}`)
  }

  show(best, '最推荐')

  const others = pareto.filter((c) => c !== best).slice(0, 3)
  if (others.length) {
    console.log('\n【其他帕累托最优解】')
    for (const c of others) {
      console.log(
        `  ${String(c.priceYuan).padStart(6)}元 | ${String(c.nutrition.protein).padStart(3)}g 蛋白 | ` +
          `${String(c.nutrition.energyKcal).padStart(4)} kcal  (${c.items.length} 项)`,
      )
      console.log(`    ${c.items.map((i) => i.name).join(' + ')}`)
    }
  }
  console.log()
}

/** 在线模式：拉真实门店数据 + 用 calculate-price 校验 */
async function runLive(args, constraints) {
  const token = mcp.loadToken()
  if (!token) {
    console.error('未找到 MCP Token。请在 .env 写入 MCD_MCP_TOKEN，或使用 --demo 离线模式。')
    process.exit(1)
  }

  const city = args.city || '南京'
  const keyword = args.keyword || '新街口'

  console.log('连接麦当劳 MCP…')
  await mcp.connect(token)

  console.log(`查找门店: ${city} / ${keyword}`)
  const stores = await mcp.findStores({ city, keyword, beType: 1 }, token)
  const open = stores.filter((s) => s.businessStatus)
  if (open.length === 0) {
    console.error('该关键词下没有营业中的门店，换个关键词试试。')
    process.exit(1)
  }
  const store = open[0]
  console.log(`选定门店: ${store.storeName} (${store.storeCode}) ${store.hours}`)

  console.log('拉取菜单…')
  const categories = await mcp.fetchMenu(store.storeCode, { orderType: 1, beType: 1 }, token)
  const allCodes = [...new Set(categories.flatMap((c) => c.codes))]
  console.log(`菜单共 ${allCodes.length} 个商品编码，逐个取详情…`)

  const details = await mcp.fetchDetails(store.storeCode, allCodes, { orderType: 1, beType: 1 }, token)
  console.log(`取到 ${details.length} 个商品详情`)

  const detailByCode = new Map(details.map((d) => [d.code, d]))

  // 用 calculate-price 逐个探测价格（受 600次/分钟 限流约束，按需抽样）
  const limit = Number(args.limit || 0) || allCodes.length
  const sample = details.slice(0, limit)
  console.log(`探测价格（${sample.length} 项，受 600 次/分钟限流约束）…`)

  const priced = []
  for (const d of sample) {
    try {
      const p = await mcp.fetchPrice(
        store.storeCode,
        [{ productCode: d.code, quantity: 1 }],
        { orderType: 1, beType: 1 },
        token,
      )
      const priceYuan = (p.productList[0]?.subtotal ?? 0) / 100
      if (priceYuan > 0) {
        priced.push({ code: d.code, name: d.name, price: priceYuan, detail: d })
      }
    } catch {
      /* 单个商品失败不中断整体流程 */
    }
  }
  console.log(`成功定价 ${priced.length} 项`)

  // 四级降级对齐：L1 精确 → L2 包含 → L3 套餐拆解 → L4 剔除
  const matcher = new NutritionMatcher(loadNutrition())
  const resolved = priced.map((p) => matcher.resolve(p.code, p.name, p.price, p.detail))

  const report = matcher.report()
  const usable = resolved.filter((r) => r.nutrition && !r.excluded)
  console.log('\n【营养对齐命中率】')
  console.log(`  总探测 ${report.total} 项`)
  console.log(
    `  L1精确 ${report.l1} · L2包含 ${report.l2} · L3套餐拆解 ${report.l3}（其中 ${report.l3Partial} 项为部分解析）`,
  )
  console.log(`  剔除非食品 ${report.skipped} · 未解析 ${report.unresolved}`)
  console.log(`  可用于求解 ${usable.length} 项，命中率 ${report.matchRate}%`)

  const items = usable.map((r) => ({
    code: r.code,
    name: r.name,
    price: r.price,
    level: r.level,
    categorySlots: r.categorySlots ?? [],
    energyKcal: r.nutrition.energyKcal,
    protein: r.nutrition.protein,
    fat: r.nutrition.fat ?? 0,
    carbohydrate: r.nutrition.carbohydrate ?? 0,
    sodium: r.nutrition.sodium ?? 0,
    components: r.components,
  }))

  if (items.length === 0) {
    console.error('没有可用的营养数据，无法求解。')
    process.exit(1)
  }

  const result = new Solver(items, constraints).solve()
  printResult(result, constraints, `在线数据 · ${store.storeName}`)

  // 数据可信度提示：部分解析的套餐营养值是子项叠加，缺失子项未计入
  const partialCount = items.filter((i) => i.level === 'L3-partial').length
  if (partialCount > 0) {
    console.log(
      `⚠ 注意: ${partialCount} 项套餐含营养表未收录的新品（如新品饮料），其营养值为已解析子项之和，可能偏低。`,
    )
  }

  if (result.best?.components) {
    console.log('\n【推荐组合的套餐拆解明细】')
    for (const c of result.best.components ?? []) {
      const mark = c.unresolved ? ' ⚠未收录' : ` → ${c.matchedName}`
      console.log(`    ${c.name} ×${c.quantity}${mark}`)
    }
    console.log()
  }
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const constraints = constraintsFrom(args)

  if (args.live) {
    await runLive(args, constraints)
    return
  }

  // 离线模式
  const nutrition = loadNutrition()
  const items = buildOfflineItems(nutrition)
  console.log(`离线模式：内置营养数据 ${nutrition.length} 条，命中示例价格 ${items.length} 项`)
  console.log('（价格为 2026-10 实测示例，非实时报价；实时请用 --live）')

  const result = new Solver(items, constraints).solve()
  printResult(result, constraints, '离线演示数据')

  if (args.explain) {
    console.log('【说明】求解策略:')
    console.log('  1. 按品类分组，避免同品类堆叠导致组合爆炸')
    console.log('  2. DFS 枚举 + 价格上界剪枝')
    console.log('  3. 约束过滤 → 帕累托前沿（价格↓ 蛋白↑）')
    console.log('  4. 从前沿取满足蛋白下限者中价格最低\n')
  }
}

main().catch((e) => {
  console.error('ERROR:', e.message)
  process.exit(1)
})
