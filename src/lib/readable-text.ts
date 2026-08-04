// Block-aware plain-text serialization of Readability-cleaned DOM content.
// Element.textContent glues block elements together on pages that have no
// whitespace text nodes between tags (React-rendered or minified HTML):
// "…end.Next heading" mangles words for the TTS front-end and every paragraph
// boundary is lost. This walk inserts hard paragraph breaks at block
// boundaries instead. Structural duck-typing (nodeType/nodeName/childNodes)
// keeps it testable outside a real DOM.

export interface ReadableNode {
  nodeType: number;
  nodeName: string;
  nodeValue?: string | null;
  childNodes: ArrayLike<ReadableNode>;
  getAttribute?(name: string): string | null;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** Elements rendered as blocks: their edges become paragraph breaks. */
const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'DD',
  'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER',
  'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI',
  'MAIN', 'NAV', 'OL', 'P', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY',
  'TFOOT', 'THEAD', 'TR', 'UL',
]);

/** Elements whose text is never speakable. SUP is citation markers ([1]) in
 *  practice — production read-aloud tools silently skip them. */
const SKIP = new Set([
  'AUDIO', 'BUTTON', 'CANVAS', 'EMBED', 'IFRAME', 'INPUT', 'MATH', 'NOSCRIPT',
  'OBJECT', 'SCRIPT', 'SELECT', 'STYLE', 'SUP', 'SVG', 'TEMPLATE', 'TEXTAREA',
  'VIDEO',
]);

export function serializeReadable(root: ReadableNode): string {
  let out = '';
  const walk = (node: ReadableNode): void => {
    if (node.nodeType === TEXT_NODE) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const name = node.nodeName.toUpperCase();
    if (SKIP.has(name)) return;
    if (node.getAttribute?.('aria-hidden') === 'true') return;
    if (name === 'BR') {
      out += '\n';
      return;
    }
    if (name === 'PRE') {
      // Reading source code aloud verbatim is noise; announce and move on.
      out += '\n\nCode block omitted.\n\n';
      return;
    }
    const block = BLOCK.has(name);
    if (block) out += '\n\n';
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    if (block) out += '\n\n';
    else if (name === 'TD' || name === 'TH') out += ' ';
  };
  walk(root);
  return out;
}
