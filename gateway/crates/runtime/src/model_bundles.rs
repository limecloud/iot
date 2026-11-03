//! 默认发行版的集成模型装配；替换此目录无需更改领域核心或快照格式。
use limeiot_core::{err, model::Model, model_bundles::Catalog, Result};

pub fn catalog() -> Result<Catalog> {
    let groups: &[&[&[u8]]] = &[
        #[cfg(feature = "android-tv")]
        &[
            include_bytes!("../../../../contracts/models/android-tv-agent.json").as_slice(),
            include_bytes!("../../../../contracts/models/android-tv-remote.json").as_slice(),
            include_bytes!("../../../../contracts/models/android-tv-audio-agent.json").as_slice(),
            include_bytes!("../../../../contracts/models/android-tv-audio-remote.json").as_slice(),
        ],
        #[cfg(feature = "dlna")]
        &[include_bytes!("../../../../contracts/models/dlna-speaker.json").as_slice()],
    ];
    let models = groups
        .iter()
        .flat_map(|group| group.iter())
        .map(|bytes| {
            serde_json::from_slice::<Model>(bytes).map_err(|_| err("invalid_model_bundle"))
        })
        .collect::<Result<Vec<_>>>()?;
    Catalog::new(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_distribution_has_valid_unique_models_and_preserves_existing_revisions() {
        let catalog = catalog().unwrap();
        assert_eq!(
            catalog.list().len(),
            usize::from(cfg!(feature = "android-tv")) * 4 + usize::from(cfg!(feature = "dlna"))
        );
        #[cfg(feature = "android-tv")]
        {
            assert_eq!(
                catalog.list()[0].model.model_id,
                "urn:limeiot:model:android-tv-agent:1"
            );
            assert_eq!(
                catalog.list()[1].model_revision,
                "sha256:a591ed3813a996a6c8bb37e9ecdef2c335efd044c629b2a4b4f896fd93aa562a"
            );
        }
        for bundle in catalog.list() {
            assert_eq!(
                catalog.get(&bundle.bundle_id).unwrap().model_revision,
                bundle.model_revision
            );
        }
    }
}
