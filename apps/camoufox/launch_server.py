"""
Camoufox Playwright WS server wrapper.

The `python -m camoufox server` CLI doesn't accept --host/--port flags
(it would expose only on localhost, which is useless from another Docker
container). We call the programmatic API and pass host/port through to
Playwright's launchServer.

The companion Dockerfile pins playwright==1.49.1 because newer versions
removed `browserServerImpl.js` from the bundled Node driver, which
camoufox 0.4's launchServer wrapper still requires.
"""
import os
import sys
from camoufox.server import launch_server


def main() -> None:
    port = int(os.environ.get("CAMOUFOX_SERVER_PORT", "1337"))
    host = os.environ.get("CAMOUFOX_SERVER_HOST", "0.0.0.0")
    sys.stdout.write(f"[camoufox] launching Playwright server on ws://{host}:{port}\n")
    sys.stdout.flush()
    # launch_server() forwards **kwargs to Playwright BrowserType.launchServer.
    # `ws_path` (custom WS path) replaces Playwright's default random UUID token,
    # so callers can connect via a predictable URL (ws://camoufox:1337/ws).
    # Without it, Playwright generates a fresh UUID at every start that nobody
    # can know upfront → 400 Bad Request from chromium.connect("ws://camoufox:1337").
    # `headless=True` is required for a containerized server (no display).
    # `geoip=True` enables geo-coherent fingerprint (locale/timezone matched
    # to the egress IP); harmless if geoip data isn't cached yet.
    launch_server(host=host, port=port, ws_path="ws", headless=True, geoip=True)


if __name__ == "__main__":
    main()
