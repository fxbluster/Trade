/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { apiClient, downloadDailyAudit } from '../apiClient';
import { TopBar } from '../../components/TopBar';

describe('apiClient.downloadDailyAudit', () => {
  let createdAnchor: HTMLAnchorElement | null = null;
  let clickSpy: any;
  let appendChildSpy: any;
  let removeChildSpy: any;
  let createObjectURLSpy: any;
  let revokeObjectURLSpy: any;

  beforeEach(() => {
    sessionStorage.clear();
    createdAnchor = null;

    // Mock URL object URL methods
    if (!window.URL.createObjectURL) {
      window.URL.createObjectURL = () => '';
    }
    if (!window.URL.revokeObjectURL) {
      window.URL.revokeObjectURL = () => {};
    }

    createObjectURLSpy = vi.spyOn(window.URL, 'createObjectURL').mockReturnValue('blob:http://localhost/mock-blob-uuid');
    revokeObjectURLSpy = vi.spyOn(window.URL, 'revokeObjectURL').mockImplementation(() => {});

    // Spy on anchor click
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      createdAnchor = this;
    });

    appendChildSpy = vi.spyOn(document.body, 'appendChild');
    removeChildSpy = vi.spyOn(document.body, 'removeChild');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs correct default URL and Authorization header with fallback token', async () => {
    const mockBlob = new Blob(['# Daily Audit Report'], { type: 'text/markdown' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'content-disposition': 'attachment; filename="tradeos-session-audit-2026-11-22.md"',
      }),
      blob: async () => mockBlob,
    } as unknown as Response);

    await downloadDailyAudit();

    // Check fetch URL & headers
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/audit/daily?format=markdown&session=current');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({
      Authorization: 'Bearer local-dev-token',
    });

    // Check blob and anchor creation
    expect(createObjectURLSpy).toHaveBeenCalledWith(mockBlob);
    expect(appendChildSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(removeChildSpy).toHaveBeenCalled();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/mock-blob-uuid');

    // Check anchor properties
    expect(createdAnchor).not.toBeNull();
    expect(createdAnchor?.href).toBe('blob:http://localhost/mock-blob-uuid');
    expect(createdAnchor?.download).toBe('tradeos-session-audit-2026-11-22.md');
  });

  it('uses session token from sessionStorage and handles custom format and session params', async () => {
    sessionStorage.setItem('tradeos_session_token', 'test-jwt-token-xyz');

    const mockBlob = new Blob(['{"summary":{}}'], { type: 'application/json' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      blob: async () => mockBlob,
    } as unknown as Response);

    await apiClient.downloadDailyAudit('json', 'all');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/audit/daily?format=json&session=all');
    expect(init?.headers).toEqual({
      Authorization: 'Bearer test-jwt-token-xyz',
    });

    // Fallback filename when Content-Disposition is absent
    expect(createdAnchor).not.toBeNull();
    expect(createdAnchor?.download).toMatch(/^tradeos-daily-audit-\d+\.json$/);
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/mock-blob-uuid');
  });

  it('handles fallback filename for markdown format when Content-Disposition header is omitted', async () => {
    const mockBlob = new Blob(['markdown data'], { type: 'text/markdown' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      blob: async () => mockBlob,
    } as unknown as Response);

    await downloadDailyAudit('markdown', 'current');

    expect(createdAnchor).not.toBeNull();
    expect(createdAnchor?.download).toMatch(/^tradeos-daily-audit-\d+\.md$/);
  });

  it('throws descriptive error if response is not ok without triggering anchor click', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers(),
      blob: async () => new Blob(),
    } as unknown as Response);

    await expect(downloadDailyAudit('markdown', 'current')).rejects.toThrow(
      'Audit export failed: Internal Server Error'
    );

    expect(createObjectURLSpy).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();
  });
});

describe('TopBar Daily Audit button', () => {
  it('renders the Daily Audit export button and triggers downloadDailyAudit on click', async () => {
    const downloadSpy = vi.spyOn(apiClient, 'downloadDailyAudit').mockResolvedValue();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(React.createElement(TopBar));
    });

    const exportBtn = container.querySelector<HTMLButtonElement>('[data-testid="audit-export-btn"]');
    expect(exportBtn).not.toBeNull();
    expect(exportBtn?.textContent).toContain('Daily Audit');

    flushSync(() => {
      exportBtn?.click();
    });

    expect(downloadSpy).toHaveBeenCalledWith('markdown');

    root.unmount();
    container.remove();
  });
});
