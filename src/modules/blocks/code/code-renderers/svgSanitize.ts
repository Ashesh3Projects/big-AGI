type SvgTreeNode = SvgElementNode | string;

interface SvgElementNode {
  name: string;
  attributes: Array<[string, string]>;
  children: SvgTreeNode[];
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

const ALLOWED_ELEMENTS = new Map<string, string>([
  'a', 'circle', 'clipPath', 'defs', 'desc', 'ellipse', 'feBlend', 'feColorMatrix',
  'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
  'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA',
  'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge',
  'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting',
  'feSpotLight', 'feTile', 'feTurbulence', 'filter', 'g', 'image', 'line',
  'linearGradient', 'marker', 'mask', 'path', 'pattern', 'polygon', 'polyline',
  'radialGradient', 'rect', 'stop', 'style', 'svg', 'switch', 'symbol', 'text',
  'textPath', 'title', 'tspan', 'use',
].map((name) => [name.toLowerCase(), name]));

const ALLOWED_ATTRIBUTES = new Map<string, string>([
  'accent-height', 'accumulate', 'additive', 'alignment-baseline', 'amplitude',
  'aria-describedby', 'aria-hidden', 'aria-label', 'aria-labelledby', 'aria-roledescription',
  'azimuth', 'baseFrequency', 'baseline-shift', 'bias', 'by', 'class',
  'clip', 'clip-path', 'clip-rule', 'color', 'color-interpolation',
  'color-interpolation-filters', 'color-profile', 'color-rendering', 'cx', 'cy',
  'd', 'direction', 'display', 'divisor', 'dominant-baseline', 'dx', 'dy',
  'edgeMode', 'elevation', 'enable-background', 'fill', 'fill-opacity', 'fill-rule',
  'filter', 'filterUnits', 'flood-color', 'flood-opacity', 'font-family', 'font-size',
  'font-size-adjust', 'font-stretch', 'font-style', 'font-variant', 'font-weight',
  'fr', 'from', 'fx', 'fy', 'gradientTransform', 'gradientUnits', 'height', 'id',
  'image-rendering', 'in', 'in2', 'intercept', 'k', 'k1', 'k2', 'k3', 'k4',
  'kernelMatrix', 'kernelUnitLength', 'kerning', 'letter-spacing', 'lighting-color',
  'limitingConeAngle', 'marker-end', 'marker-mid', 'marker-start', 'markerHeight',
  'markerUnits', 'markerWidth', 'mask', 'maskContentUnits', 'maskUnits', 'mode',
  'numOctaves', 'offset', 'opacity', 'operator', 'order', 'orient', 'origin',
  'overflow', 'paint-order', 'pathLength', 'patternContentUnits', 'patternTransform',
  'patternUnits', 'pointer-events', 'points', 'pointsAtX', 'pointsAtY', 'pointsAtZ',
  'preserveAlpha', 'preserveAspectRatio', 'primitiveUnits', 'r', 'radius', 'refX',
  'refY', 'result', 'role', 'rotate', 'rx', 'ry', 'scale', 'seed', 'shape-rendering',
  'slope', 'spacing', 'specularConstant', 'specularExponent', 'spreadMethod',
  'startOffset', 'stdDeviation', 'stitchTiles', 'stop-color', 'stop-opacity',
  'stroke', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-width', 'style',
  'surfaceScale', 'systemLanguage', 'tabindex', 'tableValues', 'targetX', 'targetY',
  'text-anchor', 'text-decoration', 'text-rendering', 'textLength', 'to', 'transform',
  'transform-origin', 'type', 'unicode-bidi', 'values', 'vector-effect', 'version',
  'viewBox', 'visibility', 'width', 'word-spacing', 'writing-mode', 'x', 'x1', 'x2',
  'xChannelSelector', 'xml:lang', 'xml:space', 'xmlns', 'xmlns:xlink', 'y', 'y1',
  'y2', 'yChannelSelector', 'z',
].map((name) => [name.toLowerCase(), name]));

const FRAGMENT_REFERENCE_ATTRIBUTES = new Set([
  'clip-path', 'fill', 'filter', 'marker-end', 'marker-mid', 'marker-start', 'mask', 'stroke',
]);

const SAFE_DATA_IMAGE = /^data:image\/(?:gif|jpeg|png|webp);base64,[a-z0-9+/=\s]+$/i;
const LOCAL_FRAGMENT = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;

/**
 * Sanitizes generated SVG before it reaches an HTML injection sink.
 * Browser calls use the native XML DOM parser. Node tests use the strict parser below.
 */
export function sanitizeRenderedSvg(svg: string): string {
  if (typeof svg !== 'string' || !svg.trim())
    throw new Error('SVG input is empty');
  if (/<!DOCTYPE\b/i.test(svg))
    throw new Error('SVG document types are not allowed');

  const root = typeof DOMParser === 'undefined' ? parseXml(svg) : parseBrowserSvg(svg);
  if (root.name !== 'svg')
    throw new Error('Expected an SVG root element');

  const sanitized = sanitizeElement(root, true);
  if (!sanitized)
    throw new Error('Expected a safe SVG root element');
  if (!sanitized.attributes.some(([name]) => name === 'xmlns'))
    sanitized.attributes.unshift(['xmlns', SVG_NAMESPACE]);

  return serializeElement(sanitized);
}

function parseBrowserSvg(svg: string): SvgElementNode {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (document.querySelector('parsererror'))
    throw new Error('Invalid SVG document');

  const root = document.documentElement;
  if (root.localName !== 'svg' || (root.namespaceURI && root.namespaceURI !== SVG_NAMESPACE))
    throw new Error('Expected an SVG root element');
  return domElementToTree(root);
}

function domElementToTree(element: Element): SvgElementNode {
  const children: SvgTreeNode[] = [];
  element.childNodes.forEach((child) => {
    if (child.nodeType === Node.ELEMENT_NODE)
      children.push(domElementToTree(child as Element));
    else if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE)
      children.push(child.nodeValue ?? '');
  });
  return {
    name: element.localName,
    attributes: Array.from(element.attributes, (attribute) => [attribute.name, attribute.value]),
    children,
  };
}

function sanitizeElement(element: SvgElementNode, isRoot = false): SvgElementNode | null {
  const safeName = ALLOWED_ELEMENTS.get(element.name.toLowerCase());
  if (!safeName || (isRoot && safeName !== 'svg')) return null;

  const attributes: Array<[string, string]> = [];
  let hasUnsafeUseReference = false;
  for (const [rawName, rawValue] of element.attributes) {
    const lowerName = rawName.toLowerCase();
    if (lowerName.startsWith('on')) continue;

    if (lowerName === 'href' || lowerName === 'xlink:href') {
      if (LOCAL_FRAGMENT.test(rawValue)) {
        attributes.push([lowerName === 'href' ? 'href' : 'xlink:href', rawValue]);
      } else if ((safeName === 'image' || safeName === 'feImage') && SAFE_DATA_IMAGE.test(rawValue)) {
        attributes.push([lowerName === 'href' ? 'href' : 'xlink:href', rawValue]);
      } else if (safeName === 'use') {
        hasUnsafeUseReference = true;
      }
      continue;
    }

    if (lowerName.startsWith('data-')) {
      attributes.push([lowerName, rawValue]);
      continue;
    }

    const safeAttributeName = ALLOWED_ATTRIBUTES.get(lowerName);
    if (!safeAttributeName || !isSafeAttributeValue(lowerName, rawValue)) continue;
    if (lowerName === 'xmlns' && rawValue !== SVG_NAMESPACE) continue;
    if (lowerName === 'xmlns:xlink' && rawValue !== XLINK_NAMESPACE) continue;
    attributes.push([safeAttributeName, rawValue]);
  }

  if (safeName === 'use' && hasUnsafeUseReference) return null;

  if (safeName === 'style') {
    const css = element.children.filter((child): child is string => typeof child === 'string').join('');
    return isSafeCss(css) ? { name: safeName, attributes, children: [css] } : null;
  }

  const children: SvgTreeNode[] = [];
  for (const child of element.children) {
    if (typeof child === 'string') {
      children.push(child);
      continue;
    }
    const safeChild = sanitizeElement(child);
    if (safeChild) children.push(safeChild);
  }
  return { name: safeName, attributes, children };
}

function isSafeAttributeValue(attributeName: string, value: string): boolean {
  const normalized = decodeCssEscapes(value).replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (/^(?:javascript|vbscript)\s*:/i.test(normalized)) return false;
  if (attributeName === 'style') return isSafeCss(normalized);
  if (/url\s*\(/i.test(normalized))
    return FRAGMENT_REFERENCE_ATTRIBUTES.has(attributeName)
      && /^url\(\s*(['"]?)(#[A-Za-z_][A-Za-z0-9_.:-]*)\1\s*\)$/i.test(normalized);
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(normalized)) return false;
  return !/(?:^|[\s;(])(?:javascript|vbscript)\s*:/i.test(normalized);
}

function isSafeCss(css: string): boolean {
  const normalized = decodeCssEscapes(css).replace(/\/\*[\s\S]*?\*\//g, '');
  return !/(?:u\s*r\s*l|image-set|expression)\s*\(|@\s*(?:import|keyframes)\b|(?:animation(?:-[\w-]+)?|transition(?:-[\w-]+)?|javascript|vbscript|behavior|-moz-binding)\s*:/i.test(normalized);
}

function decodeCssEscapes(value: string): string {
  return value.replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi, (_match, hex: string | undefined, escaped: string | undefined) => {
    if (hex) {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint === 0 || codePoint > 0x10ffff ? '\uFFFD' : String.fromCodePoint(codePoint);
    }
    return escaped ?? '';
  });
}

function serializeElement(element: SvgElementNode): string {
  const attributes = element.attributes
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');
  const children = element.children
    .map((child) => typeof child === 'string' ? escapeText(child) : serializeElement(child))
    .join('');
  return `<${element.name}${attributes}>${children}</${element.name}>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseXml(xml: string): SvgElementNode {
  const roots: SvgElementNode[] = [];
  const stack: SvgElementNode[] = [];
  let cursor = 0;

  const appendText = (text: string) => {
    const decoded = decodeXmlEntities(text);
    if (stack.length) stack[stack.length - 1].children.push(decoded);
    else if (decoded.trim()) throw new Error('Text is not allowed outside the SVG root');
  };

  while (cursor < xml.length) {
    const tagStart = xml.indexOf('<', cursor);
    if (tagStart < 0) {
      appendText(xml.slice(cursor));
      break;
    }
    appendText(xml.slice(cursor, tagStart));

    if (xml.startsWith('<!--', tagStart)) {
      const end = xml.indexOf('-->', tagStart + 4);
      if (end < 0) throw new Error('Invalid SVG comment');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', tagStart)) {
      const end = xml.indexOf('?>', tagStart + 2);
      if (end < 0) throw new Error('Invalid SVG processing instruction');
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith('<![CDATA[', tagStart)) {
      const end = xml.indexOf(']]>', tagStart + 9);
      if (end < 0) throw new Error('Invalid SVG CDATA section');
      appendText(xml.slice(tagStart + 9, end));
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<!', tagStart))
      throw new Error('Unsupported SVG declaration');

    const tagEnd = findTagEnd(xml, tagStart + 1);
    const source = xml.slice(tagStart + 1, tagEnd);
    if (source.startsWith('/')) {
      const closingName = source.slice(1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(closingName)) throw new Error('Invalid SVG closing tag');
      const current = stack.pop();
      if (!current || current.name !== closingName) throw new Error('Mismatched SVG closing tag');
    } else {
      const selfClosing = /\/\s*$/.test(source);
      const element = parseStartTag(selfClosing ? source.replace(/\/\s*$/, '') : source);
      if (stack.length) stack[stack.length - 1].children.push(element);
      else roots.push(element);
      if (!selfClosing) stack.push(element);
    }
    cursor = tagEnd + 1;
  }

  if (stack.length || roots.length !== 1) throw new Error('Invalid SVG document');
  return roots[0];
}

function findTagEnd(xml: string, start: number): number {
  let quote = '';
  for (let index = start; index < xml.length; index++) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  throw new Error('Unterminated SVG tag');
}

function parseStartTag(source: string): SvgElementNode {
  const nameMatch = /^\s*([A-Za-z_][A-Za-z0-9_.:-]*)/.exec(source);
  if (!nameMatch) throw new Error('Invalid SVG start tag');
  const name = nameMatch[1];
  const attributes: Array<[string, string]> = [];
  const seenAttributes = new Set<string>();
  let cursor = nameMatch[0].length;

  while (cursor < source.length) {
    const whitespace = /^\s+/.exec(source.slice(cursor));
    if (!whitespace) throw new Error('Invalid SVG attribute separator');
    cursor += whitespace[0].length;
    if (cursor >= source.length) break;

    const attributeMatch = /^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(["'])/.exec(source.slice(cursor));
    if (!attributeMatch) throw new Error('Invalid SVG attribute');
    const attributeName = attributeMatch[1];
    const quote = attributeMatch[2];
    cursor += attributeMatch[0].length;
    const end = source.indexOf(quote, cursor);
    if (end < 0) throw new Error('Unterminated SVG attribute');
    const lowerName = attributeName.toLowerCase();
    if (seenAttributes.has(lowerName)) throw new Error('Duplicate SVG attribute');
    seenAttributes.add(lowerName);
    attributes.push([attributeName, decodeXmlEntities(source.slice(cursor, end))]);
    cursor = end + 1;
  }

  return { name, attributes, children: [] };
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|apos|gt|lt|quot);/gi, (_match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'apos') return "'";
    if (lower === 'gt') return '>';
    if (lower === 'lt') return '<';
    if (lower === 'quot') return '"';
    const codePoint = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint === 0 || codePoint > 0x10ffff)
      throw new Error('Invalid SVG character reference');
    return String.fromCodePoint(codePoint);
  }).replace(/&[^;\s]+;/g, () => {
    throw new Error('Unsupported SVG entity');
  });
}
