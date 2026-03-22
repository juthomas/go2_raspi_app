/**
 * WebSocket LiDAR — chargé avant main.js.
 * Ne modifie PAS #status (bandeau principal) pour ne pas casser l’UI / la manette.
 */

function setLidarLine(msg, ok) {
  const el = document.getElementById("go2-lidar-status");
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok === true ? "#3fb950" : ok === false ? "#f85149" : "#888";
}

let ws = null;

function defaultWsUrl() {
  const h = location.hostname;
  const p = location.protocol === "https:" ? "wss:" : "ws:";
  if (h === "localhost" || h === "127.0.0.1") return `${p}//127.0.0.1:8765`;
  return `${p}//${h}:8765`;
}

export function connectGo2Lidar() {
  const urlInput = document.getElementById("go2-ws-url");
  const u = urlInput?.value?.trim();
  if (!u) {
    setLidarLine("URL ws://… vide", false);
    return;
  }
  if (location.protocol === "https:" && u.startsWith("ws://")) {
    setLidarLine("HTTPS: ouvre la page en http:// ou utilise wss://", false);
    return;
  }
  try {
    localStorage.setItem("go2_ws_url", u);
  } catch (_) {}
  setLidarLine("Connexion…", undefined);
  try {
    if (ws) ws.close();
  } catch (_) {}
  try {
    ws = new WebSocket(u);
  } catch (e) {
    setLidarLine(String(e), false);
    return;
  }
  ws.onopen = () => setLidarLine("WS connecté — attente DDS…", true);
  ws.onclose = () => {
    setLidarLine("WS fermé", false);
    window.dispatchEvent(new CustomEvent("go2-pointcloud", { detail: null }));
  };
  ws.onerror = () => setLidarLine("Erreur WS (serveur / pare-feu / IP)", false);
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === "hello") {
        setLidarLine(`Pont: ${data.topic}`, true);
        return;
      }
      if (data.type === "error") {
        setLidarLine(`Pont: ${data.msg}`, false);
        return;
      }
      window.dispatchEvent(new CustomEvent("go2-pointcloud", { detail: data }));
    } catch (_) {}
  };
}

export function disconnectGo2Lidar() {
  try {
    if (ws) ws.close();
  } catch (_) {}
  ws = null;
  setLidarLine("OFF", false);
  window.dispatchEvent(new CustomEvent("go2-pointcloud", { detail: null }));
}

function init() {
  const urlInput = document.getElementById("go2-ws-url");
  const btnOn = document.getElementById("btn-go2-lidar-connect");
  const btnOff = document.getElementById("btn-go2-lidar-disconnect");
  if (!urlInput || !btnOn) return;
  try {
    urlInput.value = localStorage.getItem("go2_ws_url") || defaultWsUrl();
  } catch (_) {
    urlInput.value = defaultWsUrl();
  }
  btnOn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    connectGo2Lidar();
  });
  if (btnOff) {
    btnOff.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      disconnectGo2Lidar();
    });
  }
  window.__go2LidarBridge = { connect: connectGo2Lidar, disconnect: disconnectGo2Lidar };
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
