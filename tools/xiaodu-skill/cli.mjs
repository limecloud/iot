import { readFile, stat } from 'node:fs/promises';
import { createChatProvider } from './provider.mjs';
import { createSkillServer } from './server.mjs';
import { validateCertificateUrl, verifyDuerosRequest } from './dueros.mjs';

// 仅显式读取实验配置，不从仓库或其他会话猜测凭据。
const [configPath, ...extra] = process.argv.slice(2);
if (!configPath || extra.length) {
  console.error('用法：node tools/xiaodu-skill/cli.mjs <本机私有配置.json>');
  process.exit(2);
}

try {
  const metadata = await stat(configPath);
  if (!metadata.isFile() || metadata.size > 16384
      || (process.platform !== 'win32' && (metadata.mode & 0o077))) {
    throw new Error('configuration_must_be_private_file');
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const host = config.host ?? '127.0.0.1';
  const port = config.port ?? 18765;
  if (typeof config.applicationId !== 'string' || !config.applicationId.trim()
      || !['127.0.0.1', '::1'].includes(host)
      || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('invalid_skill_configuration');
  }
  const reply = createChatProvider(config.provider ?? {});
  const server = createSkillServer({ applicationId: config.applicationId, reply,
    deferredReplies: config.deferredReplies ?? false,
    verifyRequest: async request => {
      try {
        const verified = await verifyDuerosRequest(request);
        if (!verified) console.error(JSON.stringify({ event: 'xiaodu_signature_rejected', reason: 'signature_mismatch_or_missing' }));
        return verified;
      } catch (error) {
        const known = ['invalid_certificate_url', 'invalid_signature', 'invalid_certificate',
          'certificate_unavailable', 'invalid_certificate_size', 'certificate_outside_validity',
          'certificate_identity_mismatch'];
        let certificateUrl;
        try { certificateUrl = validateCertificateUrl(request.headers.signaturecerturl).href; } catch {}
        console.error(JSON.stringify({ event: 'xiaodu_signature_rejected', certificateUrl,
          reason: known.includes(error.message) ? error.message : 'certificate_verification_failed' }));
        return false;
      }
    },
  });
  // 只记录链路状态，不记录语音文字、身份、签名或密钥。
  let requestSequence = 0;
  server.on('request', (request, response) => {
    const started = performance.now();
    const metadata = {
      sequence: ++requestSequence,
      method: ['GET', 'HEAD', 'POST'].includes(request.method) ? request.method : 'OTHER',
      path: ['/dueros', '/healthz'].includes(request.url) ? request.url : 'other',
    };
    console.log(JSON.stringify({ event: 'xiaodu_skill_http_received', at: new Date().toISOString(), ...metadata }));
    response.once('finish', () => console.log(JSON.stringify({
      event: 'xiaodu_skill_http', at: new Date().toISOString(), ...metadata,
      status: response.statusCode,
      durationMs: Math.round(performance.now() - started),
    })));
    response.once('close', () => {
      if (!response.writableFinished) console.log(JSON.stringify({
        event: 'xiaodu_skill_http_interrupted', at: new Date().toISOString(), ...metadata,
        durationMs: Math.round(performance.now() - started),
      }));
    });
  });
  // 公网HTTPS由操作者部署的反向代理终止；进程只接受回环连接。
  server.listen(port, host, () => console.log(JSON.stringify({
    event: 'xiaodu_skill_listening',
    endpoint: `http://${host === '::1' ? '[::1]' : host}:${port}/dueros`,
    publicHttpsRequired: true,
    microphoneVerified: false,
  })));
  server.on('error', error => {
    console.error(JSON.stringify({ error: error.code ?? 'skill_listen_failed' }));
    process.exitCode = 1;
  });
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 1500).unref();
  });
} catch (error) {
  // 不回显配置解析错误正文，避免格式错误时泄露密钥所在行。
  console.error(JSON.stringify({ error: error instanceof SyntaxError ? 'invalid_configuration_json'
    : ['configuration_must_be_private_file', 'invalid_skill_configuration', 'invalid_provider_url',
      'invalid_provider_configuration'].includes(error.message) ? error.message : 'skill_start_failed' }));
  process.exitCode = 1;
}
