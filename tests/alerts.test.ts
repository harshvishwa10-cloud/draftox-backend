import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAlert,
  isAlertActive,
  registerAlertSink,
  resetAlertState,
  sendAlert,
  setAlertCooldown,
  type Alert,
  type AlertDelivery,
} from '../src/lib/alerts.js';

/** Captures every alert handed to the sink and returns a controllable result. */
function makeSink(delivered = true) {
  const alerts: Alert[] = [];
  const sink = {
    send: vi.fn(async (alert: Alert): Promise<AlertDelivery> => {
      alerts.push(alert);
      return { delivered, error: delivered ? undefined : 'sink refused' };
    }),
    alerts,
  };
  return sink;
}

function alert(key = 'test_key', severity: 'warning' | 'critical' = 'warning'): Alert {
  return { key, severity, title: 'Test alert', message: 'Something happened' };
}

beforeEach(() => {
  resetAlertState();
  setAlertCooldown(30 * 60 * 1000);
});

afterEach(() => {
  resetAlertState();
});

describe('sendAlert delivery', () => {
  it('reports "sent" and marks the key active when the sink confirms', async () => {
    const sink = makeSink(true);
    registerAlertSink(sink);
    expect(await sendAlert(alert(), 1_000)).toBe('sent');
    expect(sink.send).toHaveBeenCalledTimes(1);
    expect(isAlertActive('test_key')).toBe(true);
  });

  it('reports "failed" and stays inactive when the sink does not confirm', async () => {
    const sink = makeSink(false);
    registerAlertSink(sink);
    expect(await sendAlert(alert(), 1_000)).toBe('failed');
    expect(isAlertActive('test_key')).toBe(false);
  });

  it('never throws when the sink throws — it reports failure instead', async () => {
    registerAlertSink({
      send: async () => {
        throw new Error('boom');
      },
    });
    await expect(sendAlert(alert(), 1_000)).resolves.toBe('failed');
    expect(isAlertActive('test_key')).toBe(false);
  });

  it('reports failure when no sink is registered', async () => {
    registerAlertSink(null);
    expect(await sendAlert(alert(), 1_000)).toBe('failed');
  });
});

describe('dedup + cooldown', () => {
  it('suppresses a repeat inside the cooldown window', async () => {
    const sink = makeSink(true);
    registerAlertSink(sink);
    expect(await sendAlert(alert(), 1_000)).toBe('sent');
    expect(await sendAlert(alert(), 1_000 + 5_000)).toBe('suppressed');
    expect(sink.send).toHaveBeenCalledTimes(1);
  });

  it('re-sends once the cooldown has elapsed', async () => {
    const sink = makeSink(true);
    registerAlertSink(sink);
    const cooldown = 30 * 60 * 1000;
    expect(await sendAlert(alert(), 1_000)).toBe('sent');
    expect(await sendAlert(alert(), 1_000 + cooldown + 1)).toBe('sent');
    expect(sink.send).toHaveBeenCalledTimes(2);
  });

  it('does not suppress a call that failed while inside the cooldown', async () => {
    // The attempt is recorded even on failure, so a retry inside the window is
    // suppressed — this protects against a retry storm when a sink is down.
    const sink = makeSink(false);
    registerAlertSink(sink);
    expect(await sendAlert(alert(), 1_000)).toBe('failed');
    expect(await sendAlert(alert(), 1_500)).toBe('suppressed');
    expect(sink.send).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates independently per key', async () => {
    const sink = makeSink(true);
    registerAlertSink(sink);
    expect(await sendAlert(alert('a'), 1_000)).toBe('sent');
    expect(await sendAlert(alert('b'), 1_000)).toBe('sent');
    expect(await sendAlert(alert('a'), 1_100)).toBe('suppressed');
    expect(sink.send).toHaveBeenCalledTimes(2);
  });

  it('sends every time when the cooldown is zero', async () => {
    const sink = makeSink(true);
    registerAlertSink(sink);
    setAlertCooldown(0);
    expect(await sendAlert(alert(), 1_000)).toBe('sent');
    expect(await sendAlert(alert(), 1_000)).toBe('sent');
    expect(sink.send).toHaveBeenCalledTimes(2);
  });
});

describe('recovery', () => {
  it('announces recovery exactly once, only after the alert was raised', async () => {
    const sink = makeSink(true);
    registerAlertSink(sink);
    await sendAlert(alert(), 1_000);

    expect(await clearAlert('test_key', undefined, 2_000)).toBe('recovered');
    expect(sink.send).toHaveBeenCalledTimes(2);
    expect(isAlertActive('test_key')).toBe(false);

    // A second clear is a no-op — no duplicate recovery email.
    expect(await clearAlert('test_key', undefined, 3_000)).toBe('noop');
    expect(sink.send).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when the alert was never raised', async () => {
    const sink = makeSink(true);
    registerAlertSink(sink);
    expect(await clearAlert('never_seen', undefined, 1_000)).toBe('noop');
    expect(sink.send).not.toHaveBeenCalled();
  });

  it('clears the cooldown so a re-occurrence alerts immediately', async () => {
    const sink = makeSink(true);
    registerAlertSink(sink);
    await sendAlert(alert(), 1_000);
    expect(await sendAlert(alert(), 1_100)).toBe('suppressed');

    await clearAlert('test_key', undefined, 1_200);
    // Even inside the original cooldown window, the post-recovery alert goes out.
    expect(await sendAlert(alert(), 1_300)).toBe('sent');
  });

  it('reports recovery_failed when the sink cannot confirm the all-clear', async () => {
    const sink = makeSink(true);
    registerAlertSink(sink);
    await sendAlert(alert(), 1_000);

    registerAlertSink(makeSink(false));
    expect(await clearAlert('test_key', undefined, 2_000)).toBe('recovery_failed');
    // The key is cleared locally regardless, so a failed all-clear is not retried.
    expect(isAlertActive('test_key')).toBe(false);
  });
});
