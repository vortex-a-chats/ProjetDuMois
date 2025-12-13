#!/usr/bin/env python3
"""
Script to download OSH PBF file with OSM authentication.
This script uses oauth_cookie_client.py to get authentication cookies,
then downloads the file directly using Python requests library.
"""

import argparse
import os
import sys
import tempfile
import subprocess
import requests
from pathlib import Path

def get_cookie(osm_host, osm_user, osm_pass, consumer_url, cookie_file=None):
    """Get OSM authentication cookie using oauth_cookie_client.py"""
    script_path = Path(__file__).parent.parent / "lib" / "sendfile_osm_oauth_protector" / "oauth_cookie_client.py"
    
    if not script_path.exists():
        print(f"ERROR: oauth_cookie_client.py not found at {script_path}", file=sys.stderr)
        return None
    
    cmd = [
        "python3",
        str(script_path),
        "--osm-host", osm_host,
        "-u", osm_user,
        "-p", osm_pass,
        "-c", consumer_url,
        "-f", "http"
    ]
    
    if cookie_file:
        cmd.extend(["-o", cookie_file])
    
    try:
        # Authentication should complete within 15 seconds normally
        # Each HTTP request has a 5s timeout, so with 6-7 requests max, 15s should be enough
        # If it takes longer, there's likely a problem
        print("   => Authenticating with OSM...", flush=True)
        # Use run with stderr redirected to stdout to see progress messages
        result = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=15)
        # Print stderr output (which contains progress messages)
        if result.stderr:
            for line in result.stderr.splitlines():
                print(f"   {line}", flush=True)
        if cookie_file and Path(cookie_file).exists():
            with open(cookie_file, 'r') as f:
                cookie_value = f.read().strip()
        else:
            cookie_value = result.stdout.strip()
        
        # Verify cookie is not empty
        if not cookie_value or len(cookie_value.strip()) == 0:
            print("ERROR: Authentication returned empty cookie", file=sys.stderr)
            if result.stderr:
                print(f"Error output: {result.stderr}", file=sys.stderr)
            return None
        
        print("   => Authentication successful", flush=True)
        return cookie_value
    except subprocess.TimeoutExpired:
        print("ERROR: Authentication timeout after 15 seconds", file=sys.stderr)
        print("The OSM authentication process took too long. This may be due to:", file=sys.stderr)
        print("  - Slow or unresponsive OSM servers", file=sys.stderr)
        print("  - Network connectivity issues", file=sys.stderr)
        print("  - OSM service temporarily unavailable", file=sys.stderr)
        print("", file=sys.stderr)
        print("Please check your network connection and try again.", file=sys.stderr)
        return None
    except subprocess.CalledProcessError as e:
        print("ERROR: Failed to get OSM authentication cookie", file=sys.stderr)
        # Check for specific error patterns in stderr
        if e.stderr:
            if "HTTP code 503" in e.stderr or "503" in e.stderr:
                print("OSM service is temporarily unavailable (HTTP 503)", file=sys.stderr)
                print("Please try again in a few minutes.", file=sys.stderr)
            elif "Authentication failed" in e.stderr or "Invalid" in e.stderr:
                print("Authentication failed. Please check your OSM credentials:", file=sys.stderr)
                print("  - OSM_USER and OSM_PASS in config.json", file=sys.stderr)
            else:
                print(f"Error details: {e.stderr}", file=sys.stderr)
        else:
            print(f"Exit code: {e.returncode}", file=sys.stderr)
        return None


def download_file(url, output_file, cookie_value, chunk_size=8192):
    """Download file from URL using cookie authentication"""
    headers = {
        "Cookie": cookie_value,
        "User-Agent": "download_osh_pbf.py"
    }
    
    try:
        # Check if file exists and get its size for resume support
        file_size = 0
        resume_header = {}
        if os.path.exists(output_file) and os.path.getsize(output_file) > 0:
            file_size = os.path.getsize(output_file)
            resume_header["Range"] = f"bytes={file_size}-"
            print(f"   => Resuming download from byte {file_size}")
        
        # Use a longer timeout for large file downloads
        # Connect timeout: time to establish connection (120 seconds)
        # Read timeout: time between data chunks (None = no timeout for streaming)
        # This allows for slow connections and large files
        response = requests.get(url, headers={**headers, **resume_header}, stream=True, timeout=(120, None))
        
        # Handle different status codes
        if response.status_code == 404:
            print(f"ERROR: File not found (404) at URL: {url}", file=sys.stderr)
            print("This usually means the URL is incorrect.", file=sys.stderr)
            return False
        elif response.status_code == 403:
            print(f"ERROR: Access forbidden (403) at URL: {url}", file=sys.stderr)
            print("This usually means authentication failed or the cookie is invalid.", file=sys.stderr)
            return False
        elif response.status_code == 206:
            # Partial content - resume download
            mode = "ab"
        elif response.status_code == 200:
            # Full download
            mode = "wb"
            file_size = 0  # Reset if we're doing a full download
        else:
            print(f"ERROR: Unexpected HTTP status code: {response.status_code}", file=sys.stderr)
            print(f"Response: {response.text[:500]}", file=sys.stderr)
            return False
        
        # Check if response is HTML (error page)
        content_type = response.headers.get("Content-Type", "")
        if "text/html" in content_type or "text/plain" in content_type:
            content_preview = response.text[:500]
            print(f"ERROR: Server returned HTML/text instead of PBF file", file=sys.stderr)
            print(f"Content preview: {content_preview}", file=sys.stderr)
            print("This usually means authentication failed or the URL is incorrect.", file=sys.stderr)
            return False
        
        # Get total size if available
        total_size = response.headers.get("Content-Length")
        if total_size:
            total_size = int(total_size) + file_size
        
        # Download file
        downloaded = file_size
        with open(output_file, mode) as f:
            for chunk in response.iter_content(chunk_size=chunk_size):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size:
                        percent = (downloaded / total_size) * 100
                        print(f"\r   => Downloaded: {downloaded / (1024*1024):.1f} MB / {total_size / (1024*1024):.1f} MB ({percent:.1f}%)", end="", flush=True)
        
        print()  # New line after progress
        return True
        
    except requests.exceptions.Timeout as e:
        print(f"ERROR: Connection timeout during download: {e}", file=sys.stderr)
        print("The connection to the server timed out. This may be due to:", file=sys.stderr)
        print("  - Slow network connection", file=sys.stderr)
        print("  - Server is slow to respond", file=sys.stderr)
        print("  - Large file taking too long to start downloading", file=sys.stderr)
        return False
    except requests.exceptions.RequestException as e:
        print(f"ERROR: Network error during download: {e}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"ERROR: Unexpected error during download: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description="Download OSH PBF file with OSM authentication")
    parser.add_argument("--osm-host", required=True, help="OSM host URL (e.g., https://www.openstreetmap.org)")
    parser.add_argument("--osm-user", required=True, help="OSM username")
    parser.add_argument("--osm-pass", required=True, help="OSM password")
    parser.add_argument("--url", required=True, help="OSH PBF file URL to download")
    parser.add_argument("--output", required=True, help="Output file path")
    parser.add_argument("--work-dir", help="Working directory for temporary files")
    
    args = parser.parse_args()
    
    # Determine consumer URL from OSH PBF URL
    # e.g., https://osm-internal.download.geofabrik.de/europe/reunion-internal.osh.pbf
    # -> https://osm-internal.download.geofabrik.de/get_cookie
    url_parts = args.url.split("/")
    if len(url_parts) < 3:
        print(f"ERROR: Invalid URL format: {args.url}", file=sys.stderr)
        return 1
    
    consumer_url = f"{url_parts[0]}//{url_parts[2]}/get_cookie"
    
    # Create work directory if specified
    if args.work_dir:
        os.makedirs(args.work_dir, exist_ok=True)
        cookie_file = os.path.join(args.work_dir, "cookie.txt")
    else:
        cookie_file = None
    
    # Get authentication cookie
    print("== Getting OSM authentication cookie...")
    cookie_value = get_cookie(args.osm_host, args.osm_user, args.osm_pass, consumer_url, cookie_file)
    
    if not cookie_value:
        print("ERROR: Failed to obtain authentication cookie", file=sys.stderr)
        return 1
    
    print("   => Authentication cookie obtained successfully")
    
    # Download file
    print(f"== Downloading OSH PBF file from: {args.url}")
    success = download_file(args.url, args.output, cookie_value)
    
    if not success:
        print("ERROR: Failed to download OSH PBF file", file=sys.stderr)
        return 1
    
    # Verify downloaded file
    if not os.path.exists(args.output) or os.path.getsize(args.output) == 0:
        print("ERROR: Downloaded file is empty or missing", file=sys.stderr)
        return 1
    
    file_size = os.path.getsize(args.output)
    print(f"   => Download completed successfully: {file_size / (1024*1024*1024):.2f} GB")
    
    # Clean up cookie file if it was created
    if cookie_file and os.path.exists(cookie_file):
        os.remove(cookie_file)
    
    return 0


if __name__ == "__main__":
    sys.exit(main())

