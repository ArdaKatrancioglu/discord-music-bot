const test = require('node:test');
const assert = require('node:assert/strict');
const { LatencyMonitor, WINDOW_MS } = require('../src/services/latencyService');

test('rolling metrics use monotonic time, nearest-rank percentiles and sample thresholds', () => {
  let now = 0;
  const monitor = new LatencyMonitor({ now: () => now });
  assert.equal(monitor.snapshot().metrics.gateway.avg, null);
  for (let value = 1; value <= 100; value++) {
    now = value;
    monitor.record('gateway', value);
  }
  const metric = monitor.snapshot().metrics.gateway;
  assert.deepEqual(metric, { count: 100, avg: 50.5, p90: 90, p99: 99 });
  assert.equal(monitor.record('gateway', -1), false);
  assert.equal(monitor.record('gateway', NaN), false);
  now = WINDOW_MS + 50;
  assert.equal(monitor.snapshot().metrics.gateway.count, 50);
  assert.equal(monitor.snapshot().metrics.gateway.p99, null);
  now = WINDOW_MS + 101;
  assert.deepEqual(monitor.snapshot().metrics.gateway, {
    count: 0,
    avg: null,
    p90: null,
    p99: null
  });
});

test('event loop sampling detects a stall without fabricating catch-up samples and stops cleanly', () => {
  let now = 0;
  const scheduled = [];
  let cleared;
  const monitor = new LatencyMonitor({
    now: () => now,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      cleared = timer;
    }
  });
  const client = { isReady: () => true, ws: { ping: -1 } };
  monitor.start(client);
  monitor.start(client);
  assert.equal(scheduled.length, 1);
  now = 1000;
  scheduled[0].callback();
  assert.equal(monitor.snapshot().metrics.gateway.count, 0);
  client.ws.ping = 30;
  now = 7000;
  scheduled[1].callback();
  const snapshot = monitor.snapshot();
  assert.deepEqual(snapshot.metrics.eventLoop, { count: 2, avg: 2500, p90: null, p99: null });
  assert.equal(snapshot.metrics.gateway.avg, 30);
  assert.equal(scheduled.length, 3);
  monitor.stop();
  assert.equal(cleared, scheduled[2]);
  scheduled[2].callback();
  assert.equal(scheduled.length, 3);
});

test('command response measures first successful acknowledgment; processing includes later work', async () => {
  let now = 10;
  const monitor = new LatencyMonitor({ now: () => now });
  const prototype = {
    async reply(value) {
      assert.equal(this.tag, 'message');
      now += 20;
      return value;
    }
  };
  const message = Object.assign(Object.create(prototype), { tag: 'message' });
  const finish = monitor.measureCommand(message);
  now += 30;
  assert.equal(await message.reply('first'), 'first');
  await message.reply('second');
  now += 100;
  finish();
  finish();
  assert.equal(Object.hasOwn(message, 'reply'), false);
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.metrics.commandResponse.count, 1);
  assert.equal(snapshot.metrics.commandResponse.avg, 50);
  assert.equal(snapshot.metrics.commandProcessing.avg, 170);
});

test('failed replies and commands with no response do not invent a response sample', async () => {
  let now = 0;
  const monitor = new LatencyMonitor({ now: () => now });
  const message = {
    async reply() {
      throw new Error('offline');
    }
  };
  const original = message.reply;
  const finish = monitor.measureCommand(message);
  await assert.rejects(message.reply(), /offline/);
  now = 100;
  finish();
  assert.equal(message.reply, original);
  assert.equal(monitor.snapshot().metrics.commandResponse.count, 0);
  assert.equal(monitor.snapshot().metrics.commandProcessing.avg, 100);
});

test('interaction acknowledgment counts once across defer and reply methods', async () => {
  let now = 0;
  const monitor = new LatencyMonitor({ now: () => now });
  const interaction = {
    async deferUpdate() {
      now += 5;
    },
    async reply() {
      now += 10;
    }
  };
  const finish = monitor.measureCommand(interaction, ['deferUpdate', 'reply']);
  await interaction.deferUpdate();
  await interaction.reply();
  finish();
  assert.equal(monitor.snapshot().metrics.commandResponse.count, 1);
  assert.equal(monitor.snapshot().metrics.commandResponse.avg, 5);
});

test('overlapping measurements on a reused message restore the original reply regardless of finish order', async () => {
  let now = 0;
  const monitor = new LatencyMonitor({ now: () => now });
  const target = {
    async reply() {
      now += 1;
    }
  };
  const original = target.reply;
  const outer = monitor.measureCommand(target);
  const inner = monitor.measureCommand(target);
  outer();
  await target.reply();
  inner();
  assert.equal(target.reply, original);
});
