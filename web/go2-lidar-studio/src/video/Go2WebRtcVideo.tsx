import { useEffect, useRef, useState } from "react";

type Props = {
  enabled: boolean;
  baseUrl: string;
};

function cleanBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function Go2WebRtcVideo({ enabled, baseUrl }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState("OFF");
  const [fps, setFps] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setStatus("OFF");
      setFps(0);
      if (videoRef.current) videoRef.current.srcObject = null;
      return;
    }

    const pc = new RTCPeerConnection();
    let closed = false;
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
        setStatus("LIVE");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setFps(0);
        setStatus(`Error: ${msg}`);
      }
    })();

    return () => {
      closed = true;
      try {
        pc.getReceivers().forEach((r) => r.track?.stop());
        pc.close();
      } catch {
        // ignore close errors
      }
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [enabled, baseUrl]);

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
