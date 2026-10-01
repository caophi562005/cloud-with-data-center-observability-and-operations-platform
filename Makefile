.PHONY: web api dev install build lint preview

WEB_DIR := apps/web
API_DIR := apps/api
PNPM ?= pnpm

# Default target: start the React/Vite development server.
web:
	$(PNPM) --dir "$(WEB_DIR)" run dev

# Start the NestJS API in watch mode.
api:
	$(PNPM) --dir "$(API_DIR)" run start:dev

# Start the web and API development servers in parallel.
dev:
	mprocs

install:
	$(PNPM) --dir "$(WEB_DIR)" install

build:
	$(PNPM) --dir "$(WEB_DIR)" run build

lint:
	$(PNPM) --dir "$(WEB_DIR)" run lint

preview:
	$(PNPM) --dir "$(WEB_DIR)" run preview
