// dsh-mind / bigram.js —— 中文 bigram 分词（FTS 预分词列 + 查询改写）
//
// 为什么不用 unicode61 直接切：它把整段 CJK 当一个 token，"面试"永远搜不到"他说面试很紧张"。
// 做法：CJK 连续段切两字 bigram，拉丁词整词保留；入 FTS 的列存"空格连接的 bigram 串"，
// unicode61 就能按词命中。检索打分不用 FTS 的 bm25，由 retrieve.js 自己算覆盖率。


function isCjkRun(s) {
  return /^[\u3400-\u4dbf\u4e00-\u9fff]+$/.test(s)
}

/** 把文本切成检索词（去重）：CJK 两字 bigram + 拉丁/数字词（小写） */
export function bigrams(text) {
  const out = new Set()
  const runs = String(text || '').match(/[\u3400-\u4dbf\u4e00-\u9fff]+|[A-Za-z0-9_]{2,}/g) || []
  for (const run of runs) {
    if (isCjkRun(run)) {
      if (run.length === 1) { out.add(run); continue }
      for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
    } else {
      out.add(run.toLowerCase())
    }
  }
  return [...out]
}

/** 入 FTS 列：空格连接（unicode61 按空格切词） */
export function toIndexText(text) {
  return bigrams(text).join(' ')
}

/** 查询改写：'OR' 连接的带引号词；空查询返回 '' */
export function toFtsQuery(text) {
  const g = bigrams(text)
  return g.length ? g.map((t) => `"${t}"`).join(' OR ') : ''
}

/** 覆盖率：候选文档的 bigram 被查询命中的比例（0..1）——打分主因子 */
/* 中文虚词 / 疑问 / 人称 —— 这些 bigram 不参与相关度打分。
 *
 * 为什么必须去掉：真实对话是长句，里面大量是
 * "你还记得吗""我明天要""能不能跟我说说"这类结构性成分，
 * 它们**不该**被期望出现在某条记忆里。若计入分母，
 * 任何长句的覆盖率都会被拉到接近 0（实测长句 0.000~0.100）。
 */
const STOP_BIGRAMS = new Set([
  '你还', '还记', '记得', '得吗', '吗',
  '我明', '明天', '天要', '能不', '不能', '能跟', '跟我', '我说', '说说',
  '我们', '之前', '前聊', '聊过', '过的', '的那', '那些', '些事',
  '一下', '帮我', '我帮', '可不', '可以', '以吗',
  '什么', '么时', '时候', '候的', '的是', '是不', '不是',
  '这个', '那个', '哪个', '现在', '在吗',
])

/** 去掉结构性 bigram 后的查询词 */
function meaningfulBigrams(queryBigrams) {
  const kept = queryBigrams.filter((b) => !STOP_BIGRAMS.has(b))
  // 全被过滤掉（比如整句都是虚词）时退回原集合，避免直接返回 0
  return kept.length ? kept : queryBigrams
}

/**
 * 查询与记忆的相关度（双向，0~1）。
 *
 * 旧实现是单向的：hit / queryLen ——要求**整句**被某条记忆覆盖，
 * 长句必然趋近 0（实测真实对话长句为 0.000~0.100），
 * 导致注入一条记忆都进不去。
 *
 * 新实现：
 *   ① 先去掉结构性 bigram（疑问、人称、连接词）
 *   ② 分母取 min(查询词数, 记忆词数) —— 这样
 *      "长查询命中短记忆里的核心词"也能拿高分
 *   ③ 至少命中 2 个 bigram 才认（单个 bigram 的巧合太多）；
 *      查询本身只有 1 个 bigram 时（如"睡觉"）豁免此限制
 */
export function coverRatio(docBigrams, queryBigrams) {
  if (!queryBigrams.length) return 0
  const set = new Set(docBigrams)
  const q = meaningfulBigrams(queryBigrams)

  let hit = 0
  for (const b of q) if (set.has(b)) hit++
  if (hit === 0) return 0

  // 短查询（1~2 个 bigram）：本来就是关键词式检索
  //   1 个命中 → 1.0（"睡觉"这种精确词直接满分）
  if (q.length <= 2) return Math.min(1, hit / q.length)

  // 长查询：按**命中个数**换算，不受句子长短影响。
  //   命中 2 个 → 0.55（越过默认阈值 0.45）
  //   命中 3 个 → 0.72，4 个 → 0.85，5 个及以上 → 接近 1
  //   只命中 1 个 → 0.30（低于阈值，避免长句里碰巧撞上一个常用词）
  if (hit === 1) return 0.30
  return Math.min(1, 0.40 + hit * 0.15)
}

export function docBigrams(text) {
  return bigrams(text)
}
