package onlytwo

import (
	"embed"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed client/dist/*
var staticFiles embed.FS

// NewStaticHandler serves the embedded Vite build. Unknown paths fall back to
// index.html so the SPA can own client-side routing.
func NewStaticHandler() http.Handler {
	subFS, err := fs.Sub(staticFiles, "client/dist")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(subFS))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cleanPath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if cleanPath == "." || cleanPath == "" {
			serveIndex(w, subFS)
			return
		}

		if f, err := subFS.Open(cleanPath); err == nil {
			defer f.Close()
			if stat, err := f.Stat(); err == nil && !stat.IsDir() {
				fileServer.ServeHTTP(w, r)
				return
			}
		}

		serveIndex(w, subFS)
	})
}

func serveIndex(w http.ResponseWriter, fsys fs.FS) {
	indexFile, err := fsys.Open("index.html")
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
}
