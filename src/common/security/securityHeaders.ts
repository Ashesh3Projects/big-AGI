type SecurityHeader = { key: string; value: string };


const FIREBASE_AND_GOOGLE_CONNECT_SOURCES = [
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
  'https://firestore.googleapis.com',
  'https://firebasestorage.googleapis.com',
  'https://storage.googleapis.com',
  'https://content-firebaseappcheck.googleapis.com',
  'https://recaptchaenterprise.googleapis.com',
  'https://www.googleapis.com',
  'https://accounts.google.com',
  'https://www.google.com',
  'https://www.recaptcha.net',
];

const AI_PROVIDER_CONNECT_SOURCES = [
  'https:',
  'wss:',
  'https://api.openai.com',
  'https://api.anthropic.com',
  'https://api.deepgram.com',
  'https://generativelanguage.googleapis.com',
  'https://api.groq.com',
  'https://api.mistral.ai',
  'https://api.deepseek.com',
  'https://api.cerebras.ai',
  'https://api.cohere.ai',
  'https://api.together.xyz',
  'https://api.perplexity.ai',
  'https://api.x.ai',
  'https://api.z.ai',
  'https://openrouter.ai',
  'https://dashscope-intl.aliyuncs.com',
  'https://api.moonshot.ai',
  'https://api.kimi.com',
  'https://integrate.api.nvidia.com',
  'https://gateway.ai.cloudflare.com',
  'https://api.modular.com',
  'https://api.sakana.ai',
  'https://llm.chutes.ai',
  'https://api.fireworks.ai',
  'https://api.llmapi.ai',
  'https://api.minimax.io',
  'https://api.novita.ai',
  'https://*.openai.azure.com',
  'https://*.amazonaws.com',
  'https://*.api.aws',
  'http://localhost:*',
  'http://127.0.0.1:*',
];

const PRIVATE_PRO_PERMISSIONS_POLICY = [
  'accelerometer=()',
  'ambient-light-sensor=()',
  'autoplay=(self)',
  'camera=(self)',
  'display-capture=(self)',
  'encrypted-media=(self)',
  'fullscreen=(self)',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=(self)',
  'midi=(self)',
  'payment=()',
  'picture-in-picture=(self)',
  'publickey-credentials-get=(self)',
  'screen-wake-lock=(self)',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');


export function privateProContentSecurityPolicy(): string {
  const directives = [
    `default-src 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `form-action 'self' https://accounts.google.com`,
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://apis.google.com https://accounts.google.com https://www.gstatic.com https://www.google.com https://www.recaptcha.net`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' data: https://fonts.gstatic.com`,
    `img-src 'self' data: blob: https:`,
    `media-src 'self' data: blob: https:`,
    `connect-src 'self' ${[...FIREBASE_AND_GOOGLE_CONNECT_SOURCES, ...AI_PROVIDER_CONNECT_SOURCES].join(' ')}`,
    `frame-src 'self' https://accounts.google.com https://*.firebaseapp.com https://www.google.com https://www.recaptcha.net`,
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    `upgrade-insecure-requests`,
  ];

  return directives.join('; ');
}

export function privateProSecurityHeaders(): SecurityHeader[] {
  return [
    { key: 'Content-Security-Policy', value: privateProContentSecurityPolicy() },
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    // Preserve only the origin on cross-origin Firebase calls so HTTP-referrer API-key restrictions work without path or query leakage.
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: PRIVATE_PRO_PERMISSIONS_POLICY },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
    { key: 'Access-Control-Allow-Origin', value: 'https://chatgpt.ashesh.dev' },
  ];
}
