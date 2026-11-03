// 仅用于真实 Broker 边界验证的 MQTT 5 最小客户端，不进入产品运行时。
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

const string = value => { const body = Buffer.from(value); const size = Buffer.alloc(2); size.writeUInt16BE(body.length); return Buffer.concat([size, body]); };
function packet(header, body) {
  const length = []; let size = body.length;
  do { let byte = size % 128; size = Math.floor(size / 128); if (size) byte |= 128; length.push(byte); } while (size);
  return Buffer.concat([Buffer.from([header, ...length]), body]);
}
export async function mqttProbe({ port, username, password, ...options }) {
  const socket = options.ca ? tls.connect({ host: '127.0.0.1', port, ...options }) : net.connect({ host: '127.0.0.1', port });
  let buffer = Buffer.alloc(0), failure, counter = 0, heartbeat;
  const messages = [], pending = [];
  const fail = error => { clearInterval(heartbeat); failure = error; for (const request of pending.splice(0)) { clearTimeout(request.timer); request.reject(error); } };
  socket.on('error', fail);
  socket.on('close', () => fail(failure ?? new Error('mqtt_connection_closed')));
  socket.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 2) {
      let size = 0, multiplier = 1, offset = 1, byte;
      do { if (offset >= buffer.length) return; byte = buffer[offset++]; size += (byte & 127) * multiplier; multiplier *= 128; } while (byte & 128);
      if (buffer.length < offset + size) return;
      const message = { type: buffer[0] >> 4, body: buffer.subarray(offset, offset + size) };
      buffer = buffer.subarray(offset + size);
      const index = pending.findIndex(request => request.type === message.type);
      if (index < 0) messages.push(message);
      else { const request = pending.splice(index, 1)[0]; clearTimeout(request.timer); request.resolve(message.body); }
    }
  });
  const next = (type, timeout = 3000) => new Promise((resolve, reject) => {
    const index = messages.findIndex(message => message.type === type);
    if (index >= 0) return resolve(messages.splice(index, 1)[0].body);
    if (failure) return reject(failure);
    const request = { type, resolve, reject };
    request.timer = setTimeout(() => { const index = pending.indexOf(request); if (index >= 0) pending.splice(index, 1); reject(new Error('mqtt_packet_timeout')); }, timeout);
    pending.push(request);
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('mqtt_connect_timeout')); socket.destroy(); }, 3000);
      socket.once(options.ca ? 'secureConnect' : 'connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const flags = 2 | (username ? 128 : 0) | (password ? 64 : 0);
    socket.write(packet(0x10, Buffer.concat([string('MQTT'), Buffer.from([5, flags, 0, 10, 0]), string(randomUUID()), ...(username ? [string(username)] : []), ...(password ? [string(password)] : [])])));
    const connack = await next(2);
    if (connack[1] !== 0) throw new Error(`mqtt_connack_${connack[1]}`);
  } catch (error) { socket.destroy(); throw error; }
  // CONNECT声明10秒保活；长浏览器旅程也必须持续核对Broker响应。
  heartbeat = setInterval(() => {
    const response = next(13);
    socket.write(Buffer.from([0xc0, 0]));
    void response.then(body => { if (body.length !== 0) throw new Error('mqtt_invalid_ping_response'); }).catch(error => { fail(error); socket.destroy(); });
  }, 5000);
  heartbeat.unref();
  return {
    close() { clearInterval(heartbeat); socket.destroy(); },
    async publish(topic, value = '{}') {
      const id = ++counter, bytes = Buffer.from([id >> 8, id & 255, 0]);
      socket.write(packet(0x32, Buffer.concat([string(topic), bytes, Buffer.from(value)])));
      const response = await next(4);
      if (response.readUInt16BE(0) !== id) throw new Error('mqtt_ack_mismatch');
      return response.length > 2 ? response[2] : 0;
    },
    async subscribe(topic) {
      const id = ++counter;
      socket.write(packet(0x82, Buffer.concat([Buffer.from([id >> 8, id & 255, 0]), string(topic), Buffer.from([0])])));
      return next(9);
    },
    async message(timeout = 3000) {
      const message = await next(3, timeout), size = message.readUInt16BE(0);
      return { topic: message.subarray(2, size + 2).toString(), payload: message.subarray(size + 3).toString() };
    },
  };
}
