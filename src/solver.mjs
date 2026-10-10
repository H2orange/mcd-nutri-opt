/**
 * 约束求解器 —— 项目的核心算法
 *
 * 设计原则：
 *  1. 纯函数、无 IO、无 LLM 调用 → 可单元测试、结果可复现
 *  2. 不假装最优：采用"分层剪枝 + 帕累托前沿"策略，在可接受时间内给出近优解
 *  3. 约束越紧，剪枝越狠，越能保证质量
 *
 * 帕累托前沿定义：不存在另一个方案在"价格更低"和"蛋白更高"上同时不劣于当前方案。
 */

import { normalizeName } from './nutrition.mjs'
import { guessCategory, matchCategories } from './categories.mjs'

export { guessCategory }

/**
 * 麦当劳同一品类在菜单上有多种叫法，而用户心智中的"汉堡"是品类概念。
 * 品类定义统一维护在 categories.mjs，此处不再重复定义，避免两处漂移。
 */

/**
 * @typedef {object} Item
 * @property {string} code      门店商品编码
 * @property {string} name      商品名称
 * @property {number} price     单价（元，非分）
 * @property {number} energyKcal
 * @property {number} protein
 * @property {number} fat
 * @property {number} carbohydrate
 * @property {number} sodium
 */

/**
 * @typedef {object} Constraints
 * @property {number} [budget]         预算上限（元）
 * @property {number} [maxKcal]        热量上限（kcal）
 * @property {number} [minProtein]     蛋白下限（g）
 * @property {number} [maxSodium]      钠上限（mg）
 * @property {number} [maxItems]       最单品类数
 * @property {string[]} [exclude]      排除关键词
 * @property {string[]} [includeKeywords] 只含关键词（白名单）
 * @property {boolean} [allowCombo]    是否允许套餐类
 */

/** 求解结果 */
export class Solver {
  /**
   * @param {Item[]} items 候选商品
   * @param {Constraints} constraints
   */
  constructor(items, constraints = {}) {
    this.all = items
    this.c = {
      budget: Infinity,
      maxKcal: Infinity,
      minProtein: 0,
      maxSodium: Infinity,
      maxItems: 6,
      exclude: [],
      includeKeywords: null,
      allowCombo: true,
      // 仅用于调试对比；solve() 始终同时计算两种模式并取优
      strictSlots: true,
      ...constraints,
    }
    this.filtered = this.#applyFilter(items)
    this.rejected = this.#explainRejection(items, this.filtered)
  }

  #applyFilter(items) {
    const ex = this.c.exclude.map(normalizeName).filter(Boolean)
    const inc = this.c.includeKeywords?.map(normalizeName).filter(Boolean) ?? null

    // 白名单走子串双向包含即可；黑名单需支持品类级排除（见 shouldExclude）
    const hit = (norm, keys) => keys.some((k) => norm.includes(k) || k.includes(norm))

    // 在售商品名集合：用于区分"排除整个品类"与"排除某个单品"
    const itemNameSet = new Set(items.map((i) => normalizeName(i.name)))

    return items.filter((it) => {
      const n = normalizeName(it.name)
      if (!n) return false
      if (shouldExclude(n, ex, itemNameSet)) return false
      if (inc && !hit(n, inc)) return false
      if (it.price <= 0) return false
      return true
    })
  }

  #explainRejection(all, kept) {
    const keptCodes = new Set(kept.map((i) => i.code))
    return all
      .filter((i) => !keptCodes.has(i.code))
      .map((i) => ({ code: i.code, name: i.name, reason: '被排除关键词或价格异常' }))
  }

  /**
   * 主求解入口
   * @returns {{ feasible: boolean, pareto: object[], best: object|null, stats: object }}
   */
  solve() {
    const t0 = Date.now()
    const pool = this.filtered

    if (pool.length === 0) {
      return {
        feasible: false,
        pareto: [],
        best: null,
        stats: { candidates: 0, combos: 0, ms: 0, reason: '所有候选均被过滤' },
      }
    }

    const primary = this.#solveOnce(pool, { strictSlots: true })

    // 严格槽位（不重复品类）保证"搭配合理"，但可能错过更优解——
    // 例：某套餐已含汉堡，严格模式下再也无法搭配任何汉堡类高蛋白单品。
    // 因此默认**两种模式都跑，取更优者**，并标明该结果来自哪种策略。
    const relaxed = this.#solveOnce(pool, { strictSlots: false })

    const pick = (() => {
      if (primary.feasible && relaxed.feasible) {
        // 比较目标：先看蛋白是否都达标，再比价格
        const p = primary.best,
          r = relaxed.best
        if (!p) return { ...relaxed, strategy: 'relaxed' }
        if (!r) return { ...primary, strategy: 'strict' }
        const pOk = p.nutrition.protein >= (this.c.minProtein || 0)
        const rOk = r.nutrition.protein >= (this.c.minProtein || 0)
        if (rOk && !pOk) return { ...relaxed, strategy: 'relaxed' }
        return r.priceYuan < p.priceYuan
          ? { ...relaxed, strategy: 'relaxed' }
          : { ...primary, strategy: 'strict' }
      }
      if (primary.feasible) return { ...primary, strategy: 'strict' }
      if (relaxed.feasible) {
        return {
          ...relaxed,
          strategy: 'relaxed',
          degraded: {
            reason: '严格品类去重下无可行解，已放宽为允许同品类叠加',
            strictStats: primary.stats,
          },
        }
      }
      return { ...primary, relaxedAttempt: relaxed.stats }
    })()

    return pick
  }

  #solveOnce(pool, override = {}) {
    const t0 = Date.now()
    const strictSlots = override.strictSlots ?? this.c.strictSlots

    // 阶段一：按品类分组，避免同一品类重复堆叠（比如 5 个汉堡）
    const groups = this.#groupByCategory(pool)

    // 阶段二：DFS 枚举组合（带剪枝 + 槽位去重）
    const combos = []
    // 注意：maxDepth 不能被 groups.length 卡死。
    // 槽位去重后每组最多取1 个，但套餐类商品可能一个就占多个槽位，
    // 若maxDepth 取 min(maxItems, groups.length)，在早市（品类少）场景下
    // 会导致可行解被压到个位数、蛋白目标无法达成。
    // 因此允许 maxItems 优先，只有商品总数不足时才收缩。
    const maxDepth = Math.min(this.c.maxItems, pool.length)
    const occupied = new Set()

    const dfs = (startGroup, acc, currentPrice) => {
      combos.push({
        items: acc.map((x) => x.item),
        nutrition: sumNutrition(acc),
        priceYuan: round2(acc.reduce((s, x) => s + x.item.price, 0)),
      })

      if (acc.length >= maxDepth) return

      for (let i = startGroup; i < groups.length; i++) {
        const group = groups[i]
        for (const item of group.items) {
          // 该商品会占用哪些槽位
          const slots = this.#slotsOf(item)

          // 槽位冲突剪枝：套餐内已有汉堡，就不再叠加单点汉堡。
          // 默认开启；strictSlots=false 时关闭，用于品类稀疏场景。
          if (strictSlots && slots.some((s) => occupied.has(s))) continue

          const nextPrice = currentPrice + item.price
          // 价格剪枝：组内已按价格升序，超预算即可 break
          if (nextPrice > this.c.budget) break

          for (const s of slots) occupied.add(s)
          const entry = { item, slots }
          acc.push(entry)
          dfs(i + 1, acc, nextPrice)
          acc.pop()
          for (const s of slots) occupied.delete(s)
        }
      }
    }

    dfs(0, [], 0)

    // 阶段三：过滤可行解
    const feasible = combos.filter((c) => this.#satisfies(c))

    // 阶段四：算帕累托前沿
    const front = paretoFront(feasible)

    const stats = {
      candidates: pool.length,
      combos: combos.length,
      feasible: feasible.length,
      front: front.length,
      groups: groups.length,
      ms: Date.now() - t0,
    }

    return {
      feasible: feasible.length > 0,
      pareto: front,
      best: pickBest(front, this.c),
      stats,
    }
  }

  #satisfies(combo) {
    const n = combo.nutrition
    if (combo.priceYuan > this.c.budget + 1e-9) return false
    if (n.energyKcal > this.c.maxKcal) return false
    if (n.protein < this.c.minProtein) return false
    if (n.sodium > this.c.maxSodium) return false
    return true
  }

  /**
   * 品类分组：靠分类标签 + 名称启发式识别"同品类"
   * 目的：避免 3 个汉堡 + 2 个薯条这种无意义组合爆炸
   *
   * 关键：套餐类商品会展开成它自己的子项品类集合。
   * 例「人气经典随心配」= 双层吉士汉堡 + 可乐麦炫酷，
   * 则它占用 burger + drink 两个槽位，避免再叠加单点汉堡造成重复消费。
   */
  #groupByCategory(pool) {
    const buckets = new Map()

    for (const it of pool) {
      const key = guessCategory(it)
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(it)
    }

    // 组内按价格升序，配合上层 break 剪枝生效
    const groups = [...buckets.entries()]
      .map(([name, items]) => ({
        name,
        items: items.slice().sort((a, b) => a.price - b.price),
      }))
      // 先处理候选多的组，组合覆盖更均匀
      .sort((a, b) => b.items.length - a.items.length)

    return groups
  }

  /**
   * 计算商品实际占用的品类槽位。
   * 套餐 → 展开为子项品类集合；单品 → 自身品类。
   */
  #slotsOf(item) {
    if (item.categorySlots && item.categorySlots.length > 0) return item.categorySlots
    return [guessCategory(item)]
  }
}

function sumNutrition(acc) {
  return acc.reduce(
    (s, x) => ({
      energyKcal: s.energyKcal + (x.item.energyKcal || 0),
      protein: s.protein + (x.item.protein || 0),
      fat: s.fat + (x.item.fat || 0),
      carbohydrate: s.carbohydrate + (x.item.carbohydrate || 0),
      sodium: s.sodium + (x.item.sodium || 0),
    }),
    { energyKcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0 },
  )
}

/**
 * 排除逻辑：区分「品类意图」与「单品意图」。
 *
 * 用户说「不要汉堡」——汉堡是品类词，应排除整个 burger 品类，
 *   包括不含"汉堡"二字的「巨无霸」「板烧鸡腿堡」（早期漏掉巨无霸是 bug）。
 * 用户说「不要巨无霸」——巨无霸是具体单品，只排除该单品，
 *   不能连带排除其他汉堡（否则「巨无霸」既当品类又当单品，语义自相矛盾）。
 *
 * 判定依据：品类关键词表里同时包含品类词与代表单品名，
 * 因此若排除词**本身就是一个在售商品名**，按单品意图处理；
 * 否则按品类意图处理。
 */
function shouldExclude(nameNorm, excludeKeywords, itemNameSet) {
  if (excludeKeywords.length === 0) return false

  for (const k of excludeKeywords) {
    // 直接子串命中（含反向，"薯条"命中"中薯条"）
    if (nameNorm.includes(k) || k.includes(nameNorm)) return true
  }

  for (const k of excludeKeywords) {
    // 单品意图：排除词本身就是某个在售商品名 → 只排除该单品（上面的子串匹配已处理）
    if (itemNameSet.has(k)) continue

    // 品类意图：排除词能唯一映射到某个品类 → 排除该品类全部商品
    const hitCats = matchCategories(k)
    if (hitCats.length !== 1) continue
    if (matchCategories(nameNorm).includes(hitCats[0])) return true
  }

  return false
}

const round2 = (n) => Math.round(n * 100) / 100

/**
 * 帕累托前沿（价格越低越好，蛋白越高越好）
 * 时间复杂度 O(n²)，n 通常在数千量级内可接受
 */
export function paretoFront(combos) {
  if (combos.length === 0) return []

  const sorted = combos
    .slice()
    .sort((a, b) => a.priceYuan - b.priceYuan || b.nutrition.protein - a.nutrition.protein)

  const front = []
  let maxProtein = -Infinity

  for (const c of sorted) {
    if (c.nutrition.protein > maxProtein) {
      front.push(c)
      maxProtein = c.nutrition.protein
    }
  }
  return front
}

/**
 * 从前沿中挑"最推荐"的：满足蛋白下限的前提下价格最低；
 * 若都不满足蛋白下限，则选蛋白最高的。
 */
export function pickBest(front, constraints) {
  if (front.length === 0) return null

  const minP = constraints.minProtein || 0
  const meeting = front.filter((c) => c.nutrition.protein >= minP)

  if (meeting.length > 0) {
    return meeting.reduce((best, c) => (c.priceYuan < best.priceYuan ? c : best))
  }

  return front.reduce((best, c) =>
    c.nutrition.protein > best.nutrition.protein ? c : best,
  )
}

/**
 * 计算性价比指标：每元蛋白克数，用于展示
 */
export function proteinPerYuan(combo) {
  if (!combo.priceYuan) return 0
  return Math.round((combo.nutrition.protein / combo.priceYuan) * 10) / 10
}
