"""Local dev server for the waveform player that stops the browser reusing stale files.

Python's built-in `python -m http.server` sends no Cache-Control header, so browsers
may keep running old JS modules after they're edited. This adds `Cache-Control: no-cache`,
which makes the browser re-check every file on each load (unchanged files still come
back as a quick 304 Not Modified).

Usage: python serve.py [port]   (default 8000)
"""
import functools
import http.server
import sys
from pathlib import Path


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
handler = functools.partial(NoCacheHandler, directory=Path(__file__).parent)
with http.server.ThreadingHTTPServer(("", port), handler) as httpd:
    print(f"Serving on http://localhost:{port}/")
    httpd.serve_forever()
