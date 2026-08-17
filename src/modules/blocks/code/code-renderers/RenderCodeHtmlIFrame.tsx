import * as React from 'react';


export function htmlSandboxPolicy(): string {
  return 'allow-scripts allow-forms';
}


const simpleCssReset = `
*, *::before, *::after { box-sizing: border-box; }
body, html { margin: 0; padding: 0; }
body { min-height: 100vh; line-height: 1.5; -webkit-font-smoothing: antialiased; }
img, picture, svg, video { display: block;max-width: 100%; }
`;

export const blocksRenderHTMLIFrameCss: React.CSSProperties = {
  flexGrow: 1,
  width: '100%',
  height: '54svh',
  border: 'none',
  boxSizing: 'border-box',
  maxWidth: '100%',
  maxHeight: '100%',
} as const;

const blocksRenderHTMLIFrameFullScreenCss: React.CSSProperties = {
  ...blocksRenderHTMLIFrameCss,
  height: undefined,
  flex: 1,
} as const;


function _renderHtmlInIFrame(iframeDoc: Document, htmlString: string) {
  // Note: not using this for now (2024-06-15), or it would remove the JS code
  // which is what makes the HTML interactive.
  // Sanitize the HTML string to remove any potentially harmful content
  // const sanitizedHtml = DOMPurify.sanitize(props.htmlString);

  // Inject the CSS reset
  const modifiedHtml = htmlString.replace(/<style/i, `<style>${simpleCssReset}</style><style`);

  // Write the HTML to the iframe
  iframeDoc.open();
  try {
    const meta = iframeDoc.createElement('meta');
    meta.httpEquiv = 'Content-Security-Policy';
    meta.content = "default-src 'none'; img-src data: blob: https:; media-src data: blob: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src https:; form-action 'none'; base-uri 'none'";
    iframeDoc.head.appendChild(meta);
    iframeDoc.write(modifiedHtml);
  } catch (error) {
    console.error('Error writing to iframe:', error);
  }
  iframeDoc.close();

  // Adding this event listener to prevent arrow keys from scrolling the parent page
  iframeDoc.addEventListener('keydown', (event: any) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
    }
  });
}

export function RenderCodeHtmlIFrame(props: { htmlCode: string, isFullscreen?: boolean }) {

  // state
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const firstRender = React.useRef(true);

  React.useEffect(() => {
    if (!props.htmlCode)
      return;

    // Immediately render the first time, but delay subsequent renders
    const delay = firstRender.current ? 0 : 200;
    firstRender.current = false;

    // Coalesce the rendering of the HTML content to prevent flickering and work around the React StrictMode
    const timeoutId = setTimeout(() => {
      const iframeDoc = iframeRef.current?.contentWindow?.document;
      iframeDoc && !!props.htmlCode && _renderHtmlInIFrame(iframeDoc, props.htmlCode);
    }, delay);

    return () => clearTimeout(timeoutId);
  }, [props.htmlCode]);

  return (
    <iframe
      ref={iframeRef}
      style={props.isFullscreen ? blocksRenderHTMLIFrameFullScreenCss : blocksRenderHTMLIFrameCss}
      title='Sandboxed Web Content'
      aria-label='Interactive content frame'
      sandbox={htmlSandboxPolicy()}
      loading='lazy' // do not load until visible in the viewport
    />
  );
}
