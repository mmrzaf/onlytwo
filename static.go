package onlytwo

import (
	"embed"
	"io"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed client/dist/*
var staticFiles embed.FS

// NewStaticHandler serves the embedded Vite build.
// Any path that doesn't resolve to a real file falls back to index.html,
// enabling client-side routing.
func NewStaticHandler() http.Handler {
	subFS, err := fs.Sub(staticFiles, "client/dist")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(subFS))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")

		// Try to open the exact file first.
		if f, err := subFS.Open(path); err == nil {
			defer f.Close()
			if stat, err := f.Stat(); err == nil && !stat.IsDir() {
				fileServer.ServeHTTP(w, r)
				return
			}
		}

		// Fall back to index.html for SPA routing.
		indexFile, err := subFS.Open("index.html")
		if err != nil {
			http.Error(w, "index.html not found", http.StatusInternalServerError)
			return
		}
		defer indexFile.Close()

		data, err := io.ReadAll(indexFile)
		if err != nil {
			http.Error(w, "failed to read index.html", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(data)
	})
}
