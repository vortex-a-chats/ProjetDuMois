#!/bin/bash
# Helper script to open error HTML files in Firefox
# Usage: ./open_error_in_firefox.sh <container_name> <file_path_in_container>

CONTAINER_NAME=${1:-pdm}
FILE_PATH=${2:-/tmp/pdm/auth_error.html}

if [ -z "$FILE_PATH" ]; then
    echo "Usage: $0 [container_name] <file_path_in_container>"
    echo "Example: $0 pdm /tmp/pdm/auth_error.html"
    exit 1
fi

# Extract filename from path
FILENAME=$(basename "$FILE_PATH")
OUTPUT_FILE="./${FILENAME}"

echo "Extracting $FILE_PATH from container $CONTAINER_NAME..."
docker-compose exec -T "$CONTAINER_NAME" cat "$FILE_PATH" > "$OUTPUT_FILE" 2>/dev/null

if [ -f "$OUTPUT_FILE" ] && [ -s "$OUTPUT_FILE" ]; then
    echo "File saved to $OUTPUT_FILE"
    echo "Opening in Firefox..."
    if command -v firefox >/dev/null 2>&1; then
        firefox "file://$(realpath "$OUTPUT_FILE")" 2>/dev/null &
        echo "Firefox opened with error page"
    else
        echo "Firefox not found. Please open manually: file://$(realpath "$OUTPUT_FILE")"
    fi
else
    echo "Error: Could not extract file from container"
    exit 1
fi

