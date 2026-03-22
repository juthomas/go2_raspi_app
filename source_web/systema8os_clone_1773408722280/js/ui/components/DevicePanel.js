export class DevicePanel {
    constructor(audioEngine, callbacks) {
        this.audio = audioEngine;
        this.callbacks = callbacks;
        this.selInput = document.getElementById('input-device');
        this.selOutput = document.getElementById('output-device');
        this.selMidi = document.getElementById('midi-output-device');
        this.selChannel = document.getElementById('midi-channel');
        this.btnMidiSetup = document.getElementById('btn-midi-setup');
        this.btnMidiTest = document.getElementById('btn-midi-test');
        
        // Routing UI
        this.btnRouteMidi = document.getElementById('btn-route-midi');
        this.btnRouteCss = document.getElementById('btn-route-css');
        this.selRouteMode = document.getElementById('route-midi-mode');
        this.ccConfig = document.getElementById('route-cc-config');
        this.cssConfig = document.getElementById('route-css-config');
        this.cssPreset = document.getElementById('route-css-preset');
        
        this.cc1Src = document.getElementById('route-cc1-src');
        this.cc1Num = document.getElementById('route-cc1-num');
        this.cc2Src = document.getElementById('route-cc2-src');
        this.cc2Num = document.getElementById('route-cc2-num');

        this.init();
    }

    init() {
        if (this.btnMidiSetup) {
            this.btnMidiSetup.addEventListener('click', () => {
                if (this.callbacks.onRequestMidi) this.callbacks.onRequestMidi();
            });
        }
        if (this.btnMidiTest) {
            this.btnMidiTest.addEventListener('click', () => {
                if (this.callbacks.onMidiTest) this.callbacks.onMidiTest();
            });
        }
        this.refreshDevices();
        this.initChannels();
        navigator.mediaDevices.ondevicechange = () => this.refreshDevices();

        this.selInput.addEventListener('change', (e) => { if (this.callbacks.onInputDeviceChange) this.callbacks.onInputDeviceChange(e.target.value); });
        this.selOutput.addEventListener('change', (e) => { if (this.callbacks.onOutputDeviceChange) this.callbacks.onOutputDeviceChange(e.target.value); });

        if (this.selMidi) this.selMidi.addEventListener('change', (e) => { if (this.callbacks.onMidiDeviceChange) this.callbacks.onMidiDeviceChange(e.target.value); });
        if (this.selChannel) this.selChannel.addEventListener('change', (e) => { if (this.callbacks.onMidiChannelChange) this.callbacks.onMidiChannelChange(e.target.value); });

        // Routing Handlers
        if (this.btnRouteMidi) {
            this.btnRouteMidi.addEventListener('click', () => {
                const isActive = this.btnRouteMidi.innerText.includes("ON");
                this.btnRouteMidi.innerText = isActive ? "MIDI OUT: OFF" : "MIDI OUT: ON";
                this.btnRouteMidi.style.background = isActive ? "" : "#600";
                this.updateRouting();
            });
        }
        if (this.btnRouteCss) {
            this.btnRouteCss.addEventListener('click', () => {
                const isActive = this.btnRouteCss.innerText.includes("ON");
                this.btnRouteCss.innerText = isActive ? "CSS OUT: OFF" : "CSS OUT: ON";
                this.btnRouteCss.style.background = isActive ? "" : "#006";
                this.cssConfig.style.display = isActive ? "block" : "none";
                this.updateRouting();
            });
        }
        if (this.selRouteMode) {
            this.selRouteMode.addEventListener('change', () => {
                const isCC = this.selRouteMode.value === 'cc';
                this.ccConfig.style.display = isCC ? 'block' : 'none';
                this.updateRouting();
            });
        }

        // Change listeners for detailed routing config
        const update = () => this.updateRouting();
        if(this.cc1Src) this.cc1Src.addEventListener('change', update);
        if(this.cc1Num) this.cc1Num.addEventListener('change', update);
        if(this.cc2Src) this.cc2Src.addEventListener('change', update);
        if(this.cc2Num) this.cc2Num.addEventListener('change', update);
        if(this.cssPreset) this.cssPreset.addEventListener('change', update);
    }

    setRoutingState(enabled) {
        if (this.btnRouteMidi) {
            this.btnRouteMidi.innerText = enabled ? "MIDI OUT: ON" : "MIDI OUT: OFF";
            this.btnRouteMidi.style.background = enabled ? "#600" : "";
        }
    }

    updateRouting() {
        if (!this.audio) return; // Need access to main logic, assume passed or handled via callback? 
        // DevicePanel is passed audio engine, but TransEngine handles logic.
        // We should trigger a callback with config
        
        const config = {
            midiEnabled: this.btnRouteMidi.innerText.includes("ON"),
            cssEnabled: this.btnRouteCss.innerText.includes("ON"),
            midiMode: this.selRouteMode.value,
            cssPreset: this.cssPreset.value,
            ccMap: [
                { src: this.cc1Src.value, cc: parseInt(this.cc1Num.value) },
                { src: this.cc2Src.value, cc: parseInt(this.cc2Num.value) }
            ]
        };
        
        // Dirty hack: DevicePanel usually doesn't know about TransEngine directly.
        // We will dispatch event or use callback if available.
        // Or access global app if strict decoupling not required for this patch.
        // Better: use callbacks.
        
        if (this.callbacks.onRoutingChange) {
            this.callbacks.onRoutingChange(config);
        }
    }

    initChannels() {
        if (!this.selChannel) return;
        this.selChannel.innerHTML = '';
        for (let i = 1; i <= 16; i++) {
            const opt = document.createElement('option');
            opt.value = i;
            opt.text = i;
            this.selChannel.appendChild(opt);
        }
    }

    updateMidiList(outputs) {
        if (!this.selMidi) return;
        
        // Save current selection
        const current = this.selMidi.value;

        this.selMidi.innerHTML = '';
        
        // Add 'ALL' option
        const optAll = document.createElement('option');
        optAll.value = 'all';
        optAll.text = 'ALL DEVICES';
        this.selMidi.appendChild(optAll);

        if (outputs && outputs.length > 0) {
            outputs.forEach(output => {
                const opt = document.createElement('option');
                opt.value = output.id;
                opt.text = output.name || `MIDI Out ${output.id}`;
                this.selMidi.appendChild(opt);
            });
        }

        // Restore selection if possible, else default to all
        const options = Array.from(this.selMidi.options);
        if (options.some(o => o.value === current)) {
            this.selMidi.value = current;
        } else {
            this.selMidi.value = 'all';
        }
    }

    async refreshDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            
            // Inputs
            const inputs = devices.filter(d => d.kind === 'audioinput');
            this.selInput.innerHTML = '';
            inputs.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.text = d.label || `Input ${d.deviceId.slice(0,5)}...`;
                this.selInput.appendChild(opt);
            });
            if(inputs.length === 0) {
                 const opt = document.createElement('option');
                 opt.value = 'default';
                 opt.text = 'Default Input';
                 this.selInput.appendChild(opt);
            }

            // Outputs
            const outputs = devices.filter(d => d.kind === 'audiooutput');
            this.selOutput.innerHTML = '';
            if (outputs.length > 0) {
                outputs.forEach(d => {
                    const opt = document.createElement('option');
                    opt.value = d.deviceId;
                    opt.text = d.label || `Output ${d.deviceId.slice(0,5)}...`;
                    this.selOutput.appendChild(opt);
                });
            } else {
                 const opt = document.createElement('option');
                 opt.value = 'default';
                 opt.text = 'Default / Browser';
                 this.selOutput.appendChild(opt);
            }
            
            if (this.audio.currentInputId) this.selInput.value = this.audio.currentInputId;
            if (this.audio.currentOutputId) this.selOutput.value = this.audio.currentOutputId;

        } catch(e) {
            console.warn("Could not enumerate devices", e);
        }
    }
}