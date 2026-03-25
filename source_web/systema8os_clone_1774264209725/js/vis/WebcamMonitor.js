import { VideoManager } from './VideoManager.js'; // Just for reference logic if needed, but we'll build standalone

export class WebcamMonitor {
    constructor() {
        this.container = document.getElementById('webcam-overlay');
        this.stream = null;
        this.isActive = false;

        this.buildUI();
        this.setupDrag();
    }

    buildUI() {
        // Reuse similar structure to VideoManager for consistency
        this.header = document.createElement('div');
        this.header.className = 'video-window-header';
        
        // Use span to allow flexbox to work cleanly with text + button
        const title = document.createElement('span');
        title.innerText = 'WEBCAM RETURN';
        this.header.appendChild(title);

        this.header.style.color = '#aaa';
        this.header.style.fontSize = '12px';
        // Flex layout is now handled by CSS .video-window-header

        const closeBtn = document.createElement('div');
        closeBtn.innerText = 'X';
        closeBtn.style.marginLeft = 'auto';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontSize = '16px';
        closeBtn.style.fontWeight = 'bold';
        closeBtn.style.padding = '4px 10px';
        closeBtn.style.background = '#444';
        closeBtn.style.borderRadius = '3px';
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            this.toggle(false);
        };
        this.header.appendChild(closeBtn);

        this.content = document.createElement('div');
        this.content.style.flex = '1';
        this.content.style.position = 'relative';
        this.content.style.overflow = 'hidden';
        this.content.style.background = '#000';

        this.video = document.createElement('video');
        this.video.style.width = '100%';
        this.video.style.height = '100%';
        this.video.style.objectFit = 'cover';
        this.video.autoplay = true;
        this.video.muted = true;
        this.video.playsInline = true;

        this.content.appendChild(this.video);
        this.container.appendChild(this.header);
        this.container.appendChild(this.content);
    }

    setupDrag() {
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        this.header.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            
            const style = window.getComputedStyle(this.container);
            initialLeft = parseInt(style.left, 10) || 0;
            initialTop = parseInt(style.top, 10) || 0;
            
            this.header.style.cursor = 'grabbing';
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            
            this.container.style.left = `${initialLeft + dx}px`;
            this.container.style.top = `${initialTop + dy}px`;
        });

        window.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                this.header.style.cursor = 'grab';
            }
        });
    }

    async toggle(forceState = null) {
        const shouldOpen = forceState !== null ? forceState : !this.isActive;

        if (shouldOpen) {
            try {
                this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                this.video.srcObject = this.stream;
                this.container.classList.remove('hidden');
                this.isActive = true;
            } catch (err) {
                console.error("Webcam access denied", err);
                this.isActive = false;
            }
        } else {
            if (this.stream) {
                this.stream.getTracks().forEach(track => track.stop());
                this.stream = null;
            }
            this.video.srcObject = null;
            this.container.classList.add('hidden');
            this.isActive = false;
        }
        
        return this.isActive;
    }
}