import { useEffect, useRef, useState } from "react";

type Props = {
  enabled: boolean;
  baseUrl: string;
  onRttUpdate?: (rttMs: number | null) => void;
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

export function Go2WebRtcVideo({ enabled, baseUrl, onRttUpdate }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState("OFF");
  const [fps, setFps] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setStatus("OFF");
      setFps(0);
      onRttUpdate?.(null);
      if (videoRef.current) videoRef.current.srcObject = null;
      return;
    }

    const pc = new RTCPeerConnection();
    let closed = false;
    let statsTimer: number | null = null;
    setStatus("Connecting...");

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.onconnectionstatechange = () => {
      if (closed) return;
      setStatus(`WebRTC: ${pc.connectionState}`);
    };
    pc.ontrack = (event) => {
      if (!videoRef.current) return;
      const [stream] = event.streams;
      if (stream) videoRef.current.srcObject = stream;
    };

    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
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
        setStatus("LIVE");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const extra = msg.includes("Failed to fetch") ? ` ${hintForFetchFailure(baseUrl)}` : "";
        setFps(0);
        onRttUpdate?.(null);
        setStatus(`Error: ${msg}${extra}`);
      }
    })();

    return () => {
      closed = true;
      try {
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
  }, [enabled, baseUrl, onRttUpdate]);

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
        // Approximate fallback if requestVideoFrameCallback isn't supported.
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
