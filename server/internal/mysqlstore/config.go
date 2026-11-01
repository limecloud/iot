package mysqlstore

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

func Connect(ctx context.Context) (*sql.DB, error) {
	path := os.Getenv("LIMEIOT_CONTROL_MYSQL_DSN_FILE")
	if path == "" {
		return nil, errors.New("mysql_dsn_file_required")
	}
	value, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("mysql_dsn_file_unreadable")
	}
	cfg, err := mysql.ParseDSN(strings.TrimSpace(string(value)))
	if err != nil || cfg.DBName == "" {
		return nil, errors.New("invalid_mysql_dsn")
	}
	if cfg.MultiStatements || cfg.AllowAllFiles || cfg.AllowCleartextPasswords || cfg.AllowFallbackToPlaintext || cfg.TLSConfig == "skip-verify" || cfg.TLSConfig == "preferred" {
		return nil, errors.New("unsafe_mysql_dsn")
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.Timeout = 5 * time.Second
	cfg.ReadTimeout = 10 * time.Second
	cfg.WriteTimeout = 10 * time.Second
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, errors.New("invalid_mysql_dsn")
	}
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(12)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(5 * time.Minute)
	if db.PingContext(ctx) != nil {
		db.Close()
		return nil, errors.New("mysql_unavailable")
	}
	return db, nil
}
