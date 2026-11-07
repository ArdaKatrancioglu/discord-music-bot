const { performance } = require('perf_hooks');

const WINDOW_MS = 180000;
const METRICS = ['gateway', 'eventLoop', 'commandResponse', 'commandProcessing'];
const RESPONSE_WRAPPER = Symbol('latency-response-wrapper');

class LatencyMonitor {
  constructor({
    now = () => performance.now(),
    windowMs = WINDOW_MS,
    intervalMs = 1000,
    gatewayIntervalMs = 1000,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.intervalMs = intervalMs;
    this.gatewayIntervalMs = gatewayIntervalMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.samples = Object.fromEntries(METRICS.map((name) => [name, []]));
    this.timer = null;
    this.running = false;
  }

  prune(now = this.now()) {
    const cutoff = now - this.windowMs;
    for (const samples of Object.values(this.samples)) {
      let expired = 0;
      while (expired < samples.length && samples[expired].at <= cutoff) expired++;
      if (expired) samples.splice(0, expired);
    }
  }

  record(metric, value, at = this.now()) {
    if (!this.samples[metric] || !Number.isFinite(value) || value < 0) return false;
    this.prune(at);
    this.samples[metric].push({ at, value });
    return true;
  }

  snapshot() {
    this.prune();
    const metrics = {};
    for (const [name, samples] of Object.entries(this.samples)) {
      const values = samples.map((sample) => sample.value).sort((a, b) => a - b);
      const count = values.length;
      metrics[name] = {
        count,
        avg: count ? values.reduce((sum, value) => sum + value, 0) / count : null,
        p90: count >= 10 ? values[Math.ceil(0.9 * count) - 1] : null,
        p99: count >= 100 ? values[Math.ceil(0.99 * count) - 1] : null
      };
    }
    return { windowMs: this.windowMs, metrics };
  }

  start(client) {
    if (this.running) return;
    this.running = true;
    let nextGateway = this.now();
    const schedule = () => {
      const expected = this.now() + this.intervalMs;
      this.timer = this.setTimer(() => {
        if (!this.running) return;
        const now = this.now();
        this.record('eventLoop', Math.max(0, now - expected), now);
        if (now >= nextGateway) {
          if (client?.isReady?.()) this.record('gateway', client.ws?.ping, now);
          nextGateway = now + this.gatewayIntervalMs;
        }
        this.prune(now);
        schedule();
      }, this.intervalMs);
      this.timer?.unref?.();
    };
    schedule();
  }

  stop() {
    this.running = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  measureCommand(target, methods = ['reply'], startedAt = this.now()) {
    const restorers = [];
    let responded = false;
    const monitor = this;
    for (const name of methods) {
      const original = target?.[name];
      if (typeof original !== 'function') continue;
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      const wrapped = async function (...args) {
        const response = await original.apply(this, args);
        if (!responded) {
          responded = true;
          monitor.record('commandResponse', Math.max(0, monitor.now() - startedAt));
        }
        return response;
      };
      const state = { original, descriptor, active: true };
      wrapped[RESPONSE_WRAPPER] = state;
      target[name] = wrapped;
      restorers.push(() => {
        state.active = false;
        if (target[name] !== wrapped) return;
        let restored = state;
        while (restored.original[RESPONSE_WRAPPER] && !restored.original[RESPONSE_WRAPPER].active) {
          restored = restored.original[RESPONSE_WRAPPER];
        }
        if (restored.descriptor) Object.defineProperty(target, name, restored.descriptor);
        else delete target[name];
      });
    }
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      for (const restore of restorers) restore();
      this.record('commandProcessing', Math.max(0, this.now() - startedAt));
    };
  }
}

const latencyMonitor = new LatencyMonitor();
module.exports = { WINDOW_MS, LatencyMonitor, latencyMonitor };
