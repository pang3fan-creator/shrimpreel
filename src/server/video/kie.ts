// kie.ai 聚合网关（可选，VIDEO_PROVIDER=kie）：一个 key 能调 Kling 动作控制、Wan Animate、Seedance、MiniMax 等。
// 文档：https://docs.kie.ai/market/kling/motion-control 、https://docs.kie.ai/market/common/get-task-detail
// 两种输入形态，由 site.video.kie.mode 决定：
//   motion    照片 + 动作参考视频（复刻视频里的动作，Kling Motion Control / Wan Animate）
//   reference 照片 + prompt（只保人物，不保动作，Seedance / MiniMax Reference-to-Video 这类）
// 提交立刻拿 taskId，之后靠轮询；callBackUrl 只当“现在可以查了”的信号，真实结果始终用 /jobs/recordInfo 拉。
import { site } from '#/config/site'
import { cleanSecret } from '../util'
import type { VideoProvider, VideoStatus } from './types'
import { VideoProviderError } from './types'

const API = 'https://api.kie.ai/api/v1'
const DONE = new Set(['success', 'fail'])

interface KieEnvelope<T> {
  code?: number
  msg?: string
  data?: T
}

interface KieTask {
  taskId?: string
  state?: string
  resultJson?: string
  failCode?: string
  failMsg?: string
}

export function createKieProvider(env: Env): VideoProvider {
  const key = cleanSecret(env.KIE_API_KEY)
  const headers = () => {
    if (!key) throw new VideoProviderError('provider_not_configured', 'KIE_API_KEY missing', false)
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  }

  async function read<T>(stage: 'submit' | 'status', response: Response) {
    const body = (await response.json().catch(() => null)) as KieEnvelope<T> | null
    // kie 有时候 HTTP 200 但 code 不是 200，两种都当失败
    if (!response.ok || !body || (body.code !== undefined && body.code !== 200)) {
      throw requestError(stage, response, body)
    }
    return body
  }

  return {
    id: 'kie',
    async submit(input) {
      const { model, prompt, mode, resolution, characterOrientation } = site.video.kie
      const params: Record<string, unknown> = {
        prompt,
        input_urls: [input.imageUrl],
        mode: resolution,
      }
      if (mode === 'motion') {
        params.video_urls = [input.sourceVideoUrl]
        params.character_orientation = characterOrientation
      }
      const body: Record<string, unknown> = { model, input: params }
      // 本地 http 开发环境不给回调地址，靠轮询
      if (input.webhookUrl.startsWith('https://')) body.callBackUrl = input.webhookUrl

      const response = await fetch(`${API}/jobs/createTask`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      })
      const envelope = await read<KieTask>('submit', response)
      const taskId = envelope.data?.taskId
      if (!taskId) throw new VideoProviderError('kie_no_task', 'kie submit returned no taskId', false)
      return { requestId: taskId, meta: {} }
    },

    async status(requestId): Promise<VideoStatus> {
      const response = await fetch(`${API}/jobs/recordInfo?taskId=${encodeURIComponent(requestId)}`, {
        headers: headers(),
      })
      const task = (await read<KieTask>('status', response)).data
      const state = task?.state ?? ''
      if (!state || !DONE.has(state)) return { state: 'pending' }
      if (state === 'fail') {
        const code = task?.failCode || 'kie_failed'
        const message = task?.failMsg || 'kie task failed'
        return {
          state: 'failed',
          code,
          message: `${code}: ${message}`.slice(0, 500),
          // kie 没有明确的可重试标记，超时和限流类是少数可以重投的
          retryable: /timeout|time out|rate limit|busy/i.test(message),
        }
      }
      const video = firstVideo(task?.resultJson)
      if (!video) return { state: 'failed', code: 'kie_no_video', message: 'kie result has no video url' }
      return { state: 'completed', output: { url: video } }
    },

    costCents: kieCostCents,
  }
}

// 估算：动作控制按参考视频实测秒数计费，参考视频就是模板源视频，时长固定
export function kieCostCents(durationSeconds: number) {
  return Math.round(durationSeconds * site.video.kie.costCentsPerSecond)
}

// resultJson 是字符串里套 JSON：{"resultUrls":["https://..."]}
function firstVideo(resultJson: string | undefined) {
  if (!resultJson) return undefined
  try {
    const parsed = JSON.parse(resultJson) as { resultUrls?: unknown }
    const urls = Array.isArray(parsed.resultUrls) ? parsed.resultUrls : []
    return urls.find((url): url is string => typeof url === 'string' && /^https:\/\//.test(url))
  } catch {
    return undefined
  }
}

// 网络/限流/5xx 可重投；其余（参数错、额度不足、内容被拒）直接失败并退积分
function requestError(stage: 'submit' | 'status', response: Response, body: KieEnvelope<unknown> | null) {
  const detail = body?.msg ? `: ${body.msg}` : ''
  return new VideoProviderError(
    `kie_${stage}_${response.status}`,
    `kie ${stage} failed (HTTP ${response.status}, code ${body?.code ?? 'n/a'})${detail}`.slice(0, 500),
    response.status === 408 || response.status === 429 || response.status >= 500,
  )
}
