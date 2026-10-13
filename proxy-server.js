import cors from 'cors';
import express from 'express';
import mammoth from 'mammoth';
import multer from 'multer';
import { PDFParse } from 'pdf-parse';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const app = express();
const port = Number.parseInt(process.env.RESUME_PROXY_PORT || process.env.PORT || '3002', 10);
const upstreamUrl = process.env.ARK_API_URL || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
// Long resume analysis can take over 90 seconds. Keep a five-minute floor.
const configuredTimeoutMs = Number.parseInt(process.env.ARK_TIMEOUT_MS || '', 10);
const timeoutMs = Number.isFinite(configuredTimeoutMs)
  ? Math.max(300_000, configuredTimeoutMs)
  : 300_000;
const maxUploadBytes = 10 * 1024 * 1024;
const maxExtractedChars = 100_000;
const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes, files: 1 },
});
const allowedOrigins = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...(process.env.CORS_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean),
]);

const corsOptions = {
  origin(origin, callback) {
    // Requests from curl/server-side clients have no Origin and do not need CORS headers.
    callback(null, !origin || allowedOrigins.has(origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-ark-api-key', 'x-ark-endpoint'],
  maxAge: 600,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

function sendError(res, status, code, message, details) {
  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
}

function getNetworkErrorChain(error, apiKey) {
  const chain = [];
  const seen = new Set();
  for (let current = error; current && chain.length < 6 && !seen.has(current); current = current.cause) {
    seen.add(current);
    let message = String(current.message || 'Unknown error');
    if (apiKey) message = message.split(apiKey).join('[REDACTED]');
    message = message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
    chain.push({
      name: current.name || 'Error',
      ...(current.code ? { code: current.code } : {}),
      ...(current.syscall ? { syscall: current.syscall } : {}),
      ...(current.hostname ? { hostname: current.hostname } : {}),
      ...(current.address ? { address: current.address } : {}),
      ...(current.port ? { port: current.port } : {}),
      message,
    });
  }
  return chain;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'resume-expert-ark-proxy',
    port,
  });
});

// Parse uploaded resumes locally; files are kept in memory only and are never forwarded to Ark.
app.post('/api/extract', resumeUpload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return sendError(res, 400, 'FILE_REQUIRED', '没有收到简历文件，请重新选择 DOCX 或 PDF 文件。');
  }

  const extension = extname(file.originalname).toLowerCase();
  if (!['.docx', '.pdf'].includes(extension)) {
    return sendError(res, 415, 'UNSUPPORTED_FILE_TYPE', '仅支持 DOCX 和 PDF 文件。');
  }

  let extractedText = '';
  try {
    if (extension === '.docx') {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      extractedText = result.value || '';
    } else {
      const parser = new PDFParse({ data: new Uint8Array(file.buffer) });
      try {
        const result = await parser.getText();
        extractedText = result.text || '';
      } finally {
        await parser.destroy();
      }
    }
  } catch (error) {
    console.error(`Resume extraction failed (${extension}):`, error.message);
    return sendError(res, 422, 'DOCUMENT_PARSE_FAILED', '无法解析该文件。请确认文件未损坏、未加密；扫描版 PDF 需要 OCR，或直接粘贴简历文字。');
  }

  extractedText = extractedText.replace(/\u0000/g, '').trim();
  if (!extractedText) {
    return sendError(res, 422, 'DOCUMENT_TEXT_EMPTY', '文件中没有提取到可复制的文字。扫描版 PDF 需要 OCR，或直接粘贴简历文字。');
  }

  const truncated = extractedText.length > maxExtractedChars;
  const text = truncated ? extractedText.slice(0, maxExtractedChars) : extractedText;
  return res.json({
    fileName: basename(file.originalname),
    text,
    charCount: text.length,
    truncated,
  });
});

app.post('/api/chat', async (req, res) => {
  const apiKey = typeof req.headers['x-ark-api-key'] === 'string'
    ? req.headers['x-ark-api-key'].trim()
    : '';
  if (!apiKey) {
    return sendError(res, 400, 'ARK_API_KEY_REQUIRED', '请求头缺少 x-ark-api-key。请在网页 API 配置中填写 ARK_API_KEY。');
  }

  const request = req.body || {};
  const model = typeof req.headers['x-ark-endpoint'] === 'string'
    ? req.headers['x-ark-endpoint'].trim()
    : '';
  if (!model) {
    return sendError(res, 400, 'ENDPOINT_REQUIRED', '请求头缺少 x-ark-endpoint。请在网页 API 配置中填写 Endpoint ID。');
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return sendError(res, 400, 'MESSAGES_REQUIRED', 'messages 必须是非空数组。');
  }
  if (!request.messages.every(message => message && typeof message === 'object' && typeof message.role === 'string' && typeof message.content === 'string')) {
    return sendError(res, 400, 'INVALID_MESSAGES', '每条 message 都需要包含字符串 role 和 content。');
  }

  const upstreamBody = {
    model,
    messages: request.messages,
  };
  for (const field of ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stream', 'stream_options', 'stop', 'presence_penalty', 'frequency_penalty']) {
    if (request[field] !== undefined) upstreamBody[field] = request[field];
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  const proxyEnvironment = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    .filter(name => Boolean(process.env[name]));
  let upstreamTarget;
  try {
    const target = new URL(upstreamUrl);
    upstreamTarget = { host: target.host, path: target.pathname };
  } catch {
    upstreamTarget = { host: '[invalid URL]', path: '' };
  }
  console.info('[ARK_PROXY] Sending upstream request', {
    method: 'POST',
    ...upstreamTarget,
    model,
    messageCount: request.messages.length,
    timeoutMs,
    proxyEnvironment,
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  req.on('aborted', () => controller.abort());
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: request.stream === true ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
    console.info('[ARK_PROXY] Upstream responded', {
      status: upstream.status,
      requestId: upstream.headers.get('x-request-id') || undefined,
      elapsedMs: Date.now() - startedAt,
    });

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const requestId = upstream.headers.get('x-request-id');
    if (requestId) res.setHeader('x-request-id', requestId);

    if (request.stream === true) {
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      if (!contentType) res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      if (!upstream.body) return res.end();
      await pipeline(Readable.fromWeb(upstream.body), res);
      return;
    }

    // Forward the upstream payload bytes unchanged, including error bodies and status codes.
    const payload = Buffer.from(await upstream.arrayBuffer());
    return res.end(payload);
  } catch (error) {
    if (res.destroyed || req.aborted) return;
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    if (timedOut || error.name === 'TimeoutError' || error.name === 'AbortError') {
      return sendError(res, 504, 'UPSTREAM_TIMEOUT', `火山方舟请求超过 ${timeoutMs}ms。`);
    }
    const errorChain = getNetworkErrorChain(error, apiKey);
    const detail = errorChain.map(item => [item.code, item.message].filter(Boolean).join(': ')).join(' <- ');
    console.error('[ARK_PROXY] Upstream request failed', {
      ...upstreamTarget,
      model,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
      proxyEnvironment,
      errorChain,
    });
    return sendError(
      res,
      502,
      'PROXY_ERROR',
      detail ? `代理无法连接火山方舟上游服务：${detail}` : '代理无法连接火山方舟上游服务。',
      errorChain,
    );
  } finally {
    clearTimeout(timeout);
  }
});

app.use((error, _req, res, _next) => {
  if (res.headersSent) return res.end();
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return sendError(res, 413, 'FILE_TOO_LARGE', '文件超过 10MB 限制。');
    }
    return sendError(res, 400, 'UPLOAD_INVALID', '文件上传失败，请重新选择后再试。');
  }
  if (error.type === 'entity.too.large') {
    return sendError(res, 413, 'REQUEST_TOO_LARGE', '请求体超过 2MB 限制。');
  }
  if (error instanceof SyntaxError && Object.prototype.hasOwnProperty.call(error, 'body')) {
    return sendError(res, 400, 'INVALID_JSON', '请求体不是有效 JSON。');
  }
  console.error('Proxy request failed:', error);
  return sendError(res, 500, 'PROXY_ERROR', '代理处理请求失败。', error.message);
});

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Ark proxy listening at http://127.0.0.1:${port}`);
  console.log(`Allowed browser origins: ${[...allowedOrigins].join(', ')}`);
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Proxy port ${port} is already in use. Stop the other process or choose a different port.`);
  } else {
    console.error('Unable to start the local Ark proxy:', error.message);
  }
  process.exitCode = 1;
});
