import { TransportPanel } from './components/TransportPanel.js';
import { GrainControlPanel } from './components/GrainControlPanel.js';
import { DevicePanel } from './components/DevicePanel.js';
import { StatsPanel } from './components/StatsPanel.js';
import { SpatialPanel } from './components/SpatialPanel.js';
import { ReverbPanel } from './components/ReverbPanel.js';
import { LibraryPanel } from './components/LibraryPanel.js';

export class UI {
    constructor(audioEngine, store, callbacks) {
        this.audio = audioEngine;
        this.store = store;
        this.callbacks = callbacks;

        // Sub-Components
        this.statsPanel = new StatsPanel(store, callbacks.onFamilySelect);
        
        this.transportPanel = new TransportPanel({
            btnMic: document.getElementById('btn-mic'),
            btnRecCam: document.getElementById('btn-rec-cam'),
            btnRecVid: document.getElementById('btn-rec-vid'),
            btnVidWin: document.getElementById('btn-vid-win'),
            btnWebcam: document.getElementById('btn-webcam'),
            btnClear: document.getElementById('btn-clear'),
            btnUndo: document.getElementById('btn-undo'),
            btnTrans: document.getElementById('btn-trans'),
            btnHarmo: document.getElementById('btn-harmo'),
            btnFaces: document.getElementById('btn-faces'),
            btnReverb: document.getElementById('btn-reverb'),
            btnMidi: document.getElementById('btn-midi'),
            btnCloseMidi: document.getElementById('btn-close-midi'),
            midiTerminal: document.getElementById('midi-terminal'),
            btnInfo: document.getElementById('btn-info'),
            infoOverlay: document.getElementById('info-overlay'),
            btnCloseInfo: document.getElementById('btn-close-info'),
            btnDownload: document.getElementById('btn-download')
        }, {
            ...callbacks,
            onDownloadApp: async () => {
                this.statsPanel.setStatus("PREPARING DOWNLOAD...");
                await this.callbacks.onDownloadApp();
                this.statsPanel.setStatus("DOWNLOAD READY");
            },
            onMicStart: async () => {
                this.statsPanel.setStatus("LISTENING (AUDIO)...");
                await callbacks.onMicStart();
                this.devicePanel.refreshDevices();
            },
            onCameraStart: async () => {
                this.statsPanel.setStatus("STARTING CAMERA...");
                await callbacks.onCameraStart();
            },
            onVideoStart: async () => {
                this.statsPanel.setStatus("SELECT SCREEN/TAB...");
                await callbacks.onVideoStart();
            },
            onStop: () => {
                this.statsPanel.setStatus("STOPPED");
                callbacks.onStop();
            },
            onClear: () => {
                this.statsPanel.setStatus("CLEARED");
                callbacks.onClear();
            },
            onTrans: (active) => {
                this.statsPanel.setStatus(active ? "TRANS MODE: MIC INPUT DRIVING PLAYBACK" : "TRANS MODE OFF");
                callbacks.onTrans(active);
            },
            onPerfModeChange: (mode) => callbacks.onPerfModeChange(mode),
            onMidiModeToggle: () => callbacks.onMidiModeToggle(),
            onWebcamToggle: (active) => {
                callbacks.onWebcamToggle();
            },
            onToggleReverb: (active) => {
                this.reverbPanel.toggle(active);
            },
            onOpenLibrary: () => {
                this.libraryPanel.toggle();
            },
            onMidiDeviceChange: (id) => callbacks.onMidiDeviceChange(id),
            onMidiChannelChange: (ch) => callbacks.onMidiChannelChange(ch),
            onMidiTest: () => this.transEngine.testMidi()
        });

        this.libraryPanel = new LibraryPanel(store, this.audio, {
            onSelect: (idx) => {
                 if (this.callbacks.onGrainSelect) this.callbacks.onGrainSelect(idx);
            }
        });

        this.grainPanel = new GrainControlPanel({
            ...callbacks,
            onMasterVol: (v) => this.audio.setMasterVolume(v)
        });

        this.devicePanel = new DevicePanel(audioEngine, {
            ...callbacks,
            onRequestMidi: callbacks.onRequestMidi,
            onRoutingChange: callbacks.onRoutingChange
        });
        
        this.spatialPanel = new SpatialPanel({
            onSpatialParams: (p) => this.audio.setSpatialParams(p)
        });

        this.reverbPanel = new ReverbPanel({
            onReverbChange: (val) => this.audio.setReverbAmount(val),
            onInputReverbChange: (val) => this.audio.setInputReverbAmount(val),
            onInputDryVol: (val) => this.audio.setInputDryVolume(val),
            onVisibilityChange: (active) => {
                const btn = document.getElementById('btn-reverb');
                if (btn) {
                    if (active) btn.classList.add('active');
                    else btn.classList.remove('active');
                }
            }
        });

        this.initDropZone();
        
        // Expose elements for compatibility with Main.js and InputHandler.js
        this.btnMic = document.getElementById('btn-mic');
        this.btnClear = document.getElementById('btn-clear');
        this.btnTrans = document.getElementById('btn-trans');
    }

    // Legacy getter for status element used by other modules
    get status() {
        return document.getElementById('status'); 
    }

    initDropZone() {
        const dropZone = document.getElementById('file-drop');
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = '#fff';
        });
        
        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = '#666';
        });

        dropZone.addEventListener('drop', async (e) => {
            e.preventDefault();
            dropZone.style.borderColor = '#666';
            if (e.dataTransfer.files.length > 0) {
                const file = e.dataTransfer.files[0];
                this.statsPanel.setStatus("LOADING FILE...");
                await this.callbacks.onFileLoad(file);
                this.statsPanel.setStatus("FILE LOADED. PRESS SPACE.");
            }
        });
    }

    // Delegated Methods

    reset() {
        this.transportPanel.reset();
        this.statsPanel.setStatus("READY");
        this.statsPanel.updateVu(0);
        if (this.spatialPanel) this.spatialPanel.clearRecord();
    }

    setPlayState(isPlaying) {
        this.transportPanel.setPlayState(isPlaying);
    }

    updateStats(pitch, note, time) {
        this.statsPanel.updateStats(pitch, note, time);
    }

    updateVu(vol) {
        this.statsPanel.updateVu(vol);
    }

    get isFollowEnabled() {
        return this.transportPanel.isFollowEnabled;
    }

    updateFamilies() {
        this.statsPanel.updateFamilies();
    }

    logMidi(msg) {
        this.statsPanel.logMidi(msg);
    }
    
    updateMidiDevices(outputs) {
        this.devicePanel.updateMidiList(outputs);
    }

    // removed initListeners() {} - Logic distributed to components
    // removed refreshDevices() {} - Logic moved to DevicePanel
}