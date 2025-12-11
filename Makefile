.PHONY: help check-docker check-config dev up down restart logs list-commands

# Default target
help:
	@echo "ProjetDuMois - Makefile"
	@echo ""
	@echo "Available commands:"
	@echo "  make dev          - Start and initialize PDM with docker-compose (if needed)"
	@echo "  make up           - Start docker-compose services"
	@echo "  make down         - Stop docker-compose services"
	@echo "  make restart      - Restart docker-compose services"
	@echo "  make logs         - Show docker-compose logs"
	@echo "  make check-docker - Check if Docker is installed"
	@echo "  make check-config - Check if config.json is properly filled"
	@echo "  make list-commands - List available docker-entrypoint commands"
	@echo ""

# Check if Docker is installed
check-docker:
	@echo "Checking Docker installation..."
	@command -v docker >/dev/null 2>&1 || { echo "❌ ERROR: Docker is not installed. Please install Docker first."; exit 1; }
	@command -v docker-compose >/dev/null 2>&1 || { echo "❌ ERROR: docker-compose is not installed. Please install docker-compose first."; exit 1; }
	@docker --version
	@docker-compose --version
	@echo "✓ Docker is installed"

# Check if config.json exists and is properly filled
check-config:
	@echo "Checking config.json..."
	@if [ ! -f config.json ]; then \
		echo "❌ ERROR: config.json file not found"; \
		echo "Please copy config.example.json to config.json and fill it with your values."; \
		exit 1; \
	fi
	@node -e " \
		const config = require('./config.json'); \
		const errors = []; \
		if (!config.OSM_USER || config.OSM_USER === 'user') errors.push('OSM_USER'); \
		if (!config.OSM_PASS || config.OSM_PASS === 'pass') errors.push('OSM_PASS'); \
		if (config.OSH_PBF_URL && config.OSH_PBF_URL.includes('reunion-internal.osh.pbf') && !config.OSH_PBF_URL.includes('france-internal')) { \
			console.log('⚠ WARNING: OSH_PBF_URL appears to use example value'); \
		} \
		if (errors.length > 0) { \
			console.log('❌ ERROR: The following fields need to be configured:', errors.join(', ')); \
			process.exit(1); \
		} \
		console.log('✓ config.json is properly configured'); \
	" || { echo "❌ ERROR: config.json validation failed"; exit 1; }

# Main development command
dev: check-docker check-config
	@echo ""
	@echo "Starting ProjetDuMois..."
	@echo ""
	
	# Check if services are already running
	@if docker-compose ps | grep -q "Up"; then \
		echo "Services are already running."; \
	else \
		echo "Starting docker-compose services..."; \
		docker-compose up -d; \
		echo "Waiting for services to be ready..."; \
		sleep 5; \
	fi
	
	# Check if database is initialized
	@echo "Checking if database is initialized..."
	@if docker-compose exec -T pgsqldb psql -U postgres -d pdm -c "SELECT 1 FROM pdm_projects LIMIT 1" >/dev/null 2>&1; then \
		echo "✓ Database is already initialized"; \
	else \
		echo "Database is not initialized. Initializing..."; \
		docker-compose exec -T pdm ./docker-entrypoint.sh install || { \
			echo "❌ ERROR: Failed to initialize database"; \
			exit 1; \
		}; \
		echo "✓ Database initialized"; \
	fi
	
	@echo ""
	@echo "=========================================="
	@echo "✓ ProjetDuMois is ready!"
	@echo ""
	@echo "Frontend is available at:"
	@echo "  http://localhost:3000"
	@echo ""
	@echo "To view logs, run: make logs"
	@echo "To stop services, run: make down"
	@echo "=========================================="

# Docker-compose shortcuts
up: check-docker
	docker-compose up -d

down:
	docker-compose down

restart: check-docker
	docker-compose restart

logs:
	docker-compose logs -f

# List available docker-entrypoint commands
list-commands:
	@docker-compose exec pdm ./docker-entrypoint.sh list || echo "Services are not running. Start them with 'make dev' first."

