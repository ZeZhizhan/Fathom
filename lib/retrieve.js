// dsh-mind / retrieve.js —— 省 token 注入协调器 + 混合打分入口
//
// 三条省 token 纪律：
//   1. 注入块总预算默认 1000 字，超预算按优先级裁（记忆 > 心情 > 经验卡 > 偏好）
//   2. 记忆条数默认 top-2、单条截 80 字、低于 0.45 分不注入（手册：私聊 2 条、门槛 0.45）
//   3. 注入关闭时（inject:false，"先只写不读"灰度期）本模块只算不发

const SECTION_ORDER = ['memory', 'mood', 'procedures', 'taste', 'profile']
const MARKER = '<!--dsh-mind:v1-->'

/**
 * 组装注入块。inputs:
 *   memoryHits: memory.search() 的结果（已打分）
 *   moodLine:   '当前心情：…'（emotions 桥接给出，可为空）
 *   procedureHook: 经验卡消歧索引（procedures.js renderHook，可为空）
 *   profileLine: 偏好一句话（可为空）
 * cfg: { injectBudgetChars, recallK, memoryMaxChars, recallMinScore,
 *        blocks: { memory, mood, procedures, taste, profile } }
 *        · memory / mood          缺省即开
 *        · procedures / taste / profile  缺省为关，须显式 true
 * 返回 { text, usedChars, sections: [{name, chars}] }——面板可解释：每块花了多少。
 */
export function buildInjectBlock({ memoryHits = [], moodLine = '', procedureHook = '', tasteLine = '', profileLine = '' } = {}, cfg = {}) {
  const budget = Number(cfg.injectBudgetChars) || 1000
  const k = Number(cfg.recallK) || 2
  const maxChars = Number(cfg.memoryMaxChars) || 80
  // ⚠️ 注意：不能用 `Number(x) ?? 0.45` —— Number(undefined) 是 NaN，
  //    而 NaN ?? 0.45 仍是 NaN（?? 只对 null/undefined 生效）。
  //    一旦是 NaN，下面的 `h.score >= minScore` 恒为 false，所有记忆都会被丢掉。
  const rawMin = Number(cfg.recallMinScore)
  const minScore = Number.isFinite(rawMin) ? rawMin : 0.45
  /**
   * 某节是否启用。
   *
   * · memory / mood：默认**开**（缺省即开，历史行为）
   * · procedures / profile：默认**关** —— 必须在 blocks 里显式写 true 才启用
   *
   * 关闭时 buildInjectBlock 不会为它生成任何字符，
   * 调用方也不该去取数据（避免无用的 IO 与计算）。
   */
  const blocks = cfg.blocks || {}
  const on = (name) => {
    if (name === 'memory' || name === 'mood') return blocks[name] !== false
    return blocks[name] === true
  }

  const sections = []
  if (on('memory') && memoryHits.length) {
    const hits = memoryHits.filter((h) => h.score >= minScore).slice(0, k)
    if (hits.length) {
      const lines = hits.map((h, i) => `${i + 1}.${h.text.slice(0, maxChars)}（${h.kind}）`)
      sections.push({ name: 'memory', text: `【相关记忆】\n${lines.join('\n')}` })
    }
  }
  if (on('mood') && moodLine) sections.push({ name: 'mood', text: `【心情】${moodLine}` })
  if (on('procedures') && procedureHook) sections.push({ name: 'procedures', text: procedureHook })
  if (on('taste') && tasteLine) sections.push({ name: 'taste', text: `【品味】${tasteLine}` })
  if (on('profile') && profileLine) sections.push({ name: 'profile', text: `【偏好】${profileLine}` })

  // 按优先级裁剪到预算
  const kept = []
  const keptSections = []
  let used = MARKER.length + 2
  for (const name of SECTION_ORDER) {
    const s = sections.find((x) => x.name === name)
    if (!s) continue
    const cost = s.text.length + 1
    if (used + cost > budget) continue
    kept.push(s.text)
    keptSections.push({ name, chars: s.text.length })
    used += cost
  }
  const text = kept.length ? `${MARKER}\n${kept.join('\n')}` : ''
  // kept 里存的是文本，但我们已经知道它的来源名，直接带上
  return { text, usedChars: text.length, sections: keptSections }
}

/** agent 侧检索提示：搜不到时换词重查（写进 mind_memory 工具描述） */
export const RETRY_HINT = '首轮无命中或分数低时，换同义关键词（如"紧张"→"压力/考试"）再查 1~2 次；仍无就如实说想不起来。'
