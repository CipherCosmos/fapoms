import { track, flushTelemetry, describeClickTarget } from './telemetry';

/**
 * The client half of the telemetry privacy line: it must capture control DESCRIPTORS, never field
 * contents, and it must be a genuine no-op when signed out (telemetry belongs to a session). The
 * flush batches to the ingestion endpoint with the bearer token.
 */
describe('describeClickTarget', () => {
  const el = (html: string): Element => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.firstElementChild as Element;
  };

  it('prefers an explicit data-track, then aria-label, then trimmed control text', () => {
    expect(describeClickTarget(el('<button data-track="save-profile">Save</button>'))).toBe('save-profile');
    expect(describeClickTarget(el('<button aria-label="Sign out">x</button>'))).toBe('Sign out');
    expect(describeClickTarget(el('<button>  Refresh  </button>'))).toBe('Refresh');
  });

  it('reads the nearest control when a child is clicked', () => {
    const btn = el('<button data-track="open"><span>label</span></button>');
    expect(describeClickTarget(btn.querySelector('span'))).toBe('open');
  });

  it('captures nothing for ordinary text — that is where record contents live', () => {
    expect(describeClickTarget(el('<p>Anita Sharma, PAN ABCDE1234F</p>'))).toBeNull();
    expect(describeClickTarget(null)).toBeNull();
  });

  it('caps the descriptor length', () => {
    expect(describeClickTarget(el(`<button>${'x'.repeat(200)}</button>`))!.length).toBeLessThanOrEqual(80);
  });
});

describe('telemetry queue + flush', () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true });

  beforeEach(() => {
    (global as any).fetch = fetchMock;
    fetchMock.mockClear();
    try { localStorage.clear(); } catch { /* jsdom */ }
  });

  it('does nothing when signed out', async () => {
    track({ eventType: 'PAGE_VIEW', path: '/dashboard' });
    await flushTelemetry();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('queues while signed in and flushes a batch to the ingestion endpoint', async () => {
    localStorage.setItem('fapoms_token', 'jwt.abc');
    track({ eventType: 'PAGE_VIEW', path: '/dashboard' });
    track({ eventType: 'ACTION', path: '/dashboard', label: 'Refresh' });
    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/telemetry');
    expect(opts.headers.Authorization).toBe('Bearer jwt.abc');
    const body = JSON.parse(opts.body);
    expect(body.events).toHaveLength(2);
    expect(body.events[1].label).toBe('Refresh');
  });

  it('swallows a failed flush — analytics must never surface an error', async () => {
    localStorage.setItem('fapoms_token', 'jwt.abc');
    fetchMock.mockRejectedValueOnce(new Error('network'));
    track({ eventType: 'PAGE_VIEW', path: '/x' });
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });
});
