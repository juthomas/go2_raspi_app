export class TransEngine {
    constructor(store, audio, analyzer, visualizer, ui) {
        this.store = store;
        this.audio = audio;
        this.analyzer = analyzer;
        this.visualizer = visualizer;
        this.ui = ui;

        this.isTransMode = false;
        this.isHarmoMode = false;
        
        // State
        this.activeReaderCount = 1;
        this.transFaderValue = 0;
        this.readerSpringK = 0.05; 
        this.readerSpread = 0.02; 
        this.smoothingFactor = 0.6; 

        // ADSR
        this.adsr = { a: 0.1, d: 0.2, s: 1.0, r: 0.01 };
        this.envState = 'IDLE'; 
        this.envValue = 0;
        this.lastFrameTime = Date.now();
        this.lastTransPlay = 0;

        this.smoothPitch = 0;
        this.smoothCentroid = 0;

        // Swarm
        this.followers = [];
        for(let i=0; i<16; i++) {
            this.followers.push({
                pitch: 100, centroid: 0.5,
                velPitch: 0, velCentroid: 0, id: i
            });
        }

        // MIDI
        this.midiAccess = null;
        this.midiOutputs = [];
        this.midiMode = 'CC'; // 'CC' or 'NOTE'
        this.selectedMidiId = 'all';
        this.midiChannel = 0; // 0-15 (Channels 1-16)

        // Routing State
        this.routing = {
            midiEnabled: false,
            cssEnabled: false,
            midiMode: 'cc', // 'cc' or 'note'
            ccMap: [
                { src: 'centroid', cc: 20 },
                { src: 'volume', cc: 21 }
            ],
            cssPreset: 'default',
            lastMidiTime: 0,
            lastCssTime: 0
        };

        // Cache for perf
        this.reuseVec = { pitch: 0, centroid: 0, volume: 0 };
        
        // Don't auto-init MIDI to avoid permission prompt spam. Wait for explicit request.
        // But do check if permissions were already granted previously
        this.checkMidiPermissions();
    }

    async checkMidiPermissions() {
        if (navigator.permissions) {
            try {
                const p = await navigator.permissions.query({ name: 'midi', sysex: false });
                if (p.state === 'granted') {
                    this.initMIDI(false);
                }
            } catch(e) {}
        }
    }

    setMidiDevice(id) {
        this.selectedMidiId = id;
    }

    setMidiChannel(ch) {
        // ch is 1-16, convert to 0-15
        this.midiChannel = Math.max(0, Math.min(15, parseInt(ch) - 1));
    }

    toggleMidiMode() {
        this.midiMode = this.midiMode === 'CC' ? 'NOTE' : 'CC';
        // Sync routing mode
        this.routing.midiMode = this.midiMode.toLowerCase();
        return this.midiMode;
    }

    async initMIDI(explicit = false) {
        if (!navigator.requestMIDIAccess) {
            if (this.ui) this.ui.statsPanel.setStatus("MIDI NOT SUPPORTED");
            return;
        }

        try {
            if (explicit && this.ui) this.ui.statsPanel.setStatus("REQUESTING MIDI...");
            
            this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
            
            const outputCount = this.midiAccess.outputs.size;
            if (this.ui) this.ui.statsPanel.setStatus(`MIDI ACCESS GRANTED (${outputCount} OUTS)`);
            
            this.updateMidiOutputs();
            this.setupMidiInputs();
            
            // Auto-enable MIDI routing if explicit request and outputs found
            if (explicit && outputCount > 0) {
                this.routing.midiEnabled = true;
                if (this.ui && this.ui.devicePanel) {
                    this.ui.devicePanel.setRoutingState(true);
                }
                if (this.ui) this.ui.logMidi("MIDI ROUTING AUTO-ENABLED");
            }
            
            this.midiAccess.onstatechange = () => {
                this.updateMidiOutputs();
                this.setupMidiInputs();
            };

        } catch (e) {
            console.warn("MIDI Init Failed", e);
            if (this.ui) this.ui.statsPanel.setStatus("MIDI DENIED");
        }
    }

    testMidi() {
        if (!this.midiOutputs.length) {
            if(this.ui) this.ui.logMidi("CANNOT TEST: NO MIDI OUTPUTS");
            return;
        }
        // Send C4 (60)
        this.sendNote(60, 0.8, 0.5); 
        if(this.ui) this.ui.logMidi("SENT TEST NOTE (C4) Ch:" + (this.midiChannel+1));
    }

    setupMidiInputs() {
        if (!this.midiAccess) return;
        for (let input of this.midiAccess.inputs.values()) {
            input.onmidimessage = (msg) => this.handleMidiMessage(msg);
        }
    }

    handleMidiMessage(msg) {
        if (!msg.data) return;
        const status = msg.data[0] & 0xF0;
        const note = msg.data[1];
        const velocity = msg.data[2];

        // Note On (144 / 0x90)
        if (status === 0x90 && velocity > 0) {
             if (this.audio && this.store) {
                 const freq = 440 * Math.pow(2, (note - 69) / 12);
                 const match = this.store.findClosestFrame(freq, 0.5); 
                 if (match) {
                     const pan = (match.centroid - 0.5) * 2;
                     const vol = (velocity / 127) * 1.0; 
                     this.audio.playGrain(match.time, 0.4, vol, pan, null, null, { bitmap: match.bitmap, sourceId: match.sourceVidId, frame: match });
                     
                     if (this.ui) this.ui.updateStats(freq, `MIDI IN: ${note}`, 0);
                     if (this.visualizer) this.visualizer.setCursor(match.index);
                 }
             }
        }
    }

    updateMidiOutputs() {
        this.midiOutputs = [];
        if (!this.midiAccess) return;
        
        for (let output of this.midiAccess.outputs.values()) {
            this.midiOutputs.push(output);
        }
        
        if (this.midiOutputs.length === 0) {
            if(this.ui) this.ui.logMidi("NO MIDI OUTPUTS FOUND");
        }

        if (this.ui && this.ui.updateMidiDevices) {
            this.ui.updateMidiDevices(this.midiOutputs);
        }
    }

    sendCC(cc, value) {
        // Strict CC Mode check removed here to allow flexible routing
        // This function sends raw CC if outputs exist
        if (!this.midiOutputs.length) return;
        
        const val = Math.max(0, Math.min(127, Math.floor(value)));
        const status = 0xB0 + this.midiChannel;
        const msg = [status, cc, val];
        let sent = false;

        this.midiOutputs.forEach(output => {
            if (this.selectedMidiId === 'all' || output.id === this.selectedMidiId) {
                try {
                    output.send(msg);
                    sent = true;
                } catch(e) {}
            }
        });

        // if(sent && this.ui) this.ui.logMidi(`CC${cc}: ${val}`);
    }

    sendNote(note, velocity, duration) {
        if (!this.midiOutputs.length) return;
        
        // Ensure integer MIDI note
        let midiNote = Math.round(note);
        midiNote = Math.max(0, Math.min(127, midiNote));
        
        const vel = Math.max(0, Math.min(127, Math.floor(velocity * 127)));
        
        const noteOnStatus = 0x90 + this.midiChannel;
        const noteOffStatus = 0x80 + this.midiChannel;
        
        const noteOn = [noteOnStatus, midiNote, vel];
        const noteOff = [noteOffStatus, midiNote, 0];
        
        let sent = false;
        const now = window.performance.now();

        this.midiOutputs.forEach(output => {
            if (this.selectedMidiId === 'all' || output.id === this.selectedMidiId) {
                try {
                    output.send(noteOn);
                    // Schedule Note Off safely
                    const offTime = now + (duration * 1000);
                    output.send(noteOff, offTime);
                    sent = true;
                } catch(e) {
                    console.warn("MIDI Send Error", e);
                }
            }
        });
        
        if(sent && this.ui) this.ui.logMidi(`NOTE OUT: ${midiNote} (Ch:${this.midiChannel+1})`);
    }

    // --- GRAIN ROUTING ---

    handleGrainEvent(grain) {
        // grain: { pitch, volume, centroid, note, time, ... }
        if (!grain) return;
        
        const now = Date.now();

        // CSS OUT
        if (this.routing.cssEnabled) {
            // Throttle CSS to 30fps (33ms)
            if (now - this.routing.lastCssTime > 33) {
                this.updateCSS(grain);
                this.routing.lastCssTime = now;
            }
        }

        // MIDI OUT
        if (this.routing.midiEnabled) {
            // Throttle MIDI to 20ms
            if (now - this.routing.lastMidiTime > 20) {
                this.routeMidi(grain);
                this.routing.lastMidiTime = now;
            }
        }
    }

    updateCSS(grain) {
        const root = document.documentElement;
        
        // Normalize values
        const vol = Math.min(1, Math.max(0, grain.volume || 0));
        const cen = Math.min(1, Math.max(0, grain.centroid || 0.5));
        const freq = grain.pitch || 0;
        
        let midi = 0;
        if (freq > 0) midi = 69 + 12 * Math.log2(freq / 440);
        midi = Math.max(0, Math.min(127, midi));

        // Core Variables
        root.style.setProperty('--grain-energy', vol.toFixed(3));
        root.style.setProperty('--grain-x', cen.toFixed(3));
        root.style.setProperty('--grain-freq', freq.toFixed(1));
        root.style.setProperty('--grain-note', (midi/127).toFixed(3));

        // Presets Logic
        if (this.routing.cssPreset === 'glow') {
             const glowAmt = (vol * 20).toFixed(1);
             root.style.textShadow = `0 0 ${glowAmt}px hsl(${midi*3}, 100%, 50%)`;
        } else if (this.routing.cssPreset === 'shift') {
             root.style.filter = `hue-rotate(${midi * 2}deg)`;
        } else if (this.routing.cssPreset === 'shake') {
             const offX = (Math.random()-0.5) * vol * 10;
             const offY = (Math.random()-0.5) * vol * 10;
             document.body.style.transform = `translate(${offX}px, ${offY}px)`;
        } else {
             // Default / Clean
             root.style.textShadow = 'none';
             root.style.filter = 'none';
             document.body.style.transform = 'none';
        }
    }

    routeMidi(grain) {
        if (this.routing.midiMode === 'cc') {
            this.routing.ccMap.forEach(map => {
                let val = 0;
                if (map.src === 'volume') val = grain.volume * 127;
                else if (map.src === 'centroid') val = grain.centroid * 127;
                else if (map.src === 'pitch') {
                    // Map reasonable freq range 50-2000Hz to 0-127
                    const hz = grain.pitch || 0;
                    if (hz > 0) {
                        const logP = Math.log2(hz);
                        const minL = Math.log2(50);
                        const maxL = Math.log2(2000);
                        val = ((logP - minL) / (maxL - minL)) * 127;
                    }
                }
                this.sendCC(map.cc, val);
            });
        } else if (this.routing.midiMode === 'note') {
             if (grain.pitch > 20) {
                 // Explicitly convert Hz to MIDI Note before sending
                 const midiNote = 69 + 12 * Math.log2(grain.pitch / 440);
                 const vel = Math.min(1.0, grain.volume * 2.0); 
                 this.sendNote(midiNote, vel, 0.1); 
             }
        }
    }

    setRoutingConfig(config) {
        // config: { midiEnabled, cssEnabled, midiMode, ccMap, cssPreset }
        Object.assign(this.routing, config);
        
        // Reset CSS on disable
        if (!this.routing.cssEnabled) {
            document.documentElement.style.textShadow = 'none';
            document.documentElement.style.filter = 'none';
            document.body.style.transform = 'none';
        }
    }

    process(data) {
        if (!this.isTransMode) return false;

        const now = Date.now();
        const dt = (now - this.lastFrameTime) / 1000;
        this.lastFrameTime = now;

        const isSignal = (data.volume > 0.02 && data.pitch > 50);

        // ADSR State Machine
        if (isSignal) {
            if (this.envState === 'IDLE' || this.envState === 'RELEASE') {
                this.envState = 'ATTACK';
                if(this.envValue < 0.01) {
                     this.followers.forEach(f => {
                        f.pitch = data.pitch;
                        f.centroid = data.centroid;
                    });
                    this.smoothPitch = data.pitch;
                    this.smoothCentroid = data.centroid;
                }
            }
        } else {
            if (this.envState !== 'IDLE' && this.envState !== 'RELEASE') {
                this.envState = 'RELEASE';
            }
        }

        // Envelope Calculation
        switch(this.envState) {
            case 'ATTACK':
                this.envValue += dt / Math.max(0.01, this.adsr.a);
                if (this.envValue >= 1.0) { this.envValue = 1.0; this.envState = 'DECAY'; }
                break;
            case 'DECAY':
                this.envValue -= (dt / Math.max(0.01, this.adsr.d));
                if (this.envValue <= this.adsr.s) { this.envValue = this.adsr.s; this.envState = 'SUSTAIN'; }
                break;
            case 'SUSTAIN':
                this.envValue = this.adsr.s;
                break;
            case 'RELEASE':
                this.envValue -= dt / Math.max(0.01, this.adsr.r);
                if (this.envValue <= 0) { this.envValue = 0; this.envState = 'IDLE'; }
                break;
            case 'IDLE':
                this.envValue = 0;
                break;
        }

        // Smooth Tracking
        if (isSignal) {
             const alpha = this.smoothingFactor;
             const pitchAlpha = Math.min(0.98, alpha);
             const centroidAlpha = Math.min(0.98, alpha + 0.1);

             this.smoothPitch = this.smoothPitch * pitchAlpha + data.pitch * (1 - pitchAlpha);
             this.smoothCentroid = this.smoothCentroid * centroidAlpha + data.centroid * (1 - centroidAlpha);
        }

        if (this.envValue > 0.01) {
            // Logic
            const minLog = Math.log2(50), maxLog = Math.log2(2000);
            const currLog = Math.log2(Math.max(50, this.smoothPitch));
            const midiPitch = ((currLog - minLog) / (maxLog - minLog)) * 127;
            const midiCentroid = this.smoothCentroid * 127;

            if (this.midiMode === 'CC') {
                this.sendCC(20, midiPitch);
                this.sendCC(21, midiCentroid);
            }

            // Swarm Physics
            this.updateSwarm(now, minLog, maxLog);

            if(this.ui) this.ui.updateStats(this.smoothPitch, data.note || "--", 0);

            // Playback
            this.playGrains(now);

        } else {
            this.smoothPitch = 0;
            if(this.visualizer) {
                this.visualizer.setCursor(null);
                this.visualizer.setSecondaryCursors([]);
            }
        }

        return true;
    }

    updateSwarm(now, minLog, maxLog) {
        const shiftFactor = this.transFaderValue;
        const baseTargetPitch = this.smoothPitch * Math.pow(2, shiftFactor);
        let baseTargetCentroid = this.smoothCentroid + (shiftFactor * 0.5);
        if (baseTargetCentroid > 1) baseTargetCentroid = 1 - (baseTargetCentroid - 1);

        const springK = this.readerSpringK;
        const damping = 0.90;

        let comPitch = 0, comCentroid = 0;
        if (this.activeReaderCount > 0) {
            for(let i=0; i<this.activeReaderCount; i++) {
                comPitch += this.followers[i].pitch;
                comCentroid += this.followers[i].centroid;
            }
            comPitch /= this.activeReaderCount;
            comCentroid /= this.activeReaderCount;
        }

        for(let i=0; i<this.activeReaderCount; i++) {
            const f = this.followers[i];
            if (!f) break; // Safety check if activeReaderCount > followers.length
            const noise = Math.sin(now * 0.001 + i) * 0.1; 
            
            const spreadDir = (i % 2 === 0) ? 1 : -1;
            const spreadMult = Math.ceil((i + 1) / 2); 
            const targetP = baseTargetPitch * (1 + (spreadMult * this.readerSpread * spreadDir)); 
            const targetC = Math.max(0, Math.min(1, baseTargetCentroid + (noise * 0.2)));

            const diffP = targetP - f.pitch;
            const diffC = targetC - f.centroid;
            const cohP = (comPitch - f.pitch) * 0.02; 
            const cohC = (comCentroid - f.centroid) * 0.02;

            let sepP = 0, sepC = 0;
            for (let j=0; j<this.activeReaderCount; j++) {
                if (i === j) continue;
                const other = this.followers[j];
                const deltaP = f.pitch - other.pitch;
                const deltaC = f.centroid - other.centroid;
                
                if (Math.abs(deltaP) < 30) {
                     const force = (30 - Math.abs(deltaP)) * 0.5;
                     sepP += (deltaP > 0 ? 1 : -1) * force;
                }
                if (Math.abs(deltaC) < 0.1) {
                    const force = (0.1 - Math.abs(deltaC)) * 0.05;
                    sepC += (deltaC > 0 ? 1 : -1) * force;
                }
            }

            f.velPitch += (diffP * springK) + cohP + sepP;
            f.velCentroid += (diffC * springK) + cohC + sepC;
            f.velPitch *= damping;
            f.velCentroid *= damping;
            f.pitch += f.velPitch;
            f.centroid += f.velCentroid;

            if(f.pitch < 50) f.pitch = 50;
            if(f.centroid < 0) f.centroid = 0;
            if(f.centroid > 1) f.centroid = 1;

            // MIDI for followers
            const fLog = Math.log2(Math.max(50, f.pitch));
            if (this.midiMode === 'CC') {
                const fMidiP = ((fLog - minLog) / (maxLog - minLog)) * 127;
                const fMidiC = f.centroid * 127;
                this.sendCC(22 + (i * 2), fMidiP);
                this.sendCC(23 + (i * 2), fMidiC);
            }
        }
    }

    playGrains(now) {
        if (!this.visualizer) return;
        const canPlay = (now - this.lastTransPlay > 50);
        
        // Leader
        let leaderMatch = null;
        if (this.isHarmoMode) {
            const matches = this.store.findNearestFrames(this.smoothPitch, this.smoothCentroid, 9);
            if (matches.length > 0) {
                leaderMatch = matches[0];
                this.visualizer.setCursor(leaderMatch.index);
                if(canPlay) {
                    matches.forEach(m => {
                        setTimeout(() => {
                            const pan = (m.centroid - 0.5) * 2;
                            this.audio.playGrain(m.time, 0.3, 0.12, pan, null, null, { bitmap: m.bitmap, sourceId: m.sourceVidId, frame: m });
                            // MIDI Note Trigger (Handled by routing now, but kept for explicit swarm behavior if desired, or let routeMidi handle it?)
                            // Let routeMidi handle detection to avoid double triggers if routing enabled.
                            // But TransEngine explicit swarm play usually wants explicit MIDI. 
                            // Current refactor moves ALL routing to handleGrainEvent. 
                            // Removing direct MIDI calls here to prevent double triggering if "Grain Routing" is ON.
                            // If "Grain Routing" is OFF, swarm won't send MIDI, which is cleaner.
                        }, Math.random() * 20);
                    });
                }
            }
        } else {
            leaderMatch = this.store.findClosestFrame(this.smoothPitch, this.smoothCentroid);
            if (leaderMatch) {
                this.visualizer.setCursor(leaderMatch.index);
                if(canPlay) {
                    const pan = (leaderMatch.centroid - 0.5) * 2;
                    this.audio.playGrain(leaderMatch.time, 0.15, 0.7, pan, null, null, { bitmap: leaderMatch.bitmap, sourceId: leaderMatch.sourceVidId, frame: leaderMatch });
                    // Explicit MIDI removed - routed via handleGrainEvent
                }
            }
        }

        // Swarm
        const followerIndices = [];
        if (this.activeReaderCount > 0 && leaderMatch) {
            for(let i=0; i<this.activeReaderCount; i++) {
                const f = this.followers[i];
                const fMatch = this.store.findClosestFrame(f.pitch, f.centroid);
                if (fMatch) {
                    followerIndices.push(fMatch.index);
                    if (canPlay) {
                        const baseVol = 0.5 / Math.sqrt(Math.max(1, this.activeReaderCount));
                        const vol = baseVol * this.envValue; 
                        const dur = 0.2 + Math.random() * 0.1;
                        setTimeout(() => {
                            const pan = (fMatch.centroid - 0.5) * 2;
                            this.audio.playGrain(fMatch.time, dur, vol, pan, null, null, { bitmap: fMatch.bitmap, sourceId: fMatch.sourceVidId, frame: fMatch });
                            // Explicit MIDI removed - routed via handleGrainEvent
                        }, Math.random() * 30);
                    }
                }
            }
        }
        
        this.visualizer.setSecondaryCursors(followerIndices);
        if (canPlay) this.lastTransPlay = now;
    }
}