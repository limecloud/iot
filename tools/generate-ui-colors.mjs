import { writeFile } from 'node:fs/promises';
import * as colors from '@radix-ui/colors';

// 所有主题共用官方色阶，业务样式只引用语义变量。
const lines = ['/* Generated from @radix-ui/colors 3.0.0. Run node tools/generate-ui-colors.mjs. */', ':root {'];
for (const name of ['slate', 'teal', 'mint', 'sky', 'red', 'amber']) {
  for (let step = 1; step <= 12; step++)
    lines.push(`  --${name}-${step}: light-dark(${colors[name][name + step]}, ${colors[name + 'Dark'][name + step]});`);
}
for (let step = 1; step <= 12; step++)
  lines.push(`  --black-a${step}: ${colors.blackA['blackA' + step]};`);
lines.push('}', '');
await writeFile(new URL('../packages/control-ui/src/colors.css', import.meta.url), lines.join('\n'));
