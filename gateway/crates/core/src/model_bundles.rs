//! 随网关交付的只读模型目录；目录可用不代表设备已绑定或获准执行。
use crate::{digest, err, model::Model, Result};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct ModelBundle {
    pub bundle_id: String,
    pub model_revision: String,
    pub model: Model,
}

pub fn catalog() -> Result<Vec<ModelBundle>> {
    [
        include_bytes!("../../../../contracts/models/android-tv-agent.json").as_slice(),
        include_bytes!("../../../../contracts/models/android-tv-remote.json").as_slice(),
        include_bytes!("../../../../contracts/models/dlna-speaker.json").as_slice(),
    ]
    .into_iter()
    .map(|bytes| {
        let model: Model =
            serde_json::from_slice(bytes).map_err(|_| err("invalid_model_bundle"))?;
        model.validate()?;
        let model_revision = digest(&model)?;
        Ok(ModelBundle {
            bundle_id: format!("bundle-{}", &model_revision[7..]),
            model_revision,
            model,
        })
    })
    .collect()
}

pub fn get(bundle_id: &str) -> Result<ModelBundle> {
    catalog()?
        .into_iter()
        .find(|bundle| bundle.bundle_id == bundle_id)
        .ok_or_else(|| err("model_bundle_not_found"))
}
