// dsh-mind 装配冒烟测试：用 mock ctx 验证 apply() 能被 DSH 宿主正确驱动
// （工具注册/HTTP 注册/注入灰度默认关/mood 归档导入），全程离线、临时目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mind-home-'))
process.env.DSH_HOME = HOME

// 预置一个 mood 归档（验证导入链路）
const moodData = path.join(HOME, 'mood-data')
fs.mkdirSync(moodData, { recursive: true })
fs.writeFileSync(path.join(moodData, 'dsh-mood-memory.jsonl'),
  JSON.stringify({ id: 'a1', t: 1792067106123, s: 'sess', k: 'u', x: '用户说他最近在准备面试，有点紧张' }))
fs.writeFileSync(path.join(moodData, 'dsh-mood.json'), JSON.stringify({
  current: { id: 'happy', label: '开心' },
}))
fs.writeFileSync(path.join(HOME, 'dsh-mood-store.json'), JSON.stringify({ default: moodData }))

const { name, apply } = await import('../index.js')

function makeCtx() {
  const registered = { tools: [], http: null, sections: [] }
  const ctx = {
    get(key) {
      if (key === 'tools') return { register(def) { registered.tools.push(def) } }
      if (key === 'web') return { register(o) { registered.http = o } }
      return undefined
    },
    effect(fn) { fn() },
    systemPrompt: {
      section(s) { registered.sections.push(s) },
    },
  }
  return { ctx, registered }
}

test('apply 装配（融合契约）：mood 系工具保留原名 + mind_* 并存 + news 排除 + memory 重指向 SQLite', async () => {
  const { ctx, registered } = makeCtx()
  const api = apply(ctx, { dataDir: path.join(HOME, 'mind-data') })
  assert.equal(name, 'dsh-mind')
  const toolNames = registered.tools.map((t) => t.name).sort()
  assert.deepEqual(toolNames, ['diary', 'memory', 'mind_memory', 'mind_sleep', 'mood', 'qq_speak', 'taste'],
    '融合契约：mood 系原名保留 + mind_* 新增 + qq_speak（语音）+ news 排除')
  assert.equal(registered.http.path, '/dsh-mind-api')
  // ⚠️ 语义变更（支持面板热开关）：
  //    原来 inject=false 时**不注册**这个节 —— 但那样注册与否是启动时决定的，
  //    面板改了开关必须重启才生效。现在恒定注册，由 text() 返回空串来关闭。
  //    所以断言改成：关闭时 text() 必须为空（真正的约束）。
  const injectOff = registered.sections.filter((s) => s.name === 'dsh-mind/inject')
  assert.equal(injectOff.length, 1, 'inject 节应恒定注册（热开关需要）')
  assert.equal(injectOff[0].text(), '', 'inject 默认 false：text() 必须返回空串（不注入）')

  // mood 归档被导入 SQLite
  const r = api.store.search('面试', { k: 5, minScore: 0.1 })
  assert.equal(r.length, 1, 'mood 归档应导入并可检索')
  assert.equal(r[0].source, 'mood-archive')

  // DSH 0.2.1 契约：每个工具必须有 output { schema, render }
  for (const t of registered.tools) {
    assert.ok(t.output && typeof t.output.render === 'function', `工具 ${t.name} 缺 output.render（会被 DSH 注册拒绝）`)
    assert.ok(t.parameters && t.parameters.type === 'object', `工具 ${t.name} 的 parameters 应为编译后 object schema`)
  }

  // 重指向后的 memory 工具（同名）实际查 SQLite（defineTool 包装后 execute 为 async——DSH 本就 await）
  const out = await registered.tools.find((t) => t.name === 'memory').execute({ action: 'search', query: '面试' })
  assert.equal(out.ok, true)
  assert.equal(out.hits.length, 1, 'memory 工具应命中 SQLite 里导入的归档')

  // mind_memory 工具可执行
  const out2 = await registered.tools.find((t) => t.name === 'mind_memory').execute({ action: 'search', query: '面试' })
  assert.equal(out2.ok, true)
  assert.equal(out2.hits.length, 1)

  // HTTP state 路由可跑
  let body = ''
  const res = { writeHead() {}, end(s) { body = s } }
  registered.http.handler({ url: '/dsh-mind-api/state', method: 'GET', headers: {} }, res)
  const j = JSON.parse(body)
  assert.equal(j.ok, true)
  assert.equal(j.sleep.state, 'awake')
  assert.ok(j.stats.total >= 1)
})

test('apply 开启注入后：mood 各节 + dsh-mind/inject 并存，news 节被排除，text() 有输出', () => {
  const { ctx, registered } = makeCtx()
  apply(ctx, { dataDir: path.join(HOME, 'mind-data-inject'), inject: true })
  const names = registered.sections.map((s) => s.name)
  assert.ok(names.includes('dsh-mind/inject'), '应有 dsh-mind/inject 节')
  assert.ok(names.some((n) => String(n).startsWith('dsh-mood/')), 'mood 各节应保留（情绪/日记/经验卡/品味）')
  assert.ok(!names.includes('dsh-mood/news'), 'news 节必须被排除（PRD）')
  const injectSection = registered.sections.find((s) => s.name === 'dsh-mind/inject')

  // moodLine() 读 $DSH_HOME/dsh-mood.json —— 夹具里没有就返回空串，
  // 注入块里自然不会有【心情】。所以先造一份最小状态文件。
  const moodFile = path.join(HOME, 'dsh-mood.json')
  fs.writeFileSync(moodFile, JSON.stringify({ current: 'calm', values: { calm: 60 } }))

  const text = injectSection.text()
  assert.ok(text.includes('【心情】'), '心情行应注入（已提供 mood 状态文件）')
})

// ── 回归：融合面板必须能挂上 mood 的管理路由 ──
//
// 线上曾经的现象：面板只有星图，心情/日记/经验卡/品味四块完全没有界面。
// 根因是 moodCtx.inject 里对 webServer 直接 return —— mood 的 mountApi 永远不执行，
// /dsh-mood-api 一条路由都没注册。这个测试用带 webServer 的 mock ctx 钉死该契约。
test('融合面板：mood 的 /dsh-mood-api 必须挂载（否则心情/日记/经验卡/品味全无界面）', () => {
  const mounts = []
  const webServer = {
    register(o) { mounts.push(o) },
  }
  const ctx = {
    get(key) {
      if (key === 'tools') return { register() {} }
      if (key === 'webServer') return webServer
      if (key === 'systemPrompt') return { section() {} }
      return undefined
    },
    effect(fn) { fn() },
  }
  apply(ctx, { dataDir: path.join(HOME, 'mind-data-panel') })

  const paths = mounts.map((m) => m.path).sort()
  assert.ok(paths.includes('/dsh-mind-api'), 'dsh-mind 自有面板必须挂载')
  assert.ok(paths.includes('/dsh-mood-api'),
    'mood 管理路由必须挂载（心情/日记/经验卡/品味的数据源），实际挂载：' + JSON.stringify(paths))
})
