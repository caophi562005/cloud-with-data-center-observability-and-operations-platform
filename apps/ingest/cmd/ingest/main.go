package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/auth"
	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/cache"
	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/config"
	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/ratelimit"
	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/remotewrite"
	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/repository/postgres"
	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/server"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

func main() {
	if err := run(); err != nil {
		slog.Error("gateway stopped", "error", err)
		os.Exit(1)
	}
}
func run() error {
	cfg, err := config.LoadGateway()
	if err != nil {
		return err
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return errors.New("invalid DATABASE_URL connection options")
	}
	poolCfg.MaxConns = 8
	poolCfg.MinConns = 0
	poolCfg.MaxConnLifetime = 30 * time.Minute
	poolCfg.MaxConnIdleTime = 5 * time.Minute
	poolCfg.ConnConfig.ConnectTimeout = 5 * time.Second
	poolCfg.ConnConfig.RuntimeParams["application_name"] = "opsgrid-ingest"
	poolCfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return errors.New("PostgreSQL initialization failed")
	}
	defer pool.Close()
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	err = pool.Ping(pingCtx)
	cancel()
	if err != nil {
		return errors.New("PostgreSQL startup check failed")
	}
	redisCfg, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return errors.New("invalid REDIS_URL connection options")
	}
	redisCfg.ContextTimeoutEnabled = true
	// Allow a cold remote DNS/TLS/auth handshake at startup. Request-time cache
	// operations still have the auth service's strict 250ms context deadline.
	redisCfg.DialTimeout = 2 * time.Second
	redisCfg.ReadTimeout = time.Second
	redisCfg.WriteTimeout = time.Second
	redisCfg.MaxRetries = -1
	client := redis.NewClient(redisCfg)
	defer client.Close()
	pingCtx, cancel = context.WithTimeout(ctx, 5*time.Second)
	err = client.Ping(pingCtx).Err()
	cancel()
	if err != nil {
		logger.Warn("Redis startup check failed; database fallback enabled")
	}
	authentication := auth.NewService(postgres.NewAgents(pool), cache.NewRedis(client), cfg.AuthCacheTTL, logger)
	upstream := remotewrite.NewForwarder(cfg.Write.URL, cfg.Write.Auth, cfg.Write.Timeout)
	defer upstream.Close()
	write := remotewrite.NewHandler(authentication, ratelimit.New(cfg.RateRPS, cfg.RateBurst), upstream, cfg.MaxBodyBytes, logger)
	srv := server.New(fmt.Sprintf(":%d", cfg.Port), write, pool.Ping, logger, cfg.Write.Timeout)
	logger.Info("gateway starting", "port", cfg.Port)
	return server.Run(ctx, srv, logger)
}
