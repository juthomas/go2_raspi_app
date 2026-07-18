import { useEffect, useRef, useState } from "react";

type Props = {
  enabled: boolean;
  baseUrl: string;
  onRttUpdate?: (rttMs: number | null) => void;
  onStatusUpdate?: (status: string) => void;
};

type HealthPayload = {
  ok?: boolean;
  frame_age_s?: number | null;
  peers?: number;
};

function cleanBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function hintForFetchFailure(baseUrl: string): string {
  try {
    const u = new URL(cleanBaseUrl(baseUrl));
    const isLoopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    const appIsRemote = !["127.0.0.1", "localhost"].includes(window.location.hostname);
    if (isLoopback && appIsRemote) {
      return "Use Pi IP instead of localhost/127.0.0.1.";
    }
    if (window.location.protocol === "https:" && u.protocol === "http:") {
      return "HTTPS page cannot call HTTP bridge (mixed content).";
    }
    return `Bridge unreachable: check ${u.origin}/health`;
  } catch {
    return "Invalid WebRTC bridge URL.";
  }
}

async function waitIceGatheringComplete(pc: RTCPeerConnection, timeoutMs = 2000): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener("icegatheringstatechange", onChange);
      window.clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

export function Go2WebRtcVideo({ enabled, baseUrl, onRttUpdate, onStatusUpdate }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState("OFF");
  const [fps, setFps] = useState(0);
  const [sessionNonce, setSessionNonce] = useState(0);

  const pushStatus = (next: string) => {
    setStatus(next);
    onStatusUpdate?.(next);
  };

  useEffect(() => {
    if (!enabled) {
      pushStatus("OFF");
      setFps(0);
      onRttUpdate?.(null);
      setSessionNonce(0);
      if (videoRef.current) videoRef.current.srcObject = null;
      return;
    }

    const pc = new RTCPeerConnection();
    let closed = false;
    let statsTimer: number | null = null;
    let reconnectTimer: number | null = null;
    pushStatus("Connecting...");

    const scheduleReconnect = (reason: string) => {
      if (closed || reconnectTimer !== null) return;
      pushStatus(`Reconnecting (${reason})...`);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (!closed) setSessionNonce((v) => v + 1);
      }, 1500);
    };

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.onconnectionstatechange = () => {
      if (closed) return;
      const s = pc.connectionState;
      pushStatus(`WebRTC: ${s}`);
      if (s === "failed" || s === "disconnected" || s === "closed") {
        onRttUpdate?.(null);
        scheduleReconnect(s);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (closed) return;
      const s = pc.iceConnectionState;
      if (s === "failed" || s === "disconnected" || s === "closed") {
        onRttUpdate?.(null);
        scheduleReconnect(`ice-${s}`);
      }
    };
    pc.ontrack = (event) => {
      if (!videoRef.current) return;
      const [stream] = event.streams;
      if (stream) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => {
          // Autoplay may be blocked until muted — element is muted.
        });
      }
    };

    (async () => {
      try {
        const healthUrl = `${cleanBaseUrl(baseUrl)}/health`;
        pushStatus("Checking bridge...");
        let health: HealthPayload;
        try {
          const healthRes = await fetch(healthUrl, { method: "GET" });
          if (!healthRes.ok) throw new Error(`HTTP ${healthRes.status}`);
          health = (await healthRes.json()) as HealthPayload;
        } catch {
          throw new Error(`Bridge down: ${healthUrl}. ${hintForFetchFailure(baseUrl)}`);
        }

        const age = health.frame_age_s;
        if (age == null) {
          pushStatus("Bridge OK — waiting for camera frames...");
        } else if (age > 3) {
          pushStatus(`Bridge OK — stale frames (${age.toFixed(1)}s)`);
        } else {
          pushStatus(`Bridge OK — frames ${age.toFixed(1)}s old`);
        }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitIceGatheringComplete(pc, 2000);
        const local = pc.localDescription;
        if (!local) throw new Error("No local description");

        const api = `${cleanBaseUrl(baseUrl)}/offer`;
        const res = await fetch(api, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sdp: local.sdp, type: local.type }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const answer = (await res.json()) as { sdp: string; type: "answer" };
        await pc.setRemoteDescription(answer);
        statsTimer = window.setInterval(() => {
          void (async () => {
            try {
              const stats = await pc.getStats();
              let rttMs: number | null = null;
              stats.forEach((report) => {
                if (rttMs != null) return;
                if (
                  report.type === "candidate-pair" &&
                  report.state === "succeeded" &&
                  typeof report.currentRoundTripTime === "number"
                ) {
                  rttMs = Math.max(0, Math.round(report.currentRoundTripTime * 1000));
                }
              });
              if (rttMs == null) {
                stats.forEach((report) => {
                  if (rttMs != null) return;
                  if (report.type === "remote-inbound-rtp" && typeof report.roundTripTime === "number") {
                    rttMs = Math.max(0, Math.round(report.roundTripTime * 1000));
                  }
                });
              }
              onRttUpdate?.(rttMs);
            } catch {
              onRttUpdate?.(null);
            }
          })();
        }, 2000);
        pushStatus(age == null ? "LIVE (no camera frames yet)" : "LIVE");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const extra =
          msg.includes("Failed to fetch") || msg.includes("Bridge down")
            ? msg.includes("Use Pi IP") || msg.includes("Bridge unreachable") || msg.includes("mixed content")
              ? ""
              : ` ${hintForFetchFailure(baseUrl)}`
            : "";
        setFps(0);
        onRttUpdate?.(null);
        pushStatus(`Error: ${msg}${extra}`);
        scheduleReconnect("offer");
      }
    })();

    return () => {
      closed = true;
      try {
        if (reconnectTimer !== null) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (statsTimer !== null) {
          window.clearInterval(statsTimer);
          statsTimer = null;
        }
        pc.getReceivers().forEach((r) => r.track?.stop());
        pc.close();
      } catch {
        // ignore close errors
      }
      onRttUpdate?.(null);
      if (videoRef.current) videoRef.current.srcObject = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onStatusUpdate is optional display sync
  }, [enabled, baseUrl, onRttUpdate, sessionNonce]);

  useEffect(() => {
    if (!enabled || !videoRef.current) {
      setFps(0);
      return;
    }
    const video = videoRef.current;
    const anyVideo = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { presentedFrames: number }) => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };

    let rafId: number | null = null;
    let timerId: number | null = null;
    let lastFrames = 0;
    let lastTs = performance.now();

    if (typeof anyVideo.requestVideoFrameCallback === "function") {
      const step = (now: number, meta: { presentedFrames: number }) => {
        const dt = now - lastTs;
        if (dt >= 1000) {
          const df = meta.presentedFrames - lastFrames;
          setFps(Math.max(0, Math.round((df * 1000) / dt)));
          lastFrames = meta.presentedFrames;
          lastTs = now;
        }
        if (anyVideo.requestVideoFrameCallback) {
          rafId = anyVideo.requestVideoFrameCallback(step);
        }
      };
      rafId = anyVideo.requestVideoFrameCallback(step);
    } else {
      let lastTime = video.currentTime;
      timerId = window.setInterval(() => {
        const nowTime = video.currentTime;
        const dt = nowTime - lastTime;
        const approx = dt > 0 ? Math.round(1 / dt) : 0;
        setFps(Math.max(0, Math.min(120, approx)));
        lastTime = nowTime;
      }, 1000);
    }

    return () => {
      if (rafId !== null && anyVideo.cancelVideoFrameCallback) {
        anyVideo.cancelVideoFrameCallback(rafId);
      }
      if (timerId !== null) window.clearInterval(timerId);
      setFps(0);
    };
  }, [enabled, status]);

  return (
    <div className={`webrtc-video-overlay ${enabled ? "" : "hidden"}`}>
      <div className="webrtc-video-status">
        {status} {enabled ? `| ${fps} fps` : ""}
      </div>
      <video ref={videoRef} autoPlay playsInline muted />
    </div>
  );
}
