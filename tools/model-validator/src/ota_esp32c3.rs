//! ESP32-C3应用镜像格式检查；厂商格式留在工具适配器，不进入物模型核心。
use sha2::{Digest, Sha256};

fn word(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}
fn string(bytes: &[u8]) -> Option<&str> {
    let end = bytes.iter().position(|b| *b == 0)?;
    let value = std::str::from_utf8(&bytes[..end]).ok()?;
    (!value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)))
    .then_some(value)
}
pub fn inspect(image: &[u8], version: &str, security_epoch: u32) -> Result<String, &'static str> {
    let invalid = "invalid_ota_esp32c3_image";
    if image.len() < 336
        || image[0] != 0xe9
        || !(1..=16).contains(&image[1])
        || image[12..14] != [5, 0]
        || image[23] != 1
    {
        return Err(invalid);
    }
    let mut offset = 24_usize;
    let mut checksum = 0xef_u8;
    for segment in 0..image[1] {
        let length = word(image, offset + 4).ok_or(invalid)? as usize;
        offset = offset.checked_add(8).ok_or(invalid)?;
        let end = offset.checked_add(length).ok_or(invalid)?;
        let data = image.get(offset..end).ok_or(invalid)?;
        if segment == 0 && (length < 256 || word(data, 0) != Some(0xabcd5432)) {
            return Err(invalid);
        }
        for byte in data {
            checksum ^= byte;
        }
        offset = end;
    }
    let checksum_at = offset.checked_add(16).ok_or(invalid)? / 16 * 16 - 1;
    let hash_at = checksum_at.checked_add(1).ok_or(invalid)?;
    if image.len() != hash_at.checked_add(32).ok_or(invalid)?
        || image.get(checksum_at) != Some(&checksum)
        || Sha256::digest(&image[..hash_at]).as_slice() != &image[hash_at..]
    {
        return Err(invalid);
    }
    if word(image, 36) != Some(security_epoch) || string(&image[48..80]) != Some(version) {
        return Err("ota_image_metadata_mismatch");
    }
    string(&image[80..112]).map(str::to_owned).ok_or(invalid)
}
