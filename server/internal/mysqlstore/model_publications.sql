CREATE TABLE IF NOT EXISTS control_model_publications (
  release_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  publication_order BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  principal_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  product_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model_id VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  publication_body JSON NOT NULL,
  UNIQUE KEY publication_order (publication_order),
  UNIQUE KEY model_version (principal_id,model_id,model_version),
  INDEX product_head (principal_id,product_id,publication_order),
  INDEX product_list (principal_id,product_id,release_id),
  FOREIGN KEY (principal_id) REFERENCES control_principals(principal_id),
  FOREIGN KEY (product_id) REFERENCES control_products(product_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS control_model_publish_operations (
  operation_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  principal_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  product_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_body JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  UNIQUE KEY original_request (principal_id,request_key),
  FOREIGN KEY (principal_id) REFERENCES control_principals(principal_id),
  FOREIGN KEY (product_id) REFERENCES control_products(product_id)
) ENGINE=InnoDB;
