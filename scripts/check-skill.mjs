/**
 * SKILL.md 格式校验。
 * Skill 结构约定：YAML frontmatter（name + description）+ Markdown 正文。
 *
 * 用法: node scripts/check-skill.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(ROOT, 'SKILL.md')

let problems = 0
const fail = (m) => {
  problems++
  console.log(`  [X] ${m}`)
}
const pass = (m) => console.log(`  [OK] ${m}`)

if (!existsSync(FILE)) {
  console.error('SKILL.md 不存在')
  process.exit(1)
}

const s = readFileSync(FILE, 'utf8')
console.log(`=== SKILL.md 检查 ===`)
console.log(`  大小: ${(s.length / 1024).toFixed(1)} KB`)

// 1. frontmatter
const fm = /^---\n([\s\S]*?)\n---\n/.exec(s)
if (!fm) {
  fail('缺少 YAML frontmatter（首行应为 ---）')
} else {
  pass('frontmatter 格式正确')
  const block = fm[1]

  // 2. name
  const name = /^name:\s*(.+)$/m.exec(block)
  if (!name) fail('缺少 name 字段')
  else {
    console.log(`  name: ${name[1]}`)
    // 建议用小写连字符
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name[1].trim())) {
      fail(`name 建议用小写字母+连字符: ${name[1]}`)
    } else pass('name 命名规范')
  }

  // 3. description
  const desc = /^description:\s*([\s\S]+?)$/m.exec(block)
  if (!desc) fail('缺少 description 字段')
  else {
    const d = desc[1]
    console.log(`  description: ${d.length} 字`)
    if (d.length < 50) fail('description 过短，模型难以据此判断何时触发')
    else pass('description 长度充足')
    if (d.includes('\n')) fail('description 必须单行（YAML 折叠会破坏解析）')
    else pass('description 为单行')
    if (!/触发词|trigger|when/i.test(d)) {
      console.log('  [!] 建议在 description 中包含触发词，提升被唤醒的概率')
    } else pass('含触发词')
  }

  // 4. 必需的字段不被其他字段占用
  if (/^agent_created:/m.test(block)) pass('含 agent_created 标记')
}

// 5. 正文章节
const sections = s.split('\n').filter((l) => l.startsWith('## '))
console.log(`  章节数: ${sections.length}`)
sections.forEach((x) => console.log(`    ${x.replace('## ', '')}`))

// 6. 关键内容完整性
const required = [
  ['何时使用', /## 何时使用/],
  ['调用方式/快速开始', /## 快速开始|## 何时使用/],
  ['参数说明', /## 完整参数|参数/],
  ['结果解读', /## 结果怎么读|结果/],
  ['数据可信度', /可信度|部分解析/],
  ['免责声明', /免责声明|不构成医疗/],
]
console.log('')
required.forEach(([name, re]) => {
  re.test(s) ? pass(`${name} 已覆盖`) : fail(`缺少「${name}」章节`)
})

console.log(`\n${problems === 0 ? '全部检查通过' : problems + ' 项问题'}`)
process.exit(problems === 0 ? 0 : 1)