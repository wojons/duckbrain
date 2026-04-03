#!/bin/bash
#
# DuckBrain Launcher Script
# Unified startup for DuckBrain with automatic port configuration
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default ports
API_PORT=${DUCKBRAIN_API_PORT:-8490}
UI_PORT=${DUCKBRAIN_UI_PORT:-8989}

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Function to print colored output
print_status() {
    echo -e "${BLUE}[DuckBrain]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[DuckBrain]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[DuckBrain]${NC} $1"
}

print_error() {
    echo -e "${RED}[DuckBrain]${NC} $1"
}

# Function to check if a port is in use
check_port() {
    local port=$1
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Function to find an available port
find_available_port() {
    local start_port=$1
    local port=$start_port
    while check_port $port; do
        port=$((port + 1))
        if [ $port -gt $((start_port + 100)) ]; then
            print_error "Could not find available port in range $start_port-$((start_port + 100))"
            exit 1
        fi
    done
    echo $port
}

# Function to check dependencies
check_deps() {
    print_status "Checking dependencies..."
    
    if ! command -v node >/dev/null 2>&1; then
        print_error "Node.js is not installed. Please install Node.js 20+"
        exit 1
    fi
    
    if ! command -v npm >/dev/null 2>&1; then
        print_error "npm is not installed"
        exit 1
    fi
    
    # Check Node version
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 20 ]; then
        print_warning "Node.js version is $NODE_VERSION. DuckBrain requires Node.js 20+"
    fi
    
    # Check if node_modules exists
    if [ ! -d "node_modules" ]; then
        print_status "Installing dependencies..."
        npm install
    fi
    
    # Check UI dependencies
    if [ ! -d "packages/ui/node_modules" ]; then
        print_status "Installing UI dependencies..."
        cd packages/ui && npm install && cd ../..
    fi
    
    print_success "Dependencies OK"
}

# Function to stop existing processes
stop_existing() {
    print_status "Stopping any existing DuckBrain processes..."
    
    # Find and kill existing duckbrain http processes
    local pids=$(pgrep -f "duckbrain.*http" || true)
    if [ -n "$pids" ]; then
        echo "$pids" | xargs kill -9 2>/dev/null || true
        print_warning "Stopped existing DuckBrain processes"
    fi
    
    # Kill existing Vite dev servers on our port
    local vite_pids=$(lsof -Pi :$UI_PORT -sTCP:LISTEN -t 2>/dev/null || true)
    if [ -n "$vite_pids" ]; then
        echo "$vite_pids" | xargs kill -9 2>/dev/null || true
        print_warning "Stopped existing UI dev server"
    fi
    
    sleep 2
}

# Function to start the API server
start_api() {
    print_status "Starting DuckBrain API server on port $API_PORT..."
    
    # Check if port is available
    if check_port $API_PORT; then
        print_warning "Port $API_PORT is in use, finding alternative..."
        API_PORT=$(find_available_port $API_PORT)
        print_status "Using alternative port: $API_PORT"
    fi
    
    # Export the port for the UI to use
    export DUCKBRAIN_API_PORT=$API_PORT
    
    # Start the API server in the background
    nohup node bin/duckbrain.js http --port $API_PORT > logs/api.log 2>&1 &
    API_PID=$!
    
    # Wait for API to be ready
    print_status "Waiting for API to be ready..."
    for i in {1..30}; do
        if curl -s "http://localhost:$API_PORT/api/namespaces" >/dev/null 2>&1; then
            print_success "API server ready on port $API_PORT"
            return 0
        fi
        sleep 1
    done
    
    print_error "API server failed to start"
    kill $API_PID 2>/dev/null || true
    exit 1
}

# Function to start the UI
start_ui() {
    print_status "Starting DuckBrain Web UI on port $UI_PORT..."
    
    # Check if port is available
    if check_port $UI_PORT; then
        print_warning "Port $UI_PORT is in use, finding alternative..."
        UI_PORT=$(find_available_port $UI_PORT)
        print_status "Using alternative port: $UI_PORT"
    fi
    
    # Export the port and API port for the UI
    export DUCKBRAIN_UI_PORT=$UI_PORT
    export DUCKBRAIN_API_PORT=$API_PORT
    export DUCKBRAIN_API_HOST=localhost
    
    # Change to UI directory and start
    cd packages/ui
    
    # Start Vite dev server in the background
    nohup npx vite --port $UI_PORT > ../logs/ui.log 2>&1 &
    UI_PID=$!
    cd ../..
    
    # Wait for UI to be ready
    print_status "Waiting for UI to be ready..."
    for i in {1..30}; do
        if curl -s "http://localhost:$UI_PORT" >/dev/null 2>&1; then
            print_success "UI ready on port $UI_PORT"
            return 0
        fi
        sleep 1
    done
    
    print_error "UI failed to start"
    kill $UI_PID 2>/dev/null || true
    exit 1
}

# Function to show status
show_status() {
    echo ""
    print_success "DuckBrain is running!"
    echo ""
    echo -e "  ${BLUE}API Server:${NC}  http://localhost:$API_PORT"
    echo -e "  ${BLUE}Web UI:${NC}     http://localhost:$UI_PORT"
    echo ""
    echo -e "  ${YELLOW}API Endpoints:${NC}"
    echo -e "    - GET  /api/namespaces"
    echo -e "    - GET  /api/memories"
    echo -e "    - GET  /api/keys"
    echo ""
    echo -e "  ${YELLOW}Logs:${NC}"
    echo -e "    - API:  logs/api.log"
    echo -e "    - UI:   logs/ui.log"
    echo ""
    echo -e "  Press ${YELLOW}Ctrl+C${NC} to stop all services"
    echo ""
}

# Function to cleanup on exit
cleanup() {
    print_status "Shutting down DuckBrain..."
    
    if [ -n "$API_PID" ]; then
        kill $API_PID 2>/dev/null || true
        print_status "Stopped API server"
    fi
    
    if [ -n "$UI_PID" ]; then
        kill $UI_PID 2>/dev/null || true
        print_status "Stopped UI server"
    fi
    
    print_success "DuckBrain stopped"
    exit 0
}

# Main execution
main() {
    # Create logs directory
    mkdir -p logs
    
    # Trap Ctrl+C
    trap cleanup INT TERM
    
    case "${1:-all}" in
        api|server)
            check_deps
            stop_existing
            start_api
            show_status
            print_status "API server running. Press Ctrl+C to stop."
            wait $API_PID
            ;;
        ui|web)
            check_deps
            stop_existing
            # Use existing API if running, otherwise start it
            if ! check_port $API_PORT; then
                start_api
            fi
            start_ui
            show_status
            print_status "UI server running. Press Ctrl+C to stop."
            wait $UI_PID
            ;;
        all|dev)
            check_deps
            stop_existing
            start_api
            start_ui
            show_status
            print_status "DuckBrain running. Press Ctrl+C to stop all services."
            wait
            ;;
        stop|kill)
            stop_existing
            print_success "All DuckBrain processes stopped"
            ;;
        status)
            if check_port $API_PORT; then
                print_success "API is running on port $API_PORT"
            else
                print_warning "API is not running"
            fi
            if check_port $UI_PORT; then
                print_success "UI is running on port $UI_PORT"
            else
                print_warning "UI is not running"
            fi
            ;;
        docker)
            if ! command -v docker >/dev/null 2>&1; then
                print_error "Docker is not installed"
                exit 1
            fi
            print_status "Starting DuckBrain with Docker..."
            docker-compose -f docker-compose.dev.yml up --build
            ;;
        help|--help|-h)
            echo "DuckBrain Launcher"
            echo ""
            echo "Usage: ./launch.sh [command]"
            echo ""
            echo "Commands:"
            echo "  all|dev    Start both API and UI (default)"
            echo "  api        Start only the API server"
            echo "  ui         Start only the Web UI"
            echo "  stop       Stop all running DuckBrain processes"
            echo "  status     Check if DuckBrain is running"
            echo "  docker     Start with Docker Compose"
            echo "  help       Show this help message"
            echo ""
            echo "Environment Variables:"
    echo "  DUCKBRAIN_API_PORT   API server port (default: 8490)"
    echo "  DUCKBRAIN_UI_PORT    UI dev server port (default: 8989)"
            echo ""
            echo "Examples:"
            echo "  ./launch.sh              # Start everything"
            echo "  ./launch.sh api          # Start only API"
            echo "  DUCKBRAIN_API_PORT=3000 ./launch.sh  # Use custom API port"
            ;;
        *)
            print_error "Unknown command: $1"
            print_status "Run './launch.sh help' for usage information"
            exit 1
            ;;
    esac
}

# Run main function
main "$@"
