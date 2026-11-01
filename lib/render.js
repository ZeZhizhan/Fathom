// dsh-mind / render.js —— 把工具返回值摊成**模型能读的文本**
//
// 为什么单独有这一层：工具的 output.render 决定模型看到什么。
// dsh-mind 曾经只渲染 `value.message`（"检索到 5 条相关记忆"），
// 模型于是拿着一个数字、正文一个字看不到 —— 检索结果等于没返回。
// 这里统一负责把 hits / items / memory / stats 四种形状渲染成可读文本。

const KIND_LABEL = {
  episode: '事件',
  fact: '事实',
  reflection: '反思',
  skill: '技能',
  lesson: '道理',
  preference: '偏好',
  profile: '画像',
  procedural: '流程',
  emotion_event: '情绪事件',
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 单条记忆 → 一行（正文 + 缩进的元信息行） */
export function fmtMemLine(m, i = 0) {
  if (!m) return ''
  const kind = KIND_LABEL[m.kind] || m.kind || '记忆'
  const imp = Number.isFinite(Number(m.importance)) ? Number(m.importance).toFixed(2) : '—'
  let when = ''
  if (m.created_at) {
    const d = new Date(Number(m.created_at))
    if (!Number.isNaN(d.getTime())) when = ' · ' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate())
  }
  const text = String(m.text || '').replace(/\s+/g, ' ').trim()
  const meta = [
    'id=' + m.id,
    m.source ? '来源 ' + m.source : '',
    m.score != null && Number.isFinite(Number(m.score)) ? '相关度 ' + Number(m.score).toFixed(2) : '',
  ].filter(Boolean).join(' · ')
  return (i + 1) + '. [' + kind + when + ' · 重要度' + imp + '] ' + text + (meta ? '\n   ' + meta : '')
}

/** 工具返回值 → DSH output.render 需要的 content 数组 */
export function renderMemoryValue(value) {
  const v = value || {}
  const lines = []
  if (Array.isArray(v.hits)) {
    if (v.hits.length) {
      lines.push('检索到 ' + v.hits.length + ' 条相关记忆：')
      v.hits.forEach((m, i) => lines.push(fmtMemLine(m, i)))
    } else {
      lines.push('没有检索到相关记忆。' + (v.hint ? ' ' + v.hint : ''))
    }
  } else if (Array.isArray(v.items)) {
    lines.push('最近 ' + v.items.length + ' 条记忆：')
    v.items.forEach((m, i) => lines.push(fmtMemLine(m, i)))
  } else if (v.memory) {
    lines.push(fmtMemLine(v.memory, 0))
  } else if (v.total != null || Array.isArray(v.byKind)) {
    const byKind = Array.isArray(v.byKind) ? v.byKind : []
    lines.push('记忆库：有效 ' + (v.total ?? 0) + ' 条' + (v.archived != null ? '，归档 ' + v.archived + ' 条' : ''))
    if (byKind.length) {
      lines.push('  ' + byKind.map((x) => (KIND_LABEL[x.kind] || x.kind) + ' ' + x.n).join(' · '))
    }
    if (v.entities != null) lines.push('  实体 ' + v.entities + ' 个 · 待处理冲突 ' + (v.conflictsOpen ?? 0))
  } else {
    lines.push(v.message || v.error || JSON.stringify(v))
  }
  if (v.message && (v.hits || v.items)) lines.push('(' + v.message + ')')
  return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
}
