package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mmrzaf/onlytwo/internal/config"
	internalhttp "github.com/mmrzaf/onlytwo/internal/http"
	"github.com/mmrzaf/onlytwo/internal/ws"
)

func main() {
	cfg := config.Load()

	hub := ws.NewHub(cfg)

	stopCleanup := make(chan struct{})
	go hub.Registry().CleanupExpired(cfg.CleanupInterval, stopCleanup)

	handler := internalhttp.NewRouter(hub, cfg)

	srv := &http.Server{
		Addr:    cfg.Port,
		Handler: handler,

		ReadHeaderTimeout: 15 * time.Second,

		IdleTimeout: 120 * time.Second,
	}

	shutdown := make(chan struct{})
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigCh
		log.Printf("Received signal %s — shutting down…", sig)

		close(stopCleanup)

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("HTTP server shutdown error: %v", err)
		}
		close(shutdown)
	}()

	log.Printf("OnlyTwo listening on %s", cfg.Port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}

	<-shutdown
	log.Println("Server stopped cleanly.")
}
