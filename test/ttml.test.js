const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTtml, parseTtml } = require('../src/core/ttml');
const { readLyrics, writeLyrics } = require('../src/core/lyricsStore');

test('LRC conversion preserves Unicode, escaping, repeated timestamps and source precision', () => {
  const xml = createTtml(
    {
      syncedLyrics:
        '[00:01.123456]İ & <世界> "test"\n[00:02.50][00:02.50]repeat\n[00:03.00]\n[00:04.00]end\n[00:99]invalid'
    },
    6
  );
  const parsed = parseTtml(xml);
  assert.deepEqual(
    parsed.lines.map((line) => line.timestamp),
    [1.123456, 2.5, 2.5, 3, 4]
  );
  assert.equal(parsed.lines[0].text, 'İ & <世界> "test"');
  assert.equal(parsed.lines[1].end, 3);
  assert.equal(parsed.lines[2].end, 3);
  assert.equal(parsed.lines.at(-1).end, 6);
  assert.match(xml, /<tt xmlns="http:\/\/www\.w3\.org\/ns\/ttml" xml:lang="und">/);
  assert.doesNotMatch(xml, /itunes:|xmlns:itunes|xml:space/);
  assert.doesNotMatch(xml, /<span/);
});

test('real timed words survive and missing word times are never invented', () => {
  const words = [
    { timestamp: 1, end: 2, text: 'Hello ' },
    { timestamp: 2, end: 3, text: 'world' }
  ];
  const xml = createTtml([{ timestamp: 1, end: 3, text: 'Hello world', words }], 4);
  assert.deepEqual(parseTtml(xml).lines[0].words, words);
  assert.doesNotMatch(xml, /itunes:|xmlns:itunes/);
  assert.match(xml, /<span begin="00:00:01\.000" end="00:00:02\.000">Hello <\/span>/);
  assert.match(xml, /<p [^>]*xml:space="preserve"/);
  assert.doesNotMatch(
    createTtml([{ timestamp: 1, text: 'Hello world', words: [{ text: 'Hello world' }] }], 4),
    /<span/
  );
});

test('preserves significant whitespace, XML references, Unicode and precise times on single-line paragraphs', () => {
  const text = '  A  &amp; &#10;\t世界\nline\r  ';
  const xml = createTtml([{ timestamp: 1.123456789123, text }], 5, { language: 'tr' });
  assert.match(xml, /xml:lang="tr"/);
  assert.match(xml, /<p [^>]*xml:space="preserve"/);
  assert.match(xml, /&#9;.*&#10;.*&#13;/);
  assert.equal(xml.split('\n').filter((line) => line.includes('<p ')).length, 1);
  assert.match(xml.split('\n').find((line) => line.includes('<p ')), /<\/p>$/);
  const parsed = parseTtml(xml);
  assert.equal(parsed.lines[0].text, text);
  assert.equal(parsed.lines[0].timestamp, 1.123456789123);
  assert.equal(parsed.lines[0].end, 5);
});

test('retains LRC spacing and round-trips timestamps without additional floating-point rounding', () => {
  const lrc = createTtml({ syncedLyrics: '[00:01.250]  two spaces  \n[00:02.000]next' }, 10);
  assert.equal(parseTtml(lrc).lines[0].text, '  two spaces  ');
  for (const timestamp of [0.0000001, 5.999999999999999, 6404.422455761935]) {
    const xml = createTtml([{ timestamp, text: 'line' }]);
    assert.equal(parseTtml(xml).lines[0].timestamp, timestamp);
  }
  assert.throws(() => createTtml([{ timestamp: 1, text: 'bad\u0001text' }]), /XML 1\.0/);
});

test('uses a known language when provided and defaults invalid or missing language to und', () => {
  assert.match(createTtml({ plainLyrics: 'Hello', language: 'en-US' }), /xml:lang="en-US"/);
  assert.match(createTtml({ plainLyrics: 'Hello', language: 'not a language' }), /xml:lang="und"/);
  assert.match(createTtml({ plainLyrics: 'Hello' }), /xml:lang="und"/);
});

test('continues to read older Apple-extended files and standard XML entity references', () => {
  const legacy = '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Line" xml:lang="und" xml:space="preserve"><body><div><p begin="00:00:01.234" end="00:00:05.000">Hi &amp; &#x4E16;界</p></div></body></tt>';
  assert.deepEqual(parseTtml(legacy).lines, [{ timestamp: 1.234, end: 5, text: 'Hi & 世界' }]);
});

test('plain lyrics are untimed and unusable inputs stay absent', () => {
  const xml = createTtml({ plainLyrics: '你好 & hello\nSecond line' });
  assert.equal(parseTtml(xml).lines.length, 0);
  assert.equal(parseTtml(xml).plainLyrics, '你好 & hello\nSecond line');
  assert.doesNotMatch(xml, /begin=|end=/);
  const windowsLyrics = 'First line\r\nSecond line';
  assert.equal(parseTtml(createTtml({ plainLyrics: windowsLyrics })).plainLyrics, windowsLyrics);
  assert.equal(createTtml({ syncedLyrics: '[00:99]bad' }), null);
  assert.equal(createTtml({ syncedLyrics: [{ time: null, text: 'bad' }] }), null);
  assert.equal(createTtml({ plainLyrics: '  ' }), null);
  assert.throws(() => parseTtml('<tt><body>broken</tt>'));
  assert.throws(() => parseTtml('<!DOCTYPE x [<!ENTITY y "unsafe">]><tt/>'));
});

test('local storage returns null for missing/corrupt/unsafe files and writes portable references', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ttml-test-'));
  const indexPath = path.join(directory, 'custom-index.json');
  try {
    const reference = writeLyrics(
      indexPath,
      { id: 'bpOSxM0rNPM', duration: 5 },
      { syncedLyrics: '[00:01]line' }
    );
    assert.equal(reference, 'lyrics/bpOSxM0rNPM.ttml');
    assert.equal(readLyrics(indexPath, reference).lines[0].timestamp, 1);
    assert.equal(readLyrics(indexPath, '../outside.ttml'), null);
    assert.equal(readLyrics(indexPath, '/absolute.ttml'), null);
    fs.writeFileSync(path.join(directory, reference), 'corrupt');
    assert.equal(readLyrics(indexPath, reference), null);
    fs.unlinkSync(path.join(directory, reference));
    assert.equal(readLyrics(indexPath, reference), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
