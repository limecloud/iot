CREATE TABLE IF NOT EXISTS control_products (
  product_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  principal_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  revision VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  document_digest VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model_body JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  INDEX publisher_list (principal_id,product_id),
  FOREIGN KEY (principal_id) REFERENCES control_principals(principal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS control_product_operations (
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
