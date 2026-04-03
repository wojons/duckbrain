#!/bin/bash
#
# Test script for DuckBrain launch system
# Run this before asking others to test
#

set -e

echo "🧪 DuckBrain Launch System Test Suite"
echo "======================================"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

test_pass() {
    echo -e "${GREEN}✓${NC} $1"
    PASS=$((PASS + 1))
}

test_fail() {
    echo -e "${RED}✗${NC} $1"
    FAIL=$((FAIL + 1))
}

# Test 1: Help command
echo "Test 1: Help command"
if ./launch.sh help | grep -q "DuckBrain Launcher"; then
    test_pass "Help command works"
else
    test_fail "Help command failed"
fi

# Test 2: Status command (should show not running initially)
echo "Test 2: Status command (initial state)"
if ./launch.sh status 2>&1 | grep -q "API is not running"; then
    test_pass "Status correctly shows API not running"
else
    test_fail "Status command unexpected output"
fi

# Test 3: API startup
echo "Test 3: API startup"
./launch.sh api &
API_PID=$!
sleep 8

if curl -s http://localhost:9444/api/namespaces > /dev/null 2>&1; then
    test_pass "API started successfully on port 9444"
else
    test_fail "API failed to start or not accessible"
fi

# Test 4: API endpoints
echo "Test 4: API endpoints"
if curl -s http://localhost:9444/api/namespaces | grep -q "\[\|{"; then
    test_pass "API /api/namespaces endpoint responds"
else
    test_fail "API endpoint not responding correctly"
fi

# Test 5: Stop command
echo "Test 5: Stop command"
./launch.sh stop > /dev/null 2>&1
sleep 3

if ! curl -s http://localhost:9444/api/namespaces > /dev/null 2>&1; then
    test_pass "Stop command successfully killed API"
else
    test_fail "Stop command failed - API still running"
    kill $API_PID 2>/dev/null || true
fi

# Test 6: Port conflict detection
echo "Test 6: Port conflict detection"
# Start something on port 9444
python3 -m http.server 9444 &
PYTHON_PID=$!
sleep 2

./launch.sh api &
API_PID=$!
sleep 8

# Check if API found alternative port or failed gracefully
if curl -s http://localhost:9445/api/namespaces > /dev/null 2>&1 || ! curl -s http://localhost:9444/api/namespaces > /dev/null 2>&1; then
    test_pass "Port conflict handled (API on different port or blocked)"
else
    test_fail "Port conflict not handled properly"
fi

# Cleanup
kill $PYTHON_PID 2>/dev/null || true
kill $API_PID 2>/dev/null || true
./launch.sh stop > /dev/null 2>&1 || true

# Test 7: Docker Compose config
echo "Test 7: Docker Compose config"
if docker-compose -f docker-compose.dev.yml config > /dev/null 2>&1; then
    test_pass "Docker Compose config is valid"
else
    test_fail "Docker Compose config has errors"
fi

# Test 8: Dockerfile.dev exists
echo "Test 8: Dockerfile.dev exists"
if [ -f "Dockerfile.dev" ]; then
    test_pass "Dockerfile.dev exists"
else
    test_fail "Dockerfile.dev missing"
fi

# Test 9: Package.json scripts
echo "Test 9: NPM scripts defined"
if grep -q '"start"' package.json && grep -q '"dev"' package.json; then
    test_pass "NPM scripts (start, dev) defined in package.json"
else
    test_fail "NPM scripts missing or incomplete"
fi

# Test 10: Log directory
echo "Test 10: Log directory creation"
if [ -d "logs" ]; then
    test_pass "Logs directory exists"
else
    test_fail "Logs directory missing"
fi

echo ""
echo "======================================"
echo "Test Results: ${PASS} passed, ${FAIL} failed"
echo "======================================"

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi
