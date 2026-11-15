// A fast drop-in for marked 18.1.3: parse(markdown) returns exactly the HTML
// marked renders with its defaults (GFM on, breaks off, pedantic off), byte
// for byte. Written from scratch for speed: index-cursor scanning with
// sticky regexes (no substring copies per token), first-char dispatch, and a
// single-pass inline scanner. The regexes below are the behavioural spec:
// marked's own patterns, built the same way, because only they reproduce its
// output exactly on every edge case.

const escapeReplacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtmlEntities(html, encode) {
  if (encode) {
    if (escapeTest.test(html)) return html.replace(escapeReplace, (ch) => escapeReplacements[ch]);
  } else if (escapeTestNoEncode.test(html)) {
    return html.replace(escapeReplaceNoEncode, (ch) => escapeReplacements[ch]);
  }
  return html;
}

function decodeNumericCharacterReferences(text) {
  if (!numericCharacterReference.test(text)) return text;
  return text.replace(numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(findPipe, (match, offset, str) => {
      let escaped = false;
      let curr = offset;
      while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
      return escaped ? '|' : ' |';
    }),
    cells = row.split(splitPipe);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(slashPipe, '|');
  return cells;
}

function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

// --- closer-scan hints for emStrong / del (one scan per inline pass) ---
function scanLastPossibleClosers(src) {
  const last = { '*': -1, '_': -1 };
  let lastDel = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = i;
      else last[ch] = i;
    }
    i = j - 1;
  }
  return { last, lastDel };
}

// --- regex construction (same builder marked uses) ---
const noopTest = { exec: () => null };

function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}

function edit(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace: (name, val) => {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(caret, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex: () => new RegExp(source, opt),
  };
  return obj;
}

// Turn an anchored (^...) regex into a sticky one matching at lastIndex.
// sticky (y) anchors at lastIndex, so a leading ^ is redundant — and wrong:
// ^ would also require "start of string or after \n", which fails at a cursor
// mid-line (e.g. right after a heading whose raw was rtrimmed of \n).
// Strip ^ anchors (only where they are anchors: start, or after ( or |).
// $ stays: $ means end of the whole string, which is also the end of the
// remaining suffix in marked, so it is equivalent here.
function sticky(re) {
  return new RegExp(re.source.replace(/(^|[(|])\^/g, '$1'), re.flags.includes('y') ? re.flags : re.flags + 'y');
}
// exec a (possibly sticky) regex at an exact position
function ex(re, str, pos) { re.lastIndex = pos; return re.exec(str); }

const supportsLookbehind = (() => {
  try {
    return !!new RegExp('(?<=1)(?<!1)');
  } catch {
    return false;
  }
})();

const codeRemoveIndent = /^(?: {0,3}\t| {1,4})/gm;
const outputLinkReplace = /\\([\[\]])/g;
const indentCodeCompensation = /^(\s+)(?:```)/;
const beginningSpace = /^\s+/;
const endingHash = /#$/;
const startingSpaceChar = /^ /;
const endingSpaceChar = / $/;
const endingSpaceTabChar = /[ \t]$/;
const nonSpaceChar = /[^ ]/;
const newLineCharGlobal = /\n/g;
const tabCharGlobal = /\t/g;
const leadingSpaceTab = /^[ \t]+/;
const multipleSpaceGlobal = /\s+/g;
const blankLine = /^[ \t]*$/;
const doubleBlankLine = /\n[ \t]*\n[ \t]*$/;
const blockquoteStart = /^ {0,3}>/;
const blockquoteSetextReplace = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const blockquoteSetextReplace2 = /^ {0,3}>[ \t]?/gm;
const blockquoteMarkerWhitespace = /^( {0,3}>)([ \t]+)/gm;
const listReplaceNesting = /^ {1,4}(?=( {4})*[^ ])/g;
const listIsTask = /^\[[ xX]\][ \t]+\S/;
const listReplaceTask = /^\[[ xX]\][ \t]+/;
const listTaskCheckbox = /\[[ xX]\]/;
const anyLine = /\n.*\n/;
const hrefBrackets = /^<(.*)>$/;
const tableDelimiter = /[:|]/;
const tableAlignChars = /^\||\| *$/g;
const tableRowBlankLine = /\n[ \t]*$/;
const tableAlignRight = /^ *-+: *$/;
const tableAlignCenter = /^ *:-+: *$/;
const tableAlignLeft = /^ *:-+ *$/;
const startATag = /^<a /i;
const endATag = /^<\/a>/i;
const startPreScriptTag = /^<(pre|code|kbd|script)(\s|>)/i;
const endPreScriptTag = /^<\/(pre|code|kbd|script)(\s|>)/i;
const startAngleBracket = /^</;
const endAngleBracket = />$/;
const pedanticHrefTitle = /^([^'"]*[^\s])\s+(['"])(.*)\2/;
const unicodeAlphaNumeric = /[\p{L}\p{N}]/u;
const numericCharacterReference = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericCharacterReferenceOrAmpersand = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const escapeTest = /[&<>"']/;
const escapeReplace = /[&<>"']/g;
const escapeTestNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const caret = /(^|[^\[])\^/g;
const percentDecode = /%25/g;
const findPipe = /\|/g;
const splitPipe = / \|/;
const slashPipe = /\\\|/g;
const carriageReturn = /\r\n|\r/g;
const spaceLine = /^ +$/gm;
const notSpaceStart = /^\S*/;
const endingNewline = /\n$/;
const listItemRegex = (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`);
const nextBulletRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`));
const headingBeginRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${_tag})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`));

const _tag = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// --- block regexes (GFM) ---
const newlineRe = /^(?:[ \t]*(?:\n|$))+/;
const blockCodeRe = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fencesRe = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const hrRe = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const headingRe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bulletRe = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const lheadingRe = edit(lheadingCore)
  .replace(/bull/g, bulletRe)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();
const paragraphCore = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const blockTextRe = /^[^\n]+/;
const blockLabelRe = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const defRe = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', blockLabelRe)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();
const listRe = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, bulletRe)
  .getRegex();
const htmlBlockRe = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', _comment)
  .replace('tag', _tag)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();
const tableRe = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', hrRe)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();
const createParagraph = (listInterrupt) => edit(paragraphCore)
  .replace('hr', hrRe)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('|table', '')
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', listInterrupt)
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();
const paragraphRe = edit(paragraphCore)
  .replace('hr', hrRe)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', tableRe)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();
const blockquoteParagraphRe = createParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
const blockquoteRe = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', blockquoteParagraphRe)
  .getRegex();

// --- inline regexes (GFM) ---
const escapeRe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCodeRe = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const brRe = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const punctRe = /[\p{P}\p{S}]/u;
const punctSpaceRe = /[\s\p{P}\p{S}]/u;
const notPunctSpaceRe = /[^\s\p{P}\p{S}]/u;
const punctGfm = /(?!~)[\p{P}\p{S}]/u;
const punctSpaceGfm = /(?!~)[\s\p{P}\p{S}]/u;
const notPunctSpaceGfm = /(?:[^\s\p{P}\p{S}]|~)/u;
const punctuationRe = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, punctSpaceRe).getRegex();
const blockSkipRe = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', supportsLookbehind ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();
const emStrongLDelimRe = edit(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
  .replace(/punct/g, punctGfm)
  .getRegex();
const emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';
const emStrongRDelimAstRe = edit(emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, notPunctSpaceGfm)
  .replace(/punctSpace/g, punctSpaceGfm)
  .replace(/punct/g, punctGfm)
  .getRegex();
const emStrongRDelimUndRe = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .replace(/notPunctSpace/g, notPunctSpaceRe)
  .replace(/punctSpace/g, punctSpaceRe)
  .replace(/punct/g, punctRe)
  .getRegex();
const delLDelimRe = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, punctRe)
  .getRegex();
const delRDelimCore =
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)';
const delRDelimRe = edit(delRDelimCore, 'gu')
  .replace(/notPunctSpace/g, notPunctSpaceRe)
  .replace(/punctSpace/g, punctSpaceRe)
  .replace(/punct/g, punctRe)
  .getRegex();
const anyPunctuationRe = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, punctRe)
  .getRegex();
const anyPunctuationOutsideCodeRe = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, punctRe)
  .getRegex();
const autolinkRe = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();
const inlineCommentRe = edit(_comment).replace('(?:-->|$)', '-->').getRegex();
const tagRe = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', inlineCommentRe)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();
const inlineLabelBracketsRe = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const inlineLabelRe = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', inlineLabelBracketsRe)
  .getRegex();
const linkRe = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', inlineLabelRe)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();
const reflinkRe = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', inlineLabelRe)
  .replace('ref', blockLabelRe)
  .getRegex();
const nolinkRe = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', blockLabelRe)
  .getRegex();
const boundedBlockLabelRe = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const boundedInlineLabelRe = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', inlineLabelBracketsRe)
  .getRegex();
const reflinkSearchRe = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', boundedInlineLabelRe)
    .replace('ref', boundedBlockLabelRe)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', boundedBlockLabelRe)
    .getRegex())
  .getRegex();
const caseInsensitiveProtocolRe = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const extendedEmailRe = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const extendedEmailProtocolRe = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, extendedEmailRe)
  .getRegex();
const backpedalRe = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const delRe = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const urlRe = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', extendedEmailProtocolRe)
  .replace('protocol', caseInsensitiveProtocolRe)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();
const inlineTextRe = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', caseInsensitiveProtocolRe)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', supportsLookbehind ? '(?<![^\\s*_~(])www\\.' : 'www\\.')
  .getRegex();

// --- sticky versions of the anchored regexes (cursor matching, no copies) ---
const S = {
  newline: sticky(newlineRe),
  code: sticky(blockCodeRe),
  fences: sticky(fencesRe),
  heading: sticky(headingRe),
  hr: sticky(hrRe),
  blockquote: sticky(blockquoteRe),
  list: sticky(listRe),
  html: sticky(htmlBlockRe),
  def: sticky(defRe),
  table: sticky(tableRe),
  lheading: sticky(lheadingRe),
  paragraph: sticky(paragraphRe),
  text: sticky(blockTextRe),
  escape: sticky(escapeRe),
  tag: sticky(tagRe),
  link: sticky(linkRe),
  reflink: sticky(reflinkRe),
  nolink: sticky(nolinkRe),
  emStrongLDelim: sticky(emStrongLDelimRe),
  codeSpan: sticky(inlineCodeRe),
  br: sticky(brRe),
  delLDelim: sticky(delLDelimRe),
  autolink: sticky(autolinkRe),
  url: sticky(urlRe),
  inlineText: sticky(inlineTextRe),
  punctuation: sticky(punctuationRe),
};

// --- other regexes (from rules.ts `other`) ---
const codeRemoveIndentRe = /^(?: {0,3}\t| {1,4})/gm;
const outputLinkReplaceRe = /\\([\[\]])/g;
const indentCodeCompensationRe = /^(\s+)(?:```)/;
const beginningSpaceRe = /^\s+/;
const endingHashRe = /#$/;
const startingSpaceCharRe = /^ /;
const endingSpaceCharRe = / $/;
const endingSpaceTabCharRe = /[ \t]$/;
const nonSpaceCharRe = /[^ ]/;
const newLineCharGlobalRe = /\n/g;
const tabCharGlobalRe = /\t/g;
const leadingSpaceTabRe = /^[ \t]+/;
const multipleSpaceGlobalRe = /\s+/g;
const blankLineRe = /^[ \t]*$/;
const doubleBlankLineRe = /\n[ \t]*\n[ \t]*$/;
const blockquoteStartRe = /^ {0,3}>/;
const blockquoteSetextReplaceRe = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const blockquoteSetextReplace2Re = /^ {0,3}>[ \t]?/gm;
const blockquoteMarkerWhitespaceRe = /^( {0,3}>)([ \t]+)/gm;
const listReplaceNestingRe = /^ {1,4}(?=( {4})*[^ ])/g;
const listIsTaskRe = /^\[[ xX]\][ \t]+\S/;
const listReplaceTaskRe = /^\[[ xX]\][ \t]+/;
const listTaskCheckboxRe = /\[[ xX]\]/;
const anyLineRe = /\n.*\n/;
const hrefBracketsRe = /^<(.*)>$/;
const tableDelimiterRe = /[:|]/;
const tableAlignCharsRe = /^\||\| *$/g;
const tableRowBlankLineRe = /\n[ \t]*$/;
const tableAlignRightRe = /^ *-+: *$/;
const tableAlignCenterRe = /^ *:-+: *$/;
const tableAlignLeftRe = /^ *:-+ *$/;
const startATagRe = /^<a /i;
const endATagRe = /^<\/a>/i;
const startPreScriptTagRe = /^<(pre|code|kbd|script)(\s|>)/i;
const endPreScriptTagRe = /^<\/(pre|code|kbd|script)(\s|>)/i;
const startAngleBracketRe = /^</;
const endAngleBracketRe = />$/;
const unicodeAlphaNumericRe = /[\p{L}\p{N}]/u;
const numericCharacterReferenceRe = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericCharacterReferenceOrAmpersandRe = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const escapeTestRe = /[&<>"']/;
const escapeReplaceRe = /[&<>"']/g;
const escapeTestNoEncodeRe = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncodeRe = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const percentDecodeRe = /%25/g;
const findPipeRe = /\|/g;
const splitPipeRe = / \|/;
const slashPipeRe = /\\\|/g;
const carriageReturnRe = /\r\n|\r/g;
const notSpaceStartRe = /^\S*/;
const endingNewlineRe = /\n$/;
// One scan per inline run: last index of a *, _ or ~ run that can close
// emphasis/strong/del (not preceded by ASCII whitespace or start-of-string).
function scanClosers(src) {
  const out = { star: -1, und: -1, del: -1 };
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') out.del = i;
      else if (ch === '*') out.star = i;
      else out.und = i;
    }
    i = j - 1;
  }
  return out;
}

// --- lexer + parser (faithful reimplementation of marked 18.1.3, defaults:
// gfm true, breaks false, pedantic false, async false) ---
export function parse(src) {
  if (src.includes('\r')) src = src.replace(carriageReturnRe, '\n');
  const links = Object.create(null);
  let hasLinkDefs = false;
  const inlineQueue = [];
  const state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };

  function inline(src, tokens = []) { inlineQueue.push({ src, tokens }); return tokens; }
  function infiniteLoop(byte) { throw new Error('Infinite loop on byte: ' + byte); }

  function indentCodeCompensation(raw, text) {
    const m = raw.match(indentCodeCompensationRe);
    if (m === null) return text;
    const indentToCode = m[1];
    return text.split('\n').map((node) => {
      const mi = node.match(beginningSpaceRe);
      if (mi === null) return node;
      return node.slice(Math.min(mi[0].length, indentToCode.length));
    }).join('\n');
  }

  // ----- block tokenizers: (src, pos) -> token | undefined -----
  function tokSpace(src, pos) {
    const cap = ex(S.newline, src, pos);
    if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
  }
  function tokCode(src, pos) {
    const cap = ex(S.code, src, pos);
    if (cap) {
      const raw = trimTrailingBlankLines(cap[0]);
      const text = raw.replace(codeRemoveIndentRe, '');
      return { type: 'code', raw, codeBlockStyle: 'indented', text };
    }
  }
  function tokFences(src, pos) {
    const cap = ex(S.fences, src, pos);
    if (cap) {
      const raw = cap[0];
      const text = indentCodeCompensation(raw, cap[3] || '');
      return {
        type: 'code', raw,
        lang: cap[2] ? cap[2].trim().replace(anyPunctuationRe, '$1') : cap[2],
        text,
      };
    }
  }
  function tokHeading(src, pos) {
    const cap = ex(S.heading, src, pos);
    if (cap) {
      let text = cap[2].trim();
      if (endingHashRe.test(text)) {
        const trimmed = rtrim(text, '#');
        if (!trimmed || endingSpaceTabCharRe.test(trimmed)) text = trimmed.trim();
      }
      return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text, tokens: inline(text) };
    }
  }
  function tokHr(src, pos) {
    const cap = ex(S.hr, src, pos);
    if (cap) return { type: 'hr', raw: rtrim(cap[0], '\n') };
  }
  function tokBlockquote(src, pos) {
    const cap = ex(S.blockquote, src, pos);
    if (cap) {
      let lines = rtrim(cap[0], '\n').split('\n');
      let raw = '';
      let text = '';
      const tokens = [];
      while (lines.length > 0) {
        let inBlockquote = false;
        const currentLines = [];
        let i;
        for (i = 0; i < lines.length; i++) {
          if (blockquoteStartRe.test(lines[i])) { currentLines.push(lines[i]); inBlockquote = true; }
          else if (!inBlockquote) currentLines.push(lines[i]);
          else break;
        }
        lines = lines.slice(i);
        const currentRaw = currentLines.join('\n');
        const currentText = currentRaw
          .replace(blockquoteMarkerWhitespaceRe, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
          .replace(blockquoteSetextReplaceRe, '\n    $1')
          .replace(blockquoteSetextReplace2Re, '');
        raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
        text = text ? `${text}\n${currentText}` : currentText;
        const top = state.top;
        state.top = true;
        blockTokens(currentText, tokens, true);
        state.top = top;
        if (lines.length === 0) break;
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
          break;
        } else if (lastToken?.type === 'blockquote') {
          const oldToken = lastToken;
          const continuation = lines.join('\n');
          const newText = oldToken.raw + '\n' + continuation.replace(blockquoteSetextReplace2Re, '');
          const newToken = tokBlockquote(newText, 0);
          if (!newToken) break;
          tokens[tokens.length - 1] = newToken;
          const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
          const leftoverCount = leftover ? leftover.split('\n').length : 0;
          const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
          if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
          text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
          lines = lines.slice(consumed.length);
          if (lines.length > 0 && blockquoteStartRe.test(lines[0])) continue;
          break;
        } else if (lastToken?.type === 'list') {
          const oldToken = lastToken;
          const newText = oldToken.raw + '\n' + lines.join('\n');
          const newToken = tokList(newText, 0);
          if (!newToken) break;
          tokens[tokens.length - 1] = newToken;
          const consumedCount = newToken.raw.length > oldToken.raw.length
            ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
            : 0;
          if (consumedCount > 0) {
            const consumed = lines.slice(0, consumedCount).join('\n');
            raw = `${raw}\n${consumed}`;
            text = `${text}\n${consumed}`;
          }
          lines = lines.slice(consumedCount);
          continue;
        }
      }
      return { type: 'blockquote', raw, tokens, text };
    }
  }
  function tokList(src, pos) {
    const cap0 = ex(S.list, src, pos);
    if (cap0) {
      // Cursor-based: the original walks the list with repeated
      // src.substring() per line, which copies the whole remainder each time
      // (quadratic in list length). Here p is an index into listSrc and lines
      // are sliced only as far as the next newline.
      const listSrc = src.slice(pos);
      const len = listSrc.length;
      let p = 0;
      let bull = cap0[1].trim();
      const isordered = bull.length > 1;
      const list = {
        type: 'list', raw: '', ordered: isordered,
        start: isordered ? +bull.slice(0, -1) : '', loose: false, items: [],
      };
      bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
      const itemRegex = sticky(new RegExp(`^( {0,3}${bull})((?:[\\t ][^\\n]*)?(?:\\n|$))`));
      let endsWithBlankLine = false;
      while (p < len) {
        let endEarly = false;
        let itemContents = '';
        let cap;
        if (!(cap = ex(itemRegex, listSrc, p))) break;
        if (ex(S.hr, listSrc, p)) break;
        const itemStart = p;
        p += cap[0].length;
        const firstLine = cap[2].split('\n', 1)[0];
        const bulletIndent = cap[1].length;
        let line = firstLine.replace(leadingSpaceTabRe, (whitespace) => expandTabs(whitespace, bulletIndent));
        let nl = listSrc.indexOf('\n', p);
        let nextLine = nl === -1 ? listSrc.slice(p) : listSrc.slice(p, nl);
        let blankLine = !line.trim();
        let indent = 0;
        if (blankLine) {
          indent = bulletIndent + 1;
        } else {
          indent = line.search(nonSpaceCharRe);
          indent = indent > 4 ? 1 : indent;
          itemContents = line.slice(indent);
          indent += bulletIndent;
        }
        if (blankLine && blankLineRe.test(nextLine)) {
          p = nl === -1 ? len : nl + 1;
          endEarly = true;
        }
        if (!endEarly) {
          const nextBulletRe = nextBulletRegex(indent);
          const hrRe = hrRegex(indent);
          const fencesBeginRe = fencesBeginRegex(indent);
          const headingBeginRe = headingBeginRegex(indent);
          const htmlBeginRe = htmlBeginRegex(indent);
          const blockquoteBeginRe = blockquoteBeginRegex(indent);
          while (p < len) {
            nl = listSrc.indexOf('\n', p);
            const rawLine = nl === -1 ? listSrc.slice(p) : listSrc.slice(p, nl);
            let nextLineWithoutTabs;
            nextLine = rawLine;
            nextLineWithoutTabs = nextLine.replace(leadingSpaceTabRe, (whitespace) => expandTabs(whitespace));
            if (fencesBeginRe.test(nextLine)) break;
            if (headingBeginRe.test(nextLine)) break;
            if (htmlBeginRe.test(nextLine)) break;
            if (blockquoteBeginRe.test(nextLine)) break;
            if (nextBulletRe.test(nextLine)) break;
            if (hrRe.test(nextLine)) break;
            if (nextLineWithoutTabs.search(nonSpaceCharRe) >= indent || !nextLine.trim()) {
              itemContents += '\n' + nextLineWithoutTabs.slice(indent);
            } else {
              if (blankLine) break;
              if (line.replace(tabCharGlobalRe, '    ').search(nonSpaceCharRe) >= 4) break;
              if (fencesBeginRe.test(line)) break;
              if (headingBeginRe.test(line)) break;
              if (htmlBeginRe.test(line)) break;
              if (hrRe.test(line)) break;
              const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
                && ex(S.lheading, `${line}\n${nextLine}`, 0);
              const continuation = setextContinuation
                ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
                : nextLine;
              itemContents += '\n' + continuation;
            }
            blankLine = !nextLine.trim();
            p = nl === -1 ? len : nl + 1;
            line = nextLineWithoutTabs.slice(indent);
          }
        }
        const raw = listSrc.slice(itemStart, p);
        if (!list.loose) {
          if (endsWithBlankLine) list.loose = true;
          else if (doubleBlankLineRe.test(raw)) endsWithBlankLine = true;
        }
        list.items.push({
          type: 'list_item', raw,
          task: !!listIsTaskRe.test(itemContents),
          loose: false, text: itemContents, tokens: [],
        });
      }
      const lastItem = list.items.at(-1);
      if (lastItem) {
        lastItem.raw = lastItem.raw.trimEnd();
        lastItem.text = lastItem.text.trimEnd();
      } else {
        return undefined;
      }
      list.raw = listSrc.slice(0, p).trimEnd();
      for (const item of list.items) {
        state.top = false;
        item.tokens = blockTokens(item.text, []);
        if (!list.loose) {
          const spacers = item.tokens.filter((t) => t.type === 'space');
          const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => anyLineRe.test(t.raw));
          list.loose = hasMultipleLineBreaks;
        }
      }
      for (const item of list.items) {
        const itemToken = item.tokens[0];
        if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
          item.text = item.text.replace(listReplaceTaskRe, '');
          itemToken.raw = itemToken.raw.replace(listReplaceTaskRe, '');
          itemToken.text = itemToken.text.replace(listReplaceTaskRe, '');
          for (let i = inlineQueue.length - 1; i >= 0; i--) {
            if (listIsTaskRe.test(inlineQueue[i].src)) {
              inlineQueue[i].src = inlineQueue[i].src.replace(listReplaceTaskRe, '');
              break;
            }
          }
          const taskRaw = listTaskCheckboxRe.exec(item.raw);
          if (taskRaw) {
            const checkboxToken = { type: 'checkbox', raw: taskRaw[0] + ' ', checked: taskRaw[0] !== '[ ]' };
            item.checked = checkboxToken.checked;
            if (list.loose) {
              if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
                item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
                item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
                item.tokens[0].tokens.unshift(checkboxToken);
              } else {
                item.tokens.unshift({
                  type: 'paragraph', raw: checkboxToken.raw, text: checkboxToken.raw, tokens: [checkboxToken],
                });
              }
            } else {
              item.tokens.unshift(checkboxToken);
            }
          }
        } else if (item.task) {
          item.task = false;
        }
      }
      if (list.loose) {
        for (const item of list.items) {
          item.loose = true;
          for (const token of item.tokens) {
            if (token.type === 'text') token.type = 'paragraph';
          }
        }
      }
      return list;
    }
  }
  function tokHtml(src, pos) {
    const cap = ex(S.html, src, pos);
    if (cap) {
      const raw = trimTrailingBlankLines(cap[0]);
      return {
        type: 'html', block: true, raw,
        pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
        text: raw,
      };
    }
  }
  function tokDef(src, pos) {
    const cap = ex(S.def, src, pos);
    if (cap) {
      if (!startAngleBracketRe.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return undefined;
      const tag = normalizeLabel(cap[1]);
      const href = cap[2] ? cap[2].replace(hrefBracketsRe, '$1').replace(anyPunctuationRe, '$1') : '';
      const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(anyPunctuationRe, '$1') : cap[3];
      return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
    }
  }
  function tokTable(src, pos) {
    const cap = ex(S.table, src, pos);
    if (!cap) return undefined;
    if (!tableDelimiterRe.test(cap[2])) return undefined;
    const headers = splitCells(cap[1]);
    const aligns = cap[2].replace(tableAlignCharsRe, '').split('|');
    const rows = cap[3]?.trim() ? cap[3].replace(tableRowBlankLineRe, '').split('\n') : [];
    const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
    if (headers.length !== aligns.length) return undefined;
    for (const align of aligns) {
      if (tableAlignRightRe.test(align)) item.align.push('right');
      else if (tableAlignCenterRe.test(align)) item.align.push('center');
      else if (tableAlignLeftRe.test(align)) item.align.push('left');
      else item.align.push(null);
    }
    for (let i = 0; i < headers.length; i++) {
      item.header.push({ text: headers[i], tokens: inline(headers[i]), header: true, align: item.align[i] });
    }
    for (const row of rows) {
      item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
        text: cell, tokens: inline(cell), header: false, align: item.align[i],
      })));
    }
    return item;
  }
  function tokLheading(src, pos) {
    const cap = ex(S.lheading, src, pos);
    if (cap) {
      const text = cap[1].trim();
      return {
        type: 'heading', raw: rtrim(cap[0], '\n'),
        depth: cap[2].charAt(0) === '=' ? 1 : 2, text, tokens: inline(text),
      };
    }
  }
  function tokParagraph(src, pos) {
    const cap = ex(S.paragraph, src, pos);
    if (cap) {
      const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
      return { type: 'paragraph', raw: cap[0], text, tokens: inline(text) };
    }
  }
  function tokText(src, pos) {
    const cap = ex(S.text, src, pos);
    if (cap) return { type: 'text', raw: cap[0], text: cap[0], tokens: inline(cap[0]) };
  }

  // ----- block loop -----
  function blockTokens(src, tokens, lastParagraphClipped = false) {
    let pos = 0;
    const len = src.length;
    let srcLength = Infinity;
    while (pos < len) {
      const rem = len - pos;
      if (rem < srcLength) srcLength = rem;
      else infiniteLoop(src.charCodeAt(pos));
      // First-char dispatch: each block tokenizer can only start at a few
      // characters. A block starting with a letter (the common case) only
      // ever tries table, lheading, paragraph and text. The order of tries
      // follows marked exactly; a tokenizer is skipped only when its pattern
      // cannot match at this first character.
      const ch = src.charCodeAt(pos);
      const indented = ch === 32 || ch === 9 || ch === 10;
      let token;
      if (indented && (token = tokSpace(src, pos))) {
        pos += token.raw.length;
        const lastToken = tokens.at(-1);
        if (token.raw.length === 1 && lastToken !== undefined) lastToken.raw += '\n';
        else tokens.push(token);
        continue;
      }
      if (indented && (token = tokCode(src, pos))) {
        pos += token.raw.length;
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          inlineQueue.at(-1).src = lastToken.text;
        } else tokens.push(token);
        continue;
      }
      if ((indented || ch === 96 || ch === 126) && (token = tokFences(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
      if ((indented || ch === 35) && (token = tokHeading(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
      if ((indented || ch === 45 || ch === 95 || ch === 42) && (token = tokHr(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
      if ((indented || ch === 62) && (token = tokBlockquote(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
      if ((indented || ch === 42 || ch === 43 || ch === 45 || (ch >= 48 && ch <= 57)) && (token = tokList(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
      if ((indented || ch === 60) && (token = tokHtml(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
      if ((indented || ch === 91) && (token = tokDef(src, pos))) {
        pos += token.raw.length;
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.raw;
          inlineQueue.at(-1).src = lastToken.text;
        } else {
          if (!links[token.tag]) { links[token.tag] = { href: token.href, title: token.title }; hasLinkDefs = true; }
          tokens.push(token);
        }
        continue;
      }
      if ((token = tokTable(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
      if ((token = tokLheading(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
      if (state.top && (token = tokParagraph(src, pos))) {
        const lastToken = tokens.at(-1);
        if (lastParagraphClipped && lastToken?.type === 'paragraph') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          inlineQueue.pop();
          inlineQueue.at(-1).src = lastToken.text;
        } else tokens.push(token);
        lastParagraphClipped = false;
        pos += token.raw.length;
        continue;
      }
      if ((token = tokText(src, pos))) {
        pos += token.raw.length;
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          inlineQueue.pop();
          inlineQueue.at(-1).src = lastToken.text;
        } else tokens.push(token);
        continue;
      }
      infiniteLoop(src.charCodeAt(pos));
    }
    state.top = true;
    return tokens;
  }
  // ----- inline helpers -----
  function isLabelEndInsideToken(src, pos, label, labelStart) {
    if (!label.includes('<')) return false;
    for (let i = 0; i < label.length; i++) {
      if (label[i] === '\\') { i++; continue; }
      if (label[i] === '`') {
        const code = ex(S.codeSpan, label.slice(i), 0);
        if (code) { i += code[0].length - 1; continue; }
      }
      if (label[i] !== '<') continue;
      const tokenSrc = src.slice(pos + labelStart + i);
      const token = ex(S.tag, tokenSrc, 0) || ex(S.autolink, tokenSrc, 0);
      if (!token) continue;
      if (token[0].length > label.length - i) return true;
      i += token[0].length - 1;
    }
    return false;
  }
  function outputLink(cap, link, raw) {
    const href = link.href;
    const title = link.title || null;
    const text = cap[1].replace(outputLinkReplaceRe, '$1');
    const isImage = cap[0].charAt(0) === '!';
    const outerInLink = state.inLink;
    const outerLinkEmitted = state.linkEmitted;
    const outerInRawBlock = state.inRawBlock;
    state.inLink = true;
    state.linkEmitted = false;
    const tokens = inlineTokens(text);
    const textHasLink = state.linkEmitted;
    state.linkEmitted = outerLinkEmitted;
    state.inLink = outerInLink;
    if (!isImage) {
      if (textHasLink) { state.inRawBlock = outerInRawBlock; return undefined; }
      state.linkEmitted = true;
    }
    return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
  }
  function linkInText(text) {
    if (!text.includes('[')) return false;
    for (const match of text.matchAll(blockSkipRe)) {
      if (ex(S.link, match[0], 0) && text.charAt(match.index - 1) !== '!') return true;
    }
    for (const match of text.matchAll(reflinkSearchRe)) {
      const match0 = match[0];
      const refStart = match0.lastIndexOf('[');
      if (match0.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
      if (refStart > 1 && linkInText(match0.slice(1, refStart - 1))) continue;
      return true;
    }
    return false;
  }
  function maskSrc(src) {
    // Each mask only fires on characters it can match; plain emphasis-heavy
    // text (no [, \, ` or <) skips all three regex passes entirely.
    let maskedSrc = src;
    const hasBracket = src.includes('[');
    const hasEscape = src.includes('\\');
    const hasCode = src.includes('`');
    const hasTag = src.includes('<');
    // A reflink mask can only change a run when some label is defined.
    if (hasBracket && hasLinkDefs) {
      const maskReflink = (match0) => {
        const refStart = match0.lastIndexOf('[');
        if (!Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
        if (refStart > 1 && match0.charAt(0) !== '!') {
          const text = match0.slice(1, refStart - 1);
          if (linkInText(text)) {
            return '[' + text.replace(reflinkSearchRe, maskReflink) + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(match0.length - 2) + ']';
      };
      maskedSrc = maskedSrc.replace(reflinkSearchRe, maskReflink);
    }
    if (hasEscape || hasCode) {
      maskedSrc = maskedSrc.replace(anyPunctuationOutsideCodeRe, (match0, code, punct) => {
        if (punct) return '+'.repeat(match0.length);
        if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
        return match0;
      });
    }
    if (hasBracket || hasCode || hasTag) {
      maskedSrc = maskedSrc.replace(blockSkipRe, (match0, _link, context) => {
        const offset = context ? context.length : 0;
        return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
      });
    }
    return maskedSrc;
  }

  // ----- inline tokenizers: (src, pos, ...) -> token | undefined -----
  function tokEscape(src, pos) {
    const cap = ex(S.escape, src, pos);
    if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
  }
  function tokTag(src, pos) {
    const cap = ex(S.tag, src, pos);
    if (cap) {
      if (!state.inLink && startATagRe.test(cap[0])) state.inLink = true;
      else if (state.inLink && endATagRe.test(cap[0])) state.inLink = false;
      if (!state.inRawBlock && startPreScriptTagRe.test(cap[0])) state.inRawBlock = true;
      else if (state.inRawBlock && endPreScriptTagRe.test(cap[0])) state.inRawBlock = false;
      return { type: 'html', raw: cap[0], inLink: state.inLink, inRawBlock: state.inRawBlock, block: false, text: cap[0] };
    }
  }
  function tokLink(src, pos) {
    if (state.linkParenPossible === false) return undefined;
    const cap = ex(S.link, src, pos);
    if (cap) {
      const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
      if (isLabelEndInsideToken(src, pos, cap[1], labelStart)) return undefined;
      const trimmedUrl = cap[2].trim();
      if (startAngleBracketRe.test(trimmedUrl)) {
        if (!endAngleBracketRe.test(trimmedUrl)) return undefined;
        const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
        if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return undefined;
      } else {
        const lastParenIndex = findClosingBracket(cap[2], '()');
        if (lastParenIndex === -2) return undefined;
        if (lastParenIndex > -1) {
          const start = cap[0].indexOf('!') === 0 ? 5 : 4;
          const linkLen = start + cap[1].length + lastParenIndex;
          cap[2] = cap[2].substring(0, lastParenIndex);
          cap[0] = cap[0].substring(0, linkLen).trim();
          cap[3] = '';
        }
      }
      const unescaped = rtrim(cap[0].slice(0, -1), '\\');
      if ((cap[0].length - unescaped.length) % 2 === 0) return undefined;
      let href = cap[2];
      const title = cap[3] ? cap[3].slice(1, -1) : '';
      href = href.trim();
      if (startAngleBracketRe.test(href)) href = href.slice(1, -1);
      return outputLink(cap, {
        href: href ? href.replace(anyPunctuationRe, '$1') : href,
        title: title ? title.replace(anyPunctuationRe, '$1') : title,
      }, cap[0]);
    }
  }
  function tokReflink(src, pos) {
    const cap = ex(S.reflink, src, pos) || ex(S.nolink, src, pos);
    if (cap) {
      const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
      if (isLabelEndInsideToken(src, pos, cap[1], labelStart)) return undefined;
      const link = links[normalizeLabel(cap[2] || cap[1])];
      if (!link) {
        const text = cap[0].charAt(0);
        return { type: 'text', raw: text, text };
      }
      return outputLink(cap, link, cap[0]);
    }
  }
  function tokEmStrong(src, pos, maskedSrc, hints, prevChar) {
    let match = ex(S.emStrongLDelim, src, pos);
    if (!match) return undefined;
    if (!match[1] && !match[2] && !match[3] && !match[4]) return undefined;
    const delimChar = match[0][0];
    const midRun = prevChar === delimChar;
    const srcStart = pos;
    let runStart = srcStart;
    while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
    const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
    const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!ex(S.punctuation, runPrevChar, 0);
    if (runStart < srcStart) prevChar = runPrevChar;
    const prevPunct = runStart < srcStart ? runPrevPunct : !!ex(S.punctuation, prevChar, 0);
    if (match[4] && prevChar.match(unicodeAlphaNumericRe)) return undefined;
    const nextChar = match[1] || match[3] || '';
    if (!nextChar || !prevChar || prevPunct) {
      const lLength = [...match[0]].length - 1;
      let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
      const runLength = srcStart - runStart + lLength;
      const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
      if (delimChar !== '*' && delimChar !== '_') return undefined;
      const endReg = delimChar === '*' ? emStrongRDelimAstRe : emStrongRDelimUndRe;
      const lastPossible = delimChar === '*' ? hints.star : hints.und;
      const windowStart = pos + lLength;
      if (lastPossible < windowStart) return undefined;
      const masked = maskedSrc.slice(pos + lLength);
      const lastInWindow = lastPossible - windowStart;
      endReg.lastIndex = 0;
      while ((match = endReg.exec(masked)) !== null) {
        if (match.index > lastInWindow) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!rDelim) continue;
        rLength = [...rDelim].length;
        if (match[3] || match[4]) { delimTotal += rLength; continue; }
        else if (match[5] || match[6] || openerCanClose) {
          if (midRun && (match[5] || match[6])) break;
          if (runLength % 3 && !((runLength + rLength) % 3)) { midDelimTotal += rLength; continue; }
        }
        delimTotal -= rLength;
        if (delimTotal > 0) continue;
        rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
        const lastCharLength = [...match[0]][0].length;
        const raw = src.slice(pos, pos + lLength + match.index + lastCharLength + rLength);
        if (Math.min(lLength, rLength) % 2) {
          const text = raw.slice(1, -1);
          return { type: 'em', raw, text, tokens: inlineTokens(text) };
        }
        const text = raw.slice(2, -2);
        return { type: 'strong', raw, text, tokens: inlineTokens(text) };
      }
    }
    return undefined;
  }
  function tokCodespan(src, pos) {
    const cap = ex(S.codeSpan, src, pos);
    if (cap) {
      let text = cap[2].replace(newLineCharGlobalRe, ' ');
      const hasNonSpaceChars = nonSpaceCharRe.test(text);
      const hasSpaceCharsOnBothEnds = startingSpaceCharRe.test(text) && endingSpaceCharRe.test(text);
      if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
      return { type: 'codespan', raw: cap[0], text };
    }
  }
  function tokBr(src, pos) {
    const cap = ex(S.br, src, pos);
    if (cap) return { type: 'br', raw: cap[0] };
  }
  function tokDel(src, pos, maskedSrc, hints, prevChar) {
    let match = ex(S.delLDelim, src, pos);
    if (!match) return undefined;
    const nextChar = match[1] || '';
    if (!nextChar || !prevChar || ex(S.punctuation, prevChar, 0)) {
      const lLength = [...match[0]].length - 1;
      let rDelim, rLength, delimTotal = lLength;
      const endReg = delRDelimRe;
      const lastPossible = hints.del;
      const windowStart = pos + lLength;
      if (lastPossible < windowStart) return undefined;
      const masked = maskedSrc.slice(pos + lLength);
      const lastInWindow = lastPossible - windowStart;
      endReg.lastIndex = 0;
      while ((match = endReg.exec(masked)) !== null) {
        if (match.index > lastInWindow) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!rDelim) continue;
        rLength = [...rDelim].length;
        if (rLength !== lLength) continue;
        if (match[3] || match[4]) { delimTotal += rLength; continue; }
        delimTotal -= rLength;
        if (delimTotal > 0) continue;
        rLength = Math.min(rLength, rLength + delimTotal);
        const lastCharLength = [...match[0]][0].length;
        const raw = src.slice(pos, pos + lLength + match.index + lastCharLength + rLength);
        const text = raw.slice(lLength, -lLength);
        return { type: 'del', raw, text, tokens: inlineTokens(text) };
      }
    }
    return undefined;
  }
  function tokAutolink(src, pos) {
    const cap = ex(S.autolink, src, pos);
    if (cap) {
      let text, href;
      if (cap[2] === '@') { text = cap[1]; href = 'mailto:' + text; }
      else { text = cap[1]; href = text; }
      return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
    }
  }
  function tokUrl(src, pos) {
    const cap = ex(S.url, src, pos);
    if (cap) {
      let text, href;
      if (cap[2] === '@') {
        text = cap[0];
        href = 'mailto:' + text;
      } else {
        let prevCapZero;
        do {
          prevCapZero = cap[0];
          cap[0] = backpedalRe.exec(cap[0])?.[0] ?? '';
        } while (prevCapZero !== cap[0]);
        text = cap[0];
        href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
      }
      return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
    }
  }
  function tokInlineText(src, pos) {
    const cap = ex(S.inlineText, src, pos);
    if (cap) {
      const escaped = state.inRawBlock;
      return { type: 'text', raw: cap[0], text: escaped ? cap[0] : decodeNumericCharacterReferences(cap[0]), escaped };
    }
  }

  // ----- inline loop -----
  function inlineTokens(src, tokens = []) {
    const prevLinkParenPossible = state.linkParenPossible;
    state.linkParenPossible = prevLinkParenPossible && src.includes(')');
    try {
      const maskedSrc = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskSrc(src) : src;
      const hints = scanClosers(maskedSrc);
      return tokenizeInlines(src, maskedSrc, hints, tokens);
    } finally {
      state.linkParenPossible = prevLinkParenPossible;
    }
  }
  function tokenizeInlines(src, maskedSrc, hints, tokens) {
    let keepPrevChar = false;
    let prevChar = '';
    let pos = 0;
    const len = src.length;
    let srcLength = Infinity;
    while (pos < len) {
      const rem = len - pos;
      if (rem < srcLength) srcLength = rem;
      else infiniteLoop(src.charCodeAt(pos));
      if (!keepPrevChar) prevChar = '';
      keepPrevChar = false;
      // First-char dispatch: each inline tokenizer can only match at a few
      // starting characters, and marked tries them in a fixed order. Trying
      // only the ones that can match preserves the order exactly while
      // skipping up to nine failed regex matches per text chunk.
      const ch = src.charCodeAt(pos);
      let token;
      if (ch === 92) { // backslash: escape, then br
        if ((token = tokEscape(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
        if ((token = tokBr(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
      } else if (ch === 60) { // <: tag, then autolink
        if ((token = tokTag(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
        if ((token = tokAutolink(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
      } else if (ch === 91 || ch === 33) { // [ or !: link, then reflink/nolink
        if ((token = tokLink(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
        if ((token = tokReflink(src, pos))) {
          pos += token.raw.length;
          tokens.push(token);
          continue;
        }
      } else if (ch === 42) { // *: em/strong
        if ((token = tokEmStrong(src, pos, maskedSrc, hints, prevChar))) { pos += token.raw.length; tokens.push(token); continue; }
      } else if (ch === 95) { // _: em/strong, then url (an email may start with _)
        if ((token = tokEmStrong(src, pos, maskedSrc, hints, prevChar))) { pos += token.raw.length; tokens.push(token); continue; }
        if (!state.inLink && (token = tokUrl(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
      } else if (ch === 96) { // `: code span
        if ((token = tokCodespan(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
      } else if (ch === 32) { // space: br (two spaces + newline)
        if ((token = tokBr(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
      } else if (ch === 126) { // ~: strikethrough
        if ((token = tokDel(src, pos, maskedSrc, hints, prevChar))) { pos += token.raw.length; tokens.push(token); continue; }
      } else if (!state.inLink && (ch === 46 || ch === 43 || ch === 45 || (ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122))) {
        // letter, digit, '.', '+' or '-': a url may start here
        if ((token = tokUrl(src, pos))) { pos += token.raw.length; tokens.push(token); continue; }
      }
      if ((token = tokInlineText(src, pos))) {
        pos += token.raw.length;
        if (token.raw.slice(-1) !== '_') prevChar = token.raw.slice(-1);
        keepPrevChar = true;
        // Consecutive text tokens are left unmerged: the renderer only
        // concatenates them, so merging (string copies per chunk) buys nothing.
        tokens.push(token);
        continue;
      }
      infiniteLoop(src.charCodeAt(pos));
    }
    return tokens;
  }

  // ----- run -----
  const tokens = [];
  blockTokens(src, tokens);
  for (let i = 0; i < inlineQueue.length; i++) {
    const next = inlineQueue[i];
    state.inRawBlock = false;
    inlineTokens(next.src, next.tokens);
  }
  return renderBlock(tokens);
}

// --- rendering (mirrors marked Renderer + TextRenderer) ---
function renderCode(token) {
  const langString = (token.lang || '').match(notSpaceStartRe)?.[0];
  const code = token.text ? token.text.replace(endingNewlineRe, '') + '\n' : '';
  const body = token.escaped ? code : escapeHtmlEntities(code, true);
  if (!langString) return '<pre><code>' + body + '</code></pre>\n';
  return '<pre><code class="language-' + escapeHtmlEntities(langString) + '">' + body + '</code></pre>\n';
}
function renderCheckbox(token) {
  return '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}
function renderTableCell(token) {
  const content = renderInline(token.tokens);
  const type = token.header ? 'th' : 'td';
  const tag = token.align ? `<${type} align="${token.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}
function renderTable(token) {
  let cell = '';
  for (let j = 0; j < token.header.length; j++) cell += renderTableCell(token.header[j]);
  const header = `<tr>\n${cell}</tr>\n`;
  let body = '';
  for (let j = 0; j < token.rows.length; j++) {
    const row = token.rows[j];
    cell = '';
    for (let k = 0; k < row.length; k++) cell += renderTableCell(row[k]);
    body += `<tr>\n${cell}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}
function renderLink(token) {
  const parsedText = token.autolink ? escapeHtmlEntities(token.text, true) : renderInline(token.tokens);
  const cleanHref = cleanUrl(token.href);
  if (cleanHref === null) return parsedText;
  const href = escapeHtmlEntities(cleanHref, token.autolink);
  let out = '<a href="' + href + '"';
  if (token.title) out += ' title="' + escapeHtmlEntities(token.title) + '"';
  return out + '>' + parsedText + '</a>';
}
function renderImage(token) {
  let text = token.text;
  if (token.tokens) text = renderInline(token.tokens, true);
  const cleanHref = cleanUrl(token.href);
  if (cleanHref === null) return escapeHtmlEntities(text);
  let out = `<img src="${escapeHtmlEntities(cleanHref)}" alt="${escapeHtmlEntities(text)}"`;
  if (token.title) out += ` title="${escapeHtmlEntities(token.title)}"`;
  return out + '>';
}
function renderText(token, textMode) {
  if ('tokens' in token && token.tokens) return renderInline(token.tokens, textMode);
  if (textMode) return token.text;
  return ('escaped' in token && token.escaped) ? token.text : escapeHtmlEntities(token.text);
}
function renderInline(tokens, textMode = false) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'escape': out += textMode ? token.text : escapeHtmlEntities(token.text); break;
      case 'html': out += token.text; break;
      case 'link': out += textMode ? (token.tokens ? renderInline(token.tokens, true) : token.text) : renderLink(token); break;
      case 'image': out += textMode ? (token.tokens ? renderInline(token.tokens, true) : token.text) : renderImage(token); break;
      case 'checkbox': out += textMode ? token.raw : renderCheckbox(token); break;
      case 'strong': out += textMode ? (token.tokens ? renderInline(token.tokens, true) : token.text) : `<strong>${renderInline(token.tokens)}</strong>`; break;
      case 'em': out += textMode ? (token.tokens ? renderInline(token.tokens, true) : token.text) : `<em>${renderInline(token.tokens)}</em>`; break;
      case 'codespan': out += textMode ? token.text : `<code>${escapeHtmlEntities(token.text, true)}</code>`; break;
      case 'br': out += textMode ? '' : '<br>'; break;
      case 'del': out += textMode ? (token.tokens ? renderInline(token.tokens, true) : token.text) : `<del>${renderInline(token.tokens)}</del>`; break;
      case 'text': out += renderText(token, textMode); break;
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}
function renderBlock(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${token.depth}>${renderInline(token.tokens)}</h${token.depth}>\n`; break;
      case 'code': out += renderCode(token); break;
      case 'table': out += renderTable(token); break;
      case 'blockquote': out += `<blockquote>\n${renderBlock(token.tokens)}</blockquote>\n`; break;
      case 'list': {
        let body = '';
        for (let j = 0; j < token.items.length; j++) body += `<li>${renderBlock(token.items[j].tokens)}</li>\n`;
        const type = token.ordered ? 'ol' : 'ul';
        const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'checkbox': out += renderCheckbox(token); break;
      case 'html': out += token.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${renderInline(token.tokens)}</p>\n`; break;
      case 'text': out += renderText(token, false); break;
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}
