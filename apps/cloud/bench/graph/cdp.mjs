// Minimal headless-Chrome driver over the DevTools protocol (Node >= 22's
// global WebSocket) plus a static server for the built bench harness — shared
// by scripts/graph-perf.mjs and scripts/e2e-graph.mjs. No puppeteer needed.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const CHROME_CANDIDATES = [
	process.env.CHROME_BIN,
	"/usr/bin/google-chrome-stable",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export function findChrome() {
	return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

/** Serve `dir` on an ephemeral loopback port. */
export async function serveDir(dir) {
	const server = createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		let file = path.join(dir, decodeURIComponent(url.pathname));
		if (!file.startsWith(dir) || !existsSync(file) || url.pathname === "/") file = path.join(dir, "index.html");
		res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
		res.end(readFileSync(file));
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** Launch headless Chrome and return a CDP session attached to one page. */
export async function launch({ width = 1600, height = 1000, headless = true } = {}) {
	const bin = findChrome();
	if (!bin) throw new Error("no Chrome/Chromium found (set CHROME_BIN)");
	const userDir = mkdtempSync(path.join(tmpdir(), "brainz-graph-chrome-"));
	const args = [
		`--user-data-dir=${userDir}`,
		"--remote-debugging-port=0",
		`--window-size=${width},${height}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-background-timer-throttling",
		"--disable-renderer-backgrounding",
		"--disable-backgrounding-occluded-windows",
		"about:blank",
	];
	if (headless) args.unshift("--headless=new");
	// Extra flags, e.g. CHROME_FLAGS="--use-angle=vulkan --ignore-gpu-blocklist" for GPU raster.
	if (process.env.CHROME_FLAGS) args.unshift(...process.env.CHROME_FLAGS.split(/\s+/).filter(Boolean));
	const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
	const wsUrl = await new Promise((resolve, reject) => {
		let buf = "";
		const t = setTimeout(() => reject(new Error("Chrome did not start")), 20_000);
		proc.stderr.on("data", (d) => {
			buf += d;
			const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
			if (m) {
				clearTimeout(t);
				resolve(m[1]);
			}
		});
		proc.on("exit", (code) => reject(new Error(`Chrome exited (${code})`)));
	});
	const port = new URL(wsUrl).port;
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const pageTarget = targets.find((t) => t.type === "page");
	const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
	await new Promise((r, j) => {
		ws.onopen = r;
		ws.onerror = j;
	});
	let nextId = 1;
	const pending = new Map();
	const listeners = new Map();
	ws.onmessage = (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) reject(new Error(`${msg.error.message}`));
			else resolve(msg.result);
		} else if (msg.method) {
			for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
		}
	};
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});
	const on = (method, fn) => {
		if (!listeners.has(method)) listeners.set(method, []);
		listeners.get(method).push(fn);
	};
	await send("Page.enable");
	await send("Runtime.enable");
	await send("Performance.enable");
	await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

	/** Evaluate an expression in the page (awaits promises, returns by value). */
	async function evaluate(expression) {
		const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
		return res.result.value;
	}
	async function navigate(url) {
		const loaded = new Promise((r) => on("Page.loadEventFired", r));
		await send("Page.navigate", { url });
		await loaded;
	}
	async function screenshot(file) {
		const { data } = await send("Page.captureScreenshot", { format: "png" });
		const { writeFileSync } = await import("node:fs");
		writeFileSync(file, Buffer.from(data, "base64"));
	}
	const mouse = (type, x, y, extra = {}) =>
		send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
	async function click(x, y) {
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
		await mouse("mousePressed", x, y);
		await mouse("mouseReleased", x, y);
	}
	const wheel = (x, y, deltaY) => send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
	async function metrics() {
		const { metrics } = await send("Performance.getMetrics");
		return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
	}
	async function close() {
		try {
			ws.close();
		} catch {
			/* already closed */
		}
		proc.kill("SIGKILL");
		await new Promise((r) => setTimeout(r, 200));
		rmSync(userDir, { recursive: true, force: true });
	}
	return { send, on, evaluate, navigate, screenshot, mouse, click, wheel, metrics, close, width, height };
}
