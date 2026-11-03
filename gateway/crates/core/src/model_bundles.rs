//! 宿主装配的只读模型目录；领域核心不选择品牌、协议或具体型号。
use crate::{digest, ensure, err, model::Model, Result};
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Clone, Debug, Serialize)]
pub struct ModelBundle {
    pub bundle_id: String,
    pub model_revision: String,
    pub model: Model,
}

#[derive(Clone, Debug, Default)]
pub struct Catalog {
    bundles: Vec<ModelBundle>,
}

impl Catalog {
    pub fn new(models: impl IntoIterator<Item = Model>) -> Result<Self> {
        let mut bundles = Vec::new();
        let mut revisions = BTreeSet::new();
        for model in models {
            model.validate()?;
            let model_revision = digest(&model)?;
            ensure(
                revisions.insert(model_revision.clone()),
                "duplicate_model_bundle",
            )?;
            bundles.push(ModelBundle {
                bundle_id: format!("bundle-{}", &model_revision[7..]),
                model_revision,
                model,
            });
        }
        Ok(Self { bundles })
    }

    pub fn list(&self) -> &[ModelBundle] {
        &self.bundles
    }

    pub fn get(&self, bundle_id: &str) -> Result<&ModelBundle> {
        self.bundles
            .iter()
            .find(|bundle| bundle.bundle_id == bundle_id)
            .ok_or_else(|| err("model_bundle_not_found"))
    }
}
