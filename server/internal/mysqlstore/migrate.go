package mysqlstore

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"strings"

	"github.com/limecloud/iot/server/internal/control"
)

//go:embed schema.sql
var schema string

// Migrate 仅由显式命令调用。MySQL DDL 会隐式提交；失败后允许原命令继续，不能声称事务回滚。
func Migrate(ctx context.Context, db *sql.DB) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	var locked int
	if err = conn.QueryRowContext(ctx, `SELECT GET_LOCK('limeiot_control_migration',10)`).Scan(&locked); err != nil {
		return err
	}
	if locked != 1 {
		return errors.New("migration_locked")
	}
	defer conn.ExecContext(context.Background(), `SELECT RELEASE_LOCK('limeiot_control_migration')`)
	if _, err = conn.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS control_schema_migrations (version INT PRIMARY KEY, checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, applied_at DATETIME(6) NOT NULL) ENGINE=InnoDB`); err != nil {
		return err
	}
	var unsupported int
	if err = conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM control_schema_migrations WHERE version<>1`).Scan(&unsupported); err != nil {
		return err
	}
	if unsupported != 0 {
		return errors.New("unsupported_schema_version")
	}
	var checksum string
	err = conn.QueryRowContext(ctx, `SELECT checksum FROM control_schema_migrations WHERE version=1`).Scan(&checksum)
	if err == nil {
		if checksum != control.Hash(schema) {
			return errors.New("migration_checksum_mismatch")
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	for _, statement := range strings.Split(schema, ";") {
		if strings.TrimSpace(statement) == "" {
			continue
		}
		if _, err = conn.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	_, err = conn.ExecContext(ctx, `INSERT INTO control_schema_migrations (version,checksum,applied_at) VALUES (1,?,UTC_TIMESTAMP(6))`, control.Hash(schema))
	return err
}
func Check(ctx context.Context, db *sql.DB) error {
	var checksum string
	var versions int
	if err := db.QueryRowContext(ctx, `SELECT checksum,(SELECT COUNT(*) FROM control_schema_migrations) FROM control_schema_migrations WHERE version=1`).Scan(&checksum, &versions); err != nil {
		return errors.New("schema_not_ready")
	}
	if versions != 1 || checksum != control.Hash(schema) {
		return errors.New("schema_version_mismatch")
	}
	return nil
}
func (s *Store) Ready(ctx context.Context) error { return Check(ctx, s.DB) }
