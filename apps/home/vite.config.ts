import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// 将确切的构建资源写入 SW，升级只替换本站静态外壳。
export default defineConfig({
  plugins: [{
    name: 'home-offline-shell',
    enforce: 'post',
    generateBundle: { order: 'post', handler(_options, bundle) {
      const publicFiles = ['/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/manifest.webmanifest', '/platform.json', '/brand/mark-teal.svg'];
      const assets = ['/', ...publicFiles, ...Object.keys(bundle).filter(name => name.startsWith('assets/')).map(name => `/${name}`)];
      const digest = createHash('sha256').update(JSON.stringify(bundle));
      for (const name of publicFiles) digest.update(readFileSync(new URL(`./public${name}`, import.meta.url)));
      const revision = digest.digest('hex').slice(0, 16);
      const template = readFileSync(new URL('./src/service-worker.template.js', import.meta.url), 'utf8');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: template.replace('__ASSETS__', JSON.stringify(assets)).replace('__REVISION__', revision) });
    } },
  }],
});
