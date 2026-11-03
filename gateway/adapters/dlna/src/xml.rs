//! 只解析有限UPnP设备描述和SOAP回执；禁止DTD，不采用远端给出的新目标。
use crate::Config;
use limeiot_core::{ensure, err, Result};
use roxmltree::{Document, Node, ParsingOptions};

pub(crate) const AV: &str = "urn:schemas-upnp-org:service:AVTransport:1";
pub(crate) const RENDER: &str = "urn:schemas-upnp-org:service:RenderingControl:1";
const DEVICE: &str = "urn:schemas-upnp-org:device-1-0";
const SOAP: &str = "http://schemas.xmlsoap.org/soap/envelope/";

fn parse(text: &str) -> Result<Document<'_>> {
    let doc = Document::parse_with_options(
        text,
        ParsingOptions {
            allow_dtd: false,
            nodes_limit: 4096,
            ..ParsingOptions::default()
        },
    )
    .map_err(|_| err("audio_invalid_response"))?;
    ensure(
        doc.descendants().all(|node| node.ancestors().count() <= 20),
        "audio_invalid_response",
    )?;
    Ok(doc)
}
fn child<'a, 'input>(node: Node<'a, 'input>, ns: &str, name: &str) -> Result<Node<'a, 'input>> {
    let mut children = node.children().filter(|n| n.has_tag_name((ns, name)));
    let result = children
        .next()
        .ok_or_else(|| err("audio_invalid_response"))?;
    ensure(children.next().is_none(), "audio_invalid_response")?;
    Ok(result)
}
fn text_child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Result<&'a str> {
    let node = child(node, DEVICE, name)?;
    ensure(
        !node.children().any(|n| n.is_element()),
        "audio_invalid_response",
    )?;
    Ok(node.text().unwrap_or("").trim())
}
pub(crate) fn description(text: &str, config: &Config) -> Result<()> {
    let doc = parse(text)?;
    let root = doc.root_element();
    ensure(
        root.has_tag_name((DEVICE, "root")),
        "audio_invalid_response",
    )?;
    let bases: Vec<_> = root
        .children()
        .filter(|n| n.has_tag_name((DEVICE, "URLBase")))
        .collect();
    ensure(bases.len() <= 1, "audio_invalid_response")?;
    if let Some(base) = bases.first() {
        ensure(
            base.text().unwrap_or("").trim() == config.endpoint("/"),
            "audio_identity_mismatch",
        )?;
    }
    let device = child(root, DEVICE, "device")?;
    ensure(
        text_child(device, "UDN")? == config.udn
            && text_child(device, "deviceType")? == "urn:schemas-upnp-org:device:MediaRenderer:1",
        "audio_identity_mismatch",
    )?;
    let services = child(device, DEVICE, "serviceList")?;
    for (kind, path) in [
        (AV, &config.av_transport_path),
        (RENDER, &config.rendering_control_path),
    ] {
        let matched: Vec<_> = services
            .children()
            .filter(|n| n.has_tag_name((DEVICE, "service")))
            .filter(|n| text_child(*n, "serviceType").is_ok_and(|v| v == kind))
            .collect();
        ensure(matched.len() == 1, "audio_identity_mismatch")?;
        let control = text_child(matched[0], "controlURL")?;
        ensure(
            control == path || control == config.endpoint(path),
            "audio_identity_mismatch",
        )?;
    }
    Ok(())
}
pub(crate) fn response(text: &str, service: &str, action: &str) -> Result<()> {
    let doc = parse(text)?;
    let root = doc.root_element();
    ensure(
        root.has_tag_name((SOAP, "Envelope")),
        "audio_invalid_response",
    )?;
    let body = child(root, SOAP, "Body")?;
    let children: Vec<_> = body.children().filter(Node::is_element).collect();
    ensure(
        children.len() == 1
            && children[0].has_tag_name((service, format!("{action}Response").as_str()))
            && children[0]
                .children()
                .all(|n| n.is_text() && n.text().unwrap_or("").trim().is_empty()),
        "audio_invalid_response",
    )
}
pub(crate) fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
pub(crate) fn request(service: &str, action: &str, args: &str) -> String {
    format!(
        r#"<?xml version="1.0"?><s:Envelope xmlns:s="{SOAP}" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:{action} xmlns:u="{service}"><InstanceID>0</InstanceID>{args}</u:{action}></s:Body></s:Envelope>"#
    )
}
