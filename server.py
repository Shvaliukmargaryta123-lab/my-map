from __future__ import annotations

import json
import html
import re
import time
import os
import threading
import urllib.request
import urllib.parse
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8767"))
ROOT = Path(__file__).resolve().parent
NEPTUN_ALERTS_URL = "https://neptun.in.ua/api/v1/alerts"
NEPTUN_THREATS_URL = "https://neptun.in.ua/api/v1/threats"
NEPTUN_OBLASTS_GEOJSON_URL = "https://neptun.in.ua/oblasts.geojson"
NEPTUN_RAIONS_GEOJSON_URL = "https://neptun.in.ua/raions.geojson"
TELEGRAM_PUBLIC_URL = "https://t.me/s/zaliznenebo"
TELEGRAM_CACHE = {"timestamp": 0.0, "items": []}


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        clean = path.split("?", 1)[0].split("#", 1)[0]
        relative = clean.lstrip("/") or "index.html"
        return str(ROOT / relative)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self) -> None:
        route = self.path.split("?", 1)[0]
        if route == "/api/alerts":
            self.proxy_json(NEPTUN_ALERTS_URL)
            return
        if route == "/api/threats":
            self.proxy_json(NEPTUN_THREATS_URL)
            return
        if route == "/api/oblasts-geojson":
            self.proxy_json(NEPTUN_OBLASTS_GEOJSON_URL)
            return
        if route == "/api/raions-geojson":
            self.proxy_json(NEPTUN_RAIONS_GEOJSON_URL)
            return
        if route == "/api/city-search":
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("q", [""])[0].strip()
            if not query or len(query) > 120:
                self.send_json({"error": "Вкажіть назву міста до 120 символів."}, 400)
                return
            # Photon rejects lang=uk with HTTP 400; let it choose its default
            # language while keeping Ukrainian search terms unchanged.
            params = urllib.parse.urlencode({"q": query, "limit": 12})
            self.proxy_json(f"https://photon.komoot.io/api/?{params}")
            return
        if route == "/api/telegram-news":
            self.telegram_news()
            return
        if route == "/api/telegram-launches":
            self.telegram_launches()
            return
        super().do_GET()

    def load_telegram_items(self) -> list[dict[str, str]]:
        now = time.time()
        if TELEGRAM_CACHE["items"] and now - TELEGRAM_CACHE["timestamp"] < 8:
            return TELEGRAM_CACHE["items"]
        request = urllib.request.Request(
            TELEGRAM_PUBLIC_URL,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
                "Accept-Language": "uk-UA,uk;q=0.9,en;q=0.7",
            },
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            page = response.read().decode("utf-8", errors="replace")
        blocks = re.findall(
            r'<div class="tgme_widget_message_wrap[^>]*>(.*?)<div class="tgme_widget_message_footer',
            page,
            flags=re.S,
        )
        parsed = []
        for block in blocks:
            post_match = re.search(r'data-post="([^"]+)"', block)
            text_match = re.search(r'<div class="tgme_widget_message_text[^>]*>(.*?)</div>', block, flags=re.S)
            time_match = re.search(r'<time[^>]+datetime="([^"]+)"', block)
            if not post_match or not text_match:
                continue
            raw_text = re.sub(r'<br\s*/?>', '\n', text_match.group(1), flags=re.I)
            raw_text = re.sub(r'<[^>]+>', '', raw_text)
            clean_text = html.unescape(raw_text).strip()
            clean_text = re.sub(r'\n{3,}', '\n\n', clean_text)
            if clean_text:
                parsed.append({
                    "text": clean_text,
                    "datetime": time_match.group(1) if time_match else "",
                    "url": "https://t.me/" + post_match.group(1),
                })
        items = parsed[-30:]
        TELEGRAM_CACHE["timestamp"] = now
        TELEGRAM_CACHE["items"] = items
        return items

    def send_telegram_items(self, items: list[dict[str, str]], status: int = 200) -> None:
        body = json.dumps({"channel": "zaliznenebo", "items": items}, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def telegram_news(self) -> None:
        try:
            # The public Telegram preview contains the latest posts exposed to
            # unauthenticated readers; return all of the locally parsed feed.
            self.send_telegram_items(self.load_telegram_items()[-30:])
        except Exception as exc:
            self.send_telegram_items(TELEGRAM_CACHE["items"][-10:], 200 if TELEGRAM_CACHE["items"] else 502)

    def telegram_launches(self) -> None:
        try:
            items = self.load_telegram_items()
            launch_terms = re.compile(r"пуск\w*|зліт\w*|злет\w*|запуск\w*|виліт\w*|старт\w*", re.I)
            uav_terms = re.compile(r"бпла|б\s*п\s*л\s*а|шахед|shahed|герань|дрон|uav|мопед", re.I)
            launches = []
            origins = [
                (r"(?:з|із|из|from)\s+(?:м\.?\s*)?орл(?:а|е|у)?\b|орлов(?:ської|ской|ская|ськ\w*)\s+област", {"label": "Орловська область", "lat": 52.97, "lon": 36.07}),
                (r"(?:з|із|из|from)\s+(?:м\.?\s*)?курськ(?:а|у)?\b|курськ\w*\s+област", {"label": "Курська область", "lat": 51.73, "lon": 36.19}),
                (r"(?:з|із|из|from)\s+(?:м\.?\s*)?брянськ(?:а|у)?\b|брянськ\w*\s+област", {"label": "Брянська область", "lat": 53.24, "lon": 34.36}),
                (r"(?:з|із|из|from)\s+(?:м\.?\s*)?бєлгород(?:а|у)?\b|белгород\w*\s+област", {"label": "Бєлгородська область", "lat": 50.60, "lon": 36.59}),
                (r"(?:з|із|из|from)\s+(?:м\.?\s*)?міллеров(?:а|о)?\b|миллеров(?:о|а)", {"label": "район Міллерова", "lat": 48.92, "lon": 40.40}),
                (r"приморсько[- ]ахтарськ\w*|приморско[- ]ахтарск\w*", {"label": "район Приморсько-Ахтарська", "lat": 46.05, "lon": 38.17}),
                (r"(?:з|із|из|from)\s+(?:м\.?\s*)?єйськ(?:а|у)?\b|(?:з|из)\s+ейськ(?:а|у)?\b", {"label": "район Єйська", "lat": 46.71, "lon": 38.28}),
                (r"чауд\w*|кримськ\w*\s+півостров|крымск\w*\s+полуостров", {"label": "Кримський півострів", "lat": 45.20, "lon": 34.10}),
            ]
            for item in items:
                if not launch_terms.search(item["text"]) or not uav_terms.search(item["text"]):
                    continue
                entry = dict(item)
                entry["origin"] = next((place for pattern, place in origins if re.search(pattern, item["text"], re.I)), None)
                launches.append(entry)
            self.send_telegram_items(launches[-6:])
        except Exception as exc:
            body = json.dumps({"error": str(exc), "channel": "zaliznenebo", "items": []}, ensure_ascii=False).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def proxy_json(self, url: str) -> None:
        try:
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Ukraine-Tactical-Radar/1.0",
                    "Accept": "application/json",
                },
            )
            with urllib.request.urlopen(request, timeout=12) as response:
                body = response.read()
            json.loads(body.decode("utf-8"))
            self.send_json(json.loads(body.decode("utf-8")))
        except Exception as exc:
            self.send_json({"error": str(exc)}, 502)

    def send_json(self, data: object, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        print(fmt % args)


def main() -> None:
    os.chdir(ROOT)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print(f"Карта запущена: {url}")
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
