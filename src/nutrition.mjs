/**
 * 营养数据解析器
 *
 * MCP `list-nutrition-foods` 返回的是自定义文本格式：
 *   "[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n 猪柳麦满分,null,1288,308,16,16,24,781,213\n ..."
 *
 * 坑1：productName 本身可能含英文逗号（如 "冰美式中杯" 没问题，但
 *      "浓缩咖啡" 之类还好；真正的问题是商品名里带引号如 「“苹板”支撑Pro」）
 * 坑2：nutritionDescription 字段会被塞进商品名，例如
 *      「纯悦」→ "能量约清水1杯"，「芝士安格斯厚牛堡」→ "能量约鲈鱼1条"
 *      所以不能靠"description 为 null"来判断字段位置，必须按逗号从右往左定锚。
 *
 * 解析策略：从行尾反向锚定 8 个纯数字（energyKj..calcium），
 * 剩余部分再从左取 productName，剩下的逗号段归给 nutritionDescription。
 */

const NUM_FIELDS = [
  'energyKj',
  'energyKcal',
  'protein',
  'fat',
  'carbohydrate',
  'sodium',
  'calcium',
]

/**
 * @param {string} raw MCP structuredContent.data 的原始字符串
 * @returns {Array<object>} 营养条目
 */
export function parseNutrition(raw) {
  if (!raw || typeof raw !== 'string') return []

  // 去掉表头 "[160]{...}:" 之前的部分
  const body = raw.includes('}:') ? raw.slice(raw.indexOf('}:') + 2) : raw

  const items = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const parsed = parseLine(line)
    if (parsed) items.push(parsed)
  }
  return items
}

function parseLine(line) {
  // 1. 从右往左锚定 8 个数字字段
  const parts = line.split(',')
  if (parts.length < 9) return null

  const nums = []
  let cursor = parts.length - 1
  for (let i = 0; i < NUM_FIELDS.length; i++) {
    const v = parts[cursor]?.trim()
    if (v === undefined || v === '' || !/^-?\d+(\.\d+)?$/.test(v)) return null
    nums.unshift(Number(v))
    cursor--
  }

  // 2. 剩余头部 = productName(, nutritionDescription)?
  const head = parts.slice(0, cursor + 1).join(',').trim()
  if (!head) return null

  // productName 是第一个逗号前的部分；其余归 description
  const firstComma = head.indexOf(',')
  const rawName = (firstComma >= 0 ? head.slice(0, firstComma) : head).trim()
  const productName = rawName === 'null' ? '' : rawName

  // MCP 用字面字符串 "null" 表示空值，需转成真正的 null
  let desc = firstComma >= 0 ? head.slice(firstComma + 1).trim() : ''
  if (desc === 'null') desc = ''

  if (!productName) return null

  const item = { productName, nutritionDescription: desc || null }
  NUM_FIELDS.forEach((f, i) => {
    item[f] = nums[i]
  })
  return item
}

/**
 * 计算一份食物的营养密度，用于求解器排序。
 * 每 100kcal 的蛋白 grams —— 同热量下蛋白越高越"划算"
 */
export function proteinDensity(item) {
  if (!item || item.energyKcal <= 0) return 0
  return (item.protein / item.energyKcal) * 100
}

/**
 * 归一化名称用于跨源匹配：菜单名 vs 营养表名
 * "麦辣鸡腿汉堡" vs "麦辣鸡腿汉堡" → ok
 * "板烧鸡腿堡" vs "原味板烧鸡腿堡" → 需包含匹配
 */
export function normalizeName(name) {
  return String(name || '')
    .replace(/[\s　]/g, '')
    .replace(/[（(].*?[)）]/g, '')
    .trim()
}
