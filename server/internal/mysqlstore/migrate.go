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

//go:embed remote.sql
var remoteSchema string

//go:embed native.sql
var nativeSchema string

//go:embed products.sql
var productsSchema string

//go:embed model_publications.sql
var modelPublicationsSchema string

var migrations = []string{schema, remoteSchema, nativeSchema, productsSchema, modelPublicationsSchema}

type migrationReader interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func applied(ctx context.Context, db migrationReader) (int, error) {
	rows, err := db.QueryContext(ctx, `SELECT version,checksum FROM control_schema_migrations ORDER BY version`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var version int
		var checksum string
		if err := rows.Scan(&version, &checksum); err != nil {
			return 0, err
		}
		if version < 1 || version > len(migrations) {
			return 0, errors.New("unsupported_schema_version")
		}
		if version != count+1 {
			return 0, errors.New("migration_history_gap")
		}
		if checksum != control.Hash(migrations[version-1]) {
			return 0, errors.New("migration_checksum_mismatch")
		}
		count++
	}
	return count, rows.Err()
}

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
	count, err := applied(ctx, conn)
	if err != nil {
		return err
	}
	for version := count + 1; version <= len(migrations); version++ {
		for _, statement := range strings.Split(migrations[version-1], ";") {
			if strings.TrimSpace(statement) == "" {
				continue
			}
			if _, err = conn.ExecContext(ctx, statement); err != nil {
				return err
			}
		}
		if _, err = conn.ExecContext(ctx, `INSERT INTO control_schema_migrations (version,checksum,applied_at) VALUES (?,?,UTC_TIMESTAMP(6))`, version, control.Hash(migrations[version-1])); err != nil {
			return err
		}
	}
	return nil
}
func Check(ctx context.Context, db *sql.DB) error {
	count, err := applied(ctx, db)
	if err != nil || count != len(migrations) {
		return errors.New("schema_version_mismatch")
	}
	return nil
}
func (s *Store) Ready(ctx context.Context) error { return Check(ctx, s.DB) }
