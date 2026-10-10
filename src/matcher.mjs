/**
 * 菜单 ↔ 营养数据对齐引擎
 *
 * 这是本项目最核心的数据处理环节。三个数据源口径不一致：
 *   - 营养表：标准单品，全球统一，不含套餐与限定新品
 *   - 门店菜单：当前门店在售，含套餐组合、地区限定新品、非食品周边
 *   - 菜单里还有酱料等非食品，根本不该进营养计算
 *
 * 采用四级降级链，逐级放宽：
 *   L1 精确匹配 → L2 双向包含（取最长）→ L3 套餐拆解（rounds 默认搭配）→ L4 剔除不可算
 *
 * 每一级都记录命中原因，便于输出可观测的命中率统计。
 */

import { normalizeName } from './nutrition.mjs'
import { guessCategory } from './categories.mjs'

/** 非食品关键词：这些不该进营养计算 */
const NON_FOOD = [
  /酱$/, /^酱/, /酱料/, /包$/, /帽$/, /杯套/, /玩具/, /周边/,
  /勺/, /叉/, /袋/, /纸巾/, /吸管/, /贺卡/, /券/, /卡/,
]

/** 需排除的营养表修饰前缀，做 L2 二次匹配时剥离 */
const NOISE_PREFIX = ['原味', '经典', '超值', '人气', '招牌', '特级']

export class NutritionMatcher {
  /**
   * @param {Array} nutritionItems 内置营养数据
   */
  constructor(nutritionItems) {
    this.items = nutritionItems
    // 归一化索引：加速精确匹配
    this.exact = new Map()
    for (const n of nutritionItems) {
      const k = normalizeName(n.productName)
      if (!this.exact.has(k)) this.exact.set(k, n)
    }
    this.stats = { total: 0, l1: 0, l2: 0, l3: 0, l3Partial: 0, skipped: 0, unresolved: 0 }
  }

  isNonFood(name) {
    const n = String(name || '')
    return NON_FOOD.some((re) => re.test(n))
  }

  /**
   * L1 + L2：单品营养匹配
   * @returns {{nutrition: object|null, level: string, matchedName: string|null}}
   */
  matchSingle(name) {
    const norm = normalizeName(name)
    if (!norm) return { nutrition: null, level: 'none' }

    // L1 精确
    const hit = this.exact.get(norm)
    if (hit) return { nutrition: hit, level: 'L1', matchedName: hit.productName }

    // L2 双向包含，取最长匹配（避免「麦香鸡」误配「麦香鱼」）
    let best = null
    for (const n of this.items) {
      const cand = normalizeName(n.productName)
      if (!cand) continue
      if (cand.length < 2) continue
      if (norm.includes(cand) || cand.includes(norm)) {
        if (!best || cand.length > normalizeName(best.productName).length) {
          best = n
        }
      }
    }
    if (best) return { nutrition: best, level: 'L2', matchedName: best.productName }

    // L2b：剥离修饰前缀后再试
    for (const p of NOISE_PREFIX) {
      if (!norm.startsWith(p)) continue
      const stripped = norm.slice(p.length)
      const hit2 = this.exact.get(stripped)
      if (hit2) return { nutrition: hit2, level: 'L2', matchedName: hit2.productName }
      for (const n of this.items) {
        const cand = normalizeName(n.productName)
        if (cand.length >= 2 && cand.includes(stripped)) {
          return { nutrition: n, level: 'L2', matchedName: n.productName }
        }
      }
    }

    return { nutrition: null, level: 'none' }
  }

  /**
   * L3：套餐拆解
   * 关键：`rounds[].choices[]` 中 `isDefault === 1` 的即为 MCP 定义的默认搭配。
   * 套餐营养 = Σ(子项营养 × 数量)
   *
   * @param {object} detail query-meal-detail 的 data
   * @returns {{nutrition: object|null, level: string, components: Array}}
   */
  matchCombo(detail) {
    const rounds = detail?.rounds ?? []
    if (rounds.length === 0) return { nutrition: null, level: 'none', components: [] }

    const components = []
    let allResolved = true

    for (const round of rounds) {
      const choices = round.choices ?? []
      // 优先取默认搭配；无默认则取第一个
      const chosen =
        choices.find((c) => c.isDefault === 1) ?? choices.find((c) => c.quantity > 0) ?? choices[0]
      if (!chosen) {
        allResolved = false
        continue
      }

      const sub = this.matchSingle(chosen.name)
      if (sub.nutrition) {
        const qty = chosen.quantity || 1
        components.push({
          name: chosen.name,
          quantity: qty,
          matchedName: sub.matchedName,
          nutrition: sub.nutrition,
        })
      } else {
        // 酱料等非食品子项：跳过，不影响主体
        if (this.isNonFood(chosen.name)) {
          components.push({ name: chosen.name, quantity: chosen.quantity || 1, skipped: 'nonFood' })
        } else {
          allResolved = false
          components.push({ name: chosen.name, quantity: chosen.quantity || 1, unresolved: true })
        }
      }
    }

    if (components.length === 0) return { nutrition: null, level: 'none', components: [] }

    const sum = components
      .filter((c) => c.nutrition)
      .reduce(
        (acc, c) => {
          const q = c.quantity
          acc.energyKcal += c.nutrition.energyKcal * q
          acc.protein += c.nutrition.protein * q
          acc.fat += c.nutrition.fat * q
          acc.carbohydrate += c.nutrition.carbohydrate * q
          acc.sodium += c.nutrition.sodium * q
          return acc
        },
        { energyKcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0 },
      )

    const hasAny = sum.energyKcal > 0 || sum.protein > 0
    if (!hasAny) return { nutrition: null, level: 'none', components }

    const rounded = {
      energyKcal: Math.round(sum.energyKcal),
      protein: Math.round(sum.protein * 10) / 10,
      fat: Math.round(sum.fat * 10) / 10,
      carbohydrate: Math.round(sum.carbohydrate * 10) / 10,
      sodium: Math.round(sum.sodium),
    }

    // 套餐占用的品类槽位 = 各子项的品类（去重）
    // 注意：必须基于原始组件名计算，不能受"是否解析出营养"影响。
    // 例「可乐麦炫酷」在营养表中查不到（新品），但它确实占 drink 槽位，
    // 若因解析失败而漏掉，会导致「随心配(含汉堡) + 纯牛奶」这种重复消费被误判为可行。
    const slots = [
      ...new Set(
        components
          .filter((c) => !c.skipped)
          .map((c) => guessCategory({ name: c.name })),
      ),
    ].filter((s) => s !== 'sauce')

    return {
      nutrition: rounded,
      // 部分子项未解析时标 L3-partial，便于提示用户"仅供参考"
      level: allResolved ? 'L3' : 'L3-partial',
      components,
      slots,
    }
  }

  /**
   * 主入口：为一件商品对齐营养数据
   *
   * @param {string} code
   * @param {string} name
   * @param {number} price 元
   * @param {object|null} detail query-meal-detail 的 data（含 rounds）
   */
  resolve(code, name, price, detail) {
    this.stats.total++

    if (this.isNonFood(name)) {
      this.stats.skipped++
      return { code, name, price, excluded: 'nonFood', nutrition: null }
    }

    // 先看是不是套餐（rounds 有值且子项超过 1 个）
    const rounds = detail?.rounds ?? []
    if (rounds.length > 0) {
      const combo = this.matchCombo(detail)
      if (combo.nutrition) {
        // L3-partial 同样产出了可用的叠加营养值，必须计入，
        // 否则会出现"独立测试 30 个套餐成功，完整流程却只报 5 个"的统计矛盾。
        this.stats.l3++
        if (combo.level === 'L3-partial') this.stats.l3Partial++
        return {
          code,
          name,
          price,
          nutrition: combo.nutrition,
          level: combo.level,
          // 套餐占用的品类槽位：供求解器做去重，避免"套餐里已有汉堡再单点一个"
          categorySlots: combo.slots ?? [],
          components: combo.components.map((c) => ({
            name: c.name,
            quantity: c.quantity,
            matchedName: c.matchedName ?? null,
            unresolved: !!c.unresolved,
          })),
        }
      }
    }

    // 单品路径
    const single = this.matchSingle(name)
    if (single.nutrition) {
      if (single.level === 'L1') this.stats.l1++
      else this.stats.l2++
      return {
        code,
        name,
        price,
        nutrition: single.nutrition,
        level: single.level,
        matchedName: single.matchedName,
        categorySlots: [],
      }
    }

    this.stats.unresolved++
    return { code, name, price, unresolved: true, nutrition: null }
  }

  /** 命中率报告，用于 --live 模式可观测输出 */
  report() {
    const { total, l1, l2, l3, l3Partial, skipped, unresolved } = this.stats
    const matched = l1 + l2 + l3
    const considered = total - skipped
    return {
      total,
      l1,
      l2,
      l3,
      l3Partial,
      skipped,
      unresolved,
      matched,
      // 分母剔除"剔除非食品"：酱料/周边本就不该参与营养计算，计入分母会低估真实能力
      matchRate: considered > 0 ? Math.round((matched / considered) * 100) : 0,
    }
  }
}
