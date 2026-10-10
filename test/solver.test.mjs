/**
 * 求解器单元测试 —— 用 Node 内置 test runner，无需额外依赖。
 * 运行: node --test test/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseNutrition, normalizeName } from '../src/nutrition.mjs'
import { Solver, paretoFront, proteinPerYuan } from '../src/solver.mjs'
import { NutritionMatcher } from '../src/matcher.mjs'
import { guessCategory } from '../src/categories.mjs'
import { allocateDiscount } from '../src/mcp-client.mjs'

// ---------- 营养数据解析 ----------

test('parseNutrition: 正确解析 160 条并处理 description 混坑', () => {
  const raw =
    '[2]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n' +
    '  巨无霸,null,2146,513,27,26,42,961,171\n' +
    '  纯悦,能量约清水1杯,0,0,0,0,0,0,0'
  const items = parseNutrition(raw)
  assert.equal(items.length, 2)

  assert.equal(items[0].productName, '巨无霸')
  assert.equal(items[0].energyKcal, 513)
  assert.equal(items[0].protein, 27)
  assert.equal(items[0].sodium, 961)
  assert.equal(items[0].nutritionDescription, null)

  //关键回归：description 字段混入商品名，不得错位
  assert.equal(items[1].productName, '纯悦')
  assert.equal(items[1].nutritionDescription, '能量约清水1杯')
  assert.equal(items[1].energyKcal, 0)
})

test('parseNutrition: 过滤空行与非法行', () => {
  const raw =
    '[3]{a}:\n' +
    '  巨无霸,null,2146,513,27,26,42,961,171\n' +
    '\n' +
    '  残缺行,xxx\n'
  const items = parseNutrition(raw)
  assert.equal(items.length, 1)
})

test('normalizeName: 去空格与括号内容', () => {
  assert.equal(normalizeName('纯牛奶（盒装）'), '纯牛奶')
  assert.equal(normalizeName(' 那么大鸡排（椒盐风味） '), '那么大鸡排')
})

// ---------- 帕累托前沿 ----------

test('paretoFront: 只保留非支配解', () => {
  const combos = [
    { priceYuan: 10, nutrition: { protein: 10 } },
    { priceYuan: 12, nutrition: { protein: 12 } },
    { priceYuan: 15, nutrition: { protein: 5 } },  // 被支配
    { priceYuan: 20, nutrition: { protein: 30 } },
    { priceYuan: 25, nutrition: { protein: 25 } },  // 被支配
  ]
  const front = paretoFront(combos)
  assert.equal(front.length, 3)
  assert.deepEqual(
    front.map((c) => c.priceYuan),
    [10, 12, 20],
  )
})

test('paretoFront: 空输入返回空数组', () => {
  assert.deepEqual(paretoFront([]), [])
})

// ---------- 求解器核心不变量 ----------

const SAMPLE = [
  { code: 'a', name: '麦辣鸡腿汉堡', price: 22.5, energyKcal: 485, protein: 24, fat: 24, carbohydrate: 42, sodium: 1208 },
  { code: 'b', name: '板烧鸡腿堡', price: 21.5, energyKcal: 391, protein: 23, fat: 17, carbohydrate: 35, sodium: 1041 },
  { code: 'c', name: '中薯条', price: 9, energyKcal: 289, protein: 4, fat: 12, carbohydrate: 38, sodium: 165 },
  { code: 'd', name: '无糖可口可乐中杯', price: 7, energyKcal: 0, protein: 0, fat: 0, carbohydrate: 1, sodium: 35 },
  { code: 'e', name: '圆筒冰淇淋', price: 6, energyKcal: 93, protein: 2, fat: 3, carbohydrate: 14, sodium: 36 },
]

test('Solver: 不超预算', () => {
  const s = new Solver(SAMPLE, { budget: 30, maxKcal: 1500, minProtein: 20 })
  const r = s.solve()
  assert.ok(r.feasible)
  assert.ok(r.best.priceYuan <= 30, `实际 ${r.best.priceYuan}`)
  assert.ok(r.best.nutrition.protein >= 20)
})

test('Solver: 热量上限被严格遵守', () => {
  const s = new Solver(SAMPLE, { budget: 100, maxKcal: 400, minProtein: 0 })
  const r = s.solve()
  if (r.feasible) {
    assert.ok(r.best.nutrition.energyKcal <= 400)
  }
})

test('Solver: 排除关键词生效（含不含"汉堡"二字的商品名）', () => {
  // 关键回归：板烧鸡腿堡 名字里没有"汉堡"二字，
  // 单向 includes 匹配会漏掉，必须双向包含才能正确排除
  const s = new Solver(SAMPLE, { budget: 100, exclude: ['汉堡'] })
  const names = s.filtered.map((i) => i.name)
  assert.ok(!names.includes('麦辣鸡腿汉堡'))
  assert.ok(!names.includes('板烧鸡腿堡'), '板烧鸡腿堡应被"汉堡"排除')
  assert.ok(names.includes('中薯条'), '不含汉堡的应保留')
  assert.equal(s.rejected.length, 2)
})

test('Solver: 包含关键词双向匹配', () => {
  const s = new Solver(SAMPLE, { budget: 100, includeKeywords: ['中薯条'] })
  assert.deepEqual(s.filtered.map((i) => i.name), ['中薯条'])
})

test('Solver: 超出能力的约束返回不可行而非死循环', () => {
  const s = new Solver(SAMPLE, { budget: 5, minProtein: 99 })
  const r = s.solve()
  assert.equal(r.feasible, false)
  assert.equal(r.best, null)
})

test('Solver: 同一品类不被重复堆叠（严格模式）', () => {
  const s = new Solver(SAMPLE, { budget: 100, maxKcal: 3000, strictSlots: true })
  const r = s.solve()
  const combos = [r.best, ...r.pareto].filter(Boolean)
  for (const c of combos) {
    const cats = c.items.map((i) => guessCategory(i))
    assert.equal(new Set(cats).size, cats.length, `品类重复: ${c.items.map((i) => i.name).join('+')}`)
  }
})

test('Solver: 求解结果可复现（两次调用完全一致）', () => {
  const c = { budget: 45, maxKcal: 1200, minProtein: 25 }
  const r1 = new Solver(SAMPLE, c).solve()
  const r2 = new Solver(SAMPLE, c).solve()
  assert.equal(r1.best.priceYuan, r2.best.priceYuan)
  assert.deepEqual(
    r1.best.items.map((i) => i.code),
    r2.best.items.map((i) => i.code),
  )
})

test('proteinPerYuan: 每元蛋白克数', () => {
  assert.equal(proteinPerYuan({ priceYuan: 20, nutrition: { protein: 30 } }), 1.5)
  assert.equal(proteinPerYuan({ priceYuan: 0, nutrition: { protein: 30 } }), 0)
})

// ---------- 品类识别 ----------

test('guessCategory: 关键品类判定', () => {
  assert.equal(guessCategory({ name: '麦辣鸡腿汉堡' }), 'burger')
  assert.equal(guessCategory({ name: '中薯条' }), 'side')
  assert.equal(guessCategory({ name: '可乐中杯' }), 'drink')
  assert.equal(guessCategory({ name: '圆筒冰淇淋' }), 'dessert')
  assert.equal(guessCategory({ name: '韩式甜辣酱' }), 'sauce')
})

test('guessCategory: 9900xxxx 编码段判为套餐', () => {
  assert.equal(guessCategory({ name: '某未知名称', code: '9900013304' }), 'combo')
})

// ---------- 优惠分摊 ----------

test('allocateDiscount: 多商品优惠按比例分摊且求和精确', () => {
  const list = [
    { productCode: '1', subtotal: 1000 }, // 10 元
    { productCode: '2', subtotal: 2000 }, // 20 元
  ]
  const out = allocateDiscount(list, 3) // 3 元优惠
  const total = out.reduce((s, p) => s + p.netSubtotalYuan, 0)
  // 分摊后总价必须精确等于 30 - 3 = 27，不能有浮点残差
  assert.equal(Math.round(total * 100) / 100, 27)
  // 按占比 1:2 分摊 → 1 元 / 2 元
  assert.equal(out[0].netSubtotalYuan, 9)
  assert.equal(out[1].netSubtotalYuan, 18)
  assert.ok(out.every((p) => p.netSubtotalYuan >= 0))
})

test('allocateDiscount: 无优惠时原样返回', () => {
  const list = [{ productCode: '1', subtotal: 2250 }]
  const out = allocateDiscount(list, 0)
  assert.equal(out[0].netSubtotalYuan, 22.5)
})

// ---------- 四级降级对齐 ----------

const NUTRITION = [
  { productName: '巨无霸', energyKcal: 513, protein: 27, fat: 26, carbohydrate: 42, sodium: 961, calcium: 171 },
  { productName: '麦辣鸡腿汉堡', energyKcal: 485, protein: 24, fat: 24, carbohydrate: 42, sodium: 1208, calcium: 154 },
  { productName: '中薯条', energyKcal: 289, protein: 4, fat: 12, carbohydrate: 38, sodium: 165, calcium: 18 },
  { productName: '可乐中杯', energyKcal: 147, protein: 0, fat: 0, carbohydrate: 36, sodium: 0, calcium: 10 },
  { productName: '圆筒冰淇淋', energyKcal: 93, protein: 2, fat: 3, carbohydrate: 14, sodium: 36, calcium: 77 },
]

test('matcher: L1 精确匹配', () => {
  const m = new NutritionMatcher(NUTRITION)
  const r = m.resolve('x', '巨无霸', 26, { rounds: [] })
  assert.equal(r.level, 'L1')
  assert.equal(r.nutrition.energyKcal, 513)
})

test('matcher: L1 命中带括号的同名商品', () => {
  const m = new NutritionMatcher(NUTRITION)
  const r = m.resolve('x', '麦辣鸡腿汉堡', 22.5, { rounds: [] })
  assert.equal(r.level, 'L1')
})

test('matcher: 非食品被剔除', () => {
  const m = new NutritionMatcher(NUTRITION)
  const r = m.resolve('x', '韩式甜辣酱', 2, { rounds: [] })
  assert.equal(r.excluded, 'nonFood')
  assert.equal(r.nutrition, null)
})

test('matcher: L3 套餐拆解叠加子项营养', () => {
  const m = new NutritionMatcher(NUTRITION)
  const detail = {
    rounds: [
      { name: '主餐', choices: [{ code: '1440', name: '麦辣鸡腿汉堡', quantity: 1, isDefault: 1 }] },
      { name: '小食', choices: [{ code: '4810', name: '中薯条', quantity: 1, isDefault: 1 }] },
    ],
  }
  const r = m.resolve('9900015902', '测试三件套', 28, detail)
  assert.equal(r.level, 'L3')
  assert.equal(r.nutrition.energyKcal, 485 + 289)
  assert.equal(r.nutrition.protein, 28)
  assert.equal(r.categorySlots.length, 2)
})

test('matcher: 套餐部分子项未收录时标 L3-partial 且槽位仍完整', () => {
  const m = new NutritionMatcher(NUTRITION)
  const detail = {
    rounds: [
      { name: '主餐', choices: [{ name: '麦辣鸡腿汉堡', quantity: 1, isDefault: 1 }] },
      { name: '饮料', choices: [{ name: '可乐麦炫酷', quantity: 1, isDefault: 1 }] },
    ],
  }
  const r = m.resolve('9900013304', '人气经典随心配', 14.9, detail)
  assert.equal(r.level, 'L3-partial')
  assert.ok(r.nutrition.energyKcal > 0)
  // 关键回归：新品未收录，但 drink 槽位不能丢，否则会误判"随心配+牛奶"可行
  assert.ok(r.categorySlots.includes('drink'), `实际槽位 ${r.categorySlots}`)
})

test('matcher: 酱料子项不占品类槽位', () => {
  const m = new NutritionMatcher(NUTRITION)
  const detail = {
    rounds: [
      { name: '主餐', choices: [{ name: '麦辣鸡腿汉堡', quantity: 1, isDefault: 1 }] },
      { name: '酱料', choices: [{ name: '香辣酱', quantity: 1, isDefault: 1 }] },
    ],
  }
  const r = m.resolve('c', '某套餐', 25, detail)
  assert.ok(!r.categorySlots.includes('sauce'))
})

test('matcher: 命中率报告分母剔除非食品', () => {
  const m = new NutritionMatcher(NUTRITION)
  m.resolve('1', '巨无霸', 26, { rounds: [] })
  m.resolve('2', '韩式甜辣酱', 2, { rounds: [] })
  const rep = m.report()
  assert.equal(rep.total, 2)
  assert.equal(rep.skipped, 1)
  assert.equal(rep.matchRate, 100, '剔除酱料后分母为1且已命中，应为 100%')
})