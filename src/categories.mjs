/**
 * 品类识别 —— solver 与 matcher 共用，避免循环依赖。
 *
 * 麦当劳的品类没有官方字段，只能从名称与分类标签启发式判断。
 * 规则按优先级顺序匹配，先命中先返回。
 */

const CATEGORY_RULES = [
  // 酱料等非食品要在最前面拦掉，否则「韩式甜辣酱」会被当成 side
  { key: 'sauce', label: '酱料', patterns: [/酱$/, /^酱/, /酱料/, /^.*风味酱$/] },
  { key: 'combo', label: '套餐', patterns: [/三件套/, /四件套/, /双件套/, /套餐/, /随心配/, /分享餐/, /小食盘/, /拼盘/, /^99\d{6}$/, /精选/] },
  { key: 'drink', label: '饮料', patterns: [/可乐/, /雪碧/, /红茶/, /绿茶/, /咖啡/, /美式/, /拿铁/, /奶铁/, /牛奶/, /豆浆/, /果汁/, /怡泉/, /麦旋酷/, /奶昔/, /^水$/, /气泡/] },
  { key: 'dessert', label: '甜品', patterns: [/新地/, /派$/, /麦旋风/, /雪冰/, /冰激凌/, /冰淇淋/, /奶冻/, /曲奇/, /蛋筒/, /圣代/] },
  { key: 'side', label: '小食', patterns: [/薯条/, /薯饼/, /玉米杯/, /鸡翅/, /V翅/, /油条/, /肉卷/, /营养卷/, /鸡块/, /麦乐鸡/, /脆汁鸡/, /趣鸡球/, /鸡柳/, /脆薯/] },
  // 关键：需覆盖不含"汉堡/堡"字样的商品名，否则「排除汉堡」会漏掉巨无霸这类经典款
  { key: 'burger', label: '汉堡', patterns: [/汉堡/, /堡$/, /麦满分/, /牛堡/, /鸡腿堡/, /鱼堡/, /^巨无霸$/, /双层.*堡/, /鳕鱼堡/, /安格斯/, /深海/, /蔬萃/] },
  { key: 'chicken', label: '鸡肉', patterns: [/鸡/, /翅/, /堡堡/] },
]

/**
 * 品类同义词：用户心智中的品类名与菜单实际叫法不完全一致，
 * 「排除汉堡」必须能命中「巨无霸」这种不含"汉堡"二字的经典款。
 */
const CATEGORY_KEYWORDS = {
  burger: ['汉堡', '巨无霸', '堡', '麦满分', '牛堡', '鸡腿堡', '鱼堡', '安格斯', '鳕鱼', '蔬萃'],
  chicken: ['鸡', '翅', '鸡腿', '脆汁鸡'],
  side: ['小食', '薯条', '薯饼', '玉米杯', '鸡翅', '油条', '趣鸡球'],
  drink: ['饮料', '可乐', '雪碧', '咖啡', '牛奶', '豆浆', '红茶', '果汁', '奶昔'],
  dessert: ['甜品', '新地', '派', '麦旋风', '冰淇淋', '雪冰', '奶冻'],
  combo: ['套餐', '件套', '随心配', '分享餐'],
  sauce: ['酱料', '酱'],
}

/**
 * 判断名称是否属于某品类（用于排除逻辑）
 * @param {string} name 商品名
 * @param {string} categoryKey 品类键
 */
export function isCategoryOf(name, categoryKey) {
  const n = String(name || '')
  const kws = CATEGORY_KEYWORDS[categoryKey]
  if (!kws) return false
  return kws.some((k) => n.includes(k) || k.includes(n))
}

/** 名称 → 命中的品类键列表（一个商品可能同时属于多个，如套餐含汉堡） */
export function matchCategories(name) {
  const n = String(name || '')
  return Object.keys(CATEGORY_KEYWORDS).filter((k) =>
    CATEGORY_KEYWORDS[k].some((kw) => n.includes(kw)),
  )
}

// 套餐编码段是强信号。实测麦当劳套餐编码形如 9900015902 / 9900013304 / 9900005456，
// 均为9900 开头，因此不能写死长度（早期写成 /^99\d{6}$/ 会漏掉绝大多数）。
const COMBO_CODE = /^99\d{6,}$/

export function guessCategory(item) {
  const n = String(item?.name || '')

  // 套餐编码段（9900xxxx / 9901xxxx）是强信号
  if (COMBO_CODE.test(String(item?.code ?? ''))) return 'combo'

  for (const r of CATEGORY_RULES) {
    if (r.patterns.some((p) => p.test(n))) return r.key
  }
  return 'other'
}

export const CATEGORY_LABELS = Object.fromEntries(
  CATEGORY_RULES.map((r) => [r.key, r.label]).concat([['other', '其他']]),
)
