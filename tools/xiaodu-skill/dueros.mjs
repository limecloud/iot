import { X509Certificate, verify } from 'node:crypto';

const certificates = new Map();
const certificateLimit = 64 * 1024;

export function validateCertificateUrl(value) {
  if (typeof value !== 'string' || value.length > 2048
    || !/^https:\/\/duer\.bdstatic\.com(?::443)?\/saiya\/flow\//.test(value)
    || /[?#]/.test(value)) throw new Error('invalid_certificate_url');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'duer.bdstatic.com'
    || (url.port && url.port !== '443') || url.username || url.password
    || url.search || url.hash || !url.pathname.startsWith('/saiya/flow/')
    || /[\\\s]/.test(value) || /%2f|%5c/i.test(url.pathname)) {
    throw new Error('invalid_certificate_url');
  }
  return url;
}

export function verifySignatureWithCertificate({ body, signature, certificate, now = Date.now() }) {
  if (!Buffer.isBuffer(body) || typeof signature !== 'string' || signature.length > 8192
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length % 4 !== 0) {
    throw new Error('invalid_signature');
  }
  const pem = Buffer.isBuffer(certificate) ? certificate.toString('utf8') : certificate;
  if (typeof pem !== 'string' || Buffer.byteLength(pem) > certificateLimit) {
    throw new Error('invalid_certificate');
  }
  // 百度可能返回叶证书与中间证书组成的 PEM bundle；首张是请求签名证书。
  const blocks = [...pem.matchAll(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g)].map(match => match[0]);
  if (!blocks.length || blocks.length > 8
    || pem.replace(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g, '').trim()) {
    throw new Error('invalid_certificate');
  }
  const [x509] = blocks.map(block => new X509Certificate(block));
  if (!(Date.parse(x509.validFrom) <= now && now < Date.parse(x509.validTo))) {
    throw new Error('certificate_outside_validity');
  }
  if (x509.checkHost('dueros-api.baidu.com', { subject: 'never', wildcards: false }) !== 'dueros-api.baidu.com') {
    throw new Error('certificate_identity_mismatch');
  }
  return verify('RSA-SHA1', body, x509.publicKey, Buffer.from(signature, 'base64'));
}

async function downloadCertificate(url) {
  const cached = certificates.get(url.href);
  if (cached && cached.expires > Date.now()) return cached.pem;
  certificates.delete(url.href);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  if (response.status !== 200 || !response.body) throw new Error('certificate_unavailable');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > certificateLimit)) {
    await response.body.cancel();
    throw new Error('invalid_certificate_size');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > certificateLimit) throw new Error('invalid_certificate_size');
    chunks.push(Buffer.from(chunk));
  }
  const pem = Buffer.concat(chunks);
  // 使用前仍逐次检查证书有效期、SAN 和请求签名。
  while (certificates.size >= 8) certificates.delete(certificates.keys().next().value);
  certificates.set(url.href, { pem, expires: Date.now() + 5 * 60 * 1000 });
  return pem;
}

export async function verifyDuerosRequest({ headers, body }) {
  const signature = headers.signature;
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)
    || signature.length > 8192 || signature.length % 4 !== 0) return false;
  const url = validateCertificateUrl(headers.signaturecerturl);
  const certificate = await downloadCertificate(url);
  return verifySignatureWithCertificate({ body, signature, certificate });
}
