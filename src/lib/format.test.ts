// 真实导入 formatCompletedAt 并断言行为。
// 运行：TZ=Asia/Shanghai npx tsx src/lib/format.test.ts
// 目的：证明 formatCompletedAt 真的把 RFC3339/毫秒时间戳格式化为【本地时区】 YYYY-MM-DD HH:mm，
//       且对空值/非法值返回 ''。
import { formatCompletedAt } from './format.ts'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++
    console.log('  PASS: ' + msg)
  } else {
    failed++
    console.error('  FAIL: ' + msg)
  }
}

// 独立的本地时区格式化（用本地 getter，与待测函数实现一致但独立计算，作为基准对照）
function localStr(value: string | number): string {
  const d = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 独立的 UTC 格式化（用于证明函数用的是本地时间而非 UTC）
function utcStr(value: string | number): string {
  const d = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

const FMT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/

console.log('# Test formatCompletedAt')

// 1) RFC3339 字符串 -> 本地时区 YYYY-MM-DD HH:mm
const rfc = '2026-08-06T12:34:56.789Z'
const out1 = formatCompletedAt(rfc)
assert(FMT_RE.test(out1), `RFC3339 输出符合格式 ^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$  (got "${out1}")`)
assert(out1 === localStr(rfc), `RFC3339 输出等于本地时区基准 "${localStr(rfc)}"  (got "${out1}")`)
// 关键：在 Asia/Shanghai(UTC+8) 下 12:34Z 应为本地 20:34，而非 UTC 12:34 —— 证明用的是本地时间
assert(out1 === '2026-08-06 20:34', `RFC3339 在 UTC+8 下渲染为本地 20:34  (got "${out1}")`)
assert(out1 !== utcStr(rfc), `RFC3339 输出不等于 UTC 串 "${utcStr(rfc)}" —— 证明不是 UTC 时间  (got "${out1}")`)

// 2) 毫秒时间戳 -> 本地时区
const ms = Date.UTC(2026, 7, 6, 12, 34, 56) // 2026-08-06T12:34:56Z
const out2 = formatCompletedAt(ms)
assert(FMT_RE.test(out2), `毫秒时间戳 输出符合格式  (got "${out2}")`)
assert(out2 === localStr(ms), `毫秒时间戳 输出等于本地时区基准 "${localStr(ms)}"  (got "${out2}")`)
assert(out2 === '2026-08-06 20:34', `毫秒时间戳 在 UTC+8 下渲染为本地 20:34  (got "${out2}")`)

// 3) 空值/未定义/null -> ''
assert(formatCompletedAt('') === '', '空字符串 -> \'\'')
assert(formatCompletedAt(undefined as any) === '', 'undefined -> \'\'')
assert(formatCompletedAt(null as any) === '', 'null -> \'\'')

// 4) 非法字符串 -> ''
assert(formatCompletedAt('not-a-date') === '', '非法字符串 "not-a-date" -> \'\'')

console.log(`\n# Result: ${passed} passed, ${failed} failed`)
if (failed > 0) throw new Error(`${failed} assertion(s) failed`)
