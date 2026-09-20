import Anthropic from '@anthropic-ai/sdk'
import type { MemoryProvider } from '../types.js'
import { getEnvVar } from '../config.js'

// The SDK default (60s) hard-failed complex summarization prompts against
// alternative base URLs (DeepSeek et al) with no retry. ANTHROPIC_TIMEOUT_MS
// wins, then the shared AGENTMEMORY_LLM_TIMEOUT_MS. #655
export function resolveAnthropicTimeout(): number | undefined {
  for (const key of ['ANTHROPIC_TIMEOUT_MS', 'AGENTMEMORY_LLM_TIMEOUT_MS']) {
    const raw = getEnvVar(key)
    if (!raw) continue
    const n = Number(raw.trim())
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return undefined
}

export class AnthropicProvider implements MemoryProvider {
  name = 'anthropic'
  private client: Anthropic
  private model: string
  private maxTokens: number

  constructor(apiKey: string, model: string, maxTokens: number, baseURL?: string) {
    const timeout = resolveAnthropicTimeout()
    this.client = new Anthropic({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    })
    this.model = model
    this.maxTokens = maxTokens
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt)
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt)
  }

  async describeImage(imageData: string, mimeType: string, prompt: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: imageData },
          },
          { type: 'text', text: prompt },
        ],
      }],
    })

    const textBlock = response.content.find((b) => b.type === 'text')
    return textBlock?.text ?? ''
  }

  private async call(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    })

    const textBlock = response.content.find((b) => b.type === 'text')
    return textBlock?.text ?? ''
  }
}
