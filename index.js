// dsh-mind —— 统一记忆/情绪/睡眠插件（融合版）
//
// 融合架构：vendor 进来的 dsh-mood 0.14.16 源码（vendor/mood/）通过【过滤代理 ctx】
// 运行其 apply()——心情引擎/日记/经验卡/品味/会话索引的成熟接线原样生效；
// 代理层做三件事：
//   ① 排除：news 工具与 news 提示词节（PRD 排除项）；proactive 以 moodCfg 强制 enabled:false
//   ② 重定向：mood 的 memory 工具（jsonl 归档检索）→ SQLite 统一记忆库（同名工具，行为升级）
//   ③ 记账：mood 各提示词节的字符数进预算账本，dsh-mind 自己的注入块用剩余预算
// dsh-mind 自有新增：SQLite 统一记忆核心、mind_memory/mind_sleep 工具、睡眠状态机、
//   独立管理面板（/dsh-mind-api/panel，不进 DSH 设置模块）。
//
// 会话连续性（PRD 硬要求）：插件更换不改变 sessionPolicy（模式+预设+owner），
//   DSH 会话与桥接 state 均不受影响——当前会话的上下文不重开、不重建。
//
// 灰度纪律：inject 默认 false（"先只写不读"）。启用 = cordis.patch.yml 的 dsh-mind 行
//   加 config: { inject: true }，且应在 dsh-mood 停用/移除之后。
//
// 宿主 API（对齐 dsh-mood 实测）：
//   export const name / export function apply(root, rawConfig)
//   ctx.get('tools').register(def) / ctx.systemPrompt.section({name,order,text}) / ctx.effect(fn, label)
//   ctx.get('web').register({kind:'prefix', path, handler}) / ctx.on('session/event', …)

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { join, resolve, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM 没有 __dirname——插件自身目录从 import.meta.url 推（读 panel/index.html 用）
const __dirname = fileURLToPath(new URL('.', import.meta.url))
import { openDb } from './lib/db.js'
import { createMemoryStore } from './lib/memory.js'
import { buildInjectBlock, RETRY_HINT } from './lib/retrieve.js'
import { createSleepManager } from './lib/sleep.js'
import { createConsolidator } from './lib/consolidate.js'
import { renderMemoryValue } from './lib/render.js'
import { dataDir as resolveDataDir, importMoodArchive, moodDataDir, dshHome } from './lib/pointer.js'
import { apply as moodApply } from './vendor/mood/index.js'
// mood 引擎的内存状态（它只写盘不回读，疲惫同步必须直接改这个）
import * as MOOD_NS from './vendor/mood/index.js'

/** 取 mood 的 liveState（不可达时返回 null） */
function MOOD_LIVE_STATE() {
  try { return MOOD_NS.liveState || null } catch { return null }
}
import { defineTool, defineToolSource } from './vendor/mood/dsh-tools.js'
// 经验卡模块（仅 inject.withProcedures 开启时用到）
import * as PROC from './vendor/mood/procedures.js'
import * as TASTE from './vendor/mood/taste.js'
// 语音合成与发送（BreezeBlue TTS → base64 直发 QQ，不落盘）
import { synthesize, breezeBalance, breezeModels, sendVoiceBase64, resolveSnowLuma, snowLumaHealth, createRateLimiter } from './lib/tts.js'

/* ── 语音模型列表：从 API 地址拉取，失败回退内置 ──
   面板的「模型」下拉用 voiceModelOptions() 填充；GET /voice/models 可手动刷新。 */
const VOICE_MODEL_FALLBACK = ['breeze-tts-2', 'breeze-tts-2-multilingual']
let voiceModelList = []
function voiceModelOptions() {
  return voiceModelList.length ? voiceModelList : VOICE_MODEL_FALLBACK
}

export const name = 'dsh-mind'

const CFG_DEFAULTS = {
  inject: false,               // 灰度开关：false=只写不读
  injectBudgetChars: 3500,     // 总预算（=mood 现状基础上调 500，用户指定）
  recallK: 2,                  // 每轮注入记忆条数
  recallMinScore: 0.45,
  memoryMaxChars: 80,          // 注入时单条截断
  // 两个可选注入节：默认关闭。关闭时后端**不取数据、不传参**。
  withProcedures: false,       // 经验卡检索提示
  withTaste: false,            // 品味偏好摘要

  // ── 语音（BreezeBlue TTS → QQ 语音条）──
  voiceEnabled: false,         // 总开关：是否让 AI 能发语音
  voiceApiKey: '',             // BreezeBlue key（建议用环境变量 BREEZE_API_KEY）
  voiceBaseUrl: 'https://api.breeze.blue',
  voiceId: '',                 // 克隆的音色 ID（voc_xxx）
  voiceModel: 'breeze-tts-2',  // en+zh 原生优化；multilingual 中文偏泛化
  voiceLang: 'zh',
  voiceBoost: true,            // 提高与参考原声相似度（关掉会"气声多"）
  voiceProxy: '',               // Node 不读系统代理；需要时填 http://127.0.0.1:7890
  voiceMaxPerMin: 2,           // 限流
  voiceMaxPerHour: 10,
  withProfile: false,          // 偏好类记忆摘要
  // ── 星图外观（面板"设置 → 星图外观"）──
  graphAutoRotate: true,
  graphLabels: true,
  graphHalo: true,
  noteMaxChars: 400,
  importMoodArchive: true,
  dataDir: '',
  blocks: {},                  // {memory,mood,procedures,profile} 逐块开关
  sleepEnabled: true,          // 空闲自动入睡（面板也可手动触发）
  sleepIdleMinutes: 240,       // 连续无消息多久进入 preparing
  sleepGraceMinutes: 10,       // preparing 宽限：期间来消息则取消入睡
  sleepTickSeconds: 30,        // sleeping 期间整理器步进间隔
}

// mood 侧被排除的工具（PRD：时事不开发；主动开口由桥接负责）
const MOOD_TOOL_DENY = new Set(['news'])
// mood 侧被排除的提示词节
const MOOD_SECTION_DENY = new Set(['dsh-mood/news'])

export function apply(ctx, rawConfig) {
/** 作息表是否开启「自主判断」（关掉后不因空闲自动入睡） */
  function scheduleAuto() {
    try { return sleep.schedule.get().auto !== false } catch { return true }
  }

  const cfg = { ...CFG_DEFAULTS, ...(rawConfig || {}) }

  // 启动后异步拉一次语音模型列表（失败静默回退内置，不阻塞启动）
  Promise.resolve().then(async () => {
    try {
      const apiKey = String(process.env.BREEZE_API_KEY || cfg.voiceApiKey || '').trim()
      const baseUrl = String(process.env.BREEZE_BASE_URL || cfg.voiceBaseUrl || 'https://api.breeze.blue')
      const list = await breezeModels({ apiKey, baseUrl, proxy: cfg.voiceProxy || null })
      if (list.length) voiceModelList = list
    } catch { /* 忽略：面板下拉会用兜底列表 */ }
  })

/* 当前生效的配置视图。
 *
 * 原项目没有配置中心，cfg 是启动时一次性合并的。面板改了设置后，
 * 把它写进一个内存覆盖层 runtimeCfgPatch，readCfg() 合并后返回。
 * 这样注入段每轮读到的都是最新值（支持热开关），
 * 同时不改变启动配置的语义。
 */
let runtimeCfgPatch = {}

let __voiceLimiter = null
/** 语音限流用量（供 /voice/health 显示） */
function voiceRateUsage() {
  try {
    const c = readCfg()
    if (!__voiceLimiter) {
      __voiceLimiter = createRateLimiter({
        maxPerMinute: Number(c.voiceMaxPerMin) || 2,
        maxPerHour: Number(c.voiceMaxPerHour) || 10,
      })
    }
    return __voiceLimiter.usage()
  } catch { return null }
}

function readCfg() {
  return Object.assign({}, cfg, runtimeCfgPatch)
}

/* 设置落盘路径：<数据目录>/settings.json。启动时读回，避免重启后开关丢失。 */
let settingsFilePath = null

function settingsFile() {
  return settingsFilePath
}

/** 启动时读回上次保存的设置（不存在就当没有） */
function loadSettingsFromDisk() {
  try {
    if (!settingsFilePath || !existsSync(settingsFilePath)) return
    const j = JSON.parse(readFileSync(settingsFilePath, 'utf8'))
    if (j && typeof j === 'object') {
      runtimeCfgPatch = Object.assign({}, runtimeCfgPatch, j)
      log('已读回上次保存的设置（' + Object.keys(j).length + ' 项）')
    }
  } catch (e) { log('读取设置失败（忽略）：', e?.message ?? e) }
}

/** 保存到磁盘（失败静默，不影响运行） */
function saveSettingsToDisk() {
  try {
    if (!settingsFilePath) return
    writeFileSync(settingsFilePath, JSON.stringify(runtimeCfgPatch, null, 2), 'utf8')
  } catch (e) { log('保存设置失败（忽略）：', e?.message ?? e) }
}

/** 面板改设置后调用：立即生效 + 落盘 */
function applyRuntimeCfg(patch) {
  if (patch && typeof patch === 'object') {
    runtimeCfgPatch = Object.assign({}, runtimeCfgPatch, patch)
    saveSettingsToDisk()
  }
  return readCfg()
}
  const log = (...a) => { try { console.log('', ...a) } catch { /* 不管 */ } }

  // ═══ 1. dsh-mind 自有核心（SQLite 统一记忆 + 睡眠） ═══
  const dataDir = resolveDataDir(cfg)
  settingsFilePath = join(dataDir, 'settings.json')
  mkdirSync(dataDir, { recursive: true })
  loadSettingsFromDisk()
  const db = openDb(join(dataDir, 'memory.db'))
  const store = createMemoryStore(db, { log })

  // mood 归档一次性导入（拷贝式；源文件零改动；幂等）
  if (cfg.importMoodArchive) {
    try {
      const r = importMoodArchive(store, { db, dataDir })
      if (r.imported || r.reason !== 'already-imported') log(`mood 归档导入：${JSON.stringify(r)}`)
    } catch (e) { log('mood 归档导入失败（不影响启动）：', e?.message ?? e) }
  }

  const sleep = createSleepManager({ stateFile: join(dataDir, 'state.json'), log })

  /* ═══ 身份：角色名探测 + 手动改名 ═══
   * 名字不写死。优先级：面板手动改名 > 环境变量 > 桥接角色卡目录（最近修改的 .md）
   * > 桥接 /api/status 的当前角色 > 兜底。
   * 面板品牌位和标题靠 /state.role 拿这个名字（以前根本没返回，品牌一直停在「·」）。
   */
  let cachedRole = null          // 来自桥接 /api/status 的"当前生效角色"
  let cachedRoleAt = 0
  function identityFile() { return join(dataDir, 'identity.json') }
  function readIdentity() {
    try { return JSON.parse(readFileSync(identityFile(), 'utf8')) || {} } catch { return {} }
  }
  function writeIdentity(patch) {
    const next = { ...readIdentity(), ...patch, updatedAt: Date.now() }
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(identityFile(), JSON.stringify(next, null, 2), 'utf8')
    } catch (e) { log('identity 写入失败：', e?.message ?? e) }
    return next
  }
  /** qq-bridge 目录探测（全部基于环境变量/用户目录，不硬编码绝对路径） */
  function qqBridgeConfigPath() {
    const env = process.env.QQ_BRIDGE_CONFIG
    if (env && existsSync(env)) return env
    const dirEnv = process.env.QQ_BRIDGE_DIR
    const cands = []
    if (dirEnv) cands.push(join(dirEnv, 'config.json'))
    try { cands.push(join(dirname(dshHome()), 'qq-bridge', 'config.json')) } catch {}
    cands.push(join(process.cwd(), '..', 'qq-bridge', 'config.json'))
    // 历史位置不再硬编码，改用环境变量 QQ_BRIDGE_DIR / QQ_BRIDGE_CONFIG，兜底
    for (const c of cands) { try { if (c && existsSync(c)) return c } catch {} }
    return ''
  }
  function readBridgeConfig() {
    try {
      const p = qqBridgeConfigPath()
      if (!p) return null
      return JSON.parse(readFileSync(p, 'utf8'))
    } catch { return null }
  }
  /** 角色卡目录里最近修改的 .md（排除 readme/说明） */
  function roleFromCards() {
    try {
      const bc = readBridgeConfig()
      const base = bc && bc.rolesDir ? bc.rolesDir : (qqBridgeConfigPath() ? join(dirname(qqBridgeConfigPath()), 'roles') : '')
      if (!base || !existsSync(base)) return null
      const files = readdirSync(base)
        .filter((f) => f.endsWith('.md') && !f.endsWith('.bak'))
        .map((f) => ({ name: f.slice(0, -3), mtime: statSync(join(base, f)).mtimeMs }))
        .filter((f) => !/^readme$/i.test(f.name) && !/说明/.test(f.name))
        .sort((a, b) => b.mtime - a.mtime)
      return files.length ? files[0].name : null
    } catch { return null }
  }
  function roleInfo() {
    const id = readIdentity()
    if (id.name && String(id.name).trim()) return { name: String(id.name).trim(), source: 'panel' }
    const env = process.env.DSH_MIND_ROLE_NAME
    if (env && env.trim()) return { name: env.trim(), source: 'env' }
    const card = roleFromCards()
    if (card) return { name: card, source: 'role-card' }
    if (cachedRole) return { name: cachedRole, source: 'bridge' }
    return { name: '记忆宇宙', source: 'fallback' }
  }

  // sessionController 惰性获取：宿主注入时机不定；整理器的 LLM 步（3/6/9）靠它投递指令
  let sessionCtl = null
  function getSessionCtl() {
    if (sessionCtl && typeof sessionCtl.prompt === 'function') return sessionCtl
    try { sessionCtl = ctx.get ? ctx.get('sessionController') : null } catch { sessionCtl = null }
    return sessionCtl && typeof sessionCtl.prompt === 'function' ? sessionCtl : null
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['sessionController'], (c) => {
        try {
          const s = c?.get ? c.get('sessionController') : c?.sessionController
          if (s && typeof s.prompt === 'function') sessionCtl = s
        } catch { /* 拿不到就算了——LLM 步自动延后 */ }
      })
    }
  } catch { /* 宿主不认这个服务名 */ }

  // 13 步海马体整理器（本地步直接执行；LLM 步投给模型；失败≤3 转暂停，不阻塞苏醒）
  const consolidator = createConsolidator({ db, store, sleep, getSessionCtl: () => getSessionCtl(), log })

  // 最近一条用户消息缓存：会话事件写入，注入协调器用它做检索提示
  let lastQueryHint = ''
  function setQueryHint(q) { lastQueryHint = String(q || '').slice(0, 200) }

  // 活动心跳：最后一次会话动静的时间（睡眠驱动据此判断空闲入睡）
  let lastActivityAt = Date.now()
  let preparingSince = 0

  // 会话事件：刷新活动心跳 + 检索提示；preparing 期间来消息则取消入睡
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('session/event', (_session, event) => {
        try {
          lastActivityAt = Date.now()
          const type = event?.type
          if (type === 'user/message') {
            const d = event?.data
            const txt = typeof d === 'string' ? d
              : typeof d?.text === 'string' ? d.text
              : typeof d?.content === 'string' ? d.content : ''
            setQueryHint(txt)
            if (sleep.get().state === 'preparing') sleep.cancel()
          }
        } catch { /* 事件处理不许抛 */ }
      })
    }
  } catch { /* 宿主无事件总线 */ }

  // ═══════════════════════════════════════════════════════════════
  // 睡眠驱动（2026-10-30 重写）
  // ───────────────────────────────────────────────────────────────
  // 两个真实 bug 的修复：
  //  ① 疲惫值长期不变：原来每拍都从 mood 的 tired(27.9) 拉 12% 回来，
  //     与 tick() 的累积形成动态平衡 ≈36。现在改为**单向派生**：
  //     fatigue 是唯一真相，mood 的 tired 由它派生，不再反向拉。
  //  ② "将醒"卡死：原来只在 sleeping 分支检查 shouldWake，
  //     recovering 分支完全不存在 → 永远出不去。
  //     现在四态都有推进逻辑，且 sleep.get() 内部有 selfHeal 兜底。
  // ═══════════════════════════════════════════════════════════════
  const sleepTimer = setInterval(() => {
    try {
      // ① 用真实经过时间补算疲惫值（不依赖本定时器作为时钟）
      //    页面关闭 / 服务重启 / 电脑休眠后，下一次调用会自动补齐
      try { sleep.tickFatigue() } catch {}

      const s = sleep.get()

      // ② 同步给 mood（单向：fatigue → mood 的 tired 维度）
      //    这样"动态情绪"里的疲惫反映真实体力，而不是各自漂移。
      try { syncFatigueToMood(s.fatigue) } catch {}

      // ③ 四态推进
      if (s.state === 'awive') { /* 占位，永不命中 */ }

      if (s.state === 'awake') {
        if (cfg.sleepEnabled) {
          let v = null
          try { v = sleep.shouldSleep() } catch {}
          if (v && v.yes) {
            try {
              sleep.enterPreparing({ reason: v.why })
              log('进入准备入睡：' + v.why)
            } catch (e) { log('入睡失败：', e?.message ?? e) }
          } else if (scheduleAuto() && Date.now() - lastActivityAt >= cfg.sleepIdleMinutes * 60000) {
            // ⚠️ 空闲入睡必须同时满足三个条件，缺一不可：
            //    ① 作息表开了「自主判断」(auto) —— 关掉就不该自己决定睡
            //    ② 疲惫达到入睡阈值的一半 —— 不累就没必要睡
            //    ③ 空闲时间够久
            //    原来只看 ③，导致 auto=false 也照睡、疲惫 0.5 也照睡，
            //    结果进入 preparing 后又被疲惫值劝醒 → 反复进出。
            const fatNow = (() => { try { return sleep.advanceFatigue(Date.now()) } catch { return 0 } })()
            const minFat = Math.max(20, Math.floor((cfg.fatigueSleep || 70) / 2))
            if (fatNow >= minFat) {
              try {
                sleep.enterPreparing({ reason: '空闲 ' + cfg.sleepIdleMinutes + ' 分钟，疲惫 ' + Math.round(fatNow) })
                log('进入准备入睡：空闲超时（疲惫 ' + Math.round(fatNow) + '）')
              } catch (e) {}
            }
          }
        }
      } else if (s.state === 'preparing') {
        // ⚠️ preparing 必须有**出口**，否则它会变成死胡同：
        //    叫醒没一会又回到这里、然后永远出不去。
        //    出口分两种：
        //      · 该进沉睡了 → enterSleeping
        //      · 该醒了（疲惫已降 / 手动取消 / 窗口结束）→ 退回 awake
        let wv = null
        try { wv = sleep.shouldWake() } catch {}
        const elapsed = Date.now() - (s.since || Date.now())
        const graceMs = (cfg.sleepGraceMinutes || 15) * 60000

        if (wv && wv.yes) {
          // shouldWake 说"该醒" → 退回清醒（这是原来缺失的那条路）
          try {
            sleep.wake({ reason: '准备入睡中止：' + (wv.why || '条件不再满足') })
            log('准备入睡中止，回到清醒：' + (wv.why || ''))
          } catch (e) { log('退回清醒失败：', e?.message ?? e) }

        } else if (wv && wv.trigger === 'to-sleep') {
          // 只有准备时长够了、且仍该睡，才真的进沉睡
          try {
            sleep.enterSleeping({ reason: '准备入睡完成' })
            log('进入沉睡')
          } catch (e) { log('进沉睡失败：', e?.message ?? e) }

        } else if (elapsed >= graceMs) {
          // ⚠️ 这里**绝不能**调 sleep.shouldSleep() 复核 ——
          //    shouldSleep 第一行就是
          //        if (st.state !== 'awake') return { yes: false }
          //    在 preparing 状态下它必然回 false，于是必然退回 awake；
          //    退回后仍在作息窗口内，立刻又被要求入睡 → 无限循环。
          //    实测午睡时段 30 分钟内进出 5 轮，一次都没真正睡着。
          //
          //    正确语义：准备够了就睡下去。该不该睡前一步的 shouldWake
          //    已经判断过 —— 该醒的走那条路，不该醒的就进沉睡。
          try {
            sleep.enterSleeping({ reason: '准备入睡完成（按作息进入沉睡）' })
            log('准备入睡完成，进入沉睡')
          } catch (e) { log('进沉睡失败：', e?.message ?? e) }
        }
      } else if (s.state === 'sleeping') {
        // 沉睡 → 将醒：按疲惫/时长/作息判断
        let wv = null
        try { wv = sleep.shouldWake() } catch {}
        if (wv && wv.yes) {
          try {
            sleep.enterRecovering({ reason: wv.why })
            sleep.setReport({
              at: Date.now(),
              note: '开始醒来：' + wv.why,
              fatigue: s.fatigue,
            })
            log('进入将醒：' + wv.why)
          } catch (e) { log('进入将醒失败：', e?.message ?? e) }
        }

        // ─── 记忆整理：**只在夜间睡眠时做** ───
        //
        // 用户要求：整理只在每天晚上那一觉后进行；白天（午睡等）睡觉
        // 只恢复疲惫值，不整理记忆。这样才符合"晚上睡一觉顺便消化今天的事"。
        //
        // 判定由 sleep.isNightSleep() 给出：当前时刻是否落在 type='night'
        // 的生效窗口内。
        let nightOk = { yes: false, window: null }
        try { nightOk = sleep.isNightSleep() } catch {}

        if (nightOk.yes && sleep.get().state === 'sleeping') {
          Promise.resolve()
            .then(() => consolidator.tick(getSessionCtl()))
            .then((r) => {
              if (r && r.done === true) {
                try { sleep.setReport({ at: Date.now(), steps: consolidator.STEPS.length }) } catch {}
                // ⚠️ 只打一次：done 分支每拍都会命中，不判重会刷屏
                if (!sleep.__consolidationLoggedThisSleep) {
                  sleep.__consolidationLoggedThisSleep = true
                  log('夜间睡眠整理完成（不影响醒来时机）')
                }
              }
            })
            .catch((e) => log('整理器异常（忽略，下拍重试）：', e?.message ?? e))
        } else if (!nightOk.yes) {
          // 白天小睡：只恢复体力，不整理。日志只打一次，避免刷屏。
          if (!globalThis.__dshMindNapLogged) {
            globalThis.__dshMindNapLogged = true
            log('白天睡眠，不整理记忆（仅恢复疲惫值）')
          }
        }

      } else if (s.state === 'recovering') {
        let wv = null
        try { wv = sleep.shouldWake() } catch {}

        if (wv && wv.yes) {
          // 满足醒来条件 → 回清醒
          try {
            const justWoke = sleep.__consolidationLoggedThisSleep = false
            sleep.markJustWoke({ sleptMin: wv.sleptMin || 0 })
            sleep.wake({ reason: wv.why })
            log('回到清醒：' + wv.why)
            void justWoke
          } catch (e) { log('唤醒失败：', e?.message ?? e) }

        } else if (wv && wv.inWindow && !s.manualOverride) {
          // ⚠️ 在作息窗口内 → 不该停在将醒，退回沉睡继续睡。
          //    recovering → sleeping 是合法迁移（TRANSITIONS 允许）。
          //    这样"窗口内一直沉睡"的语义在将醒阶段也成立。
          try {
            sleep.enterSleeping({ reason: '仍在作息窗口内，继续沉睡' })
            log('仍在窗口内，从将醒退回沉睡')
          } catch (e) {
            // 若状态机不允许（或已迁移），忽略即可，下一拍再看
          }
        }
      }

    } catch (e) { log('睡眠驱动异常（忽略，下拍重试）：', e?.message ?? e) }
  }, Math.max(5, cfg.sleepTickSeconds) * 1000)
  sleepTimer.unref?.()


  // ═══ 2. 过滤代理 ctx：在它的看护下运行 vendored mood 的 apply() ═══
  //
  // ⚠️ 2026-10-29 重大修正：不能用 Object.create(ctx) 做原型继承。
  //    cordis 的 ctx 是带 traceable Proxy 的对象，宿主内部的属性读取会沿 receiver 链
  //    传播——子对象上覆盖的 get 会被宿主自己的 get 调到（receiver 反射），无限递归，
  //    DSH 启动即崩（Maximum call stack size exceeded，已在线上复现）。
  //    正确做法：**扁平委托对象**——只实现 mood 实际用到的成员（实测：effect/logger/on/
  //    systemPrompt.section/get('tools')/get('web')），每个成员预绑定真 ctx 的原始方法，
  //    代理对象自己不是宿主 Proxy 的后代，任何 receiver 反射都打不回自己。
  const budgetLedger = []   // mood 各提示词节最近一次渲染的字符数（预算账本）
  const realTools = () => {
    const t = ctx.get ? ctx.get('tools') : ctx.tools
    if (!t || typeof t.register !== 'function') throw new Error('宿主 tools 注册器不可用')
    return t
  }
  const ctxEffect = typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : (fn) => fn()
  const ctxOn = typeof ctx.on === 'function' ? ctx.on.bind(ctx) : null
  const ctxLog = typeof ctx.logger === 'object' && ctx.logger ? ctx.logger : null

  // ── systemPrompt / webServer 服务获取 ──
  // DSH 0.2.1 cordis 陷阱：ctx.get('x') 绕过声明校验，而 ctx.x 直接属性访问要求
  // 插件 fiber 声明过 inject（否则抛 "cannot get property … without inject"——
  // 线上 4 个 mood 节全是这么死的）。另外宿主 web 服务名叫 **webServer** 不是 web
  //（mood 同款 register({kind:'prefix'}) 契约）。
  // 策略：先 get 直取（就绪场景/mock 测试），不行再走 mood 同款真 inject（等就绪回调），
  // 还不行把节排进队列等回调冲刷——三种时序都覆盖，注册永不丢。
  const sectionQueue = []
  let spSvc = null
  function findSP() {
    try {
      const s = ctx.get ? ctx.get('systemPrompt') : null
      if (s && typeof s.section === 'function') return s
    } catch { /* get 不该抛，但兜住 */ }
    try {
      if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') return ctx.systemPrompt
    } catch { /* 真 host 未声明时这里抛——走 inject 路 */ }
    return null
  }
  function flushSections() {
    while (sectionQueue.length && spSvc) {
      const s = sectionQueue.shift()
      try { spSvc.section(s) } catch (e) { log(`提示词节注册失败（${s?.name ?? '?'}）：`, e?.message ?? e) }
    }
  }
  function bindSystemPrompt() {
    spSvc = findSP()
    if (spSvc) { flushSections(); return true }
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['systemPrompt'], (c) => {
          try {
            spSvc = c.systemPrompt ?? (c.get ? c.get('systemPrompt') : null)
            if (spSvc && typeof spSvc.section === 'function') {
              log('[fusion] systemPrompt 经 inject 就绪，冲刷排队节')
              flushSections()
            }
          } catch (e) { log('[fusion] systemPrompt 注入回调失败：', e?.message ?? e) }
        })
      }
    } catch (e) { log('[fusion] systemPrompt 注入失败：', e?.message ?? e) }
    return false
  }
  /** 所有提示词节（mood 的 + 我们自己的）统一从这走：过滤 → 记账 → 注册/排队 */
  function submitSection(s) {
    if (s && MOOD_SECTION_DENY.has(s.name)) { log(`[fusion] 排除 mood 提示词节：${s.name}`); return }
    if (s && typeof s.text === 'function') {
      const orig = s.text
      s = { ...s, text: () => {
        const out = orig()
        try {
          budgetLedger.push({ name: s.name, chars: (out || '').length })
          if (budgetLedger.length > 24) budgetLedger.splice(0, budgetLedger.length - 24)
        } catch {}
        return out
      } }
    }
    if (!spSvc) bindSystemPrompt()
    if (spSvc) { try { return spSvc.section(s) } catch (e) { log(`提示词节注册失败（${s?.name ?? '?'}）：`, e?.message ?? e) } }
    else sectionQueue.push(s)
  }
  bindSystemPrompt()

  /* ── 记忆工具的输出渲染 ────────────────────────────────────────────
   * ⚠️ 曾经 render 只吐 value.message（"检索到 5 条相关记忆"），
   *    于是模型拿着一个数字、正文一个字看不到 —— 检索结果等于没返回。
   *    渲染逻辑下沉到 lib/render.js（可单测），这里直接用。
   */

  // SQLite 版 memory 工具（同名替换 mood 的 jsonl 归档版——行为升级、名字不变）
  function memoryToolDef() {
    return {
      name: 'memory',
      description:
        '查询或写入你的长期记忆库（已升级为结构化存储，跨会话、上下文压缩后依然可查）。' +
        'action=search 按关键词检索（' + RETRY_HINT + '）；action=note 写入一条结构化记忆' +
        '（kind：episode 事件/fact 事实/reflection 反思/skill 技能/lesson 道理；只写以后用得上的，一条一句话）；' +
        'action=recent 最近写入；action=stats 记忆库概况。',
      parameters: {
        action: { type: 'string', enum: ['search', 'note', 'recent', 'stats'] },
        query: { type: 'string', description: 'search 的关键词' },
        k: { type: 'number', description: 'search 返回几条（默认 5，最多 20）' },
        text: { type: 'string', description: 'note 的记忆正文' },
        kind: { type: 'string', description: 'note 的记忆类型' },
        importance: { type: 'number', description: '0~1 重要程度' },
      },
      execute(a = {}) {
        switch (a.action) {
          case 'search': {
            const k = Math.max(1, Math.min(20, Number(a.k) || 5))
            const hits = store.search(a.query || '', { k, minScore: 0.25 })
            return { ok: true, hits, hint: hits.length ? '' : RETRY_HINT, message: `检索到 ${hits.length} 条相关记忆` }
          }
          case 'note': {
            const r = store.note({ kind: a.kind, text: a.text, importance: a.importance ?? 0.5, source: 'agent-note', is_inference: true })
            return { ok: true, id: r.id, duplicateOf: r.duplicateOf ?? null, message: r.duplicateOf ? '已合并到相似记忆' : '已写入长期记忆' }
          }
          case 'recent': {
            const items = store.recent(10)
            return { ok: true, items, message: `最近 ${items.length} 条记忆` }
          }
          case 'stats':
            return { ok: true, ...store.stats(), message: '记忆库概况已返回' }
          default:
            return { ok: false, error: '未知 action', message: '未知 action' }
        }
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => renderMemoryValue(value),
      },
    }
  }

  // mood 实际消费的成员：effect / logger / on / systemPrompt.section / get('tools') /
  // inject(['systemPrompt','tools'] | ['webServer'] | ['sessionController'], cb)。
  // 过滤规则全部下沉到 moodTools/moodSystemPrompt 两个服务对象里——
  // 无论 mood 走 get 还是走 inject，看到的都是同一套（排除 news、预算账本、SQLite 重指向）。
  //
  // webServer 就绪等待队列：装配顺序不保证 webServer 先于插件，拿不到时把回调排进来，
  // 等宿主 inject 回调 / 面板挂载那一刻统一冲刷（mood 的 /dsh-mood-api 靠这个才挂得上）。
  const pendingWebServerCallbacks = []
  function hostWebServer() {
    try { return ctx.get ? ctx.get('webServer') : (ctx.webServer ?? null) } catch { return null }
  }
  function flushPendingWebServer() {
    const w = hostWebServer()
    if (!w || typeof w.register !== 'function') return false
    while (pendingWebServerCallbacks.length) {
      const fn = pendingWebServerCallbacks.shift()
      try { fn() } catch (e) { log('[fusion] webServer 就绪回调失败：', e?.message ?? e) }
    }
    return true
  }
  const moodTools = {
    register(def) {
      if (!def || !def.name) return
      if (MOOD_TOOL_DENY.has(def.name)) { log(`[fusion] 排除 mood 工具：${def.name}`); return }
      if (def.name === 'memory') {
        log('[fusion] mood memory 工具 → 重指向 SQLite 统一记忆库')
        return realTools().register(defineTool(memoryToolDef()))
      }
      return realTools().register(def)
    },
  }
  const moodSystemPrompt = {
    section(s) { return submitSection(s) },
  }
  const moodCtx = {
    effect: (fn, label) => {
      try { fn() } catch (e) { log(`[fusion] mood effect 失败（${label ?? 'unlabeled'}）：`, e?.message ?? e) }
    },
    logger: ctxLog ?? { info: log, warn: log, error: log, info() {}, debug() {} },
    on: (event, cb) => {
      if (!ctxOn) { log(`[fusion] 宿主无事件订阅，mood 的 ${event} 钩子跳过`); return }
      // 会话事件原样透传（消息打分/日记素材/归档钩子都在这里面）
      return ctxOn(event, cb)
    },
    systemPrompt: moodSystemPrompt,
    get(key) {
      if (key === 'tools') return moodTools
      // ★ 融合修正：mood 的管理路由必须挂载，否则心情/日记/经验卡/品味/会话索引
      //   在面板上完全不可见、不可操作（用户要求"不仅要有界面并且要能进行操作"）。
      //   mood 的 apply 内部是 `ctx.get('webServer')` 直取，只要这里如实返回宿主
      //   webServer，它就会自己把 /dsh-mood-api 注册到同一个 HTTP 服务上。
      //   路径前缀不同（/dsh-mood-api vs /dsh-mind-api），互不冲突。
      if (key === 'webServer') return hostWebServer()
      if (key === 'sessionController') return undefined
      return undefined
    },
    // mood 的 root.inject 三路注入：这里用合成容器同步回调（服务全在手里，同步更确定）。
    // webServer 现在**放行**（面板功能需要）；sessionController 仍裁掉（主动开口归桥接）。
    inject(services, cb) {
      const wants = new Set(services || [])
      if (wants.has('sessionController')) { log('[fusion] mood 主动开口通道跳过（唤醒/主动消息由 qq-bridge 负责）'); return }
      if (wants.has('webServer')) {
        // ⚠️ 时序陷阱（2026-10-29 线上实测踩到）：
        //    mood 的 mountApi 内部是 `ctx.get('webServer')` 直取。装配时 webServer
        //    常常**还没就绪**（host 服务是异步挂载的），直取拿到 undefined 后
        //    mountApi 就 `return` 了 —— /dsh-mood-api 一条路由都不注册，面板的
        //    心情/日记/经验卡/品味全部 404。而 dsh-mind 自己的面板有三时序兜底，
        //    所以"面板能开、但里面模块全空"。
        //    这里给 mood 补上同样的兜底：拿得到就同步回调，拿不到就挂到
        //    webServer 就绪后再执行回调（与面板 registerPanel 共用同一套时机）。
        const runNow = () => {
          try {
            cb({
              effect: moodCtx.effect, logger: moodCtx.logger, on: moodCtx.on,
              systemPrompt: moodSystemPrompt, tools: moodTools, get: moodCtx.get,
            })
          } catch (e) { log('[fusion] mood inject(webServer) 回调失败：', e?.message ?? e) }
        }
        const probe = () => {
          try {
            const w = ctx.get ? ctx.get('webServer') : null
            return !!(w && typeof w.register === 'function')
          } catch { return false }
        }
        if (probe()) { runNow(); return }
        // 未就绪：登记一个"等 webServer 就好"的回调队列
        pendingWebServerCallbacks.push(runNow)
        try {
          if (typeof ctx.inject === 'function') {
            ctx.inject(['webServer'], () => {
              flushPendingWebServer()
            })
          }
        } catch (e) { log('[fusion] mood webServer 注入登记失败：', e?.message ?? e) }
        return
      }
      try {
        cb({
          effect: moodCtx.effect, logger: moodCtx.logger, on: moodCtx.on,
          systemPrompt: moodSystemPrompt, tools: moodTools, get: moodCtx.get,
        })
      } catch (e) { log('[fusion] mood inject 回调失败：', e?.stack || e?.message || e) }
    },
  }

  // ═══ 3. 运行 mood 引擎（代理下） ═══
  try {
    moodApply(moodCtx, { proactive: { enabled: false }, ...((rawConfig || {}).mood || {}) })
    log('[fusion] mood 引擎已在代理下装配（情绪/日记/经验卡/品味/会话索引）')
  } catch (e) {
    log('‼️ mood 引擎装配失败——dsh-mind 自有核心继续运行，但情绪系统不可用：', e?.stack || e?.message || e)
  }

  // ═══ 4. 心情桥接行 + 自有工具 ═══
  function moodLine() {
    try {
      const f = join(moodDataDir(), 'dsh-mood.json')
      if (!existsSync(f)) return ''
      const s = JSON.parse(readFileSync(f, 'utf8'))
      const cur = typeof s.current === 'string' ? s.current : (s.current?.id ?? '')
      return cur ? `现在是「${cur}」。情绪只影响语气，不影响判断。` : ''
    } catch { return '' }
  }

  /**
   * 经验卡索引（仅在 config.inject.withProcedures === true 时调用）。
   * 数据源：vendor 的 procedures 模块 renderHook(工作区)。
   * 拿不到就返回空串，绝不让注入整体失败。
   */
  function proceduresForInject() {
    try {
      if (!PROC || typeof PROC.renderHook !== 'function') return ''
      // renderHook(ws) 的 ws 参数只用于「显示真实路径」，
      // 传 null 时模块内部会退回工作区默认值。宿主侧不一定拿得到 cwd，
      // 所以这里传 null 最稳（不会抛）。
      const hook = PROC.renderHook(null)
      return typeof hook === 'string' ? hook : ''
    } catch (e) {
      log('经验卡注入取值失败（忽略）：', e?.message ?? e)
      return ''
    }
  }

  /**
   * 品味摘要（仅在 inject.withTaste === true 时调用）。
   * 数据源：品味库 principles 里的条目，取前 3 条拼一行。
   */
  function tasteForInject() {
    try {
      if (!TASTE || typeof TASTE.loadTaste !== 'function') return ''
      const t = TASTE.loadTaste()
      if (!t) return ''
      const ps = Array.isArray(t.principles) ? t.principles : []
      const parts = ps
        .map((p) => String((p && (p.text || p.title)) || '').trim())
        .filter(Boolean)
        .slice(0, 3)
      return parts.length ? parts.join('；') : ''
    } catch { return '' }
  }

  /**
   * 偏好摘要（仅在 config.inject.withProfile === true 时调用）。
   * 数据源：记忆库里 kind=preference / profile 的条目，取前 3 条拼一行。
   * 拿不到就返回空串。
   */
  function profileForInject(c) {
    try {
      const prefs = store.search(lastQueryHint || '', {
        k: 3,
        minScore: 0,
        kinds: ['preference', 'profile'],
      })
      if (!prefs || !prefs.length) return ''
      // 单条截到半个 memoryMaxChars，避免偏好吃光预算
      const maxEach = Math.max(20, Math.floor((Number(c.memoryMaxChars) || 80) / 2))
      const parts = prefs
        .map((p) => String((p && p.text) || '').trim().slice(0, maxEach))
        .filter(Boolean)
      return parts.length ? parts.join('；') : ''
    } catch (e) {
      log('偏好注入取值失败（忽略）：', e?.message ?? e)
      return ''
    }
  }

  const tools = ctx.get ? ctx.get('tools') : ctx.tools
  if (tools && typeof tools.register === 'function') {
    const mindMemoryDef = {
      name: 'mind_memory',
      description:
        '你的长期记忆库高级接口（SQLite 结构化存储，跨会话、上下文压缩后依然可查）。' +
        'action=search 按关键词检索（' + RETRY_HINT + '）；' +
        'action=note 写入一条结构化记忆（kind：episode 事件/fact 事实/reflection 反思/skill 技能/lesson 道理；' +
        '只写以后用得上的，一条一句话，≤120 字；is_inference=1 表示推断）；' +
        'action=get 看全文与来源；action=correct 用户纠正时用（旧记忆自动降权并记一条"用户纠正过我"）；' +
        'action=forget 三级遗忘；action=recent 最近写入。',
      parameters: {
        action: { type: 'string', enum: ['search', 'note', 'get', 'correct', 'forget', 'recent'] },
        query: { type: 'string' }, text: { type: 'string' }, kind: { type: 'string' },
        k: { type: 'number', description: 'search 返回几条（默认 5，最多 20）' },
        id: { type: 'string' }, importance: { type: 'number' },
        entities: { type: 'array' }, is_inference: { type: 'boolean' },
        reason: { type: 'string' }, tier: { type: 'number' },
      },
      execute(a = {}) {
        switch (a.action) {
          case 'note': {
            const r = store.note({
              kind: a.kind, text: a.text, importance: a.importance ?? 0.5,
              entities: a.entities, source: 'agent-note', is_inference: a.is_inference !== false,
            })
            return { ok: true, id: r.id, duplicateOf: r.duplicateOf ?? null, message: r.duplicateOf ? '已合并到相似记忆' : '已写入长期记忆' }
          }
          case 'search': {
            const k = Math.max(1, Math.min(20, Number(a.k) || 5))
            const hits = store.search(a.query || '', { k, minScore: 0.25 })
            return { ok: true, hits, hint: hits.length ? '' : RETRY_HINT, message: `检索到 ${hits.length} 条相关记忆` }
          }
          case 'get': {
            const m = store.get(a.id)
            return m ? { ok: true, memory: m, message: m.text } : { ok: false, error: '不存在', message: '该记忆不存在或已删除' }
          }
          case 'correct': {
            const r = store.correct(a.id, { newText: a.text, reason: a.reason, actor: 'agent' })
            return { ok: true, ...r, message: '已纠正：旧记忆降权，纠正记录已存档' }
          }
          case 'forget': {
            const r = store.forget(a.id, { tier: a.tier || 1, reason: a.reason })
            return { ok: true, ...r, message: `遗忘已执行（等级 ${a.tier || 1}）` }
          }
          case 'recent': {
            const items = store.recent(10)
            return { ok: true, items, message: `最近 ${items.length} 条记忆` }
          }
          default:
            return { ok: false, error: '未知 action', message: '未知 action' }
        }
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => renderMemoryValue(value),
      },
    }
    ctx.effect(() => tools.register(defineTool(mindMemoryDef)), 'dsh-mind memory tool')

    const sleepDef = {
      name: 'mind_sleep',
      description:
        '你自己的睡眠。' +
        'action=state 看自己现在的状态（清醒/准备睡/睡着/刚醒）；' +
        'action=sleep 你自己想去睡（带理由：困了、累了、想安静一会）；' +
        'action=wake 你自己想醒。' +
        '睡眠是**像人一样的作息**：累了就睡，睡够了就醒。' +
        '你睡着时不会回复任何人，醒来后会有"刚睡醒"的迷糊感，可以自然地表达出来。',
      parameters: {
        action: {
          type: 'string',
          enum: ['state', 'sleep', 'wake'],
          description: 'state 查询 / sleep 自己想睡 / wake 自己想醒',
        },
        reason: { type: 'string', description: '你自己为什么想睡或想醒（一句话，会记录在案）' },
        mood: { type: 'string', description: '睡前的心情（可选，一句话）' },
      },
      execute(a = {}) {
        const action = a.action || 'state'
        const s = sleep.get()

        if (action === 'sleep') {
          // 她自己决定入睡：记录意愿，由睡眠驱动接续状态机
          try { sleep.intendSleep({ reason: a.reason || '', mood: a.mood || '' }) } catch {}
          // 若当前是清醒态，直接进入 preparing（会经宽限期后进入 sleeping）
          let moved = null
          try {
            if (s.state === 'awake') {
              moved = sleep.enterPreparing({ reason: '她自己决定睡：' + (a.reason || '没说什么') })
            }
          } catch (e) { /* 状态机不允许时忽略，意愿已记录 */ }
          log('自主入睡意图：' + (a.reason || '（未说明）'))
          return {
            ok: true, state: (moved && moved.state) || s.state,
            bySelf: true,
            message: '好，我去睡了。' + (a.reason ? '（' + a.reason + '）' : ''),
          }
        }

        if (action === 'wake') {
          try { sleep.intendWake({ reason: a.reason || '' }) } catch {}
          let moved = null
          try {
            const cur = sleep.get().state
            if (cur === 'sleeping') {
              // sleeping 只能先到 recovering
              sleep.enterRecovering({ reason: '她自己决定醒：' + (a.reason || '') })
              moved = sleep.wake({ reason: '她自己决定醒：' + (a.reason || '') })
            } else if (cur === 'preparing') {
              moved = sleep.cancel()
            } else if (cur === 'recovering') {
              moved = sleep.wake({ reason: '她自己决定醒：' + (a.reason || '') })
            }
          } catch (e) { /* 忽略 */ }
          log('自主醒来意图：' + (a.reason || '（未说明）'))
          return {
            ok: true, state: (moved && moved.state) || s.state,
            bySelf: true,
            message: '我醒了。' + (a.reason ? '（' + a.reason + '）' : ''),
          }
        }

        // state
        const intent = (() => { try { return sleep.selfIntent() } catch { return null } })()
        const justWoke = (() => { try { return sleep.isJustWoke() } catch { return null } })()
        const fat = (() => { try { return sleep.fatigue.get() } catch { return null } })()
        let message
        if (s.state === 'sleeping') {
          message = '你正在睡着（疲惫值 ' + fat + '）：不会回复任何人。想醒就用 mind_sleep(action=wake)。'
        } else if (s.state === 'preparing') {
          message = '你正要睡着（宽限期内来消息会自动取消）。'
        } else if (s.state === 'recovering') {
          message = '你睡了一觉，正在醒（疲惫值 ' + fat + '）。'
        } else if (justWoke) {
          // 睡多久用口语说，不说"480 分钟"。
          const mins = Number(justWoke.sleptMin) || 0
          let durText = ''
          if (mins >= 90) {
            const h = Math.floor(mins / 60)
            const m = mins % 60
            durText = m >= 15 ? (h + ' 个小时出头') : ('差不多 ' + h + ' 个钟头')
          } else if (mins >= 45) {
            durText = '一个钟头左右'
          } else if (mins > 0) {
            durText = ' ' + Math.round(mins) + ' 分钟'
          }
          // durText 为空时不要再说"刚醒过来"（前面已经有"你刚睡醒"了，会重复）
          const head = durText ? ('你刚睡醒，这一觉睡了' + durText) : '你刚睡醒'
          message = head + '，脑子还有点钝。疲惫值 ' + fat + '。' +
            '想说话就用日常口语，别写完整句式。比如"哦 醒了"、"我睡了挺久啊"、"还困着呢"，挑一句顺口的。'
        } else {
          message = '当前清醒（疲惫值 ' + fat + '）。累了可以 mind_sleep(action=sleep)。' +
            (fat != null && fat >= 70 ? '（你已经很累了，考虑去睡）' : '')
        }
        return {
          ok: true, state: s.state, since: s.since, reason: s.reason,
          fatigue: fat,
          justWoke: justWoke || null,
          bySelf: intent ? intent.bySelf === true : false,
          selfWhy: intent ? intent.why : null,
          checkpoint: s.checkpoint, lastReport: s.lastReport, message,
        }
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
    }
    ctx.effect(() => tools.register(defineTool(sleepDef)), 'dsh-mind sleep tool')

    /* ── 语音：用自己的声音说话 ── */
    const voiceLimiter = createRateLimiter({ maxPerMinute: 2, maxPerHour: 10 })

    const speakDef = {
      name: 'qq_speak',
      description:
        '用你自己的声音说一句话，发成 QQ 语音条（不是打字，是能听见的声音）。\n'
        + '\n'
        + '什么时候值得用：这句话你想让对方「听见」而不只是「看到」——很短、情绪重、'
        + '或者你就是想出声。比如刚睡醒的一句、撒娇的一句、想他的一句话。\n'
        + '\n'
        + '什么时候别用：日常闲聊、回答问题、解释事情、需要长篇说明——打字更快更清楚。\n'
        + '\n'
        + '别每句都发。语音用多了就不值钱了。发之前想清楚「为什么这句要出声」，'
        + '填进 why 参数；填不出来就别发，直接打字。',
      parameters: {
        text: {
          type: 'string',
          description: '要说的内容。短一点更自然，像随口说的一句话。',
        },
        why: {
          type: 'string',
          description: '为什么这句要用语音而不是打字？（必填。填不出理由就别发语音）',
        },
        to: {
          type: 'string',
          description: '可选：目标 QQ 号。省略则发主人私聊。',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{
          type: 'text',
          text: value.ok
            ? '语音已发出（' + (value.bytes ? Math.round(value.bytes / 1024) + ' KB' : '') + '）'
            : '语音没发出去：' + (value.error || '未知原因'),
        }],
      },
      execute: async (args) => {
        const a = args || {}
        const text = String(a.text || '').trim()
        const why = String(a.why || '').trim()

        if (!text) return { ok: false, error: 'text 不能为空' }
        if (!why) return { ok: false, error: 'why 不能为空：说清为什么这句要用语音' }

        const c = readCfg()
        if (c.voiceEnabled !== true) return { ok: false, error: '语音功能未开启（设置 → 语音）' }

        const lim = voiceLimiter.check()
        if (!lim.ok) {
          log('语音限流：' + lim.reason)
          return { ok: false, error: lim.reason }
        }

        const apiKey = String(process.env.BREEZE_API_KEY || c.voiceApiKey || '').trim()
        if (!apiKey) return { ok: false, error: '未配置 BreezeBlue API key' }
        if (!(process.env.BREEZE_VOICE_ID || c.voiceId)) return { ok: false, error: '未配置音色 ID（设置环境变量 BREEZE_VOICE_ID）' }

        const sl = resolveSnowLuma()
        const to = a.to ? Number(a.to) : sl.ownerQQ
        if (!to) return { ok: false, error: '拿不到目标 QQ（qq-bridge 配置里没有 ownerQQ）' }

        let audio
        try {
          audio = await synthesize(text, {
            apiKey,
            voiceId: String(process.env.BREEZE_VOICE_ID || c.voiceId || ''),
            modelId: c.voiceModel,
            languageCode: c.voiceLang,
            useSpeakerBoost: c.voiceBoost !== false,
            proxy: c.voiceProxy,
            baseUrl: String(process.env.BREEZE_BASE_URL || c.voiceBaseUrl || 'https://api.breeze.blue'),
          })
        } catch (e) {
          log('语音合成失败：' + (e?.message ?? e))
          return { ok: false, error: '合成失败：' + (e?.message ?? e) }
        }

        try {
          const r = await sendVoiceBase64(sl, to, audio.buffer)
          voiceLimiter.commit()
          log('语音已发送 → ' + to + '（' + audio.buffer.length + ' 字节，理由：' + why + '）')
          return { ok: true, to, bytes: audio.buffer.length, messageId: r.messageId, why }
        } catch (e) {
          log('语音发送失败：' + (e?.message ?? e))
          return { ok: false, error: '发送失败：' + (e?.message ?? e) }
        }
      },
    }
    ctx.effect(() => tools.register(defineTool(speakDef)), 'dsh-mind voice tool')
    log('qq_speak 工具已注册')
  }

  // ═══ 5. 提示词注入（灰度默认关；开启后受 3500 总预算约束）═══
  //    mood 各节（885/890 等 order）先渲染并进账本；我们的节 order=881 恰在它们之前
  //    ——所以预算按"上一轮账本"扣减（一轮延迟，实践上足够稳）。
  // ⚠️ 这里**不能**用 if (cfg.inject === true) 包住 —— 那样注册与否是启动时
  //    决定的，面板改开关必须重启才生效。现在 section 恒定注册，
  //    由 text() 每轮实时读配置；关闭时返回空串，宿主拿到空串自然不注入。
  ctx.effect(() => submitSection({
    name: 'dsh-mind/inject',
    order: 881,
    interpolate: false,
    text: () => {
      try {
        const c = readCfg()                       // 实时读，支持面板热开关
        if (c.inject !== true) return ''          // 关闭 → 不产出内容

        // ⚠️ 只统计**我们自己**这一节的用量，不把 mood 的四节算进来。
        //    mood（state/taste/sessions/procedures）合计 8000+ 字符，
        //    它们有自己的渲染与裁剪，却被全部推进 budgetLedger —— 结果
        //    remaining = max(200, 3000 - 8430) 恒等于 200，记忆永远进不来。
        //    实测注入块稳定 48 字符（标记+心情），一条记忆都没有。
        const ourUsed = budgetLedger
          .filter((x) => x && x.name === 'dsh-mind/inject')
          .reduce((s, x) => s + (x.chars || 0), 0)
        const remaining = Math.max(400, c.injectBudgetChars - ourUsed)

        const hits = store.search(lastQueryHint || '', {
          k: c.recallK,
          minScore: c.recallMinScore,
        })

        // ── 两节可选内容：关闭时**不取数据、不传参** ──
        const wantProc = c.withProcedures === true
        const wantTaste = c.withTaste === true
        const wantProfile = c.withProfile === true

        let procedureHook = ''
        let tasteLine = ''
        let profileLine = ''

        if (wantProc) {
          try { procedureHook = proceduresForInject() } catch { procedureHook = '' }
        }
        if (wantTaste) {
          try { tasteLine = tasteForInject() } catch { tasteLine = '' }
        }
        if (wantProfile) {
          try { profileLine = profileForInject(c) } catch { profileLine = '' }
        }

        const blocks = Object.assign({}, c.blocks, {
          procedures: wantProc,
          taste: wantTaste,
          profile: wantProfile,
        })

        return buildInjectBlock(
          { memoryHits: hits, moodLine: moodLine(), procedureHook, tasteLine, profileLine },
          {
            injectBudgetChars: remaining,
            recallK: c.recallK,
            memoryMaxChars: c.memoryMaxChars,
            recallMinScore: c.recallMinScore,
            blocks,
          },
        ).text
      } catch (e) { log('注入块生成失败（降级为空）：', e?.message ?? e); return '' }
    },
  }), 'dsh-mind inject section')

  // （lastQueryHint/setQueryHint 已上移到第 1 节，会话事件在插件装配期就要用）

  // ═══ 6. 独立管理面（/dsh-mind-api，不进 DSH 设置模块）═══
  //    ⚠️ 宿主 web 服务名是 **webServer**（mood 同款契约：register({kind:'prefix',path,handler})）。
  //    之前写成 get('web') 拿到 undefined 被静默跳过——这就是面板 404 的根因。

/** 从 mood 的落盘状态里读"疲惫"心情值（0~100）；读不到返回 null */
function readMoodTired() {
  try {
    const f = join(moodDataDir(), 'dsh-mood.json')
    if (!existsSync(f)) return null
    const st = JSON.parse(readFileSync(f, 'utf8'))
    const vals = st.values || st.ranked || null
    if (Array.isArray(vals)) {
      // 形如 [{id:'tired', value:33}, ...]
      const t = vals.find(function(x){ return x && x.id === 'tired' })
      if (t && typeof t.value === 'number') return t.value
      return null
    }
    if (vals && typeof vals === 'object' && typeof vals.tired === 'number') return vals.tired
    // 兜底：直接在顶层找
    if (typeof st.tired === 'number') return st.tired
    return null
  } catch(e){ return null }
}

/**
 * 把睡眠系统的 fatigue 单向同步到 mood 的「疲惫」维度。
 *
 * 设计要点：
 *   · fatigue 是唯一可信来源（state.json），mood 只是展示层投影
 *   · 只改 tired 一个维度，**不动**其他情绪（避免覆盖 mood 自己的判断）
 *   · 写入失败静默忽略（mood 文件可能被独占，下拍再写）
 *   · 采用"仅当差值超过 2 才写"，避免每拍都落盘
 */
function syncFatigueToMood(fatigue) {
  try {
    if (typeof fatigue !== 'number' || !isFinite(fatigue)) {
      return
    }
    const file = join(moodDataDir(), 'dsh-mood.json')
    if (!existsSync(file)) {
      return
    }

    const st = JSON.parse(readFileSync(file, 'utf8'))

    // ⚠️ 实测结构是 { values: { calm:0, happy:46.8, tired:27.9, … } } —— **对象**
    //    原实现只处理数组（[{id:'tired', value:27}]），所以永远走不到写入分支。
    //    这里两种形态都支持，避免以后 mood 改结构又静默失效。
    let cur = null
    let setter = null

    const vals = st.values
    if (vals && typeof vals === 'object' && !Array.isArray(vals)) {
      // 对象形态（当前实际用的）
      if (typeof vals.tired === 'number') {
        cur = vals.tired
        setter = function (v) { vals.tired = v }
      }
    } else if (Array.isArray(vals)) {
      // 数组形态（兼容）
      const t = vals.find(function (x) { return x && x.id === 'tired' })
      if (t && typeof t.value === 'number') {
        cur = t.value
        setter = function (v) { t.value = v }
      }
    }

    if (setter == null || cur == null) {
      return
    }

    const target = Math.round(fatigue * 10) / 10
    // ⚠️ 阈值原来是 2，导致"心情页显示 50、顶部显示 46"这类观感问题：
    //    差值不到 2 就跳过写入，用户看到的永远是上一个整数档。
    //    现在改为 0.8 —— 仍然避免每拍狂写盘（30 秒一次、变化 0.8 才写），
    //    但显示基本跟得上实际值。
    if (Math.abs(cur - target) < 0.8) {
      return
    }

    setter(target)
    st.updatedAt = Date.now()
    writeFileSync(file, JSON.stringify(st, null, 2))

    // ⚠️ 关键：mood 引擎启动时把数据载入内存（liveState），之后只写盘不回读。
    //    只改文件的话 API 与面板读到的仍是旧值（实测写 79.4、面板显示 23.7）。
    //    所以必须同步改内存里的那一份。
    try {
      const ls = (typeof MOOD_LIVE_STATE === 'function') ? MOOD_LIVE_STATE() : null
      if (ls && ls.values && typeof ls.values.tired === 'number') {
        ls.values.tired = target
      }
    } catch { /* 内存不可达时忽略 —— 文件已经写对了 */ }

    log('mood 疲惫已同步为 ' + target)
  } catch (e) {
    log('mood 同步失败：' + (e && e.message))
  }
}

  function registerPanel(web) {
    if (!web || typeof web.register !== 'function') return false
    ctx.effect(() => web.register({
      kind: 'prefix',
      path: '/dsh-mind-api',
      async handler(req, res) {
        try {
          const url = new URL(String(req.url || ''), 'http://localhost')
          const p = url.pathname.replace(/^\/dsh-mind-api/, '') || '/'
          const send = (obj, code = 200) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          }
          if (req.method === 'POST' && String(req.headers['x-dsh-mind'] || '') !== '1') {
            return send({ ok: false, error: '缺少 x-dsh-mind 头（跨站写保护）' }, 403)
          }
          // ── 设置（最小实现：只暴露可热改项，供面板开关使用）──
      if (req.method === 'GET' && p === '/settings') {
        const cur = readCfg()
        return send({
          ok: true,
          values: {
            'inject.enabled': cur.inject === true,
            'inject.budgetChars': cur.injectBudgetChars,
            'inject.recallK': cur.recallK,
            'inject.minScore': cur.recallMinScore,
            'inject.withProcedures': cur.withProcedures === true,
            'inject.withTaste': cur.withTaste === true,
            'inject.withProfile': cur.withProfile === true,
            'voice.enabled': cur.voiceEnabled === true,
            'voice.model': cur.voiceModel || 'breeze-tts-2',
            'voice.lang': cur.voiceLang || 'zh',
            'voice.boost': cur.voiceBoost !== false,
            'voice.proxy': cur.voiceProxy || '',
            'voice.maxPerMin': cur.voiceMaxPerMin ?? 2,
            'voice.maxPerHour': cur.voiceMaxPerHour ?? 10,
            'graph.autoRotate': cur.graphAutoRotate !== false,
            'graph.labels': cur.graphLabels !== false,
            'graph.halo': cur.graphHalo !== false,
          },
          schema: {
          inject: {
            label: '提示词注入',
            desc: '每轮对话把相关记忆注入提示词。关闭可省 token，但 AI 不再"记得"追问。',
            fields: {
              'enabled': { type: 'bool', def: false, label: '启用注入', desc: '总开关。关闭时下面三项都不生效' },
              'budgetChars': { type: 'num', def: 1200, min: 200, max: 8000, step: 100, label: '注入预算字符', unit: '字', desc: '超长会被截断' },
              'recallK': { type: 'num', def: 5, min: 1, max: 20, step: 1, label: '检索条数', unit: '条', desc: '每次注入最多几条记忆' },
              'minScore': { type: 'num', def: 0.25, min: 0, max: 1, step: 0.05, label: '最低相关分', desc: '低于这个分不注入' },
              'withProcedures': { type: 'bool', def: false, label: '注入经验卡索引', desc: '把经验卡的检索提示注入提示词。关闭时不生成、不传参' },
              'withTaste': { type: 'bool', def: false, label: '注入品味偏好', desc: '把品味库的偏好摘要注入提示词。关闭时不生成、不传参' },
              'withProfile': { type: 'bool', def: false, label: '注入记忆摘要', desc: '把偏好类记忆摘要注入提示词。关闭时不生成、不传参' },
            },
          },
          voice: {
            label: '语音',
            desc: '让 AI 用自己的声音说话：BreezeBlue 合成后直发 QQ 语音条，不经过 qq-bridge、不落盘。',
            fields: {
              'enabled': { type: 'bool', def: false, label: '启用语音', desc: '总开关。关闭时 AI 不能发语音。密钥与音色用环境变量配置，不进面板' },
              'model': { type: 'enum', def: 'breeze-tts-2', label: '模型', options: voiceModelOptions(), desc: '列表从 API 地址实时拉取；拉取失败时用内置兜底' },
              'lang': { type: 'enum', def: 'zh', label: '语言', options: ['zh', 'en'] },
              'boost': { type: 'bool', def: true, label: '贴近原声', desc: 'use_speaker_boost：提高与参考原声的相似度。关掉会明显"气声多"' },
              'proxy': { type: 'text', def: 'http://127.0.0.1:7890', label: 'HTTP 代理', desc: 'Node 不读系统代理，连 api.breeze.blue 必须显式配置；留空则直连' },
              'maxPerMin': { type: 'num', def: 2, min: 0, max: 30, step: 1, label: '每分钟上限', unit: '条' },
              'maxPerHour': { type: 'num', def: 10, min: 0, max: 200, step: 5, label: '每小时上限', unit: '条' },
            },
          },
          graph: {
            label: '星图外观',
            desc: '记忆星图的显示开关。改完刷新面板即可见（不影响数据）。',
            fields: {
              'autoRotate': { type: 'bool', def: true, label: '自动旋转', desc: '关闭后星图静止，靠拖拽看' },
              'labels': { type: 'bool', def: true, label: '显示标签', desc: '在星体旁显示记忆标题与主题名' },
              'halo': { type: 'bool', def: true, label: '光晕', desc: '星体的柔光辉光。低配机器可关掉省 GPU' },
            },
          },
        },
          file: '',
        })
      }

      if (req.method === 'POST' && p === '/settings') {
        return readBody(req, (b) => {
          try {
            const values = (b && b.values) || b || {}
            const patch = {}
            const applied = []
            for (const [k, v] of Object.entries(values)) {
              if (k === 'inject.enabled') { patch.inject = v === true; applied.push(k) }
              else if (k === 'inject.budgetChars') { patch.injectBudgetChars = Number(v); applied.push(k) }
              else if (k === 'inject.recallK') { patch.recallK = Number(v); applied.push(k) }
              else if (k === 'inject.minScore') { patch.recallMinScore = Number(v); applied.push(k) }
              else if (k === 'inject.withProcedures') { patch.withProcedures = v === true; applied.push(k) }
              else if (k === 'inject.withTaste') { patch.withTaste = v === true; applied.push(k) }
              else if (k === 'inject.withProfile') { patch.withProfile = v === true; applied.push(k) }
              else if (k === 'voice.enabled') { patch.voiceEnabled = v === true; applied.push(k) }
              else if (k === 'voice.model') { patch.voiceModel = String(v || 'breeze-tts-2'); applied.push(k) }
              else if (k === 'voice.lang') { patch.voiceLang = String(v || 'zh'); applied.push(k) }
              else if (k === 'voice.boost') { patch.voiceBoost = v === true; applied.push(k) }
              else if (k === 'voice.proxy') { patch.voiceProxy = String(v || ''); applied.push(k) }
              else if (k === 'voice.maxPerMin') { patch.voiceMaxPerMin = Number(v); applied.push(k) }
              else if (k === 'voice.maxPerHour') { patch.voiceMaxPerHour = Number(v); applied.push(k) }
              else if (k === 'graph.autoRotate') { patch.graphAutoRotate = v === true; applied.push(k) }
              else if (k === 'graph.labels') { patch.graphLabels = v === true; applied.push(k) }
              else if (k === 'graph.halo') { patch.graphHalo = v === true; applied.push(k) }
            }
            if (!applied.length) return send({ ok: false, error: '没有可应用的字段' }, 400)
            applyRuntimeCfg(patch)
            log('设置已应用：' + applied.join(', '))
            return send({ ok: true, applied, values: {
              'inject.enabled': readCfg().inject === true,
              'inject.withProcedures': readCfg().withProcedures === true,
              'inject.withTaste': readCfg().withTaste === true,
              'voice.enabled': readCfg().voiceEnabled === true,
              'voice.model': readCfg().voiceModel || 'breeze-tts-2',
              'inject.withProfile': readCfg().withProfile === true,
            } })
          } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
        })
      }

      // 恢复默认（只支持 inject 组）
      if (req.method === 'POST' && p === '/settings/reset') {
        return readBody(req, (b) => {
          try {
            const group = b && b.group
            if (group === 'inject' || !group) {
              runtimeCfgPatch = {}
              saveSettingsToDisk()
              log('设置已恢复默认（inject 组）')
              return send({ ok: true })
            }
            return send({ ok: false, error: '该组不支持重置' }, 400)
          } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
        })
      }

      // ── 语音诊断与测试 ──
      if (req.method === 'GET' && p === '/voice/health') {
        const c = readCfg()
        const sl = resolveSnowLuma()
        const h = await snowLumaHealth(sl)
        return send({
          ok: true,
          breeze: {
            enabled: c.voiceEnabled === true,
            configured: !!(String(process.env.BREEZE_API_KEY || c.voiceApiKey || '').trim()),
            baseUrl: c.voiceBaseUrl || 'https://api.breeze.blue',
            voiceId: Boolean(process.env.BREEZE_VOICE_ID || c.voiceId),
            model: c.voiceModel || 'breeze-tts-2',
            lang: c.voiceLang || 'zh',
            boost: c.voiceBoost !== false,
            proxy: c.voiceProxy || '',
          },
          snowluma: h,
          target: sl.ownerQQ || 0,
          rate: voiceRateUsage(),
        })
      }

      // 从 API 地址拉模型列表（面板下拉的数据源；拉不到就回退内置两种）
      if (req.method === 'GET' && p === '/voice/models') {
        const c = readCfg()
        const apiKey = String(process.env.BREEZE_API_KEY || c.voiceApiKey || '').trim()
        const baseUrl = String(process.env.BREEZE_BASE_URL || c.voiceBaseUrl || 'https://api.breeze.blue')
        const list = await breezeModels({ apiKey, baseUrl, proxy: c.voiceProxy || null })
        if (list.length) voiceModelList = list
        return send({ ok: true, source: list.length ? 'api' : 'fallback', baseUrl, models: voiceModelOptions() })
      }

      // 真实合成一条（不发送，只验证链路）
      if (req.method === 'POST' && p === '/voice/test') {
        return readBody(req, async (b) => {
          try {
            const c = readCfg()
            const apiKey = String(process.env.BREEZE_API_KEY || c.voiceApiKey || '').trim()
            if (!apiKey) return send({ ok: false, error: '未配置 API key' }, 400)
            if (!(process.env.BREEZE_VOICE_ID || c.voiceId)) return send({ ok: false, error: '未配置音色 ID（设置环境变量 BREEZE_VOICE_ID）' }, 400)

            const text = String((b && b.text) || '这是一条测试语音。').slice(0, 200)
            const t0 = Date.now()
            const audio = await synthesize(text, {
              apiKey,
              voiceId: String(process.env.BREEZE_VOICE_ID || c.voiceId || ''),
              modelId: c.voiceModel,
              languageCode: c.voiceLang,
              useSpeakerBoost: c.voiceBoost !== false,
              proxy: c.voiceProxy,
              baseUrl: String(process.env.BREEZE_BASE_URL || c.voiceBaseUrl || 'https://api.breeze.blue'),
            })
            return send({
              ok: true,
              bytes: audio.buffer.length,
              contentType: audio.contentType,
              ms: Date.now() - t0,
              text,
            })
          } catch (e) {
            return send({ ok: false, error: (e?.message ?? String(e)).slice(0, 300) }, 500)
          }
        })
      }

      // 真发一条（会消耗 credits，并真的发到 QQ）
      if (req.method === 'POST' && p === '/voice/send') {
        return readBody(req, async (b) => {
          try {
            const c = readCfg()
            if (c.voiceEnabled !== true) return send({ ok: false, error: '语音功能未开启' }, 403)
            const apiKey = String(process.env.BREEZE_API_KEY || c.voiceApiKey || '').trim()
            if (!apiKey) return send({ ok: false, error: '未配置 API key' }, 400)
            if (!(process.env.BREEZE_VOICE_ID || c.voiceId)) return send({ ok: false, error: '未配置音色 ID（设置环境变量 BREEZE_VOICE_ID）' }, 400)

            const text = String((b && b.text) || '这是一条测试语音。').slice(0, 200)
            const sl = resolveSnowLuma()
            const to = Number((b && b.to) || sl.ownerQQ)
            if (!to) return send({ ok: false, error: '拿不到目标 QQ' }, 400)

            const audio = await synthesize(text, {
              apiKey,
              voiceId: String(process.env.BREEZE_VOICE_ID || c.voiceId || ''),
              modelId: c.voiceModel,
              languageCode: c.voiceLang,
              useSpeakerBoost: c.voiceBoost !== false,
              proxy: c.voiceProxy,
              baseUrl: String(process.env.BREEZE_BASE_URL || c.voiceBaseUrl || 'https://api.breeze.blue'),
            })
            const r = await sendVoiceBase64(sl, to, audio.buffer)
            return send({ ok: true, to, bytes: audio.buffer.length, messageId: r.messageId, text })
          } catch (e) {
            return send({ ok: false, error: (e?.message ?? String(e)).slice(0, 300) }, 500)
          }
        })
      }

      // 账户余额
      if (req.method === 'GET' && p === '/voice/balance') {
        try {
          const c = readCfg()
          const apiKey = String(process.env.BREEZE_API_KEY || c.voiceApiKey || '').trim()
          if (!apiKey) return send({ ok: false, error: '未配置 API key' }, 400)
          const b = await breezeBalance({ apiKey, proxy: c.voiceProxy, baseUrl: c.voiceBaseUrl })
          return send({ ok: true, balance: b })
        } catch (e) {
          return send({ ok: false, error: (e?.message ?? String(e)).slice(0, 200) }, 500)
        }
      }

      if (req.method === 'GET' && p === '/state') {
            const sleepState = sleep.get()          // 内部已 selfHeal + 补算
            return send({
              ok: true,
              sleep: sleepState,
              // ⚠️ fatigue 直接来自同一个 sleepState，**不再单独调 fatigue.get()**
              //    （两次调用会产生微小偏差，面板与顶部会显示不同数字）
              fatigue: sleepState.fatigue,
              schedule: sleep.schedule.get(),
              sleepVerdict: (() => {
                try { return { sleep: sleep.shouldSleep(), wake: sleep.shouldWake() } }
                catch (e) { return null }
              })(),
              thresholds: sleep.thresholds,
              // ⚠️ 必须用 readCfg() 实时读：cfg 是启动时的快照，
              //    面板改了开关后这里还显示旧值（系统页"注入 关闭"与实际不符）
              inject: (() => {
                const c = readCfg()
                return {
                  enabled: c.inject === true,
                  budget: c.injectBudgetChars,
                  k: c.recallK,
                  withProcedures: c.withProcedures === true,
                  withTaste: c.withTaste === true,
                  withProfile: c.withProfile === true,
                }
              })(),
              stats: store.stats(), mood: moodLine(),
              // 角色名：面板品牌位/标题用。以前根本没返回 → 品牌一直停在「·」
              role: roleInfo(),
              // budgetLedger 是"每个 prompt 节最近一次渲染的字数"，同名节会被反复覆盖写入；
              // 直接吐原始数组会让面板看到同一个节出现 6 次（实测），这里按节名去重取最新。
              budgetLedger: (() => {
                const seen = new Map()
                for (const b of budgetLedger) if (b && b.name) seen.set(b.name, b)
                return [...seen.values()]
              })(),
            })
          }
          // ── 睡眠状态变更历史（面板时间轴用）──
          if (req.method === 'GET' && p === '/sleep/history') {
            try { return send({ ok: true, items: sleep.history() }) }
            catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
          }
          // ── 清除手动覆盖（恢复自动判断）──
          if (req.method === 'POST' && p === '/sleep/clear-override') {
            return readBody(req, () => {
              try { sleep.clearOverride(); return send({ ok: true, sleep: sleep.get() }) }
              catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
            })
          }
          // ── 强制自愈（面板"修复状态"按钮）──
          if (req.method === 'POST' && p === '/sleep/heal') {
            return readBody(req, () => {
              try {
                sleep.selfHeal()
                sleep.fatigue.advance()
                return send({ ok: true, sleep: sleep.get() })
              } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
            })
          }
          // ── qq-bridge 状态代理 ──
          // 浏览器直连 127.0.0.1:3100 会被 CORS 拦（bridge 不返回 ACAO 头）。
          // 这里由宿主机 Node 侧转发一次，面板只依赖自己的同源接口。
          if (req.method === 'GET' && p === '/bridge-status') {
            try {
              const bc = readBridgeConfig()
              if (!bc) return send({ ok: false, error: '找不到 qq-bridge/config.json（可用 QQ_BRIDGE_CONFIG / QQ_BRIDGE_DIR 指定）' }, 502)
              const port = bc.consolePort || 3100
              const token = bc.consoleToken || ''
              const ac = new AbortController()
              const timer = setTimeout(() => { try { ac.abort() } catch {} }, 5000)
              timer.unref?.()
              const resp = await fetch('http://127.0.0.1:' + port + '/api/status', {
                headers: { 'x-console-token': token },
                signal: ac.signal,
              })
              clearTimeout(timer)
              if (!resp.ok) return send({ ok: false, error: 'bridge 返回 HTTP ' + resp.status }, 502)
              const data = await resp.json()
              // 桥接报的"当前生效角色"最可信：缓存下来给 roleInfo() 兜底用
              if (data && data.role) { cachedRole = String(data.role).trim() || null; cachedRoleAt = Date.now() }
              return send({ ok: true, ...data })
            } catch (e) {
              return send({ ok: false, error: 'bridge 不可达：' + (e?.message ?? String(e)) }, 502)
            }
          }
          // ── 面板手动改角色名（持久化到 dataDir/identity.json）──
          if (req.method === 'POST' && p === '/role-name') {
            return readBody(req, (body) => {
              const name = String((body && body.name) || '').trim()
              if (!name) return send({ ok: false, error: '名字不能为空' }, 400)
              if (name.length > 24) return send({ ok: false, error: '名字最长 24 字' }, 400)
              writeIdentity({ name })
              log('角色名已改为：' + name)
              return send({ ok: true, role: roleInfo() })
            })
          }
          // ── 星图外观参数（面板启动时读取，改设置后刷新即可见）──
          // 以前前端请求它、后端没有这条路由 → 404，星图参数永远用默认值。
          if (req.method === 'GET' && p === '/graph-settings') {
            const c = readCfg()
            return send({
              ok: true,
              values: {
                autoRotate: c.graphAutoRotate !== false,
                labels: c.graphLabels !== false,
                halo: c.graphHalo !== false,
              },
            })
          }
          // ── qq-bridge 通用代理（角色卡 / 令牌消费等）──
          // 浏览器直连 3100 会被 CORS 拦；这里由宿主机转发。
          // 白名单路径，避免变成任意代理。
          if (req.method === 'GET' && p.startsWith('/bridge/')) {
            const ALLOWED = [
              '/api/presets', '/api/roles', '/api/roles/content',
              '/api/preset/sim-prompt',
              '/api/tokens/summary', '/api/tokens/series',
              '/api/tokens/turns', '/api/tokens/recent',
            ]
            const target = p.slice('/bridge'.length)
            if (!ALLOWED.includes(target)) {
              return send({ ok: false, error: '不允许的代理路径：' + target }, 403)
            }
            try {
              const bc = readBridgeConfig()
              if (!bc) return send({ ok: false, error: '找不到 qq-bridge/config.json' }, 502)
              const port = bc.consolePort || 3100
              const token = bc.consoleToken || ''
              const ac = new AbortController()
              const timer = setTimeout(() => { try { ac.abort() } catch {} }, 6000)
              timer.unref?.()
              // ⚠️ 必须把 query 原样带上（/api/roles/content?name=… 靠它定位文件名）。
              //    原来只转 target 路径，query 丢了 → bridge 返回 400。
              const qs = url.search ? url.search : ''
              const resp = await fetch('http://127.0.0.1:' + port + target + qs, {
                headers: { 'x-console-token': token },
                signal: ac.signal,
              })
              clearTimeout(timer)
              const txt = await resp.text()
              res.writeHead(resp.status, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              })
              res.end(txt)
              return
            } catch (e) {
              return send({ ok: false, error: 'bridge 不可达：' + (e?.message ?? String(e)) }, 502)
            }
          }
          // ── 作息表读写（面板可设定她什么时候睡、什么时候醒）──
          if (req.method === 'GET' && p === '/sleep/schedule') {
            try { return send({ ok: true, schedule: sleep.schedule.get(), fatigue: sleep.fatigue.get() }) }
            catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
          }
          if (req.method === 'POST' && p === '/sleep/schedule') {
            return readBody(req, (b) => {
              try {
                const patch = {}
                if (b && typeof b.auto === 'boolean') patch.auto = b.auto
                if (b && typeof b.preferFixedTime === 'boolean') patch.preferFixedTime = b.preferFixedTime
                if (b && typeof b.fatigueSleep === 'number') patch.fatigueSleep = b.fatigueSleep
                if (b && typeof b.fatigueWake === 'number') patch.fatigueWake = b.fatigueWake
                if (b && Array.isArray(b.windows)) patch.windows = b.windows
                const next = sleep.schedule.set(patch)
                log('作息表已更新')
                // 返回最新状态（改完作息立刻重算，面板可直接刷新）
                return send({ ok: true, schedule: next, sleep: sleep.get() })
              } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
            })
          }
          // ── 手动设置疲惫值 ──
          if (req.method === 'POST' && p === '/sleep/fatigue') {
            return readBody(req, (b) => {
              try {
                if (!b || typeof b.value !== 'number') return send({ ok: false, error: 'value 必须是数字' }, 400)
                const v = sleep.fatigue.set(b.value)
                // 手动改疲惫值后同步到 mood（保持单一数据源）
                try { syncFatigueToMood(v) } catch {}
                return send({ ok: true, fatigue: v, sleep: sleep.get() })
              } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
            })
          }
          // ── 真正删除一条记忆（物理删除 + FTS 清理 + 审计）──
          if (req.method === 'POST' && p === '/memory/delete') {
            return readBody(req, (b) => {
              try {
                if (!b || !b.id) return send({ ok: false, error: '缺少 id' }, 400)
                const r = store.purge(b.id, { reason: b.reason || '用户手动删除' })
                log('物理删除记忆：' + b.id)
                return send({ ok: true, ...r })
              } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }, 500) }
            })
          }
          if (req.method === 'GET' && p === '/graph') {
            const sinceRaw = url.searchParams.get('since')
            const untilRaw = url.searchParams.get('until')
            return send({
              ok: true,
              ...store.graphData({
                scope: url.searchParams.get('scope') || 'private',
                limit: Number(url.searchParams.get('limit')) || 200,
                since: sinceRaw ? Number(sinceRaw) : undefined,
                until: untilRaw ? Number(untilRaw) : undefined,
              }),
            })
          }
          if (req.method === 'GET' && p === '/recent') return send({ ok: true, items: store.recent(50) })
          if (req.method === 'GET' && p === '/audit') return send({ ok: true, items: store.auditList(80) })
          // ── 星图时间轴元信息 ──
          // 面板的时间轴需要知道"库里的时间跨度是多少"，否则滑块没有意义。
          // 这里只给真实的最早/最晚 created_at 与按类型计数，不编造区间。
          if (req.method === 'GET' && p === '/graph-meta') {
            try {
              const row = store.timeRange()
              return send({ ok: true, ...row })
            } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }) }
          }
          // ── 单条记忆全文（详情面板展开用）──
          if (req.method === 'GET' && p === '/memory/get') {
            const id = url.searchParams.get('id') || ''
            try {
              const m = store.get(id)
              if (!m) return send({ ok: false, error: '记忆不存在或已删除' }, 404)
              return send({ ok: true, memory: m })
            } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }) }
          }
          // ── 日记列表（面板用）──
          // mood 的 /dsh-mood-api/state 只给 count、不给日期列表（它把日期日历交给设置页
          // 自己按需一篇篇去 /diary?date= 取）。独立面板需要先看到有哪些天，
          // 所以这里提供 only 元信息（日期+心情+字数），正文仍走 mood 的 /diary 受锁门禁。
          if (req.method === 'GET' && p === '/diary-index') {
            try {
              const f = join(moodDataDir(), 'dsh-mood-diary.json')
              if (!existsSync(f)) return send({ ok: true, entries: [], locked: false, count: 0 })
              // 日记是 AES-256-GCM 加密的，dsh-mind 侧不持密钥——这里只能给出
              // "文件存在 + 大小 + 修改时间"这种不涉正文的元信息，避免绕过 mood 的锁。
              const st = statSync(f)
              return send({
                ok: true, count: null, locked: true,
                file: f, bytes: st.size, mtime: st.mtimeMs,
                note: '日记正文由 mood 引擎加密持有，面板经 /dsh-mood-api/diary 受锁门禁读取',
              })
            } catch (e) { return send({ ok: false, error: e?.message ?? String(e) }) }
          }
          if (req.method === 'GET' && p === '/query') {
            const q = url.searchParams.get('q') || ''
            return send({ ok: true, q, hits: q ? store.search(q, { k: 8, minScore: 0.15 }) : [] })
          }
          if (req.method === 'POST' && p === '/memory/correct') {
            return readBody(req, (b) => send({ ok: true, ...store.correct(b.id, { newText: b.text, reason: b.reason, actor: 'panel' }) }))
          }
          if (req.method === 'POST' && p === '/memory/forget') {
            return readBody(req, (b) => send({ ok: true, ...store.forget(b.id, { tier: b.tier || 1, reason: b.reason, actor: 'panel' }) }))
          }
          if (req.method === 'POST' && p === '/sleep/enter') {
            return send({ ok: true, ...sleep.enterPreparing({ reason: '管理面板手动' }) })
          }
          if (req.method === 'POST' && p === '/sleep/wake') {
            // ⚠️ 两个线上实测踩到的坑，别再踩：
            //   ① sleeping 只能迁移到 recovering，直接 wake() 会抛「非法状态迁移」→ 面板 500。
            //      所以这里按状态机路径走：sleeping → recovering → awake。
            //   ② 原写法 `!sleep.canForceWake(true)` 永远为 false（传 true 就永远允许），
            //      等于严格锁对管理员完全失效。严格锁的语义是「agent/普通消息不能唤醒，
            //      但**管理员在面板上**可以」—— 面板就是管理员通道，故此处放行是符合设计的，
            //      但要把意图写清楚，而不是靠一个恒假的条件蒙混过去。
            const st = sleep.get().state
            if (st === 'awake') return send({ ok: true, state: 'awake', note: '已经是清醒状态' })
            try {
              if (st === 'preparing') {
                return send({ ok: true, ...sleep.cancel() })
              }
              if (st === 'sleeping') {
                sleep.enterRecovering({ reason: '管理面板强制唤醒' })
                return send({ ok: true, ...sleep.wake({ reason: '管理面板强制唤醒' }) })
              }
              if (st === 'recovering') {
                return send({ ok: true, ...sleep.wake({ reason: '管理面板手动' }) })
              }
              return send({ ok: false, error: `未知状态 ${st}` }, 400)
            } catch (e) {
              return send({ ok: false, error: `唤醒失败：${e?.message ?? e}` }, 500)
            }
          }
          if (req.method === 'GET' && p === '/panel') {
            // panel/index.html 从插件自身目录读（ESM 无 __dirname，用 import.meta.url 推导）；
            // 读不到（被打包/拷贝丢文件）时退到内置轻量页——面板永不白屏。
            let html = null
            try { html = readFileSync(join(__dirname, 'panel', 'index.html')) } catch {}
            if (!html) {
              log('panel/index.html 读取失败，退到内置轻量页（__dirname=' + __dirname + '）')
              html = Buffer.from(PANEL_FALLBACK_HTML)
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end(html)
            return
          }
          // ── 面板脚本：universe.js（3D 引擎模块）──
          // 它必须走 /dsh-mind-api/ 前缀而不是 /vendor/，因为模块内部
          // `import * as THREE from './vendor/three.module.min.js'` 是相对路径，
          // 浏览器会解析到 /dsh-mind-api/vendor/three.module.min.js ——
          // 正好命中上面那条静态资源路由。放在 /panel/vendor/ 下反而会断链。
          if (req.method === 'GET' && p === '/universe.js') {
            try {
              const src = readFileSync(join(__dirname, 'panel', 'universe.js'))
              res.writeHead(200, {
                'content-type': 'text/javascript; charset=utf-8',
                'cache-control': 'no-store',
              })
              res.end(src)
              return
            } catch (e) {
              return send({ ok: false, error: 'universe.js 读取失败：' + (e?.message ?? e) }, 500)
            }
          }
          // ── 面板静态资源（3D 引擎等）──
          // Three.js 必须**随插件本地分发**，不能走 CDN：这是本地管理面板，
          // 断网/内网环境下 CDN 拉不到会让整个星图白屏。所以这里提供
          // /panel/vendor/* 的静态服务。
          // ⚠️ 路径穿越防护：解析出真实绝对路径后必须校验仍在 panel/vendor 之内，
          //    否则 ../ 就能读到任意文件（本服务无鉴权）。
          if (req.method === 'GET' && (p === '/vendor' || p.startsWith('/vendor/'))) {
            try {
              const rel = decodeURIComponent(p.slice('/vendor'.length)) || '/'
              const vendorRoot = join(__dirname, 'panel', 'vendor')
              const abs = resolve(vendorRoot, '.' + rel)
              const rootResolved = resolve(vendorRoot)
              if (!abs.startsWith(rootResolved + sep) && abs !== rootResolved) {
                log('拒绝越界的静态资源请求：' + rel)
                return send({ ok: false, error: '非法路径' }, 403)
              }
              if (!existsSync(abs)) return send({ ok: false, error: '资源不存在' }, 404)
              const body = readFileSync(abs)
              const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase()
              const MIME = {
                '.js': 'text/javascript; charset=utf-8',
                '.mjs': 'text/javascript; charset=utf-8',
                '.json': 'application/json; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.wasm': 'application/wasm',
                '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
                '.glsl': 'text/plain; charset=utf-8',
              }
              res.writeHead(200, {
                'content-type': MIME[ext] || 'application/octet-stream',
                // 引擎文件不带 hash，但体积稳定，允许短缓存减少重复传输
                'cache-control': 'public, max-age=3600',
              })
              res.end(body)
              return
            } catch (e) {
              return send({ ok: false, error: '静态资源读取失败：' + (e?.message ?? e) }, 500)
            }
          }
          send({ ok: false, error: '未知路径' }, 404)
        } catch (e) {
          try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e?.message ?? String(e) })) } catch {}
        }
      },
    }), 'dsh-mind http')
    // 面板挂载成功 = webServer 确实就绪了 → 立刻冲刷 mood 的 /dsh-mood-api 等待队列
    try { flushPendingWebServer() } catch {}
    return true
  }
  // 三时序拿 webServer：get 直取 → get('web') 旧名兜底 → 真 inject 就绪回调
  let panelBound = false
  try { panelBound = registerPanel(ctx.get ? ctx.get('webServer') : null) } catch { panelBound = false }
  if (!panelBound) { try { panelBound = registerPanel(ctx.get ? ctx.get('web') : null) } catch { panelBound = false } }
  if (!panelBound) {
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (c) => {
          try {
            const w = c.webServer ?? (c.get ? c.get('webServer') : null)
            if (!registerPanel(w)) log('[fusion] webServer 注入回调里仍拿不到注册器——面板无法挂载')
            else log('[fusion] webServer 经 inject 就绪，星图面板已挂载')
            // 面板与 mood 共用同一个 webServer：这里一并把 mood 的等待队列冲刷掉
            try { flushPendingWebServer() } catch {}
          } catch (e) { log('[fusion] webServer 注入回调失败：', e?.message ?? e) }
        })
      } else log('[fusion] webServer 不可用且宿主无 inject——面板无法挂载')
    } catch (e) { log('[fusion] webServer 注入失败：', e?.message ?? e) }
  }

  function readBody(req, cb) {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 65536) req.destroy() })
    req.on('end', () => { try { cb(JSON.parse(buf || '{}')) } catch { cb(null) } })
  }

  log(`就绪（融合模式）：dataDir=${dataDir} inject=${cfg.inject === true ? 'on' : 'off(灰度)'} defineTool=${defineToolSource}`)
  return { cfg, store, sleep, setQueryHint, db }
}

// 内置轻量兜底页：panel/index.html 读不到时用（功能完整，只是没有星图画布）
const PANEL_FALLBACK_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-mind 记忆面板</title>
<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#0d0f1c;color:#e6e8f5;max-width:960px;margin:30px auto;padding:0 16px}
h1{font-size:20px}.card{background:#151829;border:1px solid #262b4a;border-radius:12px;padding:16px;margin:14px 0}
.k{color:#8f94b5;font-size:12px}.num{font-size:26px;font-weight:650}code{color:#a3abee}
button{background:#5457d6;color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;margin-right:6px}
input{background:#1a1e33;border:1px solid #31365e;border-radius:8px;color:#e6e8f5;padding:8px;width:60%}
.m{color:#aeb2cf;font-size:13px;line-height:1.7}.hint{color:#e9bd6c;font-size:12px}</style></head><body>
<h1>dsh-mind 记忆面板（轻量版 · panel/index.html 缺失时兜底）</h1>
<div class="card"><span class="k">状态</span><div id="state">加载中…</div></div>
<div class="card"><span class="k">检索调试（可解释打分）</span><br>
<input id="q" placeholder="关键词，如：面试"><button onclick="doQuery()">搜索</button>
<div class="m" id="hits"></div></div>
<p class="hint">完整星图面板需要插件目录下的 panel/index.html——检查 dsh-mind 安装完整性。</p>
<script>
async function jf(u,o){const r=await fetch(u,Object.assign({headers:{'x-dsh-mind':'1'}},o||{}));return r.json()}
async function load(){const r=await jf('/dsh-mind-api/state');
document.getElementById('state').innerHTML=
 '睡眠：<b>'+r.sleep.state+'</b> ｜ 记忆：<b>'+r.stats.total+'</b> 条（归档 '+r.stats.archived+'）｜ 实体 '+r.stats.entities+
 ' ｜ 未处理冲突 '+r.stats.conflictsOpen+'<br>注入：'+(r.inject.enabled?'<b style="color:#4fd1a5">开</b>':'<b style="color:#e9bd6c">关（灰度只写）</b>')+
 '，总预算 '+r.inject.budget+' 字 ｜ '+ (r.mood||'') }
async function doQuery(){const q=document.getElementById('q').value;
const r=await jf('/dsh-mind-api/query?q='+encodeURIComponent(q));
document.getElementById('hits').innerHTML=(r.hits||[]).map(h=>'<div>['+h.kind+'] '+h.text+' <span class="k">score '+h.score+'</span></div>').join('')||'（无命中——可换同义词再试）'}
load()
</script></body></html>`

const PANEL_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-mind 记忆面板</title>
<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#0d0f1c;color:#e6e8f5;max-width:960px;margin:30px auto;padding:0 16px}
h1{font-size:20px}.card{background:#151829;border:1px solid #262b4a;border-radius:12px;padding:16px;margin:14px 0}
.k{color:#8f94b5;font-size:12px}.num{font-size:26px;font-weight:650}code{color:#a3abee}
button{background:#5457d6;color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;margin-right:6px}
input{background:#1a1e33;border:1px solid #31365e;border-radius:8px;color:#e6e8f5;padding:8px;width:60%}
.m{color:#aeb2cf;font-size:13px;line-height:1.7}</style></head><body>
<h1>dsh-mind 记忆面板（独立页 · 不属于 DSH 设置）</h1>
<div class="card"><span class="k">状态</span><div id="state">加载中…</div></div>
<div class="card"><span class="k">检索调试（可解释打分）</span><br>
<input id="q" placeholder="关键词，如：面试"><button onclick="doQuery()">搜索</button>
<div class="m" id="hits"></div></div>
<script>
async function jf(u,o){const r=await fetch(u,Object.assign({headers:{'x-dsh-mind':'1'}},o||{}));return r.json()}
async function load(){const r=await jf('/dsh-mind-api/state');
document.getElementById('state').innerHTML=
 '睡眠：<b>'+r.sleep.state+'</b> ｜ 记忆：<b>'+r.stats.total+'</b> 条（归档 '+r.stats.archived+'）｜ 实体 '+r.stats.entities+
 ' ｜ 未处理冲突 '+r.stats.conflictsOpen+'<br>注入：'+(r.inject.enabled?'<b style="color:#4fd1a5">开</b>':'<b style="color:#e9bd6c">关（灰度只写）</b>')+
 '，总预算 '+r.inject.budget+' 字 ｜ '+ (r.mood||'') }
async function doQuery(){const q=document.getElementById('q').value;
const r=await jf('/dsh-mind-api/query?q='+encodeURIComponent(q));
document.getElementById('hits').innerHTML=(r.hits||[]).map(h=>'<div>['+h.kind+'] '+h.text+' <span class="k">score '+h.score+'</span></div>').join('')||'（无命中——可换同义词再试）'}
load()
</script></body></html>`
