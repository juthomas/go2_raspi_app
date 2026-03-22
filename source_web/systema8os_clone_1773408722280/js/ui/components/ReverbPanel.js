export class ReverbPanel {
    constructor(callbacks) {
        this.callbacks = callbacks;
        this.container = document.createElement('div');
        this.container.id = 'reverb-panel';
        this.container.className = 'hidden';
        document.body.appendChild(this.container);

        this.buildUI();
        this.setupDrag();
    }

    buildUI() {
        this.container.style.position = 'absolute';
        this.container.style.top = '150px';
        this.container.style.left = '300px';
        this.container.style.width = '200px';
        this.container.style.height = '200px';
        this.container.style.background = 'rgba(0, 0, 0, 0.9)';
        this.container.style.border = '1px solid #444';
        this.container.style.zIndex = '210';
        this.container.style.display = 'flex';
        this.container.style.flexDirection = 'column';
        this.container.style.boxShadow = '0 0 15px rgba(0,0,0,0.5)';
        this.container.style.resize = 'both';
        this.container.style.overflow = 'hidden';
        this.container.style.minWidth = '150px';
        this.container.style.minHeight = '100px';

        // Header
        this.header = document.createElement('div');
        this.header.className = 'video-window-header'; // Reuse existing class for style
        this.header.style.justifyContent = 'space-between';
        
        const title = document.createElement('span');
        title.innerText = 'REVERB (FX)';
        this.header.appendChild(title);

        const closeBtn = document.createElement('div');
        closeBtn.innerText = 'X';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.background = '#444';
        closeBtn.style.padding = '2px 8px';
        closeBtn.style.borderRadius = '3px';
        closeBtn.onclick = () => this.toggle(false);
        this.header.appendChild(closeBtn);

        this.container.appendChild(this.header);

        // Content
        const content = document.createElement('div');
        content.style.flex = '1';
        content.style.padding = '15px';
        content.style.display = 'flex';
        content.style.flexDirection = 'column';
        content.style.justifyContent = 'center';
        content.style.alignItems = 'center';
        content.style.gap = '10px';

        // Fader
        const label = document.createElement('label');
        label.innerText = 'WET LEVEL';
        label.style.fontSize = '12px';
        label.style.color = '#ccc';
        label.style.fontFamily = 'monospace';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '100';
        slider.value = '0';
        slider.style.width = '100%';
        slider.style.cursor = 'pointer';

        slider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value) / 100;
            if (this.callbacks.onReverbChange) this.callbacks.onReverbChange(val);
        });

        content.appendChild(label);
        content.appendChild(slider);

        // Input Send Fader
        const labelIn = document.createElement('label');
        labelIn.innerText = 'INPUT SEND';
        labelIn.style.fontSize = '12px';
        labelIn.style.color = '#ccc';
        labelIn.style.fontFamily = 'monospace';
        labelIn.style.marginTop = '10px';

        const sliderIn = document.createElement('input');
        sliderIn.type = 'range';
        sliderIn.min = '0';
        sliderIn.max = '100';
        sliderIn.value = '0';
        sliderIn.style.width = '100%';
        sliderIn.style.cursor = 'pointer';

        sliderIn.addEventListener('input', (e) => {
            const val = parseInt(e.target.value) / 100;
            if (this.callbacks.onInputReverbChange) this.callbacks.onInputReverbChange(val);
        });

        content.appendChild(labelIn);
        content.appendChild(sliderIn);

        // Input Dry Fader
        const labelDry = document.createElement('label');
        labelDry.innerText = 'INPUT DRY';
        labelDry.style.fontSize = '12px';
        labelDry.style.color = '#ccc';
        labelDry.style.fontFamily = 'monospace';
        labelDry.style.marginTop = '10px';

        const sliderDry = document.createElement('input');
        sliderDry.type = 'range';
        sliderDry.min = '0';
        sliderDry.max = '100';
        sliderDry.value = '0';
        sliderDry.style.width = '100%';
        sliderDry.style.cursor = 'pointer';

        sliderDry.addEventListener('input', (e) => {
            const val = parseInt(e.target.value) / 100;
            if (this.callbacks.onInputDryVol) this.callbacks.onInputDryVol(val);
        });

        content.appendChild(labelDry);
        content.appendChild(sliderDry);

        this.container.appendChild(content);
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
        
        if (this.callbacks.onVisibilityChange) {
            this.callbacks.onVisibilityChange(active);
        }
    }
}