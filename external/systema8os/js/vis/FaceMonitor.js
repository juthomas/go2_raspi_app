export class FaceMonitor {
    constructor() {
        this.container = document.createElement('div');
        this.container.id = 'face-monitor';
        this.container.className = 'hidden';
        document.body.appendChild(this.container);

        this.buildUI();
        this.setupDrag();
    }

    buildUI() {
        this.container.style.position = 'absolute';
        this.container.style.top = '100px';
        // Anchor to left to allow standard resizing behavior immediately
        const startX = Math.max(20, window.innerWidth - 300);
        this.container.style.left = `${startX}px`;
        
        this.container.style.width = '265px';
        this.container.style.height = '350px';
        this.container.style.minWidth = '160px';
        this.container.style.minHeight = '160px';
        this.container.style.resize = 'both';
        this.container.style.overflow = 'hidden';

        this.container.style.background = 'rgba(0,0,0,0.9)';
        this.container.style.border = '1px solid #444';
        this.container.style.zIndex = '205';
        this.container.style.display = 'flex';
        this.container.style.pointerEvents = 'auto';
        this.container.style.flexDirection = 'column';
        this.container.style.boxShadow = '0 0 10px rgba(0,0,0,0.5)';

        // Header
        this.header = document.createElement('div');
        this.header.className = 'video-window-header';
        
        const title = document.createElement('span');
        title.innerText = 'DETECTED OBJECTS (BODY/FACE)';
        this.header.appendChild(title);

        this.header.style.color = '#aaa';
        this.header.style.fontSize = '12px';
        // Flex handled by CSS, just add spacing
        this.header.style.justifyContent = 'space-between';
        
        const closeBtn = document.createElement('div');
        closeBtn.innerText = 'X';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontWeight = 'bold';
        closeBtn.style.fontSize = '16px';
        closeBtn.style.padding = '4px 10px';
        closeBtn.style.background = '#444';
        closeBtn.style.borderRadius = '3px';
        closeBtn.onclick = () => this.toggle(false);
        this.header.appendChild(closeBtn);

        this.content = document.createElement('div');
        this.content.style.flex = '1';
        this.content.style.overflowY = 'auto';
        this.content.style.display = 'flex';
        this.content.style.flexWrap = 'wrap';
        this.content.style.alignContent = 'flex-start';
        this.content.style.gap = '4px';
        this.content.style.padding = '4px';

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
            
            const rect = this.container.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            
            this.header.style.cursor = 'grabbing';
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            
            this.container.style.left = `${initialLeft + dx}px`;
            this.container.style.top = `${initialTop + dy}px`;
            this.container.style.right = 'auto'; 
        });

        window.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                this.header.style.cursor = 'grab';
            }
        });
    }

    toggle(active) {
        if (active) this.container.classList.remove('hidden');
        else this.container.classList.add('hidden');
    }

    addFace(bitmap) {
        if (!bitmap) return;

        // Clone bitmap to canvas
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        // Visual style: roughly 3 columns
        canvas.style.width = '80px'; 
        canvas.style.height = 'auto'; 
        canvas.style.border = '1px solid #444';
        canvas.style.borderRadius = '2px';
        canvas.style.backgroundColor = '#111';
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);

        // Prepend
        if (this.content.firstChild) {
            this.content.insertBefore(canvas, this.content.firstChild);
        } else {
            this.content.appendChild(canvas);
        }

        // Cleanup old faces (limit reduced to 50 to prevent memory exhaustion/crashes)
        while (this.content.children.length > 50) { 
            const el = this.content.lastChild;
            // Explicitly clear canvas context if possible to help GC
            if (el instanceof HTMLCanvasElement) {
                el.width = 1; 
                el.height = 1;
            }
            this.content.removeChild(el);
        }
    }

    reset() {
        this.content.innerHTML = '';
    }
}