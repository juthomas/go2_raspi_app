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

class App {
    constructor() {
        this.store = new Store();
        this.audio = new AudioEngine();
        this.analyzer = new Analyzer(this.audio.ctx);
        
        this.sceneMgr = new SceneManager(document.getElementById('gl-canvas'));
        this.visualizer = new Visualizer(this.sceneMgr.scene, this.store);
        this.go2Lidar = new Go2LidarLayer(this.sceneMgr.scene);

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
            if (!this.go2Lidar) return;
            if (!e.detail) {
                this.go2Lidar.disconnect();
                return;
            }
            this.go2Lidar.updateFromPayload(e.detail);
        });

        this.setupGo2LidarUi();

        // Enable Face Mode by default
        this.visualizer.imageCloud.setEnabled(true);
        this.faceMonitor.toggle(true);
        const btnFaces = document.getElementById('btn-faces');
        if (btnFaces) btnFaces.classList.add('active');
        
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
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