/**
 * SVG 静态检查：出界、箭头长度、文字重叠风险。
 * 不做真正的渲染，但能拦住绝大多数手写 SVG 的低级错误。
 *
 * 用法: node scripts/check-figures.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'assets')

let problems = 0
const fail = (msg) => {
  problems++
  console.log(`  [X] ${msg}`)
}
const pass = (msg) => console.log(`  [OK] ${msg}`)

for (const f of readdirSync(DIR).filter((x) => x.endsWith('.svg'))) {
  const svg = readFileSync(join(DIR, f), 'utf8')
  console.log(`\n=== ${f} ===`)

  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)
  if (!vb) {
    fail('缺少 viewBox')
    continue
  }
  const W = parseFloat(vb[1])
  const H = parseFloat(vb[2])
  console.log(`  画布 ${W} x ${H}`)

  // 1. 文本出界检查
  const texts = [...svg.matchAll(/<text x="([-\d.]+)" y="([-\d.]+)"[^>]*>([^<]*)<\/text>/g)]
  const out = texts.filter((m) => {
    const x = parseFloat(m[1])
    const y = parseFloat(m[2])
    return x < 0 || x > W || y < 0 || y > H
  })
  if (out.length) {
    for (const m of out) fail(`文本出界 "${m[3].slice(0, 28)}" @(${m[1]},${m[2]})`)
  } else {
    pass(`${texts.length} 个文本均在画布内`)
  }

  // 2. 箭头长度检查（marker 宽度 6px，短线段会导致箭头不可见）
  const arrows = [...svg.matchAll(/M\s+([\d.]+)\s+[\d.]+\s+L\s+([\d.]+)\s+[\d.]+[^>]*marker-end/g)]
  const shortArrows = arrows.filter((m) => parseFloat(m[2]) - parseFloat(m[1]) < 12)
  if (arrows.length === 0) {
    pass('无箭头元素')
  } else if (shortArrows.length) {
    for (const m of shortArrows) fail(`箭头过短 ${(parseFloat(m[2]) - parseFloat(m[1])).toFixed(0)}px，需 ≥12px`)
  } else {
    const lens = arrows.map((m) => (parseFloat(m[2]) - parseFloat(m[1])).toFixed(0))
    pass(`${arrows.length} 个箭头长度正常（${Math.min(...lens.map(Number))}~${Math.max(...lens.map(Number))}px）`)
  }

  // 2b. marker 定义必须存在，否则箭头不可见
  const hasMarkerDef = /<marker[^>]*id="/.test(svg)
  const usesMarker = /marker-end="url\(#/.test(svg)
  if (usesMarker && !hasMarkerDef) fail('使用了 marker-end 但未定义 <marker>')
  else if (usesMarker) pass('marker 定义完整')

  // 3. 字号检查（小于 11px 在 GitHub 上难辨）
  const tiny = [...svg.matchAll(/font-size="([\d.]+)"/g)].filter((m) => parseFloat(m[1]) < 11)
  if (tiny.length) fail(`${tiny.length} 处字号 < 11px`)
  else pass('字号均≥ 11px')

  // 4. 字体族声明（缺字体在 Windows/Linux 渲染差异大）
  if (!svg.includes('font-family')) fail('未声明 font-family')
  else pass('已声明字体族')

  // 5. 可访问性
  if (!svg.includes('role="img"') || !svg.includes('aria-label')) {
    fail('缺少 role="img" / aria-label')
  } else {
    pass('含无障碍属性')
  }

  // 6. 渐变/阴影（本项目用扁平设计，出现即为偏离规范）
  if (/<linearGradient|<filter|filter=/.test(svg)) fail('含渐变或阴影，应使用扁平设计')
  else pass('扁平设计，无渐变阴影')

  // 7. 注释（多余 token，SVG 内不需要）
  if (svg.includes('<!--')) pass('含注释（可接受，浏览器会忽略）')
}

console.log(`\n${problems === 0 ? '全部检查通过' : problems + ' 项问题'}`)
process.exit(problems === 0 ? 0 : 1)