const { XMLParser, XMLValidator } = require('fast-xml-parser');

const TTML_NAMESPACE = 'http://www.w3.org/ns/ttml';
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  trimValues: false,
  parseTagValue: false,
  processEntities: false,
  cdataPropName: '#cdata'
});

function escapeXml(value) {
  const text = String(value);
  // Reject unrepresentable XML 1.0 characters instead of silently discarding lyrics.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
    throw new Error('Lyrics contain characters that XML 1.0 cannot represent');
  }
  return (
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      .replace(/\t/g, '&#9;')
      .replace(/\n/g, '&#10;')
      .replace(/\r/g, '&#13;')
  );
}

function timeValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const text = String(value ?? '');
  if (/^\d+(?:\.\d+)?s$/.test(text)) {
    const seconds = Number(text.slice(0, -1));
    return Number.isFinite(seconds) ? seconds : null;
  }
  const match = text.match(/^(?:(\d+):)?(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) return null;
  const [wholeSeconds, fractional] = match[3].split('.');
  const total = BigInt(match[1] || 0) * 3600n + BigInt(match[2]) * 60n + BigInt(wholeSeconds);
  const seconds = Number(`${total}${fractional === undefined ? '' : `.${fractional}`}`);
  return Number.isFinite(seconds) ? seconds : null;
}

function clockTime(seconds) {
  // Expand scientific notation without rounding the input number's decimal representation.
  const [mantissa, exponentText] = String(seconds).toLowerCase().split('e');
  const exponent = Number(exponentText || 0);
  const parts = mantissa.split('.');
  const digits = parts.join('');
  const decimalPosition = parts[0].length + exponent;
  const expanded = decimalPosition <= 0
    ? `0.${'0'.repeat(-decimalPosition)}${digits}`
    : decimalPosition >= digits.length
      ? `${digits}${'0'.repeat(decimalPosition - digits.length)}`
      : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  const [wholeSeconds, fractional = ''] = expanded.split('.');
  const totalSeconds = BigInt(wholeSeconds);
  const hours = String(totalSeconds / 3600n).padStart(2, '0');
  const minutes = String((totalSeconds / 60n) % 60n).padStart(2, '0');
  const whole = String(totalSeconds % 60n).padStart(2, '0');
  return `${hours}:${minutes}:${whole}.${fractional.padEnd(3, '0')}`;
}

function languageTag(language) {
  if (typeof language !== 'string' || !language.trim()) return 'und';
  try {
    return Intl.getCanonicalLocales(language.trim())[0] || 'und';
  } catch {
    return 'und';
  }
}

function needsPreservedSpace(text) {
  return /^[ \t\r\n]|[ \t\r\n]$|[ \t\r\n]{2}|[\t\r\n]/.test(text);
}

function parseLrc(input, { keepEmpty = false, preserveWhitespace = false } = {}) {
  if (typeof input !== 'string') return [];
  const lines = [];
  for (const raw of input.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d+)?)\]/g)];
    const rawText = raw.replace(/\[\d{1,3}:\d{2}(?:\.\d+)?\]/g, '');
    const text = preserveWhitespace ? rawText : rawText.trim();
    if (!text && !keepEmpty) continue;
    for (const tag of tags) {
      if (Number(tag[2]) < 60)
        lines.push({ timestamp: Number(tag[1]) * 60 + Number(tag[2]), text });
    }
  }
  return lines.sort((a, b) => a.timestamp - b.timestamp);
}

function createTtml(input, duration, { language } = {}) {
  if (!input) return null;
  const source = Array.isArray(input) ? input : input.syncedLyrics;
  let lines = typeof source === 'string'
    ? parseLrc(source, { keepEmpty: true, preserveWhitespace: true })
    : source;
  lines = Array.isArray(lines)
    ? lines
      .filter(
        (line) =>
          line && typeof line.text === 'string' && timeValue(line.timestamp ?? line.time) !== null
      )
      .map((line) => ({ ...line, timestamp: timeValue(line.timestamp ?? line.time) }))
      .sort((a, b) => a.timestamp - b.timestamp)
    : [];
  let paragraphs;
  if (lines.some((line) => line.text.trim())) {
    paragraphs = lines.map((line) => {
      const next = lines.find((item) => item.timestamp > line.timestamp)?.timestamp;
      const explicitEnd = timeValue(line.end);
      const end =
        explicitEnd > line.timestamp
          ? explicitEnd
          : (next ?? (Number(duration) > line.timestamp ? Number(duration) : null));
      const words = Array.isArray(line.words) ? line.words : [];
      const validWords =
        words.length &&
        words.every(
          (word) =>
            typeof word.text === 'string' &&
            timeValue(word.timestamp ?? word.time) !== null &&
            timeValue(word.timestamp ?? word.time) >= line.timestamp &&
            timeValue(word.end) > timeValue(word.timestamp ?? word.time) &&
            (end === null || timeValue(word.end) <= end)
        );
      let content = escapeXml(line.text);
      const hasTimedWords = validWords && words.map((word) => word.text).join('') === line.text;
      if (hasTimedWords) {
        content = words
          .map(
            (word) =>
              `<span begin="${clockTime(timeValue(word.timestamp ?? word.time))}" end="${clockTime(timeValue(word.end))}">${escapeXml(word.text)}</span>`
          )
          .join('');
      }
      const preserveSpace = needsPreservedSpace(line.text) ||
        (hasTimedWords && words.some((word) => needsPreservedSpace(word.text)));
      return `      <p begin="${clockTime(line.timestamp)}"${end !== null ? ` end="${clockTime(end)}"` : ''}${preserveSpace ? ' xml:space="preserve"' : ''}>${content}</p>`;
    });
  } else if (typeof input.plainLyrics === 'string' && input.plainLyrics.trim()) {
    paragraphs = input.plainLyrics.split(/\n/).map((text) =>
      `      <p${needsPreservedSpace(text) ? ' xml:space="preserve"' : ''}>${escapeXml(text)}</p>`
    );
  } else return null;
  const lang = languageTag(language ?? input.language ?? input.lang);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="${TTML_NAMESPACE}" xml:lang="${lang}">\n  <body>\n    <div>\n${paragraphs.join('\n')}\n    </div>\n  </body>\n</tt>\n`;
}

function decodeText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\u0027' };
  return String(value).replace(/&([^;\s]+);/g, (entity, name) => {
    if (Object.hasOwn(entities, name)) return entities[name];
    if (!/^#(?:\d+|x[\da-fA-F]+)$/.test(name)) throw new Error('Unsupported XML entity');
    const codepoint = name[1] === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!(codepoint === 9 || codepoint === 10 || codepoint === 13 ||
      (codepoint >= 0x20 && codepoint <= 0xd7ff) ||
      (codepoint >= 0xe000 && codepoint <= 0xfffd) ||
      (codepoint >= 0x10000 && codepoint <= 0x10ffff))) throw new Error('Invalid XML character');
    return String.fromCodePoint(codepoint);
  });
}

function parseTtml(xml) {
  if (
    typeof xml !== 'string' ||
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    XMLValidator.validate(xml) !== true
  ) {
    throw new Error('Invalid TTML XML');
  }
  const document = parser.parse(xml);
  const root = document.find((node) => node.tt);
  if (!root || root[':@']?.['@_xmlns'] !== TTML_NAMESPACE)
    throw new Error('Not a supported TTML document');
  function textContent(nodes) {
    return nodes
      .map((node) => node['#text'] !== undefined ? decodeText(node['#text']) :
        node['#cdata'] ? node['#cdata'].map((part) => part['#text'] ?? '').join('') :
          node.br ? '\n' : node.span ? textContent(node.span) : '')
      .join('');
  }
  const lines = [];
  function walk(nodes) {
    for (const node of nodes) {
      for (const name of ['body', 'div', 'p']) {
        if (!node[name]) continue;
        const attributes = node[':@'] || {};
        if (name !== 'p') {
          if (attributes['@_begin'] || attributes['@_end'] || attributes['@_timeContainer'])
            throw new Error('Unsupported parent timing');
          walk(node[name]);
          continue;
        }
        const begin = attributes['@_begin'];
        const end = attributes['@_end'];
        const timestamp = begin === undefined ? null : timeValue(begin);
        if (
          (begin !== undefined && timestamp === null) ||
          (end !== undefined &&
            (timeValue(end) === null || timestamp === null || timeValue(end) <= timestamp))
        ) {
          throw new Error('Invalid lyric timing');
        }
        const line = { timestamp, text: textContent(node.p) };
        if (end !== undefined) line.end = timeValue(end);
        const spans = node.p.filter((item) => item.span);
        if (spans.length) {
          line.words = spans.map((span) => ({
            timestamp: timeValue(span[':@']?.['@_begin']),
            end: timeValue(span[':@']?.['@_end']),
            text: textContent(span.span)
          }));
          if (
            line.words.some(
              (word) =>
                word.timestamp === null ||
                word.end === null ||
                word.end <= word.timestamp ||
                word.timestamp < timestamp ||
                (line.end !== undefined && word.end > line.end)
            )
          ) {
            throw new Error('Unsupported span timing');
          }
        }
        lines.push(line);
      }
    }
  }
  walk(root.tt);
  if (!lines.some((line) => line.text.trim())) throw new Error('Empty lyrics');
  return {
    lines: lines
      .filter((line) => line.timestamp !== null)
      .sort((a, b) => a.timestamp - b.timestamp),
    plainLyrics: lines.map((line) => line.text).join('\n')
  };
}

module.exports = { createTtml, parseTtml, parseLrc, clockTime, timeValue };
