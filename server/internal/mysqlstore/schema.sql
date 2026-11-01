CREATE TABLE IF NOT EXISTS control_principals (
  principal_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  issuer VARBINARY(512) NOT NULL,
  subject VARBINARY(255) NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  UNIQUE KEY identity_subject (issuer, subject)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS control_sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  audience VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  credential VARBINARY(16384) NOT NULL,
  external_identity BOOLEAN NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  INDEX expiry (expires_at),
  FOREIGN KEY (principal_id) REFERENCES control_principals(principal_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS control_login_flows (
  flow_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  state_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  audience VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nonce CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  verifier VARBINARY(256) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  INDEX expiry (expires_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS control_spaces (
  space_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  display_name VARCHAR(160) NOT NULL,
  created_by VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL,
  UNIQUE KEY original_request (created_by, request_key),
  FOREIGN KEY (created_by) REFERENCES control_principals(principal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS control_memberships (
  space_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  active BOOLEAN NOT NULL,
  PRIMARY KEY (space_id, principal_id),
  FOREIGN KEY (space_id) REFERENCES control_spaces(space_id),
  FOREIGN KEY (principal_id) REFERENCES control_principals(principal_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS control_pairings (
  pairing_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  space_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  challenge CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scopes JSON NOT NULL,
  code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code_encrypted VARBINARY(256) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  claimed BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE KEY original_request (space_id, principal_id, request_key),
  FOREIGN KEY (space_id) REFERENCES control_spaces(space_id),
  FOREIGN KEY (principal_id) REFERENCES control_principals(principal_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS control_gateways (
  gateway_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  space_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  local_space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  public_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  pairing_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scopes JSON NOT NULL,
  revision VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  active BOOLEAN NOT NULL,
  active_space VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (IF(active, space_id, NULL)) STORED,
  active_gateway VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (IF(active, gateway_id, NULL)) STORED,
  created_at DATETIME(6) NOT NULL,
  UNIQUE KEY single_active_gateway (active_space),
  UNIQUE KEY single_active_binding (active_gateway),
  INDEX gateway_history (gateway_id, created_at),
  UNIQUE KEY one_claim (pairing_id),
  FOREIGN KEY (space_id) REFERENCES control_spaces(space_id),
  FOREIGN KEY (principal_id) REFERENCES control_principals(principal_id),
  FOREIGN KEY (pairing_id) REFERENCES control_pairings(pairing_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS control_audit (
  sequence BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  space_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL
) ENGINE=InnoDB;
