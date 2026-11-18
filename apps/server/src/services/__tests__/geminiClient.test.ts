import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promptGeminiMentor } from '../geminiClient.js';

describe('promptGeminiMentor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null immediately when no API key is configured', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const result = await promptGeminiMentor('Salam Sokrat', { apiKey: '' });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends prompt with x-goog-api-key header and returns candidate text', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    globalThis.fetch = vi.fn().mockImplementation((url: string, init: any) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      capturedBody = JSON.parse(init.body);

      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: 'Tələsmə, intizamını qoru və riskini idarə et.' }]
                }
              }
            ]
          }),
          { status: 200 }
        )
      );
    });

    const reply = await promptGeminiMentor('Nə məsləhət görürsən?', {
      apiKey: 'test-valid-gemini-key'
    });

    expect(reply).toBe('Tələsmə, intizamını qoru və riskini idarə et.');
    // Key must be in x-goog-api-key header, NOT in URL query string
    expect(capturedHeaders['x-goog-api-key']).toBe('test-valid-gemini-key');
    expect(capturedUrl).not.toContain('key=');
    expect(capturedBody.contents[0].parts[0].text).toBe('Nə məsləhət görürsən?');
  });

  it('returns null on HTTP error response (e.g. 403 / 500)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), {
        status: 429
      })
    );

    const reply = await promptGeminiMentor('Məsləhət ver', {
      apiKey: 'test-key'
    });
    expect(reply).toBeNull();
  });

  it('returns null gracefully on network failure or abort timeout', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('The operation was aborted due to timeout'));

    const reply = await promptGeminiMentor('Məsləhət ver', {
      apiKey: 'test-key'
    });
    expect(reply).toBeNull();
  });
});
