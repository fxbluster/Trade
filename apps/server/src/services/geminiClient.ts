import { GEMINI_API_KEY } from '../config.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.0-flash';
const DEFAULT_TIMEOUT_MS = 3_000;

export interface GeminiClientOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

interface GeminiCandidatePart {
  text?: string;
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiCandidatePart[];
    role?: string;
  };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Prompts Google Gemini AI model for contextual mentor advice.
 * Uses native fetch with x-goog-api-key header and 3000ms AbortSignal timeout.
 * Returns the generated string response, or null on missing key, timeout, or failure.
 */
export async function promptGeminiMentor(
  prompt: string,
  options: GeminiClientOptions = {}
): Promise<string | null> {
  const apiKey = (options.apiKey || GEMINI_API_KEY || process.env.GEMINI_API_KEY || '').trim();

  // Silent fallback to deterministic mode if no API key is provided
  if (!apiKey || apiKey.startsWith('AIzaSy_BURAYA') || apiKey === 'PLACEHOLDER') {
    return null;
  }

  const model = options.model || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const endpoint = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 600
        }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as GeminiResponse;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (typeof text === 'string' && text.trim().length > 0) {
      return text.trim();
    }
    return null;
  } catch {
    // Timeout, network failure, or aborted signal gracefully falls back to deterministic mentor
    return null;
  }
}
