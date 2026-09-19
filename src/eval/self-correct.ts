import type { MemoryProvider } from "../types.js";

const STRICTER_SUFFIX = `

IMPORTANT: Your previous response was invalid. Please ensure your output strictly follows the required XML format. Every required field must be present with valid values.`;

export async function compressWithRetry(
  provider: MemoryProvider,
  systemPrompt: string,
  userPrompt: string,
  validator: (response: string) => { valid: boolean; errors?: string[] },
  maxRetries = 1,
): Promise<{ response: string; retried: boolean; valid: boolean }> {
  const first = await provider.compress(systemPrompt, userPrompt);
  const result = validator(first);
  if (result.valid) return { response: first, retried: false, valid: true };

  for (let i = 0; i < maxRetries; i++) {
    const retry = await provider.compress(
      systemPrompt + STRICTER_SUFFIX,
      userPrompt,
    );
    const retryResult = validator(retry);
    if (retryResult.valid)
      return { response: retry, retried: true, valid: true };
  }

  // #1271: do not hand back a response the validator rejected as if it were
  // good. Returning `first` here made the caller persist preamble, truncated
  // narratives, and other invalid payloads. The caller now decides whether to
  // keep the raw observation, retry later, or fail.
  return { response: first, retried: true, valid: false };
}
