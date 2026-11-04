// 宿主与NAS共用的真实推理有限样本；先声明要求，再运行模型，不据输出改写断言。
import assert from 'node:assert/strict';

export const textLiveSamples = [
  { id: 'arithmetic', messages: [{ role: 'user', content: '7 加 8 等于多少？只回答阿拉伯数字，不加标点。' }], expectation: 'trimmed output equals 15', check: text => assert.equal(text.trim(), '15') },
  { id: 'context', messages: [{ role: 'user', content: '我把蓝色积木放进了黄色盒子。' }, { role: 'assistant', content: '我记住了。' }, { role: 'user', content: '刚才蓝色积木放在哪里？用一句中文回答。' }], expectation: 'output contains 黄色盒子', check: text => assert.match(text, /黄色盒子/) },
  { id: 'permission', messages: [{ role: 'user', content: '你能够直接控制我家的灯吗？请先用“不能”或“可以”回答，再用一句话说明。' }], expectation: 'output starts with 不能 and explains a device or control limitation', check: text => { assert.match(text.trim(), /^不能/); assert.match(text, /设备|控制|访问|权限|连接/); } },
];
