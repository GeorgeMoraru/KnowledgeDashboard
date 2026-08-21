"""CDP screenshot sweep for KnowledgeDashboard.

Drives a headless Chrome over the DevTools protocol against a running
kb_server.py --static-dir, emulating a set of viewports and capturing each
view (cards / list / graph) plus the light theme. Also reports any console
errors or page exceptions seen along the way.

Usage: python tools/cdp_sweep.py [base_url] [out_dir]

Requires `websocket-client`. Chrome is located via $CHROME_BIN when the default
Windows install path does not apply.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

import websocket

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7650"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.environ.get("TEMP", "/tmp"), "kbshots")
CHROME = os.environ.get("CHROME_BIN", r"C:\Program Files\Google\Chrome\Application\chrome.exe")
PORT = int(os.environ.get("CDP_PORT", "9333"))

VIEWPORTS = [
    ("mobile-430x900", 430, 900, 2.0, True),
    ("mobile-390x844", 390, 844, 3.0, True),
    ("mobile-360x740", 360, 740, 3.0, True),
    ("tablet-768x1024", 768, 1024, 2.0, True),
]


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=60)
        self.id = 0
        self.events = []

    def send(self, method, **params):
        self.id += 1
        self.ws.send(json.dumps({"id": self.id, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.id:
                if "error" in msg:
                    raise RuntimeError("%s -> %s" % (method, msg["error"]))
                return msg.get("result", {})
            if "method" in msg:
                self.events.append(msg)

    def pump(self, seconds):
        end = time.time() + seconds
        self.ws.settimeout(0.4)
        while time.time() < end:
            try:
                msg = json.loads(self.ws.recv())
            except Exception:
                continue
            if "method" in msg:
                self.events.append(msg)
        self.ws.settimeout(60)

    def eval(self, expr, await_promise=False):
        r = self.send("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=await_promise)
        res = r.get("result", {})
        if r.get("exceptionDetails"):
            return {"__exception": str(r["exceptionDetails"].get("text"))}
        return res.get("value")

    def shot(self, path):
        r = self.send("Page.captureScreenshot", format="png", captureBeyondViewport=False)
        import base64
        with open(path, "wb") as f:
            f.write(base64.b64decode(r["data"]))


def main():
    os.makedirs(OUT, exist_ok=True)
    profile = os.path.join(OUT, "_profile")
    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         "--remote-debugging-port=%d" % PORT, "--user-data-dir=" + profile,
         "--no-first-run", "--no-default-browser-check",
         "--remote-allow-origins=*", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ws_url = None
        for _ in range(60):
            try:
                data = json.loads(urllib.request.urlopen(
                    "http://127.0.0.1:%d/json/list" % PORT, timeout=3).read().decode())
                pages = [t for t in data if t.get("type") == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                time.sleep(0.5)
        if not ws_url:
            print("FAIL: chrome devtools never came up")
            return 1

        cdp = CDP(ws_url)
        cdp.send("Page.enable")
        cdp.send("Runtime.enable")
        cdp.send("Log.enable")

        report = []
        for name, w, h, dsf, mobile in VIEWPORTS:
            cdp.send("Emulation.setDeviceMetricsOverride", width=w, height=h,
                     deviceScaleFactor=dsf, mobile=mobile)
            cdp.send("Emulation.setTouchEmulationEnabled", enabled=mobile, maxTouchPoints=5)
            # Fresh load per viewport so first-paint layout is what we capture.
            cdp.eval("localStorage.setItem('kb_base_url', %s); "
                     "localStorage.setItem('sh_kb_theme','dark')" % json.dumps(BASE))
            cdp.send("Page.navigate", url=BASE + "/index.html")
            cdp.pump(2)
            # Wait for the payload to land.
            ready = False
            for _ in range(60):
                n = cdp.eval("(window.__kbNoteCount !== undefined) ? window.__kbNoteCount : "
                             "document.querySelectorAll('.sh-result-card').length")
                if isinstance(n, (int, float)) and n > 0:
                    ready = True
                    break
                cdp.pump(1)
            cdp.pump(1.5)

            metrics = cdp.eval("""(() => {
              const q = s => document.querySelector(s);
              const r = s => { const e = q(s); return e ? e.getBoundingClientRect() : null; };
              const box = s => { const b = r(s); return b ? {w: Math.round(b.width), h: Math.round(b.height),
                                  top: Math.round(b.top), left: Math.round(b.left)} : null; };
              const bar = q('.app-topbar');
              return {
                cards: document.querySelectorAll('.sh-result-card').length,
                topbar: box('.app-topbar'),
                topbarWraps: bar ? bar.scrollHeight > bar.clientHeight + 1 : null,
                hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
                scrollW: document.documentElement.scrollWidth,
                innerW: window.innerWidth,
                sidebarFooterVisible: (() => { const b = r('.sidebar-footer'); return b ? b.bottom <= window.innerHeight + 1 : null; })(),
                readonly: document.body.classList.contains('kb-readonly'),
                pill: (q('#kbSourceLabel') || {}).textContent || null,
              };
            })()""")
            report.append((name, "load", ready, metrics))
            cdp.shot(os.path.join(OUT, "%s-01-cards.png" % name))

            # List view
            cdp.eval("window.switchView && window.switchView('list');"
                     "(document.getElementById('listView')||{scrollIntoView(){}}).scrollIntoView({block:'start'})")
            cdp.pump(1.2)
            cdp.shot(os.path.join(OUT, "%s-02-list.png" % name))

            # Graph view (legend is the thing under review)
            cdp.eval("window.switchView && window.switchView('graph');"
                     "(document.querySelector('.modern-graph-container')||{scrollIntoView(){}}).scrollIntoView({block:'center'})")
            cdp.pump(3)
            legend = cdp.eval("""(() => {
              const box = document.getElementById('graphLegend');
              if (!box) return null;
              const b = box.getBoundingClientRect();
              const items = [...box.querySelectorAll('.sh-graph-legend-item')];
              const gc = document.querySelector('.modern-graph-container');
              const gb = gc ? gc.getBoundingClientRect() : null;
              const tb = document.querySelector('.graph-floating-toolbar');
              const tbb = tb ? tb.getBoundingClientRect() : null;
              const overlap = (a, c) => !!(a && c) && !(a.right < c.left || c.right < a.left || a.bottom < c.top || c.bottom < a.top);
              return {
                w: Math.round(b.width), h: Math.round(b.height),
                items: items.length,
                title: !!box.querySelector('.graph-legend-title'),
                more: (box.querySelector('.graph-legend-more') || {}).textContent || null,
                overflowsContainer: gb ? (b.right > gb.right + 1 || b.bottom > gb.bottom + 1) : null,
                labelClipped: items.some(i => { const l = i.querySelector('.legend-label'); return l && l.scrollWidth > l.clientWidth + 1; }),
                itemWraps: items.some(i => i.getBoundingClientRect().height > 24),
                overlapsToolbar: overlap(b, tbb),
                scrolls: box.scrollHeight > box.clientHeight + 1,
              };
            })()""")
            report.append((name, "graph-legend", None, legend))
            cdp.shot(os.path.join(OUT, "%s-03-graph.png" % name))

            # Light theme, back on cards
            cdp.eval("window.toggleTheme && window.toggleTheme(); window.switchView && window.switchView('cards')")
            cdp.pump(1.5)
            themeMeta = cdp.eval("(document.querySelector('meta[name=\\'theme-color\\']')||{}).content || null")
            report.append((name, "light-theme-color", None, themeMeta))
            cdp.shot(os.path.join(OUT, "%s-04-cards-light.png" % name))

            cdp.eval("window.switchView && window.switchView('graph');"
                     "(document.querySelector('.modern-graph-container')||{scrollIntoView(){}}).scrollIntoView({block:'center'})")
            cdp.pump(2.5)
            cdp.shot(os.path.join(OUT, "%s-05-graph-light.png" % name))
            cdp.eval("window.toggleTheme && window.toggleTheme()")
            cdp.pump(0.5)

        # Console / exception harvest
        problems = []
        for ev in cdp.events:
            m = ev.get("method")
            if m == "Runtime.exceptionThrown":
                d = ev["params"]["exceptionDetails"]
                problems.append("EXCEPTION: " + str(d.get("text")) + " " +
                                str((d.get("exception") or {}).get("description", ""))[:200])
            elif m == "Runtime.consoleAPICalled" and ev["params"].get("type") in ("error", "warning"):
                args = " ".join(str(a.get("value", a.get("description", "")))
                                for a in ev["params"].get("args", []))[:300]
                problems.append("CONSOLE %s: %s" % (ev["params"]["type"], args))
            elif m == "Log.entryAdded" and ev["params"]["entry"].get("level") == "error":
                problems.append("LOG error: " + str(ev["params"]["entry"].get("text"))[:300])

        print("=== SWEEP REPORT ===")
        for name, kind, ready, data in report:
            print("[%s] %s ready=%s" % (name, kind, ready))
            print("   " + json.dumps(data))
        print("=== CONSOLE (%d) ===" % len(problems))
        for p in problems[:40]:
            print("  " + p)
        print("=== SHOTS in %s ===" % OUT)
        for f in sorted(os.listdir(OUT)):
            if f.endswith(".png"):
                print("  " + f)
        return 0
    finally:
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
