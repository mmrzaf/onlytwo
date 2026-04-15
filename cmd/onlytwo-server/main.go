package main

import (
	"log"
	"net/http"
	"time"

	"github.com/mmrzaf/onlytwo/internal/config"
	apphttp "github.com/mmrzaf/onlytwo/internal/http"
	"github.com/mmrzaf/onlytwo/internal/ws"
)

func main() {
	cfg := config.Load()

	hub := ws.NewHub(cfg)

	stopCh := make(chan struct{})
	go hub.Registry().CleanupExpired(5*time.Minute, stopCh)
	defer close(stopCh)

	router := apphttp.NewRouter(hub, cfg)

	addr := ":" + cfg.Port
	log.Printf("OnlyTwo relay listening on %s", addr)
	if err := http.ListenAndServe(addr, router); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
