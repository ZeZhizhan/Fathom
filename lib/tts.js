// dsh-mind / lib/tts.js —— 语音合成与发送
//
// 职责：
//   ① BreezeBlue 克隆音色合成（需要 HTTP 代理，Node 的 fetch 不读系统代理）
//   ② 直连 SnowLuma 的 OneBot v11 接口，用 base64:// 发语音条（**不落盘**）
//   ③ 限流（防刷屏）
//
// 为什么不走 qq-bridge 的 qq_send_voice：
//   它只能从本地 audio/ 目录取文件。我们要发的是内存里刚合成的音频，
//   落盘再删既浪费又留痕。SnowLuma 的 record 段原生支持 base64://
//   （见其 inlineBase64Payload），全程在内存里解码。

import http from 'node:http'
import https from 'node:https'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { URL } from 'node:url'

/* ═══════════════════════════════════════════════════════════════════
   HTTP 请求（支持代理）
   ───────────────────────────────────────────────────────────────────
   api.breeze.blue 在国内网络下不直连可达，而 **Node 的 fetch 不读系统代理**
   （curl / PowerShell 会读，Node 不会）。所以这里用原生 http CONNECT 建隧道，
   不引入 undici 等依赖。代理不可用时自动降级直连。
   ═══════════════════════════════════════════════════════════════════ */
function requestWithProxy(urlStr, { method = 'GET', headers = {}, body = null, proxy = null, timeoutMs = 60000 } = {}) {
  const target = new URL(urlStr)
  const host = target.hostname
  const port = Number(target.protocol === 'https:' ? 443 : 80)
  const path = target.pathname + target.search

  return new Promise((resolve, reject) => {
    const doRequest = (socket) => {
      const mod = target.protocol === 'https:' ? https : http
      const req = mod.request({
        host, port, path, method, headers,
        ...(socket ? { socket, agent: false } : {}),
        servername: target.protocol === 'https:' ? host : undefined,
        timeout: timeoutMs,
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          buffer: Buffer.concat(chunks),
        }))
      })
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error('请求超时（' + timeoutMs + 'ms）')))
      if (body) req.write(body)
      req.end()
    }

    if (!proxy) return doRequest(null)

    let pUrl
    try { pUrl = new URL(proxy) } catch { return doRequest(null) }

    const connectReq = http.request({
      host: pUrl.hostname,
      port: Number(pUrl.port || 7890),
      method: 'CONNECT',
      path: host + ':' + port,
      headers: { host: host + ':' + port },
      timeout: 20000,
    })
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error('代理 CONNECT 失败（HTTP ' + res.statusCode + '）'))
      doRequest(socket)
    })
    connectReq.on('error', reject)
    connectReq.on('timeout', () => connectReq.destroy(new Error('代理连接超时')))
    connectReq.end()
  })
}

/* ═══════════════════════════════════════════════════════════════════
   BreezeBlue TTS
   ═══════════════════════════════════════════════════════════════════ */
export async function synthesize(text, cfg = {}) {
  const apiKey = String(cfg.apiKey || '').trim()
  if (!apiKey) throw new Error('缺少 BreezeBlue API key')
  const voiceId = String(cfg.voiceId || '').trim()
  if (!voiceId) throw new Error('缺少 voiceId')

  const baseUrl = String(cfg.baseUrl || 'https://api.breeze.blue').replace(/\/+$/, '')

  const payload = {
    text: String(text),
    model_id: cfg.modelId || 'breeze-tts-2',
    language_code: cfg.languageCode || 'zh',
  }

  // ⚠️ use_speaker_boost 是解决"气声多"的关键：默认 false 时不像克隆原声。
  //    官方文档：Improve similarity to the reference voice. Default: false.
  //    注意：instructions 非空且 guidance_scale > 1 时它会被忽略，所以默认不传 instructions。
  const vs = {}
  if (cfg.useSpeakerBoost === true) vs.use_speaker_boost = true
  if (cfg.speed != null) vs.speed = Number(cfg.speed)
  if (cfg.guidanceScale != null) vs.guidance_scale = Number(cfg.guidanceScale)
  if (Object.keys(vs).length) payload.voice_settings = vs

  const bodyStr = JSON.stringify(payload)
  const res = await requestWithProxy(`${baseUrl}/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(bodyStr),
    },
    body: bodyStr,
    proxy: cfg.proxy || null,
    timeoutMs: Number(cfg.timeoutMs) || 60000,
  })

  if (res.status !== 200) {
    throw new Error('BreezeBlue 合成失败（HTTP ' + res.status + '）：' + res.buffer.toString('utf8').slice(0, 300))
  }
  if (!res.buffer.length) throw new Error('BreezeBlue 返回空音频')

  return { buffer: res.buffer, contentType: String(res.headers['content-type'] || 'audio/mpeg') }
}

/** 查账户余额（诊断用） */
export async function breezeBalance(cfg = {}) {
  const res = await requestWithProxy(`${String(cfg.baseUrl || 'https://api.breeze.blue').replace(/\/+$/, '')}/v1/account/balance`, {
    headers: { 'xi-api-key': String(cfg.apiKey || '') },
    proxy: cfg.proxy || null,
    timeoutMs: 20000,
  })
  if (res.status !== 200) return null
  try { return JSON.parse(res.buffer.toString('utf8')) } catch { return null }
}

/* 从 API 地址拉模型列表：面板的"模型"下拉用它填充，拉不到就用调用方给的兜底。 */
export async function breezeModels(cfg = {}) {
  const base = String(cfg.baseUrl || 'https://api.breeze.blue').replace(/\/+$/, '')
  const apiKey = String(cfg.apiKey || '')
  for (const p of ['/v1/models', '/models']) {
    try {
      const res = await requestWithProxy(base + p, {
        headers: apiKey ? { 'xi-api-key': apiKey, authorization: 'Bearer ' + apiKey } : {},
        proxy: cfg.proxy || null,
        timeoutMs: 12000,
      })
      if (res.status !== 200) continue
      const body = JSON.parse(res.buffer.toString('utf8'))
      const rows = Array.isArray(body) ? body : (body.data || body.models || [])
      const ids = rows
        .map((m) => (typeof m === 'string' ? m : (m.id || m.model_id || m.name)))
        .filter((x) => typeof x === 'string' && x)
      if (ids.length) return [...new Set(ids)]
    } catch { /* 换下一个路径 */ }
  }
  return []
}

/* ═══════════════════════════════════════════════════════════════════
   SnowLuma（OneBot v11）
   ───────────────────────────────────────────────────────────────────
   只读 qq-bridge 的 config.json 拿地址与 token，凭据不重复保存。
   ═══════════════════════════════════════════════════════════════════ */
function findBridgeConfig() {
  const candidates = [
    process.env.QQ_BRIDGE_CONFIG,
    process.env.QQ_BRIDGE_DIR ? join(process.env.QQ_BRIDGE_DIR, 'config.json') : null,
    join(homedir(), 'qq-bridge', 'config.json'),
    join(homedir(), 'Documents', 'qq-bridge', 'config.json'),
    process.env.DSH_HOME ? join(process.env.DSH_HOME, '..', 'qq-bridge', 'config.json') : null,
  ].filter(Boolean)
  for (const p of candidates) {
    try { if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) } catch { /* next */ }
  }
  return null
}

export function resolveSnowLuma(override = {}) {
  const br = findBridgeConfig() || {}
  const sn = br.snowluma || {}
  return {
    httpUrl: String(override.httpUrl || process.env.SNOWLUMA_HTTP || sn.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: String(override.token || process.env.SNOWLUMA_TOKEN || sn.accessToken || ''),
    ownerQQ: Number(override.ownerQQ || process.env.QQ_OWNER || br.ownerQQ || 0),
  }
}

async function callOneBot(sl, action, params) {
  const res = await fetch(`${sl.httpUrl}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sl.token ? { authorization: `Bearer ${sl.token}` } : {}),
    },
    body: JSON.stringify(params || {}),
    signal: AbortSignal.timeout(60000),
  })
  let body = {}
  try { body = await res.json() } catch { /* 空响应 */ }
  if (!res.ok) throw new Error('OneBot ' + action + ' HTTP ' + res.status + '：' + JSON.stringify(body).slice(0, 200))
  if (typeof body.retcode === 'number' && body.retcode !== 0) {
    throw new Error('OneBot ' + action + ' retcode=' + body.retcode + '：' + (body.message || body.wording || '').slice(0, 200))
  }
  return body
}

/** 把内存里的音频作为 QQ 语音条发出去（不落盘） */
export async function sendVoiceBase64(sl, userId, buffer) {
  const body = await callOneBot(sl, 'send_private_msg', {
    user_id: Number(userId),
    message: [{ type: 'record', data: { file: 'base64://' + buffer.toString('base64') } }],
  })
  return { messageId: body.data?.message_id ?? null, bytes: buffer.length }
}

/** SnowLuma 健康检查 */
export async function snowLumaHealth(sl) {
  try {
    const body = await callOneBot(sl, 'get_login_info', {})
    return { ok: true, userId: body.data?.user_id ?? null, nickname: body.data?.nickname ?? '', httpUrl: sl.httpUrl }
  } catch (e) {
    return { ok: false, httpUrl: sl.httpUrl, error: (e?.message ?? String(e)).slice(0, 200) }
  }
}

/* ═══════════════════════════════════════════════════════════════════
   限流
   ═══════════════════════════════════════════════════════════════════ */
export function createRateLimiter({ maxPerMinute = 2, maxPerHour = 10 } = {}) {
  const stamps = []
  const prune = (now) => {
    const hourAgo = now - 3600000
    while (stamps.length && stamps[0] < hourAgo) stamps.shift()
  }
  return {
    check(nowMs) {
      const now = nowMs || Date.now()
      prune(now)
      const minuteAgo = now - 60000
      const inMinute = stamps.filter((t) => t >= minuteAgo).length
      if (inMinute >= maxPerMinute) {
        return { ok: false, reason: '每分钟最多 ' + maxPerMinute + ' 条语音，稍等一下', inMinute, inHour: stamps.length }
      }
      if (stamps.length >= maxPerHour) {
        return { ok: false, reason: '每小时最多 ' + maxPerHour + ' 条语音', inMinute, inHour: stamps.length }
      }
      return { ok: true, inMinute, inHour: stamps.length }
    },
    commit(nowMs) { stamps.push(nowMs || Date.now()) },
    usage(nowMs) {
      const now = nowMs || Date.now()
      prune(now)
      const minuteAgo = now - 60000
      return { inMinute: stamps.filter((t) => t >= minuteAgo).length, inHour: stamps.length, maxPerMinute, maxPerHour }
    },
  }
}
