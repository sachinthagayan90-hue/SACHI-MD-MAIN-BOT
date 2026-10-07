import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

process.env.PORT = process.env.PORT || "20064";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN_DIR = path.join(__dirname, ".cloudflared-bin");
const BIN = path.join(BIN_DIR, "cloudflared");
const URL_FILE = path.join(__dirname, "quick_tunnel_url.txt");

let tunnel = null;
let stopping = false;
let retryTimer = null;
let retryDelay = 3000;

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "SACHi-MD" } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) {
        const loc = res.headers.location;
        res.resume();
        if (!loc) return reject(new Error("redirect missing"));
        return download(new URL(loc, url).toString(), dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`download HTTP ${res.statusCode}`));
      }
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on("finish", () => f.close(resolve));
      f.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("download timeout")));
  });
}

async function ensureCloudflared() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  if (fs.existsSync(BIN)) {
    fs.chmodSync(BIN, 0o755);
    return;
  }
  const arch = os.arch();
  const asset =
    arch === "arm64" ? "cloudflared-linux-arm64" :
    arch === "arm" ? "cloudflared-linux-arm" :
    "cloudflared-linux-amd64";
  console.log(`[QUICK TUNNEL] Downloading ${asset}...`);
  await download(
    `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
    BIN
  );
  fs.chmodSync(BIN, 0o755);
}

function extractUrl(text) {
  const m = String(text).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/ig);
  return m ? m[0] : null;
}

function publishUrl(url) {
  if (!url) return;
  fs.writeFileSync(URL_FILE, url + "\n");
  console.log("");
  console.log("==============================================");
  console.log("   SACHi-MD WEB ADMIN HTTPS URL READY");
  console.log("==============================================");
  console.log(`[QUICK TUNNEL URL] ${url}`);
  console.log("==============================================");
  console.log("");
}

function scheduleRetry(reason) {
  if (stopping || retryTimer) return;
  console.log(`[QUICK TUNNEL] ${reason}. Retrying in ${Math.ceil(retryDelay / 1000)}s...`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    startTunnel().catch(err => {
      console.error("[QUICK TUNNEL] Retry failed:", err?.message || err);
      scheduleRetry("retry failed");
    });
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30000);
}

async function startTunnel() {
  if (stopping || tunnel) return;

  await ensureCloudflared();
  try { fs.unlinkSync(URL_FILE); } catch {}

  console.log(`[QUICK TUNNEL] Starting: cloudflared tunnel --url http://127.0.0.1:${process.env.PORT}`);
  console.log("[QUICK TUNNEL] Waiting for Cloudflare to issue the public URL...");

  // Do NOT use --logfile here. The Quick Tunnel hostname is printed by
  // cloudflared after it receives the hostname from api.trycloudflare.com.
  // Keeping stdout/stderr attached guarantees we can capture that line.
  tunnel = spawn(
    BIN,
    [
      "tunnel",
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${process.env.PORT}`
    ],
    {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  const handle = chunk => {
    const text = String(chunk || "");
    process.stdout.write(text);
    const url = extractUrl(text);
    if (url) {
      publishUrl(url);
      retryDelay = 3000;
    }
  };

  tunnel.stdout.on("data", handle);
  tunnel.stderr.on("data", handle);

  tunnel.on("error", err => {
    tunnel = null;
    console.error("[QUICK TUNNEL] Process error:", err?.message || err);
    scheduleRetry("cloudflared process error");
  });

  tunnel.on("exit", (code, signal) => {
    tunnel = null;
    if (!stopping) {
      scheduleRetry(`cloudflared exited (code=${code}, signal=${signal || "none"})`);
    }
  });
}

async function main() {
  console.log("[SACHi-MD] Starting backend...");
  await import("./index.js");
  console.log(`[SACHi-MD] Backend loaded on port ${process.env.PORT}.`);
  await new Promise(r => setTimeout(r, 1500));

  try {
    await startTunnel();
  } catch (err) {
    console.error("[QUICK TUNNEL] Initial start failed:", err?.message || err);
    scheduleRetry("initial start failed");
  }
}

function shutdown() {
  stopping = true;
  if (retryTimer) clearTimeout(retryTimer);
  try { tunnel?.kill("SIGTERM"); } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch(err => {
  console.error("[SACHi-MD] FATAL:", err);
  process.exit(1);
});
