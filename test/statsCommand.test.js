const test = require('node:test');
const assert = require('node:assert/strict');
const { latencyMonitor } = require('../src/services/latencyService');
const { getAnalyticsSnapshot } = require('../src/services/analyticsService');
const command = require('../src/commands/actions/statsCommand');

test('stats retains existing analytics and displays memory-only latency windows', async () => {
  latencyMonitor.record('gateway', 25);
  let payload;
  await command.execute({
    message: {
      async reply(value) {
        payload = value;
      }
    }
  });
  assert.match(payload.content, /Music bot analytics/);
  assert.match(payload.content, /Metadata pipelines:/);
  const embed = payload.embeds[0].toJSON();
  assert.match(embed.title, /180 seconds/);
  assert.equal(embed.fields.length, 4);
  assert.match(embed.fields[0].value, /AVG 25\.0 ms · P90 n\/a · P99 n\/a · n=1/);
  assert.match(embed.fields[1].value, /n=0/);
  assert.match(embed.footer.text, /memory-only/);
  assert.equal('latency' in getAnalyticsSnapshot(), false);
});
