// Rich text (proposal terms & conditions) arrives as HTML from the editor. Only an allow-list of
// formatting survives, so stored HTML is always safe to render and predictable for the PDF.
import sanitizeHtml from 'sanitize-html';
import { badRequest } from './HttpError.js';

const MAX_TEXT = 6000; // visible characters
const MAX_HTML = 30000;

const BLOCKS = ['p', 'h2', 'h3', 'li', 'blockquote'];
// editor classes that carry meaning: alignment and list/paragraph indent
const CLASSES = ['ql-align-center', 'ql-align-right', 'ql-align-justify', ...Array.from({ length: 8 }, (_, i) => `ql-indent-${i + 1}`)];

// markup the editor produces — anything else is treated as plain text (so "a < b" stays literal)
const IS_HTML = /<\/?(p|br|div|span|ol|ul|li|h[1-6]|blockquote|strong|b|em|i|u|s|a)(\s[^>]*)?\/?>/i;

const OPTIONS = {
  allowedTags: ['p', 'br', 'h2', 'h3', 'blockquote', 'strong', 'b', 'em', 'i', 'u', 's', 'ol', 'ul', 'li', 'a'],
  allowedAttributes: { a: ['href', 'target', 'rel'] },
  allowedClasses: Object.fromEntries(BLOCKS.map((tag) => [tag, CLASSES])),
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
    h1: 'h2',
    h4: 'h3',
    div: 'p',
  },
};

/** Plain text (older data, API clients) becomes a numbered list, one point per line. */
function fromPlainText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<ol>${lines.map((l) => `<li>${escape(l)}</li>`).join('')}</ol>`;
}

export const textOf = (html) => sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();

export function cleanRichText(input) {
  let html = String(input ?? '');
  if (html.length > MAX_HTML) throw badRequest('The terms & conditions are too long');
  if (!IS_HTML.test(html)) html = fromPlainText(html);
  html = sanitizeHtml(html.replace(/&nbsp;| /g, ' '), OPTIONS).trim();
  const text = textOf(html);
  if (text.length > MAX_TEXT) throw badRequest(`The terms & conditions can be at most ${MAX_TEXT} characters`);
  return text ? html : ''; // an editor that only holds empty paragraphs counts as empty
}
