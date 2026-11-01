package main

import (
	"context"
	"log"
	"time"

	"github.com/limecloud/iot/server/internal/mysqlstore"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	db, err := mysqlstore.Connect(ctx)
	if err != nil {
		log.Fatal("mysql_connection_failed")
	}
	defer db.Close()
	if mysqlstore.Migrate(ctx, db) != nil {
		log.Fatal("migration_failed")
	}
	log.Print("migration_applied")
}
