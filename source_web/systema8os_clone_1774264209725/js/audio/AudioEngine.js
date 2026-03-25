export class AudioEngine {
    constructor() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.source = null;
        this.buffer = null;
        this.startTime = 0;
        this.pausedAt = 0;
        this.isPlaying = false;
        this.isRecording = false;
        
        this.clips = []; // Array of { buffer, startTime }
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.lastRecordingType = 'audio'; // or 'video'
        this.recordingPromise = null;
        this.recordingResolver = null;
        
        this.currentInputId = 'default';
        this.currentOutputId = 'default';
        
        this.onVideoData = null; // Callback for main to handle video blob

        // Nodes
        this.masterGain = this.ctx.createGain();
        this.masterGain.channelCount = 2;
        this.masterGain.channelCountMode = 'explicit';

        // Output Limiter: Safety net to prevent saturation/clipping
        this.outputLimiter = this.ctx.createDynamicsCompressor();
        this.outputLimiter.channelCount = 2;
        this.outputLimiter.channelCountMode = 'explicit';
        this.outputLimiter.threshold.value = -1.0; 
        this.outputLimiter.knee.value = 0.0;
        this.outputLimiter.ratio.value = 20.0; // Brickwall limiting
        this.outputLimiter.attack.value = 0.001;
        this.outputLimiter.release.value = 0.1;

        this.masterGain.connect(this.outputLimiter);
        this.outputLimiter.connect(this.ctx.destination);
        
        this.initReverb();

        // Spatial Params
        this.spatParams = {
            mode: 'stereo',
            width: 1.0,
            jitter: 0.0,
            x: 0.0,
            z: 0.0,
            lx: 0.0,
            lz: 0.0
        };
    }

    setSpatialParams(params) {
        this.spatParams = { ...this.spatParams, ...params };
    }

    initReverb() {
        this.reverbNode = this.ctx.createConvolver();
        this.reverbGain = this.ctx.createGain();
        this.reverbGain.gain.value = 0.0; // Start dry

        // Generate synthetic impulse response
        this.generateReverbImpulse(3.0, 2.0); 

        // Route: Master -> Reverb -> ReverbGain -> Limiter (Parallel)
        this.masterGain.connect(this.reverbNode);
        this.reverbNode.connect(this.reverbGain);
        this.reverbGain.connect(this.outputLimiter);

        // Input Send Gain (Direct mic/line to Reverb)
        this.inputReverbGain = this.ctx.createGain();
        this.inputReverbGain.gain.value = 0.0;
        this.inputReverbGain.connect(this.reverbNode);

        // Input Dry Gain (Direct monitoring)
        this.inputDryGain = this.ctx.createGain();
        this.inputDryGain.gain.value = 0.0;
        this.inputDryGain.connect(this.masterGain);
    }

    generateReverbImpulse(duration, decay) {
        const rate = this.ctx.sampleRate;
        const length = rate * duration;
        const impulse = this.ctx.createBuffer(2, length, rate);
        const left = impulse.getChannelData(0);
        const right = impulse.getChannelData(1);

        for (let i = 0; i < length; i++) {
            // Exponential decay
            const n = i / length;
            const vol = Math.pow(1 - n, decay); 
            // White noise
            left[i] = (Math.random() * 2 - 1) * vol;
            right[i] = (Math.random() * 2 - 1) * vol;
        }
        this.reverbNode.buffer = impulse;
    }

    setReverbAmount(amount) {
        if(this.reverbGain) {
            this.reverbGain.gain.setTargetAtTime(amount, this.ctx.currentTime, 0.1);
        }
    }

    setInputReverbAmount(amount) {
        if(this.inputReverbGain) {
            this.inputReverbGain.gain.setTargetAtTime(amount, this.ctx.currentTime, 0.1);
        }
    }

    setInputDryVolume(amount) {
        if(this.inputDryGain) {
            this.inputDryGain.gain.setTargetAtTime(amount, this.ctx.currentTime, 0.1);
        }
    }

    async initMic(record = true) {
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        
        const constraints = {
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
            video: false
        };

        if (this.currentInputId !== 'default') {
            constraints.audio.deviceId = { exact: this.currentInputId };
        }

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.stop();
        this.lastRecordingType = 'audio';
        return this.setupStream(stream, record, 'audio');
    }

    async initVideo(record = true) {
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true 
            });
            this.stop();
            this.lastRecordingType = 'video';
            return this.setupStream(stream, record, 'video');
        } catch (err) {
            console.error("Video capture cancelled or failed", err);
            return null;
        }
    }

    async initCamera(record = true) {
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        
        const constraints = {
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
            video: true
        };

        if (this.currentInputId !== 'default') {
            constraints.audio.deviceId = { exact: this.currentInputId };
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            this.stop();
            this.lastRecordingType = 'video';
            return this.setupStream(stream, record, 'video');
        } catch (err) {
            console.error("Camera access denied", err);
            return null;
        }
    }

    setupStream(stream, record, type) {
        this.stream = stream;
        
        // Handle stream ending (user stops sharing)
        this.stream.getVideoTracks().forEach(track => {
            track.onended = () => this.stop();
        });

        // Audio Processing Chain
        let rawSource;
        if (stream.getAudioTracks().length > 0) {
            rawSource = this.ctx.createMediaStreamSource(stream);
        } else {
            // Create dummy source if no audio in video capture (to prevent crashes)
            const osc = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            g.gain.value = 0;
            osc.connect(g);
            osc.start();
            rawSource = g; 
        }

        // EQ Clean-up
        const lowCut = this.ctx.createBiquadFilter();
        lowCut.type = 'highpass';
        lowCut.frequency.value = 90;
        lowCut.Q.value = 0.6;

        const highShelf = this.ctx.createBiquadFilter();
        highShelf.type = 'highshelf';
        highShelf.frequency.value = 10000;
        highShelf.gain.value = -8;

        // Limiter
        const compressor = this.ctx.createDynamicsCompressor();
        compressor.threshold.value = -6;
        compressor.knee.value = 10;
        compressor.ratio.value = 20;
        compressor.attack.value = 0.002;
        compressor.release.value = 0.1;
        
        rawSource.connect(lowCut);
        lowCut.connect(highShelf);
        highShelf.connect(compressor);
        
        this.source = compressor;

        if (this.inputReverbGain) {
            this.source.connect(this.inputReverbGain);
        }

        if (this.inputDryGain) {
            this.source.connect(this.inputDryGain);
        }

        if (record) {
            this.isRecording = true;
            this.recordedChunks = [];

            // Fade In Setup
            this.recordGain = this.ctx.createGain();
            this.recordGain.gain.setValueAtTime(0, this.ctx.currentTime);
            this.recordGain.gain.linearRampToValueAtTime(1, this.ctx.currentTime + 0.5);
            compressor.connect(this.recordGain);
            
            let recorderStream;
            const dest = this.ctx.createMediaStreamDestination();
            this.recordGain.connect(dest);
            
            if (type === 'video') {
                // Record the original video + processed audio (via gain)
                const tracks = [
                    ...stream.getVideoTracks(),
                    ...dest.stream.getAudioTracks()
                ];
                recorderStream = new MediaStream(tracks);
            } else {
                // Audio only
                recorderStream = dest.stream;
            }

            try {
                this.mediaRecorder = new MediaRecorder(recorderStream, {
                    mimeType: type === 'video' ? 'video/webm;codecs=vp8,opus' : 'audio/webm;codecs=opus'
                });
            } catch (e) {
                console.warn("Preferred codec failed, falling back to default", e);
                this.mediaRecorder = new MediaRecorder(recorderStream);
            }
            
            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.recordedChunks.push(e.data);
            };
            
            const recStartTime = this.ctx.currentTime;
            
            // Create a promise that resolves when processing is done
            this.recordingPromise = new Promise(resolve => {
                this.recordingResolver = resolve;
            });

            this.mediaRecorder.onstop = async () => {
                if (this.recordedChunks.length === 0) {
                    if (this.recordingResolver) this.recordingResolver();
                    return;
                }
                
                const blob = new Blob(this.recordedChunks, { 
                    type: type === 'video' ? 'video/webm' : 'audio/webm' 
                });

                if (type === 'video' && this.onVideoData) {
                    this.onVideoData(blob);
                }
                
                // Always decode the audio part for analysis/granular
                try {
                    const arrayBuffer = await blob.arrayBuffer();
                    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
                    this.clips.push({
                        buffer: audioBuffer,
                        startTime: recStartTime
                    });
                } catch (e) {
                    console.error("Error decoding recording", e);
                }
                
                if (this.recordingResolver) this.recordingResolver();
            };
            this.mediaRecorder.start(100); // 100ms slices to ensure data
        }

        return this.source;
    }

    async decodeAudioData(arrayBuffer) {
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        return await this.ctx.decodeAudioData(arrayBuffer);
    }

    addClip(buffer, startTime) {
        this.clips.push({
            buffer: buffer,
            startTime: startTime
        });
    }

    removeLastClip() {
        if (this.clips.length > 0) {
            return this.clips.pop();
        }
        return null;
    }

    async loadFile(file) {
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        const arrayBuffer = await file.arrayBuffer();
        this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
        return this.buffer;
    }

    playBuffer(startOffset = 0) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        if (!this.buffer) return;
        this.stop();

        // Ensure playback rate is reset
        if(this.source) {
            try { this.source.playbackRate.value = 1.0; } catch(e){}
        }

        // Auto-rewind if near end
        if (startOffset >= this.buffer.duration - 0.1) {
            startOffset = 0;
        }
        
        this.source = this.ctx.createBufferSource();
        this.source.buffer = this.buffer;
        
        // Anti-pop fade in
        const fadeGain = this.ctx.createGain();
        fadeGain.gain.setValueAtTime(0, this.ctx.currentTime);
        fadeGain.gain.linearRampToValueAtTime(1, this.ctx.currentTime + 0.05);
        
        this.source.connect(fadeGain);
        fadeGain.connect(this.masterGain);
        
        this.startTime = this.ctx.currentTime - startOffset;
        
        // Register this playback as a "clip" for segmentation
        this.clips.push({
            buffer: this.buffer,
            startTime: this.startTime
        });

        this.pausedAt = startOffset;
        this.playbackStartTime = this.startTime; // Track for sync
        this.source.playbackRate.value = 1.0;
        this.source.start(0, startOffset);
        this.isPlaying = true;

        const mySource = this.source;
        this.source.onended = () => {
            if (this.source === mySource) {
                this.isPlaying = false;
            }
        };

        return this.source;
    }

    playGrain(globalTime, duration = 0.15, volume = 0.8, pan = 0, envelope = null, spatParams = null, visualContext = null) {
        // Find the clip containing this time
        const clip = this.clips.find(c => 
            globalTime >= c.startTime - 0.5 && 
            globalTime < (c.startTime + c.buffer.duration + 0.5)
        );

        if (!clip) return;

        const offset = Math.max(0, globalTime - clip.startTime);

        const source = this.ctx.createBufferSource();
        source.buffer = clip.buffer;
        source.playbackRate.value = 1.0;
        
        const gainNode = this.ctx.createGain();

        // Spatial Logic
        const params = spatParams || this.spatParams;

        // Grain Panning (Timbre/Centroid based) acts as spread around the main Position
        const spreadOffset = pan * params.width;
        
        // Base Position from Head View (Relative to Listener)
        const lx = params.lx || 0;
        const lz = params.lz || 0;

        const baseX = (params.x || 0) - lx;
        const baseZ = (params.z !== undefined ? params.z : 0) - lz;

        let finalX = baseX + spreadOffset;
        
        // Apply Jitter
        if (params.jitter > 0) {
            finalX += (Math.random() - 0.5) * 2.0 * params.jitter;
        }

        let panner;

        if (params.mode === 'binaural') {
            // HRTF 3D Panner
            panner = this.ctx.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'inverse'; // Better for near field
            panner.refDistance = 1;
            panner.maxDistance = 10;
            panner.rolloffFactor = 1;
            panner.coneInnerAngle = 360;

            // Scale to meters. 
            // X: -2 to 2m roughly
            // Z: -2 to 2m roughly. 
            // WebAudio Z: Negative is Front, Positive is Back.
            // Our UI Z: -1(Front) to 1(Back). Matches logic roughly, scale up.
            
            const px = finalX * 3.0; 
            const pz = baseZ * 3.0; 
            
            // Elevation (Y) + Jitter
            const baseY = params.y !== undefined ? params.y * 3.0 : 0;
            const jitterY = params.jitter > 0 ? (Math.random() - 0.5) * params.jitter : 0;
            const py = baseY + jitterY;

            if(panner.positionX) {
                panner.positionX.value = px;
                panner.positionY.value = py;
                panner.positionZ.value = pz;
            } else {
                panner.setPosition(px, py, pz);
            }
        } else {
            // Standard Stereo
            panner = this.ctx.createStereoPanner();
            // Just clamp X. Z is ignored in StereoPanner.
            panner.pan.value = Math.max(-1, Math.min(1, finalX));
        }

        // Ensure stereo continuity
        gainNode.channelCount = 2;
        gainNode.channelCountMode = 'explicit';

        source.connect(gainNode);
        gainNode.connect(panner);
        panner.connect(this.masterGain);

        const now = this.ctx.currentTime;
        
        // Envelope Logic
        let attTime, decTime, relTime, susLevel;
        
        if (envelope) {
            // Interpret envelope values as percentages of duration (0..1)
            // A, D, R are ratios. S is Level.
            attTime = duration * envelope.a;
            decTime = duration * envelope.d;
            relTime = duration * envelope.r;
            susLevel = volume * envelope.s;

            // Normalize time if sum > duration
            const totalTime = attTime + decTime + relTime;
            if (totalTime > duration) {
                const scale = duration / totalTime;
                attTime *= scale;
                decTime *= scale;
                relTime *= scale;
            }
        } else {
            // Default Adaptive
            attTime = Math.min(duration * 0.4, 0.1);
            relTime = Math.min(duration * 0.4, 0.2);
            decTime = 0;
            susLevel = volume;
            
            if (duration < attTime + relTime) duration = attTime + relTime + 0.01;
        }

        // Video Sync Hook
        if (this.onGrainPlay) {
            this.onGrainPlay(offset, duration, volume, visualContext);
        }

        const susTime = Math.max(0, duration - (attTime + decTime + relTime));

        gainNode.gain.setValueAtTime(0, now);
        
        // Attack
        if (attTime > 0) gainNode.gain.linearRampToValueAtTime(volume, now + attTime);
        else gainNode.gain.setValueAtTime(volume, now);
        
        // Decay -> Sustain
        if (decTime > 0) gainNode.gain.linearRampToValueAtTime(susLevel, now + attTime + decTime);
        
        // Hold Sustain
        // (Implicit until Release starts)

        // Release
        const relStart = now + attTime + decTime + susTime;
        gainNode.gain.setValueAtTime(susLevel, relStart); // Anchor
        gainNode.gain.linearRampToValueAtTime(0, relStart + relTime);

        source.start(now, offset);
        source.stop(relStart + relTime + 0.1); 
    }

    playSegment(globalStartTime, duration, pan = 0) {
        // Find the clip that contains this segment
        // Allow a small tolerance for start time mismatch
        const clip = this.clips.find(c => 
            globalStartTime >= c.startTime - 0.1 && 
            globalStartTime < (c.startTime + c.buffer.duration + 0.1)
        );

        if (!clip) return;

        const offset = Math.max(0, globalStartTime - clip.startTime);
        
        const oneShot = this.ctx.createBufferSource();
        oneShot.buffer = clip.buffer;
        oneShot.playbackRate.value = 1.0;
        
        const gainNode = this.ctx.createGain();
        const panner = this.ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, pan));

        oneShot.connect(gainNode);
        gainNode.connect(panner);
        panner.connect(this.masterGain);

        // Fade In / Out
        const fadeTime = 0.05; // 50ms
        const now = this.ctx.currentTime;
        
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(1, now + fadeTime);
        gainNode.gain.linearRampToValueAtTime(1, now + duration - fadeTime);
        gainNode.gain.linearRampToValueAtTime(0, now + duration);

        oneShot.start(now, offset);
        oneShot.stop(now + duration + 0.2);
    }

    async stop() {
        if (this.isRecording && this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            // Fade out
            if (this.recordGain) {
                try {
                    const now = this.ctx.currentTime;
                    this.recordGain.gain.cancelScheduledValues(now);
                    this.recordGain.gain.setValueAtTime(this.recordGain.gain.value, now);
                    this.recordGain.gain.linearRampToValueAtTime(0, now + 0.5);
                    await new Promise(r => setTimeout(r, 500));
                } catch(e) {}
            }
            if (this.mediaRecorder.state !== 'inactive') {
                this.mediaRecorder.stop();
                // Wait for onstop processing (decoding) to finish
                if (this.recordingPromise) {
                    await this.recordingPromise;
                    this.recordingPromise = null;
                    this.recordingResolver = null;
                }
            }
        }
        
        this.isRecording = false;
        this.recordGain = null;

        if (this.source) {
            try {
                this.source.onended = null;
                if (this.source.stop) this.source.stop();
                this.source.disconnect();
            } catch(e) {} 
            this.source = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        this.isPlaying = false;
    }

    clear() {
        this.clips = [];
    }

    pause() {
        if (this.isPlaying) {
            this.stop();
            this.pausedAt = this.ctx.currentTime - this.startTime;
        }
    }

    getCurrentTime() {
        // Return Absolute Time (Context Time) to ensure all clips and frames 
        // align on the same timeline for the "cluster" visualization.
        // The Store will hold frames with this absolute time.
        return this.ctx.currentTime;
    }

    toggleMute() {
        this.masterGain.gain.value = this.masterGain.gain.value > 0 ? 0 : 1;
        return this.masterGain.gain.value === 0;
    }

    setMasterVolume(val) {
        if(this.masterGain) {
             this.masterGain.gain.setTargetAtTime(val, this.ctx.currentTime, 0.05);
        }
    }

    async setOutputDevice(deviceId) {
        if (this.ctx.setSinkId) {
            try {
                await this.ctx.setSinkId(deviceId);
                this.currentOutputId = deviceId;
                console.log(`Audio Output set to ${deviceId}`);
            } catch(e) {
                console.warn('Error setting audio output:', e);
            }
        } else {
            console.warn('setSinkId not supported in this browser');
        }
    }

    getSegmentBuffer(startTime, duration) {
        // Find clip containing the start time with small tolerance
        const clip = this.clips.find(c => 
            startTime >= (c.startTime - 0.05) && 
            startTime < (c.startTime + c.buffer.duration + 0.05)
        );

        if (!clip) return null;

        const offset = Math.max(0, startTime - clip.startTime);
        // Clamp duration to end of clip
        const remaining = clip.buffer.duration - offset;
        const safeDuration = Math.min(duration, remaining);

        if (safeDuration <= 0.01) return null;

        const sampleRate = clip.buffer.sampleRate;
        const frameCount = Math.floor(safeDuration * sampleRate);
        const channels = clip.buffer.numberOfChannels;

        const newBuffer = this.ctx.createBuffer(channels, frameCount, sampleRate);

        for (let i = 0; i < channels; i++) {
            const chanData = clip.buffer.getChannelData(i);
            const startIdx = Math.floor(offset * sampleRate);
            const endIdx = Math.min(startIdx + frameCount, chanData.length);
            const slice = chanData.slice(startIdx, endIdx);
            newBuffer.copyToChannel(slice, i);
        }

        return newBuffer;
    }

    encodeToWav(buffer) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const bitDepth = 16;
        
        // Interleave if stereo
        let samples;
        if (numChannels === 2) {
            const left = buffer.getChannelData(0);
            const right = buffer.getChannelData(1);
            samples = new Float32Array(left.length * 2);
            for (let i = 0; i < left.length; i++) {
                samples[i * 2] = left[i];
                samples[i * 2 + 1] = right[i];
            }
        } else {
            samples = buffer.getChannelData(0);
        }

        const bufferLength = 44 + samples.length * 2;
        const outBuffer = new ArrayBuffer(bufferLength);
        const view = new DataView(outBuffer);

        const writeString = (view, offset, string) => {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        };

        // RIFF chunk
        writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + samples.length * 2, true);
        writeString(view, 8, 'WAVE');
        
        // FMT sub-chunk
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numChannels * 2, true); // Byte rate
        view.setUint16(32, numChannels * 2, true); // Block align
        view.setUint16(34, bitDepth, true);

        // Data sub-chunk
        writeString(view, 36, 'data');
        view.setUint32(40, samples.length * 2, true);

        // Write PCM samples
        let offset = 44;
        for (let i = 0; i < samples.length; i++) {
            let s = Math.max(-1, Math.min(1, samples[i]));
            // 16-bit signed integer scaling
            s = s < 0 ? s * 0x8000 : s * 0x7FFF;
            view.setInt16(offset, s, true);
            offset += 2;
        }

        return new Blob([view], { type: 'audio/wav' });
    }
}

