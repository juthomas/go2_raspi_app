import { AudioEngine } from './audio/AudioEngine.js';
import { Analyzer } from './audio/Analyzer.js';
import { Store } from './data/Store.js';
import { SceneManager } from './vis/Scene.js';
import { Visualizer } from './vis/Visualizer.js';
import { UI } from './ui/UI.js';
import { ScatterPad } from './ui/ScatterPad.js';
import { TransEngine } from './logic/TransEngine.js';
import { ExportManager } from './logic/ExportManager.js';
import { InputHandler } from './logic/InputHandler.js';
import { VideoManager } from './vis/VideoManager.js';
import { WebcamMonitor } from './vis/WebcamMonitor.js';
import { FaceMonitor } from './vis/FaceMonitor.js';
import { Go2LidarLayer } from './vis/Go2LidarLayer.js';
import { LidarSoundMapper } from './logic/LidarSoundMapper.js';
import { Go2RobotScatter } from './logic/Go2RobotScatter.js';
import { Go2ControlClient } from './go2_control_client.js';

class App {
    constructor() {
        this.store = new Store();
        this.audio = new AudioEngine();
        this.analyzer = new Analyzer(this.audio.ctx);
        
        this.sceneMgr = new SceneManager(document.getElementById('gl-canvas'));
        this.visualizer = new Visualizer(this.sceneMgr.scene, this.store);
        this.go2Lidar = new Go2LidarLayer(this.sceneMgr.scene);
        this.lidarSoundMapper = new LidarSoundMapper({ boxSize: 60 });

        // Connect LiDAR mapper to the sound point cloud
        if (this.visualizer.pointCloud) {
            this.visualizer.pointCloud.setLidarMapper(this.lidarSoundMapper);
        }

        this.videoMgr = new VideoManager(); // Primary active manager
        this.videoManagers = [this.videoMgr]; // Track all windows
        
        this.webcamMon = new WebcamMonitor();
        this.faceMonitor = new FaceMonitor();

        // Handle Video Window Close event to update UI button
        this.setupVideoManager(this.videoMgr);

        // Pass video callback to audio engine (connects to currently active manager)
        this.audio.onVideoData = (blob) => {
            if (this.videoMgr) {
                this.videoMgr.setSource(blob);
                this.ui.status.innerText = "VIDEO READY";
            }
        };
        
        // Sync grain playback to video AND Routing
        this.audio.onGrainPlay = (time, duration, volume, metadata) => {
            // 1. Handle Routing (Grain -> MIDI/CSS)
            if (metadata && metadata.frame) {
                // Synthesize a live grain event for routing if frame data exists
                const liveGrain = {
                    ...metadata.frame,
                    volume: volume // Use actual playback volume
                };
                this.transEngine.handleGrainEvent(liveGrain);
            }

            // 2. Video Sync
            let mgr = this.videoMgr;
            let bmp = metadata; 

            // Handle rich context object with source routing
            if (metadata && typeof metadata === 'object') {
                 if (metadata.sourceId) {
                    const found = this.videoManagers.find(m => m.id === metadata.sourceId);
                    if (found) mgr = found;
                 }
                 bmp = metadata.bitmap;
            }

            if (mgr) {
                if (bmp) {
                    mgr.showFrame(bmp, duration);
                } else {
                    mgr.jumpTo(time, duration, volume);
                }
            }
        };

        // Subsystems
        this.scatterPad = new ScatterPad(this.store, this.audio, (index) => {
            if (this.visualizer) {
                const pos = this.visualizer.setCursor(index);
                if (pos) this.sceneMgr.focusOn(pos);
                else this.sceneMgr.stopFocus();
            }
        });

        this.robotScatter = new Go2RobotScatter({
            onSendCmd: (msg) => {
                if (this.go2ctrl?.connected && this.go2ctrl?.pilot) {
                    if (msg?.type === "go2_move") {
                        this.go2ctrl.setTarget(
                            Number(msg.vx ?? 0),
                            Number(msg.vy ?? 0),
                            Number(msg.vyaw ?? 0),
                        );
                        return;
                    }
                    if (msg?.type === "go2_stop") {
                        this.go2ctrl.stop();
                        return;
                    }
                }
                // Strict separation: movement is only accepted on control WS bridge.
                if (msg?.type === "go2_move" || msg?.type === "go2_stop") {
                    if (this.ui?.status) {
                        this.ui.status.innerText = "GO2 control unavailable (connect Control WS + claim pilot)";
                    }
                }
            },
            scale: 0.1,
        });

        this.ui = new UI(this.audio, this.store, {
            onMicStart: this.startMic.bind(this),
            onCameraStart: this.startCamera.bind(this),
            onVideoStart: this.startVideo.bind(this),
            onFaceMode: (active) => {
                this.isFaceMode = active;
                this.visualizer.imageCloud.setEnabled(active);
                this.faceMonitor.toggle(active);
                if (active) {
                    if (this.videoMgr && (!this.videoMgr.faceModel || !this.videoMgr.bodyModel)) {
                         this.ui.status.innerText = "DETECTION MODELS LOADING... PLEASE WAIT";
                    } else {
                         this.ui.status.innerText = "DETECTION MODE: BODY + FACE";
                    }
                } else {
                    this.ui.status.innerText = "FACES MODE OFF";
                }
            },
            onFileLoad: this.loadFile.bind(this),
            onFamilySelect: this.playFamily.bind(this),
            onStop: this.stopAll.bind(this),
            onClear: this.clearAll.bind(this),
            onPlay: this.togglePlayback.bind(this),
            onToggleVideoWin: (isOpen) => {
                if(this.videoMgr) this.videoMgr.setOpen(isOpen);
            },
            onWebcamToggle: async () => {
                const isActive = await this.webcamMon.toggle();
                const btn = document.getElementById('btn-webcam');
                if(btn) {
                    if (isActive) btn.classList.add('active');
                    else btn.classList.remove('active');
                }
            },
            onTrans: this.toggleTrans.bind(this),
            onTransFader: (v) => this.transEngine.transFaderValue = v,
            onReadersFader: (v) => this.transEngine.activeReaderCount = v,
            onReaderSmooth: (v) => this.transEngine.readerSpringK = 0.005 + (1.0 - v/100) * 0.2,
            onReaderDist: (v) => this.transEngine.readerSpread = (v/100) * 0.5,
            onSmoothFader: (v) => this.transEngine.smoothingFactor = v/100,
            onGrainParams: (p) => this.scatterPad.setParams(p),
            onGrainAdsr: (a) => this.scatterPad.setAdsr(a),
            onAdsrChange: (v) => this.transEngine.adsr = v,
            onHarmo: (v) => this.transEngine.isHarmoMode = v,
            onExport: () => this.exportMgr.exportSoundPack(this.store, this.audio),
            onDownloadApp: () => this.exportMgr.exportApp(),
            onUndo: this.undoLast.bind(this),
            onInputDeviceChange: async (id) => {
                this.audio.currentInputId = id;
                if (this.isAnalyzing && !this.transEngine.isTransMode) {
                    await this.startMic(); // Restart with new device
                } else if (this.transEngine.isTransMode) {
                    await this.toggleTrans(true); // Restart trans mode with new device
                }
            },
            onOutputDeviceChange: (id) => {
                this.audio.setOutputDevice(id);
            },
            onGrainSelect: (idx) => {
                this.visualizer.setCursor(idx);
                if(idx !== null && idx >= 0 && idx < this.store.frames.length) {
                    const vec = this.visualizer.calculateFullPos(idx, this.store.frames[idx]);
                    this.sceneMgr.focusOn(vec);
                }
            },
            onPerfModeChange: (mode) => {
                switch(mode) {
                    case 'PERFORMANCE':
                        this.perfConfig.visThrottle = 100; // 10fps
                        this.perfConfig.faceThrottle = 500; // 2fps
                        this.perfConfig.cropSize = 64;
                        this.isFaceMode = false; // Auto-disable faces for speed
                        break;
                    case 'QUALITY':
                        this.perfConfig.visThrottle = 16; // 60fps
                        this.perfConfig.faceThrottle = 100; // 10fps
                        this.perfConfig.cropSize = 256;
                        break;
                    default: // BALANCED
                        this.perfConfig.visThrottle = 33;
                        this.perfConfig.faceThrottle = 200;
                        this.perfConfig.cropSize = 128;
                }
                this.visualizer.imageCloud.setEnabled(this.isFaceMode);
                this.ui.status.innerText = `MODE: ${mode}`;
            },
            onMidiModeToggle: () => this.transEngine.toggleMidiMode(),
            onMidiDeviceChange: (id) => this.transEngine.setMidiDevice(id),
            onMidiChannelChange: (ch) => this.transEngine.setMidiChannel(ch),
            onRequestMidi: () => this.transEngine.initMIDI(true),
            onRoutingChange: (cfg) => this.transEngine.setRoutingConfig(cfg)
        });

        this.transEngine = new TransEngine(this.store, this.audio, this.analyzer, this.visualizer, this.ui);
        this.exportMgr = new ExportManager(this.ui);
        this.inputHandler = new InputHandler(this);

        this.isAnalyzing = false;
        this.isFaceMode = true;
        this.currentSegment = null;
        this.currentViewMode = 'default';
        this.lastGrainPlay = 0;
        
        // Performance Throttling defaults (Balanced)
        this.perfConfig = {
            visThrottle: 33, // ~30fps
            faceThrottle: 200, // ~5fps
            cropSize: 128
        };

        this.inputHandler.setupKeyboard();
        this.inputHandler.setupMouse();
        this.inputHandler.setupGamepad();

        window.addEventListener('go2-pointcloud', (e) => {
            if (!e.detail) {
                if (this.go2Lidar) this.go2Lidar.disconnect();
                this.lidarSoundMapper.disconnect();
                this.lidarSoundMapper.setEnabled(false);
                return;
            }
            if (this.go2Lidar) this.go2Lidar.updateFromPayload(e.detail);
            this.lidarSoundMapper.updateFromPayload(e.detail);
            this.lidarSoundMapper.setEnabled(true);

            // Mise à jour position robot dans l'explorateur Timbre/Pitch
            if (e.detail.robot_state) {
                this.robotScatter.update(e.detail.robot_state);
                if (this.robotScatter.scatterPos) {
                    this.scatterPad.setRobotCursor(
                        this.robotScatter.scatterPos.nx,
                        this.robotScatter.scatterPos.ny,
                        this.robotScatter.worldYaw,
                    );
                }
            }
        });

        // Enable Face Mode by default
        this.visualizer.imageCloud.setEnabled(true);
        this.faceMonitor.toggle(true);
        const btnFaces = document.getElementById('btn-faces');
        if (btnFaces) btnFaces.classList.add('active');
        
        // --- LiDAR Faders/Sliders bindings ---
        const lsm = this.lidarSoundMapper;
        const g2l = this.go2Lidar;
        const lidarEl = (id) => document.getElementById(id);

        const blendF = lidarEl('lidar-blend-fader');
        if (blendF) blendF.addEventListener('input', (e) => lsm.setBlendFactor(parseInt(e.target.value) / 100));

        const attrF = lidarEl('lidar-attraction-fader');
        if (attrF) attrF.addEventListener('input', (e) => lsm.setAttractionForce(parseInt(e.target.value) / 100));

        const densF = lidarEl('lidar-density-fader');
        if (densF) densF.addEventListener('input', (e) => lsm.setDensityRadius(0.5 + (parseInt(e.target.value) / 100) * 9.5));

        const minDF = lidarEl('lidar-min-dist-fader');
        if (minDF) minDF.addEventListener('input', (e) => lsm.setMinDistance(parseInt(e.target.value) / 100));

        const maxDF = lidarEl('lidar-max-dist-fader');
        if (maxDF) maxDF.addEventListener('input', (e) => lsm.setMaxDistance(parseInt(e.target.value) / 100));

        const smoothF = lidarEl('lidar-smooth-fader');
        if (smoothF) smoothF.addEventListener('input', (e) => lsm.setSmoothFactor(parseInt(e.target.value) / 100));

        const budgetF = lidarEl('lidar-point-budget-fader');
        if (budgetF) budgetF.addEventListener('input', (e) => {
            const v = parseInt(e.target.value);
            const budget = Math.round(500 + (v / 100) * 49500);
            lsm.setPointBudget(budget);
            if (g2l) g2l.maxPoints = budget;
        });

        this.setupGo2LidarUi();
        this.setupRobotScatterUi();
        this.setupGo2ControlUi();

        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }

    setupGo2ControlUi() {
        const $ = (id) => document.getElementById(id);

        const ctrlStatus = $('go2-ctrl-status');
        const seqInfo    = $('go2-seq-info');
        const btnPlay    = $('go2-btn-play');
        const btnRec     = $('go2-btn-rec');
        const btnKb      = $('go2-btn-ctrl-kb');

        const getVx   = () => parseFloat($('go2-ctrl-vx')?.value   ?? 25) / 100;
        const getVyaw = () => parseFloat($('go2-ctrl-vyaw')?.value ?? 70) / 100;

        const setCtrlStatus = (text, ok) => {
            if (!ctrlStatus) return;
            ctrlStatus.textContent = text;
            ctrlStatus.style.color = ok === true ? '#3fb950' : ok === false ? '#f85149' : '#888';
        };

        const updateSeqInfo = (seq) => {
            if (!seqInfo || !btnPlay) return;
            const len = seq?.length ?? 0;
            const ms  = seq ? seq.reduce((s, e) => s + e.dt, 0) : 0;
            if (this.go2ctrl.isPlaying) {
                seqInfo.textContent = '▶ lecture…';
                seqInfo.style.color = '#44ff88';
                btnPlay.textContent = '■ STOP';
                btnPlay.style.color = '#ffaa44';
                btnPlay.disabled    = false;
            } else if (this.go2ctrl.isRecording) {
                seqInfo.textContent = `● ${len} frames`;
                seqInfo.style.color = '#ff4444';
            } else {
                seqInfo.textContent = len ? `${len} frames · ${(ms / 1000).toFixed(1)}s` : 'pas de séquence';
                seqInfo.style.color = '#555';
                btnPlay.textContent = '▶ PLAY';
                btnPlay.style.color = '#44ff88';
                btnPlay.disabled    = len === 0;
            }
        };

        this.go2ctrl = new Go2ControlClient({
            onStatus:    setCtrlStatus,
            onPilot:     (ok) => setCtrlStatus(ok ? 'Pilot accordé ✓' : 'Pilot refusé', ok),
            onSeqUpdate: updateSeqInfo,
        });

        // URL par défaut
        const urlInput = $('go2-ctrl-url');
        if (urlInput) {
            const defaultUrl = (() => {
                const p = location.protocol === 'https:' ? 'wss:' : 'ws:';
                const h = location.hostname;
                return (h === 'localhost' || h === '127.0.0.1') ? `${p}//127.0.0.1:8766` : `${p}//${h}:8766`;
            })();
            try { urlInput.value = localStorage.getItem('go2_ctrl_url') || defaultUrl; } catch (_) { urlInput.value = defaultUrl; }
        }

        // Connexion
        $('btn-go2-ctrl-on')?.addEventListener('click', () => {
            const url = urlInput?.value?.trim();
            if (!url) { setCtrlStatus('URL vide', false); return; }
            try { localStorage.setItem('go2_ctrl_url', url); } catch (_) {}
            this.go2ctrl.connect(url);
        });
        $('btn-go2-ctrl-off')?.addEventListener('click', () => this.go2ctrl.disconnect());

        // Clavier flèches toggle
        $('btn-go2-ctrl-kb')?.addEventListener('click', () => {
            const active = !this.go2ctrl._kbActive;
            this.go2ctrl.toggleKeyboard(active, getVx(), getVyaw());
            if ($('btn-go2-ctrl-kb')) {
                $('btn-go2-ctrl-kb').textContent = `KB: ${active ? 'ON' : 'OFF'}`;
                $('btn-go2-ctrl-kb').classList.toggle('active', active);
            }
        });

        // Sliders vitesse
        const updateSpeeds = () => this.go2ctrl._speedVx = getVx(), this.go2ctrl._speedVyaw = getVyaw();
        $('go2-ctrl-vx')?.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value) / 100;
            if ($('go2-ctrl-vx-val')) $('go2-ctrl-vx-val').textContent = v.toFixed(2);
            this.go2ctrl._speedVx = v;
        });
        $('go2-ctrl-vyaw')?.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value) / 100;
            if ($('go2-ctrl-vyaw-val')) $('go2-ctrl-vyaw-val').textContent = v.toFixed(2);
            this.go2ctrl._speedVyaw = v;
        });

        // D-Pad (pointerdown/up pour touch + souris)
        const dpad = (btnId, vx, vy, vyaw) => {
            const btn = $(btnId);
            if (!btn) return;
            btn.addEventListener('pointerdown', () => this.go2ctrl.setTarget(vx * getVx(), vy, vyaw * getVyaw()));
            btn.addEventListener('pointerup',   () => this.go2ctrl.setTarget(0, 0, 0));
            btn.addEventListener('pointerleave',() => this.go2ctrl.setTarget(0, 0, 0));
            btn.addEventListener('pointercancel',()=> this.go2ctrl.setTarget(0, 0, 0));
        };
        dpad('go2-btn-fwd',   1,  0,  0);
        dpad('go2-btn-back', -1,  0,  0);
        dpad('go2-btn-left',  0,  0,  1);
        dpad('go2-btn-right', 0,  0, -1);
        $('go2-btn-stop')?.addEventListener('click', () => this.go2ctrl.stop());

        // Postures
        const cmd = (btnId, type) => $(btnId)?.addEventListener('click', () => this.go2ctrl.send({ type }));
        cmd('go2-btn-standup',   'stand_up');
        cmd('go2-btn-standdown', 'stand_down');
        cmd('go2-btn-balance',   'balance_stand');
        cmd('go2-btn-recovery',  'recovery_stand');
        cmd('go2-btn-normal',    'normal_mode');

        // REC
        btnRec?.addEventListener('click', () => {
            if (this.go2ctrl.isRecording) {
                this.go2ctrl.stopRec();
                if (btnRec) { btnRec.textContent = '● REC'; btnRec.classList.remove('active'); }
                if (this.ui?.status) this.ui.status.innerText = `GO2 REC STOP — ${this.go2ctrl.sequenceLength} frames`;
            } else {
                this.go2ctrl.startRec();
                if (btnRec) { btnRec.textContent = '■ STOP REC'; btnRec.classList.add('active'); }
                if (this.ui?.status) this.ui.status.innerText = 'GO2 REC…';
            }
        });

        // PLAY
        btnPlay?.addEventListener('click', () => {
            if (this.go2ctrl.isPlaying) {
                this.go2ctrl.stopPlay();
                if (this.ui?.status) this.ui.status.innerText = 'GO2 PLAY ARRÊTÉ';
            } else {
                if (this.go2ctrl.startPlay()) {
                    if (this.ui?.status) this.ui.status.innerText = 'GO2 PLAY — robot rejoue la séquence';
                }
            }
        });
    }

    setupGo2LidarUi() {
        const slider = document.getElementById('go2-history-retention');
        const valLabel = document.getElementById('go2-history-retention-val');
        const colorCur = document.getElementById('go2-color-current');
        const colorHist = document.getElementById('go2-color-history');
        if (!this.go2Lidar || !slider || !valLabel || !colorCur || !colorHist) return;

        const applyRetention = () => {
            const sec = parseFloat(slider.value);
            const ms = Math.round(sec * 1000);
            valLabel.textContent = `${sec.toFixed(1)} s`;
            this.go2Lidar.setHistoryRetentionMs(ms);
            try {
                localStorage.setItem('go2_history_ms', String(ms));
            } catch (_) {}
        };

        const applyColors = () => {
            this.go2Lidar.setCurrentColor(colorCur.value);
            this.go2Lidar.setHistoryColor(colorHist.value);
            try {
                localStorage.setItem('go2_color_current', colorCur.value);
                localStorage.setItem('go2_color_history', colorHist.value);
            } catch (_) {}
        };

        try {
            const ms = parseInt(localStorage.getItem('go2_history_ms'), 10);
            if (Number.isFinite(ms) && ms >= 100 && ms <= 120000) {
                slider.value = String(Math.min(15, Math.max(0.2, ms / 1000)));
            }
            const cc = localStorage.getItem('go2_color_current');
            if (cc && /^#[0-9a-fA-F]{6}$/.test(cc)) colorCur.value = cc;
            const ch = localStorage.getItem('go2_color_history');
            if (ch && /^#[0-9a-fA-F]{6}$/.test(ch)) colorHist.value = ch;
        } catch (_) {}

        applyRetention();
        applyColors();

        slider.addEventListener('input', applyRetention);
        colorCur.addEventListener('input', applyColors);
        colorHist.addEventListener('input', applyColors);
    }

    setupRobotScatterUi() {
        const $ = (id) => document.getElementById(id);

        // Calibrer : position actuelle du robot → centre de l'explorateur
        const btnCal = $('btn-go2-scatter-cal');
        if (btnCal) {
            btnCal.addEventListener('click', () => {
                const origin = this.robotScatter.calibrate();
                if (origin) {
                    this.scatterPad.setRobotActive(true);
                    this.ui.status.innerText = `GO2 CALIBRÉ (${origin.x.toFixed(2)}, ${origin.y.toFixed(2)})`;
                    btnCal.classList.add('active');
                } else {
                    this.ui.status.innerText = 'CALIBRATION: AUCUNE POSITION ROBOT — connecte le pont LiDAR';
                }
            });
        }

        // REC : enregistrer la trajectoire
        const btnRec = $('btn-go2-scatter-rec');
        if (btnRec) {
            btnRec.addEventListener('click', () => {
                if (this.robotScatter.isRecording) {
                    const path = this.robotScatter.stopRec();
                    this.scatterPad.setRecordedPath(path);
                    this.scatterPad.setRobotRecording(false);
                    this.ui.status.innerText = `GO2 REC STOP — ${path.length} pts enregistrés`;
                    btnRec.classList.remove('active');
                } else {
                    if (!this.robotScatter.calibOrigin) {
                        this.ui.status.innerText = 'REC: calibre d\'abord (bouton CAL)';
                        return;
                    }
                    this.robotScatter.startRec();
                    this.scatterPad.setRobotRecording(true);
                    this.scatterPad.setRecordedPath([]);
                    this.scatterPad.setPlaybackIdx(-1);
                    this.ui.status.innerText = 'GO2 REC...';
                    btnRec.classList.add('active');
                }
            });
        }

        // PLAY : rejouer physiquement la trajectoire enregistrée
        const btnPlay = $('btn-go2-scatter-play');
        if (btnPlay) {
            btnPlay.addEventListener('click', () => {
                if (this.robotScatter.isPlaying) {
                    this.robotScatter.stopPlayback();
                    this.scatterPad.setPlaybackIdx(-1);
                    btnPlay.classList.remove('active');
                    this.ui.status.innerText = 'GO2 PLAY ARRÊTÉ';
                } else {
                    if (this.robotScatter.startPlayback()) {
                        this.scatterPad.setPlaybackIdx(0);
                        btnPlay.classList.add('active');
                        this.ui.status.innerText = 'GO2 PLAY — robot retourne sur la trajectoire';
                    } else {
                        this.ui.status.innerText = 'GO2 PLAY: enregistre une trajectoire d\'abord (REC)';
                    }
                }
            });
        }

        // Slider échelle (m/unité scatter)
        const sliderScale = $('go2-scatter-scale');
        const labelScale  = $('go2-scatter-scale-val');
        if (sliderScale) {
            const apply = () => {
                const v = parseFloat(sliderScale.value);
                this.robotScatter.setScale(v);
                if (labelScale) labelScale.textContent = `${v.toFixed(2)} u/m`;
            };
            sliderScale.addEventListener('input', apply);
            apply();
        }

        // Slider rayon du reader robot
        const sliderRadius = $('go2-scatter-radius');
        const labelRadius  = $('go2-scatter-radius-val');
        if (sliderRadius) {
            const applyRadius = () => {
                // slider 1..100 → rayon 0.005..0.5
                const v = parseInt(sliderRadius.value) / 200;
                this.scatterPad.setRobotRadius(v);
                if (labelRadius) labelRadius.textContent = v.toFixed(3);
            };
            sliderRadius.addEventListener('input', applyRadius);
            applyRadius();
        }

        // Toggle son autour du robot
        const btnSound = $('btn-go2-scatter-sound');
        if (btnSound) {
            btnSound.addEventListener('click', () => {
                const next = !this.scatterPad.robotActive;
                this.scatterPad.setRobotActive(next);
                btnSound.classList.toggle('active', next);
                this.ui.status.innerText = next ? 'GO2 SON ACTIF' : 'GO2 SON OFF';
            });
        }
    }

    setupVideoManager(mgr) {
        mgr.onClose = (closedMgr) => {
            // Remove from list
            this.videoManagers = this.videoManagers.filter(m => m !== closedMgr);
            
            // If we closed the active one, fallback to another or null
            if (this.videoMgr === closedMgr) {
                this.videoMgr = this.videoManagers.length > 0 ? this.videoManagers[this.videoManagers.length - 1] : null;
                if (this.videoMgr) {
                    // Update UI state based on new active window
                    // (Optional, keeps sync)
                } else {
                    if (this.ui.transportPanel.elements.btnVidWin) {
                        this.ui.transportPanel.elements.btnVidWin.classList.remove('active');
                    }
                }
            }
        };
    }

    createNewVideoWindow() {
        // If the current videoMgr is empty/unused, reuse it? 
        // For now, always spawn new if requested, to ensure "history" style
        if (this.videoMgr && !this.videoMgr.isActive) {
            return this.videoMgr;
        }
        
        const mgr = new VideoManager();
        this.setupVideoManager(mgr);
        this.videoManagers.push(mgr);
        this.videoMgr = mgr;
        return mgr;
    }

    async startMic() {
        this.stopAll();
        const source = await this.audio.initMic(true);
        if (source) {
            this.analyzer.connectSource(source);
            this.isAnalyzing = true;
            if (this.videoMgr) this.videoMgr.hide();
            if (this.ui.btnMic) this.ui.btnMic.classList.add('active');
        }
    }

    async startVideo() {
        this.stopAll();
        const source = await this.audio.initVideo(true);
        if (source) {
            const mgr = this.createNewVideoWindow();
            mgr.initStream(this.audio.stream);
            this.analyzer.connectSource(source);
            this.isAnalyzing = true;
            this.ui.status.innerText = "RECORDING SCREEN...";
            
            if(this.ui.transportPanel.elements.btnVidWin) {
                this.ui.transportPanel.elements.btnVidWin.classList.add('active');
            }
            if(this.ui.transportPanel.elements.btnRecVid) {
                this.ui.transportPanel.elements.btnRecVid.classList.add('active');
            }
        } else {
             this.ui.status.innerText = "VIDEO CANCELLED";
             this.ui.transportPanel.reset();
        }
    }

    async startCamera() {
        this.stopAll();
        const source = await this.audio.initCamera(true);
        if (source) {
            const mgr = this.createNewVideoWindow();
            mgr.initStream(this.audio.stream);
            this.analyzer.connectSource(source);
            this.isAnalyzing = true;
            this.ui.status.innerText = "RECORDING CAMERA...";
            if(this.ui.transportPanel.elements.btnVidWin) {
                this.ui.transportPanel.elements.btnVidWin.classList.add('active');
            }
            if(this.ui.transportPanel.elements.btnRecCam) {
                this.ui.transportPanel.elements.btnRecCam.classList.add('active');
            }
        } else {
            this.ui.status.innerText = "CAMERA FAILED";
            this.ui.transportPanel.reset();
        }
    }

    clearAll() {
        this.store.reset();
        this.audio.clear();
        this.visualizer.reset();
        this.sceneMgr.resetFollow();
        this.ui.reset();
        if (this.faceMonitor) this.faceMonitor.reset();
        if (this.scatterPad) this.scatterPad.clearLFOs();
    }

    undoLast() {
        // Attempt to remove the entire last audio clip (recording session)
        const clip = this.audio.removeLastClip();
        
        if (clip) {
            const end = clip.startTime + clip.buffer.duration;
            // Remove all frames associated with this clip's timeframe
            const removedFrames = this.store.removeFramesInTimeRange(clip.startTime, end);
            
            removedFrames.forEach(f => {
                if (f.isFace || f.bitmap) {
                    this.visualizer.removeFace(f);
                }
                // Dispose bitmaps to free memory
                if (f.bitmap && f.bitmap.close) f.bitmap.close();
            });
            
            this.visualizer.updatePoints(this.sceneMgr.camera.position);
            this.visualizer.renderSegments();
            this.ui.updateFamilies();
            
            this.ui.status.innerText = `UNDO: REMOVED ${removedFrames.length} FRAMES`;
        } else {
            // Fallback for single points (legacy)
            const removed = this.store.removeLastFrame();
            if (removed) {
                this.ui.status.innerText = `UNDO: ${this.store.frames.length} PTS`;
                if (removed.isFace || removed.bitmap) {
                    this.visualizer.removeFace(removed);
                }
                this.visualizer.updatePoints(this.sceneMgr.camera.position);
            } else {
                this.ui.status.innerText = "NOTHING TO UNDO";
            }
        }
    }

    stopAll() {
        this.audio.stop();
        // Stop current active recording
        if (this.videoMgr) this.videoMgr.stop();
        
        this.isAnalyzing = false;
        this.transEngine.isTransMode = false;
        this.ui.setPlayState(false);
        this.ui.updateVu(0);
        this.ui.btnTrans.classList.remove('active');
        
        // Ensure buttons reset
        if(this.ui.transportPanel.elements.btnRecCam) {
            this.ui.transportPanel.elements.btnRecCam.classList.remove('active');
        }
        if(this.ui.transportPanel.elements.btnRecVid) {
            this.ui.transportPanel.elements.btnRecVid.classList.remove('active');
        }
        if(this.ui.btnMic) {
            this.ui.btnMic.classList.remove('active');
        }
    }

    async toggleTrans(active) {
        if (active) {
            if (this.ui.btnMic.classList.contains('active')) {
                this.ui.btnMic.classList.remove('active');
                this.isAnalyzing = false;
            }
            
            const btnRecVid = this.ui.transportPanel.elements.btnRecVid;
            if (btnRecVid && btnRecVid.classList.contains('active')) {
                btnRecVid.classList.remove('active');
            }

            if (this.audio.isPlaying) this.audio.stop();
            this.ui.setPlayState(false);
            
            const source = await this.audio.initMic(false);
            this.analyzer.connectSource(source);
            
            this.transEngine.isTransMode = true;
            this.isAnalyzing = false;
        } else {
            this.transEngine.isTransMode = false;
            this.audio.stop();
        }
    }
    
    togglePlayback() {
        if (this.audio.isPlaying) {
            this.audio.pause();
            if (this.videoMgr) this.videoMgr.pause();
            this.ui.setPlayState(false);
        } else {
            const src = this.audio.playBuffer(this.audio.pausedAt);
            if(src) {
                this.isAnalyzing = false; 
                this.ui.setPlayState(true);
                this.analyzer.connectSource(src);
                if (this.videoMgr) {
                    this.videoMgr.play();
                    // Sync video start time
                    this.videoMgr.jumpTo(this.audio.pausedAt);
                }
            }
        }
    }

    async loadFile(file) {
        this.store.reset();
        this.visualizer.reset();
        this.audio.clear();

        if (file.name.toLowerCase().endsWith('.zip')) {
            await this.exportMgr.loadZip(file, this.audio, this.store, this.visualizer, this.analyzer);
        } else {
            // Check if it's a video file type roughly or if we have video handling in audio engine (AudioEngine just loads generic buffer usually)
            // But if the user drops a video, we might want to see it? 
            // Current VideoManager.setSource handles blob urls.
            // If it's a video file, we should try to load it into VideoManager too.
            
            if (file.type.startsWith('video')) {
                const mgr = this.createNewVideoWindow();
                mgr.setSource(file);
                if(this.ui.transportPanel.elements.btnVidWin) {
                    this.ui.transportPanel.elements.btnVidWin.classList.add('active');
                }
            }

            await this.audio.loadFile(file);
            const source = this.audio.playBuffer();
            this.analyzer.connectSource(source);
            this.isAnalyzing = true;
        }
    }

    // removed setupKeyboard() { ... } - moved to InputHandler.js
    // removed setupMouse() { ... } - moved to InputHandler.js
    // removed exportSoundPack() { ... } - moved to ExportManager.js
    // removed swarm & physics variables - moved to TransEngine.js

    toggleView(mode) {
        document.body.classList.remove('view-2d', 'view-3d', 'view-params');
        if (this.currentViewMode === mode) {
            this.currentViewMode = 'default';
        } else {
            this.currentViewMode = mode;
            document.body.classList.add(`view-${mode}`);
        }
        setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
    }

    playFamily(note) {
        const segs = this.store.getSegmentsByFamily(note);
        if (segs.length === 0) return;
        let delay = 0;
        segs.forEach(seg => {
            setTimeout(() => {
                const pan = (seg.avgCentroid - 0.5) * 2;
                this.audio.playSegment(seg.startTime, seg.endTime - seg.startTime, pan);
            }, delay * 1000);
            delay += (seg.endTime - seg.startTime) + 0.1; 
        });
    }

    processAnalysis() {
        // Unified Data Fetching
        let data = { volume: 0, pitch: 0, centroid: 0, note: null, time: this.audio.getCurrentTime() };
        if (this.audio.ctx.state === 'running') {
            try { data = this.analyzer.getFrameData(data.time); } catch(e) {}
        }
        this.ui.updateVu(data.volume);

        // 1. Trans Mode Logic (Delegated)
        // removed big chunk of logic - moved to TransEngine.process()
        if (this.transEngine.process(data)) return;

        // 2. Recording / Playback Analysis
        if (!this.isAnalyzing && !this.audio.isPlaying && !this.audio.source) return;

        if (data.volume > 0) {
            if (this.isAnalyzing) {
                // Unique ID for texture mapping
                data.id = Date.now() + Math.random();

                // Video Snapshot Capture
                const now = Date.now();
                // Throttle Face Detection to ~5fps (200ms) to save CPU/GPU
                if (this.audio.lastRecordingType === 'video' && (!this.lastFaceDetect || now - this.lastFaceDetect > 200)) {
                     this.lastFaceDetect = now;
                     this.videoMgr.captureFrame().then(async (bmp) => {
                         if (bmp) {
                             let displayBitmap = bmp;

                             // Face Detection & Cropping
                             if (this.isFaceMode) {
                                 try {
                                     const detections = await this.videoMgr.detectAll(bmp);
                                     if (detections.length > 0) {
                                         data.isFace = true;
                                         
                                         // 1. Send all detections to monitor
                                         for (let detection of detections) {
                                             const { x, y, width, height } = detection.boundingBox;
                                             // Expand slightly
                                             const pad = width * 0.2;
                                             
                                             // Round coordinates to prevent index errors
                                             const sx = Math.floor(Math.max(0, x - pad));
                                             const sy = Math.floor(Math.max(0, y - pad));
                                             const sw = Math.floor(Math.min(bmp.width - sx, width + pad * 2));
                                             const sh = Math.floor(Math.min(bmp.height - sy, height + pad * 2));

                                             if (sw > 0 && sh > 0) {
                                                 const crop = await createImageBitmap(bmp, sx, sy, sw, sh);
                                                 this.faceMonitor.addFace(crop);
                                                 
                                                 // Use the first detection for the granular cloud
                                                 if (detection === detections[0]) {
                                                     displayBitmap = crop; 
                                                 } else {
                                                     // Close auxiliary crops immediately after drawing to monitor
                                                     crop.close();
                                                 }
                                             }
                                         }
                                         
                                         // If we cropped, close the full frame to save mem
                                         if (displayBitmap !== bmp && bmp) {
                                             bmp.close();
                                         }
                                     }
                                 } catch(e) {
                                     console.error("Face Detect Error", e);
                                 }
                             }

                             // Race condition fix
                             if (this.store.frames.includes(data)) {
                                 data.bitmap = displayBitmap;
                                 if (data.isFace) {
                                    this.visualizer.addFace(data);
                                 }
                             } else {
                                 if(displayBitmap) displayBitmap.close();
                             }
                         }
                     });
                }

                if (this.videoMgr) {
                    data.sourceVidId = this.videoMgr.id;
                }
                this.store.addFrame(data);
                this.visualizer.updatePoints(this.sceneMgr.camera.position); 
                
                if (!this.currentSegment) {
                    this.currentSegment = {
                        startTime: data.time, pitchSum: data.pitch, centroidSum: data.centroid,
                        count: 1, note: data.note, id: Date.now()
                    };
                } else {
                    if (data.note === this.currentSegment.note) {
                        this.currentSegment.pitchSum += data.pitch;
                        this.currentSegment.centroidSum += data.centroid;
                        this.currentSegment.count++;
                    } else {
                        this.finishSegment(data.time);
                        this.currentSegment = {
                             startTime: data.time, pitchSum: data.pitch, centroidSum: data.centroid,
                             count: 1, note: data.note, id: Date.now()
                        };
                    }
                }
            }
            this.ui.updateStats(data.pitch, data.note, data.time);
        } else {
            if (this.isAnalyzing && this.currentSegment) {
                this.finishSegment(data.time);
            }
        }
    }

    finishSegment(endTime) {
        if (!this.currentSegment) return;
        
        const dur = endTime - this.currentSegment.startTime;
        if (dur > 0.1) { 
            const seg = {
                id: this.currentSegment.id,
                startTime: this.currentSegment.startTime,
                endTime: endTime,
                avgPitch: this.currentSegment.pitchSum / this.currentSegment.count,
                avgCentroid: this.currentSegment.centroidSum / this.currentSegment.count,
                note: this.currentSegment.note
            };
            this.store.addSegment(seg);
            this.visualizer.renderSegments();
            this.ui.updateFamilies();
        }
        this.currentSegment = null;
    }

    animate() {
        requestAnimationFrame(this.animate);
        this.processAnalysis();

        // Tick playback robot GO2
        if (this.robotScatter.isPlaying) {
            const idx = this.robotScatter.tick();
            this.scatterPad.setPlaybackIdx(idx);
            if (idx < 0) {
                const btnPlay = document.getElementById('btn-go2-scatter-play');
                if (btnPlay) btnPlay.classList.remove('active');
            }
        }

        // Pass camera position for billboards
        // Optimized: Dynamic throttling based on perf mode
        const now = Date.now();
        if (!this.lastVisUpdate || now - this.lastVisUpdate > this.perfConfig.visThrottle) {
            // Check if user is rotating camera (cheap check) or if data changed
            if (this.isFaceMode) {
                this.visualizer.updatePoints(this.sceneMgr.camera.position);
            } else {
                // Point cloud doesn't need camera pos if no faces (billboards)
                this.visualizer.updatePoints(null);
            }
            this.lastVisUpdate = now;
        }
        
        // Cache current audio time to avoid multiple AudioContext calls
        let currentTime = 0;
        let volume = 0;
        
        const audioActive = (this.audio.isPlaying || this.isAnalyzing) && !this.store.isPaused;

        if (audioActive) {
             currentTime = this.audio.getCurrentTime();
             
             // Sync linear video playback
             if (this.audio.isPlaying && this.audio.playbackStartTime && this.videoMgr) {
                 const trackTime = currentTime - this.audio.playbackStartTime;
                 this.videoMgr.sync(trackTime);
             }

             // Analyze only once per frame
             if (this.audio.isPlaying || this.isAnalyzing) {
                 const frame = this.analyzer.getFrameData(currentTime);
                 volume = frame.volume;
             }
             
             if (this.ui.isFollowEnabled) {
                this.visualizer.updatePlayhead(currentTime, volume);
                this.visualizer.setPlayheadVisible(true);
             } else {
                this.visualizer.setPlayheadVisible(false);
             }
        }
        


        this.sceneMgr.render();
    }
}

window.onload = () => {
    const app = new App();
};