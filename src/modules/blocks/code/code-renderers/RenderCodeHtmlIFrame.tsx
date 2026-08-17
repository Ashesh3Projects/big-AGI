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

const htmlContentSecurityPolicy = "default-src 'none'; img-src data: blob: https:; media-src data: blob: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src https:; form-action 'none'; base-uri 'none'";

export function buildSandboxedHtmlDocument(html: string): string {
  return `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${htmlContentSecurityPolicy}">
<style>${simpleCssReset}</style>
</head>
<body>${html}</body>
</html>`;
}

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


export function RenderCodeHtmlIFrame(props: { htmlCode: string, isFullscreen?: boolean }) {

  return (
    <iframe
      style={props.isFullscreen ? blocksRenderHTMLIFrameFullScreenCss : blocksRenderHTMLIFrameCss}
      title='Sandboxed Web Content'
      aria-label='Interactive content frame'
      sandbox={htmlSandboxPolicy()}
      srcDoc={buildSandboxedHtmlDocument(props.htmlCode)}
      loading='lazy' // do not load until visible in the viewport
    />
  );
}
