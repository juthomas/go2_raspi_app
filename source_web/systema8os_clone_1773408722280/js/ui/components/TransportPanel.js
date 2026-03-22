export class TransportPanel {
    constructor(elements, callbacks) {
        this.elements = elements;
        this.callbacks = callbacks;
        this.perfModes = ['BALANCED', 'PERFORMANCE', 'QUALITY'];
        this.perfIndex = 0;
        this.init();
    }

    init() {
        const { btnMic, btnRecCam, btnRecVid, btnVidWin, btnWebcam, btnPlay, btnStop, btnClear, btnUndo, btnFollow, btnTrans, btnHarmo, btnExport, btnFaces, btnReverb, btnMidi, btnCloseMidi, midiTerminal, btnInfo, infoOverlay, btnCloseInfo, btnDownload } = this.elements;
        
        // Performance Mode Button
        const btnPerf = document.getElementById('btn-perf-mode');
        if (btnPerf) {
            btnPerf.addEventListener('click', () => {
                this.perfIndex = (this.perfIndex + 1) % this.perfModes.length;
                const mode = this.perfModes[this.perfIndex];
                btnPerf.innerText = `PERF: ${mode}`;
                if (this.callbacks.onPerfModeChange) this.callbacks.onPerfModeChange(mode);
            });
        }

        // MIDI Mode Button
        const btnMidiMode = document.getElementById('btn-midi-mode');
        if (btnMidiMode) {
            btnMidiMode.addEventListener('click', () => {
                if (this.callbacks.onMidiModeToggle) {
                    const newMode = this.callbacks.onMidiModeToggle();
                    btnMidiMode.innerText = `MIDI: ${newMode}`;
                }
            });
        }

        const btnLib = document.getElementById('btn-lib');
        if(btnLib) {
             btnLib.addEventListener('click', () => {
                 if(this.callbacks.onOpenLibrary) this.callbacks.onOpenLibrary();
             });
        }

        if (btnDownload) {
            btnDownload.addEventListener('click', () => {
                if (this.callbacks.onDownloadApp) {
                    this.callbacks.onDownloadApp();
                }
            });
        }

        if (btnReverb) {
            btnReverb.addEventListener('click', () => {
                const active = btnReverb.classList.toggle('active');
                if (this.callbacks.onToggleReverb) {
                    this.callbacks.onToggleReverb(active);
                }
            });
        }

        if (btnFaces) {
            btnFaces.addEventListener('click', () => {
                btnFaces.classList.toggle('active');
                if (this.callbacks.onFaceMode) {
                    this.callbacks.onFaceMode(btnFaces.classList.contains('active'));
                }
            });
        }

        if (btnInfo && infoOverlay) {
            btnInfo.addEventListener('click', () => {
                infoOverlay.classList.remove('hidden');
                btnInfo.classList.add('active');
            });
        }

        if (btnCloseInfo && infoOverlay) {
            btnCloseInfo.addEventListener('click', () => {
                infoOverlay.classList.add('hidden');
                if (btnInfo) btnInfo.classList.remove('active');
            });
        }

        if (btnWebcam) {
            btnWebcam.addEventListener('click', () => {
                this.callbacks.onWebcamToggle();
            });
        }

        if (btnVidWin) {
            btnVidWin.addEventListener('click', () => {
                const active = btnVidWin.classList.toggle('active');
                if (this.callbacks.onToggleVideoWin) {
                    this.callbacks.onToggleVideoWin(active);
                }
            });
        }

        btnMic.addEventListener('click', async () => {
            btnMic.classList.add('active');
            if (btnRecVid) btnRecVid.classList.remove('active');
            if (btnRecCam) btnRecCam.classList.remove('active');
            await this.callbacks.onMicStart();
        });

        if (btnRecCam) {
            btnRecCam.addEventListener('click', async () => {
                if (btnRecCam.classList.contains('active')) {
                    btnRecCam.classList.remove('active');
                    this.callbacks.onStop();
                } else {
                    btnRecCam.classList.add('active');
                    btnMic.classList.remove('active');
                    if (btnRecVid) btnRecVid.classList.remove('active');
                    await this.callbacks.onCameraStart();
                }
            });
        }

        if (btnRecVid) {
            btnRecVid.addEventListener('click', async () => {
                if (btnRecVid.classList.contains('active')) {
                    btnRecVid.classList.remove('active');
                    this.callbacks.onStop();
                } else {
                    btnRecVid.classList.add('active');
                    btnMic.classList.remove('active');
                    if (btnRecCam) btnRecCam.classList.remove('active');
                    await this.callbacks.onVideoStart();
                }
            });
        }

        if (btnPlay) btnPlay.addEventListener('click', () => this.callbacks.onPlay());
        
        if (btnStop) {
            btnStop.addEventListener('click', () => {
                btnMic.classList.remove('active');
                if (btnRecVid) btnRecVid.classList.remove('active');
                this.callbacks.onStop();
            });
        }

        if (btnClear) btnClear.addEventListener('click', () => this.callbacks.onClear());
        if (btnUndo) btnUndo.addEventListener('click', () => this.callbacks.onUndo && this.callbacks.onUndo());
        
        if (btnFollow) btnFollow.addEventListener('click', () => btnFollow.classList.toggle('active'));

        btnTrans.addEventListener('click', () => {
            btnTrans.classList.toggle('active');
            this.callbacks.onTrans(btnTrans.classList.contains('active'));
        });

        btnHarmo.addEventListener('click', () => {
            btnHarmo.classList.toggle('active');
            this.callbacks.onHarmo(btnHarmo.classList.contains('active'));
        });

        if (btnExport) btnExport.addEventListener('click', () => this.callbacks.onExport());

        btnMidi.addEventListener('click', () => {
            midiTerminal.classList.toggle('hidden');
            btnMidi.classList.toggle('active', !midiTerminal.classList.contains('hidden'));
        });

        btnCloseMidi.addEventListener('click', () => {
            midiTerminal.classList.add('hidden');
            btnMidi.classList.remove('active');
        });
    }

    reset() {
        this.elements.btnMic.classList.remove('active');
        if(this.elements.btnRecVid) this.elements.btnRecVid.classList.remove('active');
        if(this.elements.btnRecCam) this.elements.btnRecCam.classList.remove('active');
        if(this.elements.btnPlay) {
            this.elements.btnPlay.innerText = "PLAY";
            this.elements.btnPlay.classList.remove('active');
        }
    }

    setPlayState(isPlaying) {
        if(this.elements.btnPlay) {
            this.elements.btnPlay.innerText = isPlaying ? "PAUSE" : "PLAY";
            if (isPlaying) this.elements.btnPlay.classList.add('active');
            else this.elements.btnPlay.classList.remove('active');
        }
    }

    get isFollowEnabled() {
        // Default to false if button is missing
        return this.elements.btnFollow ? this.elements.btnFollow.classList.contains('active') : false;
    }
}