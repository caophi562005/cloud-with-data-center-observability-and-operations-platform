package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"
)

func New(address string, write http.Handler, ready func(context.Context) error, logger *slog.Logger, upstreamTimeout time.Duration) *http.Server {
	return &http.Server{Addr: address, Handler: NewHandler(write, ready, logger), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: upstreamTimeout + 40*time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
}

// Run drains accepted requests before resource owners close the pool/cache.
func Run(ctx context.Context, srv *http.Server, logger *slog.Logger) error {
	done := make(chan error, 1)
	go func() { done <- srv.ListenAndServe() }()
	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return errors.New("HTTP server failed")
	case <-ctx.Done():
		logger.Info("gateway shutting down")
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdown); err != nil {
			_ = srv.Close()
			<-done
			return errors.New("HTTP shutdown exceeded grace period")
		}
		err := <-done
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return errors.New("HTTP server failed")
		}
		return nil
	}
}
