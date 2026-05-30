package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mmrzaf/onlytwo/internal/config"
	onlytwohttp "github.com/mmrzaf/onlytwo/internal/http"
	"github.com/mmrzaf/onlytwo/internal/session"
	"github.com/mmrzaf/onlytwo/internal/ws"
)

const shutdownTimeout = 10 * time.Second

func main() {
	cfg := config.FromEnv()

	if len(cfg.AllowedOrigins) == 0 {
		log.Println("[server] warning: ONLYTWO_ALLOWED_ORIGINS is empty; browser WebSocket origins may be rejected")
	}

	registry := session.NewRegistry(cfg.SessionTTL)
	cleanupStop := make(chan struct{})
	defer close(cleanupStop)
	go registry.CleanupExpired(time.Minute, cleanupStop)

	hub := ws.NewHub(registry, ws.Config{
		AllowedOrigins:      cfg.AllowedOrigins,
		TrustedProxies:      cfg.TrustedProxies,
		MaxMessageSize:      cfg.MaxFrameBytes,
		SendBufferSize:      cfg.SendBufferSize,
		WriteWait:           cfg.WriteWait,
		PongWait:            cfg.PongWait,
		RateLimitPerMinute:  cfg.RateLimitPerMinute,
		MaxSessionsPerIP:    cfg.MaxSessionsPerIP,
		MaxConnectionsPerIP: cfg.MaxConnectionsPerIP,
	})

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           onlytwohttp.NewRouter(hub, cfg),
		ReadHeaderTimeout: 5 * time.Second,
	}

	errCh := make(chan error, 1)

	go func() {
		log.Printf("[server] listening on %s", cfg.Addr)

		err := server.ListenAndServe()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
			return
		}

		errCh <- nil
	}()

	stopCh := make(chan os.Signal, 1)
	signal.Notify(stopCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-stopCh:
		log.Printf("[server] received %s; shutting down", sig)

		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()

		if err := server.Shutdown(ctx); err != nil {
			log.Fatalf("[server] graceful shutdown failed: %v", err)
		}

		log.Println("[server] stopped")

	case err := <-errCh:
		if err != nil {
			log.Fatalf("[server] failed: %v", err)
		}
	}
}
