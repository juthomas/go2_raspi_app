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

  useEffect(() => {
    if (!enabled) {
      setStatus("OFF");
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

  return (
    <div className={`webrtc-video-overlay ${enabled ? "" : "hidden"}`}>
      <div className="webrtc-video-status">{status}</div>
      <video ref={videoRef} autoPlay playsInline muted />
    </div>
  );
}
