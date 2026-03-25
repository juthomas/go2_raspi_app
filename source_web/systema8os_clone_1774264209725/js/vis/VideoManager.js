import * as tf from '@tensorflow/tfjs';
import * as blazeface from '@tensorflow-models/blazeface';

export class VideoManager {
    static faceModel = null;
    static bodyModel = null;
    static loadingPromise = null;
    static instanceCount = 0;

    constructor() {
        VideoManager.instanceCount++;
        
        // Unique ID for routing visuals
        this.id = `vid-${Date.now()}-${Math.floor(Math.random()*1000)}`;

        // Create dedicated container for this instance
        this.container = document.createElement('div');
        this.container.className = 'video-overlay-window hidden';
        
        // Offset position to cascade windows
        const offset = (VideoManager.instanceCount * 30) % 300;
        this.container.style.top = `${60 + offset}px`;
        this.container.style.left = `${20 + offset}px`;
        
        document.body.appendChild(this.container);

        this.video = document.createElement('video');
        this.video.id = this.id;
        this.video.playsInline = true;
        this.video.muted = true;
        
        // Window UI Structure
        this.header = document.createElement('div');
        this.header.className = 'video-window-header';
        
        const title = document.createElement('span');
        title.innerText = 'VIDEO INPUT / MONITOR';
        this.header.appendChild(title);

        this.header.style.color = '#ccc';
        this.header.style.fontSize = '12px';
        this.header.style.justifyContent = 'space-between'; // Use flex spacing

        // Controls Container
        const controls = document.createElement('div');
        controls.style.display = 'flex';
        controls.style.alignItems = 'center';
        controls.style.gap = '10px';

        // Volume Control
        const volContainer = document.createElement('div');
        volContainer.style.display = 'flex';
        volContainer.style.alignItems = 'center';
        volContainer.style.gap = '5px';

        const volLabel = document.createElement('span');
        volLabel.innerText = 'VOL';
        volLabel.style.fontSize = '10px';
        volLabel.style.color = '#888';

        this.volSlider = document.createElement('input');
        this.volSlider.type = 'range';
        this.volSlider.min = 0;
        this.volSlider.max = 1;
        this.volSlider.step = 0.01;
        this.volSlider.value = 0; // Default muted
        this.volSlider.style.width = '60px';
        this.volSlider.style.height = '10px';
        this.volSlider.style.cursor = 'pointer';
        
        this.volSlider.addEventListener('mousedown', (e) => e.stopPropagation());
        this.volSlider.addEventListener('click', (e) => e.stopPropagation());
        this.volSlider.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value);
            this.video.volume = v;
            this.video.muted = (v <= 0.01);
        });

        volContainer.appendChild(volLabel);
        volContainer.appendChild(this.volSlider);

        // Close Button
        const closeBtn = document.createElement('div');
        closeBtn.innerText = 'X';
        closeBtn.style.color = '#fff';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontWeight = 'bold';
        closeBtn.style.fontSize = '16px';
        closeBtn.style.padding = '4px 10px';
        closeBtn.style.background = '#444';
        closeBtn.style.borderRadius = '3px';
        closeBtn.onclick = (e) => {
            e.stopPropagation(); // Prevent drag start
            this.close();
        };

        controls.appendChild(volContainer);
        controls.appendChild(closeBtn);
        this.header.appendChild(controls);
        
        this.content = document.createElement('div');
        this.content.style.position = 'relative';
        this.content.style.flex = '1';
        this.content.style.width = '100%';
        this.content.style.overflow = 'hidden';
        this.content.style.background = '#000';

        this.video.style.position = 'absolute';
        this.video.style.width = '100%';
        this.video.style.height = '100%';
        this.video.style.top = '0';
        this.video.style.left = '0';
        this.video.style.objectFit = 'contain';
        
        // Canvas for granular snapshots
        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.objectFit = 'contain';
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.zIndex = '2'; 
        this.canvas.style.opacity = '0';
        
        this.content.appendChild(this.video);
        this.content.appendChild(this.canvas);
        
        this.container.appendChild(this.header);
        this.container.appendChild(this.content);
        
        this.ctx = this.canvas.getContext('2d', { alpha: false });

        this.isActive = false;
        this.isOpen = false; // User controlled visibility
        this.videoUrl = null;
        this.stopTimer = null;
        this.pauseTimer = null;
        
        // Callbacks
        this.onClose = null; 

        this.faceModel = null;
        this.bodyModel = null;
        this.detectionMode = 'body'; // 'face', 'body', or 'both'
        if (VideoManager.faceModel) {
            this.faceModel = VideoManager.faceModel;
        }
        if (VideoManager.bodyModel) {
            this.bodyModel = VideoManager.bodyModel;
        }
        if (!VideoManager.faceModel || !VideoManager.bodyModel) {
            this.loadModels();
        }

        this.setupDrag();
    }

    async loadModels() {
        if (VideoManager.faceModel && VideoManager.bodyModel) {
             this.faceModel = VideoManager.faceModel;
             this.bodyModel = VideoManager.bodyModel;
             return;
        }

        if (VideoManager.loadingPromise) {
            await VideoManager.loadingPromise;
            this.faceModel = VideoManager.faceModel;
            this.bodyModel = VideoManager.bodyModel;
            return;
        }

        VideoManager.loadingPromise = (async () => {
            try {
                console.log("Loading detection models...");
                
                // Load BlazeFace
                if (!VideoManager.faceModel) {
                    console.log("Loading BlazeFace...");
                    VideoManager.faceModel = await blazeface.load();
                    console.log("BlazeFace loaded");
                }
                
                // Load RT-DETR for body detection
                if (!VideoManager.bodyModel) {
                    console.log("Loading RT-DETR body detector...");
                    // Using COCO-SSD as a lightweight alternative to RT-DETR (which requires custom implementation)
                    // RT-DETR is not directly available in TensorFlow.js yet, so using a person detection model
                    const cocoSsd = await import('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/+esm');
                    VideoManager.bodyModel = await cocoSsd.load({
                        base: 'mobilenet_v2' // Faster than lite_mobilenet_v2
                    });
                    console.log("Body detector loaded");
                }
            } catch(e) {
                console.error("Failed to load detection models", e);
            } finally {
                VideoManager.loadingPromise = null;
            }
        })();

        await VideoManager.loadingPromise;
        this.faceModel = VideoManager.faceModel;
        this.bodyModel = VideoManager.bodyModel;
    }

    setOpen(isOpen) {
        this.isOpen = isOpen;
        if (isOpen) {
            this.container.classList.remove('hidden');
            this.container.style.opacity = '1';
        } else {
            this.container.classList.add('hidden');
            this.container.style.opacity = '0';
        }
    }

    close() {
        this.setOpen(false);
        this.container.remove(); // Remove from DOM
        
        // Cleanup listeners to prevent leaks
        if (this._dragHandlers) {
            window.removeEventListener('mousemove', this._dragHandlers.move);
            window.removeEventListener('mouseup', this._dragHandlers.up);
        }

        if (this.onClose) this.onClose(this);
    }

    setupDrag() {
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        const onMouseDown = (e) => {
            e.preventDefault();
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            
            const style = window.getComputedStyle(this.container);
            initialLeft = parseInt(style.left, 10) || 0;
            initialTop = parseInt(style.top, 10) || 0;
            
            this.header.style.cursor = 'grabbing';
        };

        const onMouseMove = (e) => {
            if (!isDragging) return;
            e.preventDefault();
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            
            this.container.style.left = `${initialLeft + dx}px`;
            this.container.style.top = `${initialTop + dy}px`;
            this.container.style.right = 'auto'; 
        };

        const onMouseUp = () => {
            if (isDragging) {
                isDragging = false;
                this.header.style.cursor = 'grab';
            }
        };

        this.header.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

        // Store references for cleanup
        this._dragHandlers = { move: onMouseMove, up: onMouseUp };
    }

    initStream(stream) {
        this.video.srcObject = stream;
        this.video.muted = true;
        if (this.volSlider) this.volSlider.value = 0;
        this.video.play().catch(e => console.log("Stream play error", e));
        this.isActive = true;
        
        // Auto-open on record start
        this.setOpen(true);
        this.video.style.opacity = '1';
        this.canvas.style.opacity = '0';
    }

    setOpen(isOpen) {
        this.isOpen = isOpen;
        if (isOpen) {
            this.container.classList.remove('hidden');
            this.container.style.opacity = '1';
            // Ensure z-index is high
            this.container.style.zIndex = '210';
        } else {
            this.container.classList.add('hidden');
            this.container.style.opacity = '0';
        }
    }

    async captureFrame() {
        if (!this.isActive || !this.video || this.video.readyState < 2) return null;
        try {
            // High Performance Optimization: Downscale aggressively (128px)
            return await createImageBitmap(this.video, { resizeWidth: 128 }); 
        } catch(e) {
            return null;
        }
    }

    async detectFaces(bitmap) {
        if (!this.faceModel || !bitmap) return [];
        try {
            const predictions = await this.faceModel.estimateFaces(bitmap, false);
            return predictions.map(pred => ({
                type: 'face',
                boundingBox: {
                    x: pred.topLeft[0],
                    y: pred.topLeft[1],
                    width: pred.bottomRight[0] - pred.topLeft[0],
                    height: pred.bottomRight[1] - pred.topLeft[1]
                }
            }));
        } catch (e) {
            console.warn("Face detection failed", e);
            return [];
        }
    }

    async detectBodies(bitmap) {
        if (!this.bodyModel || !bitmap) return [];
        try {
            const predictions = await this.bodyModel.detect(bitmap);
            // Filter for person class only
            const persons = predictions.filter(pred => pred.class === 'person');
            return persons.map(pred => ({
                type: 'body',
                confidence: pred.score,
                boundingBox: {
                    x: pred.bbox[0],
                    y: pred.bbox[1],
                    width: pred.bbox[2],
                    height: pred.bbox[3]
                }
            }));
        } catch (e) {
            console.warn("Body detection failed", e);
            return [];
        }
    }

    async detectAll(bitmap) {
        const results = [];
        
        if (this.detectionMode === 'face' || this.detectionMode === 'both') {
            const faces = await this.detectFaces(bitmap);
            results.push(...faces);
        }
        
        if (this.detectionMode === 'body' || this.detectionMode === 'both') {
            const bodies = await this.detectBodies(bitmap);
            results.push(...bodies);
        }
        
        return results;
    }

    showFrame(bitmap, duration = 0.2) {
        if (!bitmap || !this.isOpen) return;

        // Reset timers
        if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }

        // Switch to Canvas View
        this.video.style.opacity = '0';
        this.canvas.style.opacity = '1';

        try {
            // Update Canvas
            if (this.canvas.width !== bitmap.width) this.canvas.width = bitmap.width;
            if (this.canvas.height !== bitmap.height) this.canvas.height = bitmap.height;
            this.ctx.drawImage(bitmap, 0, 0);
        } catch(e) {
            // Safely ignore closed bitmaps to prevent crash
        }

        // No fade out in manual mode - user decides when to close
    }

    setSource(blob) {
        if (this.videoUrl) {
            URL.revokeObjectURL(this.videoUrl);
        }
        this.video.srcObject = null; // Clear stream if any
        this.videoUrl = URL.createObjectURL(blob);
        this.video.src = this.videoUrl;
        this.video.load();
        this.isActive = true;
        
        // Auto-open on file load
        this.setOpen(true);
        this.video.style.opacity = '1';
        this.canvas.style.opacity = '0';
    }

    play() {
        if (this.isActive) {
            if (this.isOpen) {
                this.video.style.opacity = '1';
                this.canvas.style.opacity = '0';
            }
            this.video.playbackRate = 1.0;
            this.video.play().catch(e => {});
        }
    }

    pause() {
        if (this.isActive) {
            this.video.pause();
        }
    }

    stop() {
        if (this.isActive) {
            this.pause();
            this.video.currentTime = 0;
            // Don't hide if manually open? No, stop usually means reset.
            // But user said "I decide". So we leave it open if it's open, just black/paused.
        }
    }

    sync(time) {
        if (!this.isActive) return;
        // Smooth sync during continuous playback
        if (!this.video.paused) {
            const diff = Math.abs(this.video.currentTime - time);
            if (diff > 0.3) {
                this.video.currentTime = time;
            }
        }
    }

    // Legacy jumpTo for non-bitmap grains (fallback)
    jumpTo(time, duration = 0, volume = 1.0) {
        if (!this.isActive || !this.isOpen) return;
        
        // Ensure video mode
        this.video.style.opacity = '1';
        this.canvas.style.opacity = '0';

        // Force mute during granular playback to prevent double audio (WebAudio + Video Element)
        this.video.muted = true;

        try {
            if (Math.abs(this.video.currentTime - time) > 0.05) {
                this.video.currentTime = time;
            }
            
            if (this.video.paused) {
                const p = this.video.play();
                if (p !== undefined) p.catch(() => {});
            }

            // No auto-hide timers here either
        } catch (e) { }
    }

    hide() {
        // Only internal hide logic uses this, but now we use setOpen
        this.setOpen(false);
    }

    show() {
        if (this.isActive) this.setOpen(true);
    }
}