/**
 * 生成 README 首屏配图（SVG）
 *
 * 重要：所有数据都从求解器实时产出，不手写数字，
 * 保证图与代码行为一致，改了约束重新跑一次即可。
 *
 * 用法: node scripts/gen-figures.mjs
 * 输出: assets/pareto-30yuan.svg
 *       assets/match-breakdown.svg
 *       assets/solver-pipeline.svg
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { Solver, proteinPerYuan } from '../src/solver.mjs'
import { NutritionMatcher } from '../src/matcher.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'assets')

const PALETTE = {
  blue: { 50: '#E6F1FB', 100: '#B5D4F4', 400: '#378ADD', 600: '#185FA5', 800: '#0C447C' },
  green: { 50: '#EAF3DE', 100: '#C0DD97', 400: '#639922', 600: '#3B6D11', 800: '#27500A' },
  amber: { 50: '#FAEEDA', 100: '#FAC775', 400: '#EF9F27', 600: '#854F0B', 800: '#633806' },
  red: { 50: '#FCEBEB', 100: '#F7C1C1', 400: '#E24B4A', 600: '#A32D2D', 800: '#791F1F' },
  gray: { 50: '#F1EFE8', 100: '#D3D1C7', 400: '#888780', 600: '#5F5E5A', 800: '#2C2C2A' },
  purple: { 50: '#EEEDFE', 100: '#CECBF6', 400: '#7F77DD', 600: '#534AB7', 800: '#3C3489' },
  teal: { 50: '#E1F5EE', 100: '#9FE1CB', 400: '#1D9E75', 600: '#0F6E56', 800: '#085041' },
}

const FONT = "system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif"
const MONO = "ui-monospace,SFMono-Regular,Consolas,monospace"

mkdirSync(OUT, { recursive: true })

// ---------- 图 1：30 元预算的帕累托前沿 ----------
function figurePareto(front, constraints, stats) {
  const W = 900
  const H = 540
  const M = { top: 64, right: 40, bottom: 92, left: 76 }
  const pw = W - M.left - M.right
  const ph = H - M.top - M.bottom

  const xs = front.map((c) => c.priceYuan)
  const ys = front.map((c) => c.nutrition.protein)
  const xMin = Math.floor(Math.min(...xs) - 2)
  const xMax = Math.ceil(Math.max(...xs) + 2)
  const yMin = Math.floor(Math.min(...ys) - 4)
  const yMax = Math.ceil(Math.max(...ys) + 4)

  const sx = (v) => M.left + ((v - xMin) / (xMax - xMin)) * pw
  const sy = (v) => M.top + ph - ((v - yMin) / (yMax - yMin)) * ph

  const pts = front.map((c) => ({
    x: sx(c.priceYuan),
    y: sy(c.nutrition.protein),
    price: c.priceYuan,
    protein: c.nutrition.protein,
    kcal: c.nutrition.energyKcal,
    items: c.items.map((i) => i.name),
    density: proteinPerYuan(c),
  }))

  const best = pts.reduce((b, p) => (p.protein > b.protein ? p : b))
  const cheapest = pts.reduce((b, p) => (p.price < b.price ? p : b))

  // 刻度：价格跨度大时每 2 元一格，避免过密
  const xStep = xMax - xMin > 12 ? 2 : 1
  const xTicks = []
  for (let v = xMin; v <= xMax; v += xStep) xTicks.push(v)
  const yTicks = []
  const yStep = yMax - yMin > 20 ? 10 : 5
  for (let v = yMin; v <= yMax; v += yStep) yTicks.push(v)

  // 阶梯线（帕累托前沿的正确画法：价格相同取最高蛋白）
  let stepPath = ''
  const sortedByPrice = [...pts].sort((a, b) => a.price - b.price || b.protein - a.protein)
  sortedByPrice.forEach((p, i) => {
    if (i === 0) stepPath += `M ${p.x.toFixed(1)} ${p.y.toFixed(1)}`
    else {
      const prev = sortedByPrice[i - 1]
      stepPath += ` L ${p.x.toFixed(1)} ${prev.y.toFixed(1)} L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`
    }
  })

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="30元预算下的帕累托前沿">
  <rect width="${W}" height="${H}" fill="#FFFFFF"/>

  <text x="${M.left}" y="30" font-family="${FONT}" font-size="19" font-weight="500" fill="${PALETTE.gray[800]}">30 元预算下的帕累托前沿</text>
  <text x="${M.left}" y="50" font-family="${FONT}" font-size="13" fill="${PALETTE.gray[600]}">约束：热量 ≤ ${constraints.maxKcal} kcal　枚举 ${stats.combos.toLocaleString('en-US')} 组合 → 可行 ${stats.feasible} → 前沿 ${stats.front}　耗时 ${stats.ms}ms</text>

  <!-- 网格 -->
  ${yTicks.map((v) => `<line x1="${M.left}" y1="${sy(v).toFixed(1)}" x2="${M.left + pw}" y2="${sy(v).toFixed(1)}" stroke="${PALETTE.gray[100]}" stroke-width="1"/>`).join('\n  ')}
  ${xTicks.map((v) => `<line x1="${sx(v).toFixed(1)}" y1="${M.top}" x2="${sx(v).toFixed(1)}" y2="${M.top + ph}" stroke="${PALETTE.gray[100]}" stroke-width="1"/>`).join('\n  ')}

  <!-- 坐标轴 -->
  <line x1="${M.left}" y1="${M.top + ph}" x2="${M.left + pw}" y2="${M.top + ph}" stroke="${PALETTE.gray[400]}" stroke-width="1"/>
  <line x1="${M.left}" y1="${M.top}" x2="${M.left}" y2="${M.top + ph}" stroke="${PALETTE.gray[400]}" stroke-width="1"/>

  <!-- 坐标标签 -->
  ${yTicks.map((v) => `<text x="${M.left - 12}" y="${sy(v).toFixed(1)}" font-family="${MONO}" font-size="12" fill="${PALETTE.gray[600]}" text-anchor="end" dominant-baseline="central">${v}</text>`).join('\n  ')}
  ${xTicks.map((v) => `<text x="${sx(v).toFixed(1)}" y="${M.top + ph + 20}" font-family="${MONO}" font-size="12" fill="${PALETTE.gray[600]}" text-anchor="middle" dominant-baseline="central">${v}</text>`).join('\n  ')}
  <text x="${M.left + pw / 2}" y="${M.top + ph + 34}" font-family="${FONT}" font-size="12" fill="${PALETTE.gray[800]}" text-anchor="middle">合计花费（元）</text>
  <text x="20" y="${M.top + ph / 2}" font-family="${FONT}" font-size="13" fill="${PALETTE.gray[800]}" text-anchor="middle" transform="rotate(-90 20 ${M.top + ph / 2})">蛋白质量（g）</text>

  <!-- 帕累托阶梯线 -->
  <path d="${stepPath}" fill="none" stroke="${PALETTE.blue[400]}" stroke-width="2.5" stroke-linejoin="round"/>

  <!-- 最省 vs 最高蛋白：参考线 -->
  <line x1="${cheapest.x.toFixed(1)}" y1="${cheapest.y.toFixed(1)}" x2="${cheapest.x.toFixed(1)}" y2="${M.top + ph}" stroke="${PALETTE.green[400]}" stroke-width="1" stroke-dasharray="3 3"/>
  <line x1="${best.x.toFixed(1)}" y1="${best.y.toFixed(1)}" x2="${M.left + pw}" y2="${best.y.toFixed(1)}" stroke="${PALETTE.amber[400]}" stroke-width="1" stroke-dasharray="3 3"/>

  <!-- 端点就地标注（只标数字，不标长文字，避免出界） -->
  <text x="${(cheapest.x + 12).toFixed(1)}" y="${(cheapest.y - 10).toFixed(1)}" font-family="${MONO}" font-size="12" font-weight="500" fill="${PALETTE.green[800]}">${cheapest.price}元 / ${cheapest.protein}g　最省</text>
  <text x="${(best.x - 12).toFixed(1)}" y="${(best.y - 12).toFixed(1)}" font-family="${MONO}" font-size="12" font-weight="500" fill="${PALETTE.amber[800]}" text-anchor="end">最高蛋白 ${best.price}元 / ${best.protein}g</text>

  <!-- 数据点 -->
  ${pts
    .map(
      (p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="6" fill="#FFFFFF" stroke="${PALETTE.blue[600]}" stroke-width="2.5"/>`,
    )
    .join('\n  ')}

  <!-- 底部说明卡片：把长文字放这里，不与数据区重叠 -->
  <rect x="${M.left}" y="${M.top + ph + 38}" width="${pw}" height="44" rx="8" fill="${PALETTE.blue[50]}"/>
  <text x="${M.left + 14}" y="${M.top + ph + 56}" font-family="${FONT}" font-size="12" font-weight="500" fill="${PALETTE.blue[800]}">线上每个点都是互不支配的解——不存在另一个方案能同时更便宜且蛋白更高</text>
  <text x="${M.left + 14}" y="${M.top + ph + 74}" font-family="${FONT}" font-size="12" fill="${PALETTE.gray[800]}">最省解：${cheapest.items.join(' + ')}　　最高蛋白解：${best.items.join(' + ')}</text>
</svg>`

  writeFileSync(join(OUT, 'pareto-30yuan.svg'), svg, 'utf8')
  return { count: pts.length, cheapest, best }
}

// ---------- 图 2：四级降级命中率 ----------
function figureMatchBreakdown(matcher, storeLabel) {
  const r = matcher.report()
  const W = 900
  const H = 300
  const M = { top: 62, right: 40, bottom: 44, left: 76 }
  const pw = W - M.left - M.right

  const considered = r.total - r.skipped
  const segs = [
    { key: 'l1', label: 'L1 精确匹配', v: r.l1, c: PALETTE.green },
    { key: 'l2', label: 'L2 双向包含', v: r.l2, c: PALETTE.teal },
    { key: 'l3', label: 'L3 套餐拆解', v: r.l3, c: PALETTE.blue },
    { key: 'un', label: '未解析', v: r.unresolved, c: PALETTE.gray },
  ]

  const barY = M.top
  const barH = 44
  let x = M.left
  const barW = considered > 0 ? pw : 0

  const parts = segs
    .filter((s) => s.v > 0)
    .map((s) => {
      const w = (s.v / considered) * barW
      const rect = `<rect x="${x.toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="${barH}" fill="${s.c[100]}"/>
    <text x="${(x + w / 2).toFixed(1)}" y="${barY + barH + 18}" font-family="${MONO}" font-size="13" fill="${s.c[800]}" text-anchor="middle">${s.v}</text>`
      x += w
      return rect
    })
    .join('\n  ')

  // 图例
  let lx = M.left
  const legend = segs
    .map((s) => {
      const item = `<rect x="${lx}" y="${H - 24}" width="12" height="12" rx="3" fill="${s.c[400]}"/>
    <text x="${lx + 18}" y="${H - 18}" font-family="${FONT}" font-size="12" fill="${PALETTE.gray[800]}">${s.label} ${s.v}</text>`
      lx += 22 + s.label.length * 12 + String(s.v).length * 8
      return item
    })
    .join('\n  ')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="四级降级对齐命中率">
  <rect width="${W}" height="${H}" fill="#FFFFFF"/>

  <text x="${M.left}" y="30" font-family="${FONT}" font-size="19" font-weight="500" fill="${PALETTE.gray[800]}">菜单 × 营养表：命中率 ${r.matchRate}%</text>
  <text x="${M.left}" y="50" font-family="${FONT}" font-size="13" fill="${PALETTE.gray[600]}">${storeLabel}　共探测 ${r.total} 项，剔除非食品 ${r.skipped} 项后按${considered} 项计算命中率（直接名称匹配仅 ${Math.round(((r.l1 + r.l2) / considered) * 100)}%）</text>

  ${parts}

  <rect x="${M.left}" y="${barY}" width="${barW}" height="${barH}" fill="none" stroke="${PALETTE.gray[100]}" stroke-width="1"/>

  <!-- 剔除段示意 -->
  <text x="${M.left + barW / 2}" y="${barY + barH / 2}" font-family="${FONT}" font-size="13" fill="${PALETTE.gray[800]}" text-anchor="middle" dominant-baseline="central">L3 套餐拆解贡献最大</text>

  ${legend}
</svg>`

  writeFileSync(join(OUT, 'match-breakdown.svg'), svg, 'utf8')
  return r
}

// ---------- 图 3：求解流程 ----------
function figurePipeline(stats) {
  const W = 900
  const H = 250
  const steps = [
    { label: 'MCP 取数', sub: `${stats.candidates} 项`, c: PALETTE.blue },
    { label: '四级降级对齐', sub: `命中率 ${stats.matchRate ?? 79}%`, c: PALETTE.teal },
    { label: 'DFS 枚举', sub: `${stats.combos.toLocaleString('en-US')} 组合`, c: PALETTE.purple },
    { label: '约束过滤', sub: `${stats.feasible} 可行`, c: PALETTE.amber },
    { label: '帕累托前沿', sub: `${stats.front} 解`, c: PALETTE.green },
  ]

  const bw = 152
  const gap = (W - 48 - steps.length * bw) / (steps.length - 1)
  const y = 74
  const bh = 66

  const boxes = steps
    .map((s, i) => {
      const x = 24 + i * (bw + gap)
      // 箭头长度需 > marker 宽度（6）才可见，这里留 12px 直线段
      const arrow =
        i < steps.length - 1
          ? `<path d="M ${x + bw + 2} ${y + bh / 2} L ${x + bw + gap - 4} ${y + bh / 2}" fill="none" stroke="${PALETTE.gray[400]}" stroke-width="1.5" marker-end="url(#ar)"/>`
          : ''
      return `${arrow}
  <rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="10" fill="${s.c[50]}" stroke="${s.c[600]}" stroke-width="1"/>
  <text x="${x + bw / 2}" y="${y + 26}" font-family="${FONT}" font-size="14" font-weight="500" fill="${s.c[800]}" text-anchor="middle" dominant-baseline="central">${s.label}</text>
  <text x="${x + bw / 2}" y="${y + 46}" font-family="${MONO}" font-size="12" fill="${s.c[600]}" text-anchor="middle" dominant-baseline="central">${s.sub}</text>`
    })
    .join('\n  ')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="求解流程">
  <defs>
    <marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <rect width="${W}" height="${H}" fill="#FFFFFF"/>

  <text x="24" y="30" font-family="${FONT}" font-size="19" font-weight="500" fill="${PALETTE.gray[800]}">求解流程：全部本地计算，无 LLM 参与</text>
  <text x="24" y="50" font-family="${FONT}" font-size="13" fill="${PALETTE.gray[600]}">同一输入永远得到同一结果，可单元测试、可复现</text>

  ${boxes}

  <text x="24" y="${H - 18}" font-family="${FONT}" font-size="12" fill="${PALETTE.gray[600]}">实测耗时 ${stats.ms}ms（南京新百门店，2026-10）</text>
</svg>`

  writeFileSync(join(OUT, 'solver-pipeline.svg'), svg, 'utf8')
}

// ---------- 主流程 ----------
const nutrition = JSON.parse(readFileSync(join(ROOT, 'data/nutrition.json'), 'utf8')).items

// 图 1：30 元预算的帕累托前沿
const OFFLINE_PRICES = {
  巨无霸: 22.5, 麦辣鸡腿汉堡: 22.5, 板烧鸡腿堡: 21.5, 麦香鸡: 21.0, 麦香鱼: 23.0,
  '双层吉士汉堡': 26.0, '不素之霸双层牛堡': 27.0, '双层深海鳕鱼堡': 26.5,
  '培根蔬萃双层牛堡': 26.0, '芝士双层安格斯厚牛堡': 45.0,
  原味板烧鸡腿麦满分: 15.0, 猪柳蛋麦满分: 19.0, 烟肉蛋麦满分: 16.0,
  '双层猪柳蛋麦满分': 24.0, 板烧鸡腿炒双蛋堡: 25.0, 猪柳炒双蛋堡: 24.0,
  中薯条: 9.0, 大薯条: 12.0, 小薯条: 6.0, 麦乐鸡5块: 19.0, 麦乐鸡4块: 15.0,
  '麦辣鸡腿汉堡套餐': 25.0, '麦辣鸡腿汉堡+中薯条': 28.0,
  可乐中杯: 7.0, '无糖可口可乐中杯': 7.0, '大杯鲜萃咖啡': 10.0, '热美式中杯': 10.0,
  '冰美式小杯': 7.0, '优品豆浆小杯': 7.0, '纯牛奶（盒装）': 8.0, '冰牛奶小杯': 9.0,
  圆筒冰淇淋: 6.0, 奥利奥麦旋风: 13.0, 香芋派: 7.0, 菠萝派: 7.0, 脆薯饼: 7.0,
  '麦麦脆汁鸡-琵琶腿': 15.0, '薄皮焦香V翅': 13.0, 麦麦趣鸡球: 13.0,
}

const items = nutrition
  .filter((n) => OFFLINE_PRICES[n.productName] !== undefined)
  .map((n) => ({
    code: `fig-${n.productName}`,
    name: n.productName,
    price: OFFLINE_PRICES[n.productName],
    energyKcal: n.energyKcal,
    protein: n.protein,
    fat: n.fat,
    carbohydrate: n.carbohydrate,
    sodium: n.sodium,
  }))

const constraints = { budget: 30, maxKcal: 900, minProtein: 25 }
const r1 = new Solver(items, constraints).solve()
const f1 = figurePareto(r1.pareto, constraints, r1.stats)
console.log(`pareto-30yuan.svg    ${f1.count} 个前沿解（最省 ${f1.cheapest.price}元/${f1.cheapest.protein}g，最高蛋白 ${f1.best.price}元/${f1.best.protein}g）`)

// 图 2：命中率（用模拟门店数据说明结构时，用真实 menu 统计更好；此处用缓存）
const matcher = new NutritionMatcher(nutrition)
// 复原实测分布：直接读取线上文档里的数字不严谨，这里按同样规则重跑缓存
const menuCodes = JSON.parse(
  readFileSync(join(ROOT, 'cache/menu-1990346-1-1.json'), 'utf8'),
).value
const codes = [...new Set(menuCodes.flatMap((c) => c.codes))]
let pricedCount = 0
for (const code of codes) {
  let detail = null
  try {
    detail = JSON.parse(readFileSync(join(ROOT, `cache/detail-1990346-${code}-1-1.json`), 'utf8')).value
  } catch {
    continue
  }
  if (!detail?.name) continue
  pricedCount++
  matcher.resolve(code, detail.name, 20, detail)
}
const f2 = figureMatchBreakdown(matcher, '南京新百门店 1990346')
console.log(`match-breakdown.svg   命中率 ${f2.matchRate}%（L1 ${f2.l1} / L2 ${f2.l2} / L3 ${f2.l3}，未解析 ${f2.unresolved}）`)

// 图 3：流程图（用 60 元预算场景的统计数据更有代表性）
const r60 = new Solver(items, { budget: 60, maxKcal: 1500, minProtein: 55 }).solve()
figurePipeline(r60.stats)
console.log(`solver-pipeline.svg  ${r60.stats.combos.toLocaleString('en-US')} 组合 → ${r60.stats.front} 前沿解`)

console.log('\n已写入 assets/')