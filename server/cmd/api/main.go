package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/limecloud/iot/server/internal/control"
	"github.com/limecloud/iot/server/internal/mysqlstore"
)

func main() {
	if err := run(); err != nil {
		log.Fatal("control_server_failed")
	}
}
func run() error {
	cfg, err := control.FromEnv()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	initCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	db, err := mysqlstore.Connect(initCtx)
	if err != nil {
		return err
	}
	defer db.Close()
	if err = mysqlstore.Check(initCtx, db); err != nil {
		return err
	}
	store := &mysqlstore.Store{DB: db}
	app, err := control.New(cfg, store, store, store, store, nil)
	if err != nil {
		return err
	}
	defer app.Close()
	gin.SetMode(gin.ReleaseMode)
	server := &http.Server{Addr: cfg.Address, Handler: app.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	log.Print("control_listening")
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case err := <-done:
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return err
		case <-ticker.C:
			cleanCtx, c := context.WithTimeout(ctx, 10*time.Second)
			if store.Sweep(cleanCtx) != nil {
				log.Print("session_cleanup_failed")
			}
			c()
		case <-ctx.Done():
			app.Close()
			closeCtx, c := context.WithTimeout(context.Background(), 10*time.Second)
			defer c()
			return server.Shutdown(closeCtx)
		}
	}
}
