import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
// 仅回环HTTP渲染器。音频拉取与协议受理分别记录，不模拟物理声音。
export async function rendererFixture(database,{expectedMedia}={}) {
  const effects=[],proofs=[],pulls=[],renderedPulls=[],descriptions=[];let uri='',fault='',identity='uuid:software-speaker';
  const media=createServer((req,res)=>{
    pulls.push({url:req.url,range:req.headers.range});
    const wav=Buffer.alloc(46);wav.write('RIFF');wav.writeUInt32LE(38,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(2,40);
    res.writeHead(206,{'Content-Type':'audio/wav','Content-Length':wav.length,'Accept-Ranges':'bytes','Content-Range':`bytes 0-${wav.length-1}/${wav.length}`});res.end(wav);
  });
  await new Promise(resolve=>media.listen(0,'127.0.0.1',resolve));
  const server=createServer(async(req,res)=>{
    try {
      if(req.method==='GET') {
        descriptions.push(req.url);res.setHeader('Content-Type','text/xml');res.end(`<root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><UDN>${identity}</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/render</controlURL></service></serviceList></device></root>`);return;
      }
      let body='';for await(const chunk of req)body+=chunk;
      const action=req.headers.soapaction?.split('#')[1]?.replaceAll('"','');assert(['SetVolume','SetAVTransportURI','Play','Stop'].includes(action));
      // 每项业务请求都从真实SQLite重新读取已提交快照；不为每个SOAP启动解释器。
      const db=new DatabaseSync(database,{readOnly:true});let snapshot;
      try{snapshot=db.prepare('SELECT version,body FROM snapshot WHERE id=1').get();}finally{db.close();}
      const data=JSON.parse(snapshot.body),commands=Object.values(data.commands).filter(c=>c.status==='dispatched'&&c.execution_route);assert.equal(commands.length,1);
      const command=commands[0],proof={version:snapshot.version,command,binding:data.execution_registry.bindings[command.request.device_id]};assert.equal(proof.command.status,'dispatched');proofs.push(proof);effects.push({action,body,command_id:proof.command.command_id});
      if(action==='SetAVTransportURI')uri=body.match(/<CurrentURI>(.*?)<\/CurrentURI>/s)[1].replaceAll('&amp;','&');
      if(action==='Play') {const response=await fetch(uri,{headers:{Range:'bytes=0-'},signal:AbortSignal.timeout(2000)});assert.equal(response.status,206);const bytes=Buffer.from(await response.arrayBuffer());if(expectedMedia)assert.deepEqual(bytes,expectedMedia);else assert.equal(bytes.byteLength,46);renderedPulls.push({status:response.status,byte_length:bytes.length});}
      if(action==='Play'&&fault==='drop-play'){req.socket.destroy();return;}
      const service=action==='SetVolume'?'RenderingControl':'AVTransport';
      res.setHeader('Content-Type','text/xml');res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1"/></s:Body></s:Envelope>`);
    }catch(error){effects.push({error:error.stack});res.statusCode=500;res.end('fixture_failed');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={schema_version:1,target:`127.0.0.1:${server.address().port}`,description_path:'/description.xml',av_transport_path:'/av',rendering_control_path:'/render',udn:identity,playback_volume:10,volume_limit:20,media:[{media_id:'chime',url:`http://127.0.0.1:${media.address().port}/chime.wav`,expires_at:new Date(Date.now()+300_000).toISOString()}],timeout_ms:3000};
  return {config,effects,proofs,pulls,renderedPulls,descriptions,setExpectedMedia(value){assert.ok(Buffer.isBuffer(value));expectedMedia=Buffer.from(value);},setFault(value){fault=value;},setIdentity(value){identity=value;},setDatabase(value){database=value;},async close(){await Promise.all([server,media].map(s=>new Promise(resolve=>{s.closeAllConnections();s.close(resolve);})));}};
}
