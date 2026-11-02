//! 真实 MQTT 5 客户端；虚拟硬件状态单独耐久保存，不作为实机证据。
use chrono::Utc;
use limeiot_core::{
    digest, id,
    model::Model,
    protocol::{Envelope, Operation, MAX_PACKET},
};
use rumqttc::v5::{
    mqttbytes::{v5::Packet, QoS},
    AsyncClient, Event, MqttOptions,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};
use tokio::io::{AsyncBufReadExt, BufReader};

struct Device {
    id: String,
    model: Model,
    revision: String,
    boot: String,
    seq: u64,
    session: Option<String>,
    challenge: String,
    snapshot: u64,
    state: Value,
    path: PathBuf,
    space: String,
}
impl Device {
    fn message(&mut self, kind: &str, body: Value) -> Envelope {
        self.seq += 1;
        Envelope {
            v: 1,
            kind: kind.into(),
            message_id: id(),
            device_id: self.id.clone(),
            model_revision: self.revision.clone(),
            boot_id: Some(self.boot.clone()),
            seq: Some(self.seq),
            session_id: self.session.clone(),
            body,
        }
    }
    async fn publish(
        &self,
        client: &AsyncClient,
        message: &Envelope,
    ) -> Result<(), Box<dyn std::error::Error>> {
        client
            .publish(
                format!("limeiot/v1/{}/{}/up/{}", self.space, self.id, message.kind),
                QoS::AtLeastOnce,
                false,
                serde_json::to_vec(message)?,
            )
            .await?;
        Ok(())
    }
    async fn snapshot(&mut self, client: &AsyncClient) -> Result<(), Box<dyn std::error::Error>> {
        self.snapshot += 1;
        let properties:Vec<_>=self.state["reported"].as_object().unwrap().iter().map(|(path,value)|json!({"path":path,"value":value,"observed_at":Utc::now(),"quality":"confirmed","source":"simulator"})).collect();
        let message = self.message(
            "state",
            json!({"type":"snapshot","revision":self.snapshot,"properties":properties}),
        );
        self.publish(client, &message).await
    }
    fn execute(&mut self, message: &Envelope) -> Result<Value, Box<dyn std::error::Error>> {
        message.validate()?;
        if message.device_id != self.id
            || message.model_revision != self.revision
            || message.session_id != self.session
        {
            return Err("session_or_model_mismatch".into());
        }
        let command_id = message.body["command_id"]
            .as_str()
            .ok_or("invalid_command")?;
        let hash = digest(message)?;
        if let Some(receipt) = self.state["receipts"].get(command_id) {
            if receipt["digest"] != hash {
                return Err("duplicate_conflict".into());
            }
            return Ok(receipt["result"].clone());
        }
        if self.state["receipts"].as_object().unwrap().len() >= 4096 {
            return Err("capacity_exceeded".into());
        }
        let expires: chrono::DateTime<Utc> =
            serde_json::from_value(message.body["expires_at"].clone())?;
        if expires <= Utc::now() {
            return Err("command_expired".into());
        }
        let operation: Operation = serde_json::from_value(message.body["operation"].clone())?;
        self.model.operation(&operation)?;
        let mut next = self.state.clone();
        let result = if operation.kind == "action.invoke" {
            let action = self.model.action(&operation.path)?;
            if action.completion != "submitted" {
                return Err("unsupported simulator action completion".into());
            }
            let output = json!({});
            action.output.validate(&output)?;
            if !next["action_log"].is_array() {
                next["action_log"] = json!([]);
            }
            next["action_log"].as_array_mut().unwrap().push(json!({
                "command_id":command_id,"path":operation.path,"input":operation.value
            }));
            json!({"command_id":command_id,"status":"confirmed","evidence":{
                "type":"action_result","observed_at":Utc::now(),"path":operation.path,
                "input_digest":digest(&operation.value)?,"output":output,"completion":action.completion
            }})
        } else {
            let mut reported = BTreeMap::new();
            reported.insert(operation.path.clone(), operation.value.clone());
            next["reported"][&operation.path] = operation.value;
            json!({"command_id":command_id,"status":"confirmed","evidence":{"type":"device_result","observed_at":Utc::now(),"reported":reported}})
        };
        next["receipts"][command_id] = json!({"digest":hash,"result":result});
        // 模拟设备的副作用就是这个快照；与回执一起原子替换，避免伪造执行证据。
        let temporary = self.path.with_extension("tmp");
        std::fs::write(&temporary, serde_json::to_vec(&next)?)?;
        std::fs::rename(temporary, &self.path)?;
        self.state = next;
        Ok(result)
    }
}
fn setting(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.into())
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let device_id = args
        .get(1)
        .ok_or("usage: limeiot-simulator DEVICE_ID MODEL_FILE STATE_FILE")?
        .clone();
    let model: Model =
        serde_json::from_slice(&std::fs::read(args.get(2).ok_or("missing model file")?)?)?;
    model.validate()?;
    let path = PathBuf::from(args.get(3).ok_or("missing state file")?);
    let state = if path.exists() {
        serde_json::from_slice(&std::fs::read(&path)?)?
    } else {
        let mut reported = BTreeMap::new();
        for service in &model.services {
            for property in &service.properties {
                let value = match property.schema.kind.as_str() {
                    "boolean" => json!(false),
                    "integer" => json!(property.schema.minimum.unwrap_or(0.0) as i64),
                    "number" => json!(property.schema.minimum.unwrap_or(0.0)),
                    _ => return Err("unsupported simulator property".into()),
                };
                reported.insert(format!("{}.{}", service.id, property.id), value);
            }
        }
        json!({"reported":reported,"receipts":{}})
    };
    let revision = digest(&model)?;
    let mut device = Device {
        id: device_id.clone(),
        model,
        revision,
        boot: id(),
        seq: 0,
        session: None,
        challenge: id(),
        snapshot: 0,
        state,
        path,
        space: setting("LIMEIOT_SPACE", "space-demo"),
    };
    let host = setting("LIMEIOT_MQTT_HOST", "127.0.0.1");
    if host != "127.0.0.1" {
        return Err("simulator requires loopback MQTT".into());
    }
    let mut options = MqttOptions::new(
        format!("simulator-{device_id}"),
        host,
        setting("LIMEIOT_MQTT_PORT", "18884").parse()?,
    );
    options.set_keep_alive(Duration::from_secs(5));
    options.set_max_packet_size(Some((MAX_PACKET + 512) as u32));
    options.set_credentials(&device_id, setting("LIMEIOT_MQTT_PASSWORD", ""));
    let (client, mut eventloop) = AsyncClient::new(options, 32);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(2));
    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    let mut stdin_open = true;
    loop {
        tokio::select! {
            _=heartbeat.tick(),if device.session.is_some()=>{device.snapshot(&client).await?;},
            line=stdin.next_line(),if stdin_open=>{
                match line? {
                    Some(line)=>{
                        let input:Value=match serde_json::from_str(&line){Ok(v)=>v,Err(_)=>continue};
                        if device.session.is_none() {continue;}
                        if let Some(raw)=input.get("raw") {if let Ok(message)=serde_json::from_value::<Envelope>(raw.clone()){device.publish(&client,&message).await?;}continue;}
                        let path=input["path"].as_str().unwrap_or("button.pressed");device.model.event(path)?.schema.validate(&input["data"])?;
                        let message=device.message("event",json!({"event_id":input.get("event_id").cloned().unwrap_or(json!(id())),"path":path,"historical":input["historical"].as_bool().unwrap_or(false),"occurred_at":input.get("occurred_at").cloned().unwrap_or(json!(Utc::now())),"data":input["data"]}));
                        device.publish(&client,&message).await?;
                    },None=>stdin_open=false,
                }
            },
            result=eventloop.poll()=>match result {
                Ok(Event::Incoming(Packet::ConnAck(_)))=>{
                    device.session=None;device.challenge=id();
                    client.subscribe(format!("limeiot/v1/{}/{}/down/+",device.space,device.id),QoS::AtLeastOnce).await?;
                    let hello=device.message("hello",json!({"challenge":device.challenge,"firmware":concat!("simulator-",env!("CARGO_PKG_VERSION")),"hardware":"virtual"}));device.publish(&client,&hello).await?;
                },
                Ok(Event::Incoming(Packet::Publish(packet)))=>{
                    if packet.retain || packet.payload.len()>MAX_PACKET {continue;}
                    let message:Envelope=match serde_json::from_slice(&packet.payload){Ok(v)=>v,Err(_)=>continue};
                    if message.device_id!=device.id || message.model_revision!=device.revision {continue;}
                    if message.kind=="welcome" && message.body["challenge"]==device.challenge && message.session_id.is_some() {
                        device.session=message.session_id;device.snapshot=0;device.snapshot(&client).await?;
                        println!("{}",json!({"event":"simulator.ready","device_id":device.id}));
                    } else if message.kind=="command" {
                        match device.execute(&message) {
                            Ok(body)=>{
                                if setting("LIMEIOT_SIM_DROP_RESULTS","0")!="1" {let result=device.message("result",body);device.publish(&client,&result).await?;}
                                device.snapshot(&client).await?;
                            },
                            Err(error)=>eprintln!("{}",json!({"event":"simulator.rejected","code":error.to_string()})),
                        }
                    }
                },
                Err(_)=>{device.session=None;tokio::time::sleep(Duration::from_millis(500)).await;},
                _=>{},
            },
            _=tokio::signal::ctrl_c()=>return Ok(()),
        }
    }
}
