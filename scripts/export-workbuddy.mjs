/**
 * 导出 WorkBuddy 对话上下文为 workbuddy.md
 *
 * 麦当劳大赛要求：提交 workbuddy.md 用于核验是否真实使用了 WorkBuddy 开发。
 * 官方说明：「使用 WorkBuddy 开发时的对话上下文，可自行导出」
 *
 * 用法:
 *   node scripts/export-workbuddy.mjs            # 自动定位本项目会话
 *   node scripts/export-workbuddy.mjs <jsonl路径> # 指定会话文件
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'workbuddy.md')
// 不硬编码用户目录：优先读环境变量，其次从 HOME 推导
const WB_ROOT = process.env.WORKBUDDY_HOME || (process.env.USERPROFILE || process.env.HOME) + "/.workbuddy"
const SESSION_DIR = join(WB_ROOT, 'projects', 'e-vibeCoding-McDonald')

/** 定位本项目的会话文件（取最近修改的 .jsonl） */
function locateSession() {
  const explicit = process.argv[2]
  if (explicit) return explicit

  if (!existsSync(SESSION_DIR)) {
    console.error(`未找到会话目录: ${SESSION_DIR}`)
    process.exit(1)
  }

  const files = readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, p: join(SESSION_DIR, f), mtime: statSync(join(SESSION_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)

  if (files.length === 0) {
    console.error('会话目录中没有 .jsonl 文件')
    process.exit(1)
  }
  return files[0].p
}

/**
 * 凭据与身份信息脱敏 —— 必须做。
 *
 * 官方 CONTEST_DECLARATION.md 的「信息安全声明」明确要求：
 * 参赛材料不得包含真实 Token、密钥、密码、账号凭证。
 * 而对话中往往会直接粘贴 Token 或身份信息（本次开发即如此），
 * 若不过滤，导出的 workbuddy.md 会把它们带进公开仓库。
 *
 * 注意：不能只脱敏 Token —— 用户名、中文姓名、手机号同样属于个人身份信息，
 * 且一旦提交进 git 历史就很难彻底清除（需重写历史）。
 */
function redactSecrets(text) {
  let t = text

  // 32 位以上无分隔的 token（麦当劳 MCP Token 为 32 位）
  t = t.replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED_TOKEN]')

  // 手机号（含带区号/分隔符的各种写法）
  // 注意：必须在邮箱脱敏之前处理，否则形如 [REDACTED_PHONE]@example.com
  // 的组合会残留域名后缀
  t = t.replace(/\b1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}\b/g, '[REDACTED_PHONE]')

  // 邮箱：排除 GitHub 隐私邮箱（那是推荐做法，保留）
  t = t.replace(/\b[\w.+-]+@(?!users\.noreply\.github\.com)[\w-]+\.[\w.]+\b/g, (m) => {
    if (m.includes('[REDACTED')) return m
    return '[REDACTED_EMAIL]'
  })

  // 残留的邮箱域名后缀（脱敏后可能剩下裸域名）
  t = t.replace(/\[REDACTED_PHONE\]@[\w.-]+/g, '[REDACTED_EMAIL]')
  t = t.replace(/@[a-z0-9-]+\.(com|cn|net|org|io|cc)\b(?![a-z])/gi, (m) => {
    // 保留 noreply 域名
    if (m.includes('users.noreply')) return m
    return '[REDACTED_DOMAIN]'
  })

  // Windows 用户名路径：C:/Users/<name>/ 或 C:\Users\<name>\
  t = t.replace(/([A-Za-z]:[/\\])Users[/\\]([A-Za-z0-9._-]+)([/\\])/g, '$1Users[/\\][REDACTED_USER]$3')

  // 裸的中文姓名难以自动识别，这里只处理显式的"姓名：xxx"标注形式
  t = t.replace(/(姓\s*名|真实姓名)\s*[:：]\s*[\u4e00-\u9fa5]{2,4}/g, '$1：[REDACTED_NAME]')

  return t
}

/**
 * 已知身份值精确替换
 *
 * 通用正则无法可靠识别裸文本形式的姓名与 Windows 用户名（如对话中直接写出
 * 某个姓名），因此需要维护一份已知敏感值清单。
 *
 * 配置位置：.env 的 REDACT_VALUES（逗号分隔）。该文件已被 .gitignore 排除，
 * **不要把敏感值写进本代码** —— 注释和字面量都会进git 历史。
 */
function readEnvValues() {
  const p = join(ROOT, '.env')
  if (!existsSync(p)) return ''
  const line = readFileSync(p, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('REDACT_VALUES='))
  return line ? line.slice('REDACT_VALUES='.length).trim() : ''
}

const KNOWN_SENSITIVE = readEnvValues()
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length >= 3)

function redactKnownValues(text) {
  let t = text
  for (const v of KNOWN_SENSITIVE) {
    if (!v || v.length < 3) continue
    // 转义正则特殊字符
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    t = t.replace(new RegExp(escaped, 'g'), '[REDACTED]')
  }
  return t
}

/** 去掉系统注入的噪声，只保留用户真实输入与助手输出 */
function cleanText(text, role) {
  let t = text

  // 去掉系统提醒块（user 消息里会注入 system-reminder / identity_context）
  t = t.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '')
  t = t.replace(/<identity_context>[\s\S]*?<\/identity_context>/g, '')
  t = t.replace(/<product_identity>[\s\S]*?<\/product_identity>/g, '')
  t = t.replace(/<connector-status>[\s\S]*?<\/connector-status>/g, '')
  t = t.replace(/<additional_data>[\s\S]*?<\/additional_data>/g, '')
  t = t.replace(/<current-expert>[\s\S]*?<\/current-expert>/g, '')
  t = t.replace(/<craft_mode>[\s\S]*?<\/craft_mode>/g, '')
  t = t.replace(/<memory_and_skills_reminder>[\s\S]*?<\/memory_and_skills_reminder>/g, '')

  // 去掉注入的项目结构快照（很长且与对话无关）
  t = t.replace(/<project_layout>[\s\S]*?<\/project_layout>/g, '')

  // 脱敏凭据与身份信息（必须在所有清理之后、写出之前）
  t = redactSecrets(t)
  t = redactKnownValues(t)

  return t.trim()
}

/** 判断是否为用户真实输入（而非系统注入） */
function isRealUserText(text) {
  const t = text.trim()
  if (!t) return false
  if (t.startsWith('<system-reminder')) return false
  if (t.startsWith('<user_query>')) return true
  return false
}

function extractUserQuery(text) {
  const m = text.match(/<user_query>([\s\S]*?)<\/user_query>/)
  return m ? m[1].trim() : null
}

function main() {
  const sessionPath = locateSession()
  const lines = readFileSync(sessionPath, 'utf8').split('\n').filter(Boolean)

  const turns = []
  for (const line of lines) {
    let j
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    if (j.type !== 'message') continue

    const raw = (j.content || [])
      .map((c) => c.text || '')
      .join('\n')
      .trim()
    if (!raw) continue

    if (j.role === 'user') {
      const query = extractUserQuery(raw)
      if (query) turns.push({ role: 'user', text: cleanText(query, 'user') })
      continue
    }

    if (j.role === 'assistant') {
      const t = cleanText(raw, 'assistant')
      // 过滤纯展示型回复（show_widget 的引导语等），保留有实质内容的
      if (!t || t.length < 2) continue
      turns.push({ role: 'assistant', text: t })
    }
  }

  if (turns.length === 0) {
    console.error('未解析到有效对话，请检查会话文件路径')
    process.exit(1)
  }

  const md = `# WorkBuddy 开发上下文

> 本文件记录本项目（麦麦最优解 McdNutriOpt）的开发过程，
> 用于证明项目真实使用腾讯 WorkBuddy 智能体开发。
>
> 活动：2026 麦当劳程序员创意开发大赛
> 会话文件：${sessionPath.replace(/^.*[/\\]/, '')}
> 导出时间：${new Date().toLocaleString('zh-CN')}
> 对话轮次：${turns.filter((t) => t.role === 'user').length} 轮提问 / ${turns.length} 条消息

---

## 开发要点回顾

本次开发中，WorkBuddy 完成了以下工作：

1. **活动规则调研**：检索麦当劳官方 GitHub（M-China组织），
   发现关键信息——本赛事按 **GitHub 公开 Star 数排名**而非评委打分，
   据此确定"Star 转化率优先"的项目策略。

2. **MCP 逆向探查**：编写探针脚本逐个调用35 个 MCP Tool，
   摸清真实返回结构，识别出7 个文档未说明的陷阱
   （如 \`query-nearby-stores\` 的 \`searchType\` 默认值陷阱、
   \`calculate-price\` 用 \`productCode\` 而 \`query-meal-detail\` 用 \`code\`、
   价格单位为分、\`list-nutrition-foods\` 的 \`nutritionDescription\` 字段混入商品名）。

3. **数据对齐设计**：实测发现菜单 83 项与营养表直接匹配命中率仅 15%，
   设计四级降级链（L1 精确 / L2 双向包含 / L3 套餐拆解 / L4 剔除非食品），
   将命中率提升至 79%。

4. **算法实现与调试**：实现约束求解器（DFS +剪枝 + 帕累托前沿），
   通过单元测试定位并修复 6 个实现缺陷，其中 3 个属于会静默产生错误结果的数据对齐bug。

5. **全链路验证**：离线模式与在线模式（真实门店数据）均跑通，
   求解耗时 126ms，输出 12 个帕累托最优解。

---

## 完整对话记录

`

  const body = turns
    .map((t) => {
      const label = t.role === 'user' ? '**用户**' : '**WorkBuddy**'
      return `${label}\n\n${t.text}\n`
    })
    .join('\n---\n\n')

  writeFileSync(OUT, md + body, 'utf8')

  const size = (Buffer.byteLength(md + body) / 1024).toFixed(1)
  console.log(`已导出 ${turns.length} 条消息 → workbuddy.md (${size} KB)`)
  console.log(
    `用户提问 ${turns.filter((t) => t.role === 'user').length} 轮，助手回复 ${turns.filter((t) => t.role === 'assistant').length} 条`,
  )
}

main()