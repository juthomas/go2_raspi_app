/**
 * GO2 Mobile Companion — interface web (PWA-friendly) pour le Pi.
 * - WebSocket vers go2_lidar_ws_bridge.py
 * - Enregistrement audio (MediaRecorder) avec horodatage pour alignement futur
 */

import "./style.css";

const WS_DEFAULT = () => {
  const { protocol, hostname } = window.location;
  const wsProto = protocol === "https:" ? "wss:" : "ws:";
  // Sur téléphone : remplacer par l'IP du Pi (ex: 192.168.1.x)
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `${wsProto}//127.0.0.1:8765`;
  }
  return `${wsProto}//${hostname}:8765`;
};

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

const root = document.getElementById("app");
root.appendChild(
  el(`
  <div>
    <h1>GO2 Companion</h1>
    <p class="sub">LiDAR (WebSocket) + audio — à lancer sur le Raspberry Pi avec <code>npm run dev</code></p>

    <div class="card">
      <label for="ws-url">URL WebSocket LiDAR</label>
      <input id="ws-url" type="text" autocomplete="off" spellcheck="false" />
      <div class="row">
        <button type="button" class="primary" id="btn-ws-connect">Connecter</button>
        <button type="button" id="btn-ws-disconnect" disabled>Déconnecter</button>
      </div>
      <div id="ws-status" class="status">Déconnecté</div>
    </div>

    <div class="card">
      <label>Aperçu nuage (projection XY, sous-échantillon)</label>
      <canvas id="canvas" width="400" height="220"></canvas>
      <div id="metrics" class="metrics"></div>
    </div>

    <div class="card">
      <label>Audio (micro du téléphone / tablette)</label>
      <div class="row">
        <button type="button" class="primary" id="btn-rec-start">Enregistrer</button>
        <button type="button" class="danger" id="btn-rec-stop" disabled>Stop</button>
      </div>
      <div id="rec-status" class="status">Prêt</div>
      <p class="hint">Les horodatages <code>performance.now()</code> sont loggés dans la console et dans le dernier export JSON.</p>
    </div>
  </div>
`)
);

const $wsUrl = root.querySelector("#ws-url");
const $btnConnect = root.querySelector("#btn-ws-connect");
const $btnDisconnect = root.querySelector("#btn-ws-disconnect");
const $wsStatus = root.querySelector("#ws-status");
const $canvas = root.querySelector("#canvas");
const $metrics = root.querySelector("#metrics");
const $btnRecStart = root.querySelector("#btn-rec-start");
const $btnRecStop = root.querySelector("#btn-rec-stop");
const $recStatus = root.querySelector("#rec-status");

$wsUrl.value = localStorage.getItem("go2_ws_url") || WS_DEFAULT();

let ws = null;
let lastFrame = null;
let frames = 0;
const ctx = $canvas.getContext("2d");

function setWsStatus(text, ok) {
  $wsStatus.textContent = text;
  $wsStatus.className = "status " + (ok === true ? "ok" : ok === false ? "err" : "");
}

function drawPoints(points) {
  const w = $canvas.width;
  const h = $canvas.height;
  ctx.fillStyle = "#010409";
  ctx.fillRect(0, 0, w, h);
  if (!points || !points.length) return;

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  const step = Math.max(1, Math.floor(points.length / 8000));
  for (let i = 0; i < points.length; i += step) {
    const p = points[i];
    if (!p || p.length < 2) continue;
    const x = p[0],
      y = p[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return;

  const pad = 8;
  const rx = maxX - minX || 1;
  const ry = maxY - minY || 1;
  const sx = (w - 2 * pad) / rx;
  const sy = (h - 2 * pad) / ry;
  const scale = Math.min(sx, sy);

  ctx.fillStyle = "#58a6ff";
  for (let i = 0; i < points.length; i += step) {
    const p = points[i];
    if (!p || p.length < 2) continue;
    const x = p[0],
      y = p[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const px = pad + (x - minX) * scale;
    const py = h - pad - (y - minY) * scale;
    ctx.fillRect(px, py, 1.5, 1.5);
  }
}

function onWsMessage(ev) {
  try {
    const data = JSON.parse(ev.data);
    if (data.type === "hello") {
      setWsStatus(`Connecté — topic ${data.topic} @ ${data.iface}`, true);
      return;
    }
    if (data.type === "go2_pointcloud") {
      lastFrame = data;
      frames++;
      const n = data.points?.length ?? 0;
      const st = data.stamp;
      $metrics.textContent = JSON.stringify(
        {
          frames_recues: frames,
          points: n,
          stamp,
          recv_mono: data.recv_mono,
          frame_id: data.frame_id,
          decode_note: data.decode_note,
        },
        null,
        2
      );
      drawPoints(data.points);
    } else if (data.type === "error") {
      setWsStatus(`Erreur nuage: ${data.msg}`, false);
    }
  } catch {
    setWsStatus("Message non-JSON", false);
  }
}

$btnConnect.addEventListener("click", () => {
  const url = $wsUrl.value.trim();
  localStorage.setItem("go2_ws_url", url);
  if (ws) ws.close();
  try {
    ws = new WebSocket(url);
    setWsStatus("Connexion…", undefined);
    ws.onopen = () => {
      setWsStatus("Connecté", true);
      $btnConnect.disabled = true;
      $btnDisconnect.disabled = false;
    };
    ws.onclose = () => {
      setWsStatus("Déconnecté", false);
      $btnConnect.disabled = false;
      $btnDisconnect.disabled = true;
      ws = null;
    };
    ws.onerror = () => setWsStatus("Erreur WebSocket", false);
    ws.onmessage = onWsMessage;
  } catch (e) {
    setWsStatus(String(e), false);
  }
});

$btnDisconnect.addEventListener("click", () => {
  if (ws) ws.close();
});

// --- Audio ---
let mediaRecorder = null;
let chunks = [];
let recStartPerf = 0;
const sessionLog = [];

$btnRecStart.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);
    recStartPerf = performance.now();
    sessionLog.push({ t: "rec_start", perf_ms: recStartPerf, wall: Date.now() });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `go2_audio_${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);

      const exportObj = {
        exported_at_wall_ms: Date.now(),
        last_lidar_frame: lastFrame,
        session_log: sessionLog,
      };
      const jb = new Blob([JSON.stringify(exportObj, null, 2)], { type: "application/json" });
      const ju = URL.createObjectURL(jb);
      const ja = document.createElement("a");
      ja.href = ju;
      ja.download = `go2_sync_meta_${Date.now()}.json`;
      ja.click();
      URL.revokeObjectURL(ju);

      $recStatus.textContent = `Export audio + meta JSON (${(blob.size / 1024).toFixed(0)} Ko)`;
      $recStatus.className = "status ok";
    };
    mediaRecorder.start(500);
    $btnRecStart.disabled = true;
    $btnRecStop.disabled = false;
    $recStatus.textContent = "Enregistrement…";
    $recStatus.className = "status ok";
  } catch (e) {
    $recStatus.textContent = "Micro refusé ou indisponible: " + e.message;
    $recStatus.className = "status err";
  }
});

$btnRecStop.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    sessionLog.push({
      t: "rec_stop",
      perf_ms: performance.now(),
      wall: Date.now(),
      delta_ms_from_start: performance.now() - recStartPerf,
    });
    mediaRecorder.stop();
  }
  $btnRecStart.disabled = false;
  $btnRecStop.disabled = true;
  mediaRecorder = null;
});
