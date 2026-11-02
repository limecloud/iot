CREATE TABLE IF NOT EXISTS control_native_authorization_guard (
  guard_id TINYINT PRIMARY KEY
) ENGINE=InnoDB;
INSERT IGNORE INTO control_native_authorization_guard (guard_id) VALUES (1);
CREATE TABLE IF NOT EXISTS control_native_authorizations (
  authorization_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  control_origin VARBINARY(400) NOT NULL,
  platform VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code_challenge CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code_encrypted VARBINARY(256) NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  parent_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  principal_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  child_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  material_encrypted VARBINARY(4096) NULL,
  expires_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  INDEX expiry (expires_at)
) ENGINE=InnoDB;
