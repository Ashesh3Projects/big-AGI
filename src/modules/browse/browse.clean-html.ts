import { load as cheerioLoad } from 'cheerio';


export function cleanHtml(html: string): string {
  try {
    const _C = cheerioLoad(html);

    // 1. --unwanted elements
    const unwantedSelectors = [
      // core unwanted
      'script', 'style', 'link', 'noscript', 'iframe', 'svg', 'canvas',

      // navigation and structural elements
      'nav:not(main nav)', 'aside', 'footer:not(article footer)',

      // common web clutter
      '.ad, .ads, .advertisement, .banner, .popup, .modal, .overlay',
      '.cookie-banner, .newsletter-signup, .social-share, .comments',
      '.sidebar, .widget, .carousel, .slider',

      // hidden elements
      '[aria-hidden="true"]',
      '[hidden]',
      '[style*="display: none"]',
      '[style*="visibility: hidden"]',

      // tracking and analytics
      '[data-analytics]',
      '[data-tracking]',
      '[data-gtm]',

      // meta elements except essential ones
      'meta:not([charset], [name="viewport"], [name="description"])',
    ].join(', ');
    _C(unwantedSelectors).remove();

    // 2. --unwanted attributes tag-specific
    const tagSpecificAttrs: Record<string, string[]> = {
      a: ['href', 'title', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      video: ['src', 'controls', 'width', 'height'],
      audio: ['src', 'controls'],
      source: ['src', 'type'],
      meta: ['charset', 'name', 'content', 'viewport'],
      time: ['datetime'],
      input: ['type', 'name', 'value', 'checked', 'disabled'],
      button: ['type', 'disabled'],
      th: ['scope', 'colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
      table: ['summary'],
      figure: ['role'],
      figcaption: [],
    };
    const commonAttrs = ['id', 'lang'];
    _C('*').each(function() {
      const el = _C(this);
      if (!('tagName' in this)) return;
      const tagName = this.tagName?.toLowerCase() || '';

      // Get allowed attributes for this tag
      const allowedAttrs = new Set([
        ...(tagSpecificAttrs[tagName] || []),
        ...commonAttrs,
      ]);

      // -all non-allowed attributes
      const attribs = Object.keys(this.attribs || {});
      attribs.forEach(attr => {
        if (!allowedAttrs.has(attr.toLowerCase()))
          el.removeAttr(attr);
      });

      // cleanup href attributes on anchors
      if (tagName === 'a') {
        const href = el.attr('href');
        if (href) {
          // -javascript: links
          if (href.toLowerCase().startsWith('javascript:'))
            el.removeAttr('href');
          // -tracking parameters
          else if (href.includes('?')) {
            try {
              const url = new URL(href);
              const cleanParams = new URLSearchParams();
              url.searchParams.forEach((value, key) => {
                // keep only essential query parameters
                if (!key.match(/^(utm_|fbclid|gclid|msclkid)/i))
                  cleanParams.append(key, value);
              });
              const cleanHref = `${url.origin}${url.pathname}${
                cleanParams.toString() ? '?' + cleanParams.toString() : ''
              }${url.hash}`;
              el.attr('href', cleanHref);
            } catch (e) {
              // If URL parsing fails, keep original href
            }
          }
        }
      }
    });

    // 3. --comments
    _C('*').contents().filter(function() {
      return this.type === 'comment';
    }).remove();

    // 4. --empty element
    const preserveTags = new Set([
      'img', 'br', 'hr', 'input', 'source', 'meta', 'link',
      'area', 'base', 'col', 'embed', 'param', 'track', 'wbr',
    ]);
    _C('*').each(function() {
      const $el = _C(this);
      if (!('tagName' in this)) return;
      const tagName = this.tagName?.toLowerCase() || '';
      const hasContent =
        $el.text().trim() ||
        $el.find('img, video, audio, iframe, canvas, svg').length ||
        preserveTags.has(tagName) ||
        (tagName === 'a' && $el.attr('href'));

      if (!hasContent && !$el.children().length)
        $el.remove();
    });

    // 5. simplify nested structure
    _C('div > div:only-child, section > section:only-child').each(function() {
      const $parent = _C(this).parent();
      if ($parent.children().length === 1)
        $parent.replaceWith(_C(this));
    });

    // 6. div to paragraph conversion
    _C('div').each(function() {
      const $div = _C(this);
      const hasBlockElements = $div.children('div, p, section, article, aside, header, footer, nav').length > 0;
      if (!hasBlockElements && $div.text().trim())
        $div.replaceWith(`<p>${$div.html()}</p>`);
    });

    // 7. clean up whitespace
    _C('*').each(function() {
      if (this.type === 'text') {
        const text = _C(this).text().trim().replace(/\s+/g, ' ');
        if (text) _C(this).text(text);
      }
    });

    // 8. format final output
    return _C.html()
      .replace(/>\s+</g, '>\n<')
      .replace(/\n\s+/g, '\n')
      .replace(/^\s+|\s+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  } catch (error) {
    console.error('HTML cleaning error:', error);
    return html; // Return original if cleaning fails
  }
}
