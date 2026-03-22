export class StatsPanel {
    constructor(store, onFamilySelect) {
        this.store = store;
        this.onFamilySelect = onFamilySelect;
        
        this.status = document.getElementById('status');
        this.valPitch = document.getElementById('val-pitch');
        this.valNote = document.getElementById('val-note');
        this.valTime = document.getElementById('val-time');
        this.familyContainer = document.getElementById('family-container');
        this.vuLevel = document.getElementById('vu-level');
        this.vuClip = document.getElementById('vu-clip');
        this.midiLog = document.getElementById('midi-log');
        this.midiTerminal = document.getElementById('midi-terminal');
    }

    setStatus(text) {
        if(this.status) this.status.innerText = text;
    }

    updateStats(pitch, note, time) {
        if(pitch && this.valPitch) this.valPitch.innerText = Math.round(pitch) + ' Hz';
        if(note && this.valNote) this.valNote.innerText = note;
        if(this.valTime) this.valTime.innerText = (time % 60).toFixed(2) + 's';
    }

    updateVu(vol) {
        if(this.vuLevel) {
            const pct = Math.min(100, vol * 200); 
            this.vuLevel.style.width = pct + '%';
            
            if (this.vuClip) {
                if (vol > 0.45) this.vuClip.classList.add('active');
                else this.vuClip.classList.remove('active');
            }
        }
    }

    updateFamilies() {
        if (!this.familyContainer) return;
        this.familyContainer.innerHTML = '';
        const families = Object.keys(this.store.families).sort();
        
        families.forEach(note => {
            const tag = document.createElement('div');
            tag.className = 'family-tag';
            tag.innerText = `${note} (${this.store.families[note].length})`;
            tag.onclick = () => this.onFamilySelect(note);
            this.familyContainer.appendChild(tag);
        });
    }

    logMidi(msg) {
        if (!this.midiTerminal || this.midiTerminal.classList.contains('hidden')) return;
        if (!this.midiLog) return;
        
        const line = document.createElement('div');
        line.className = 'log-line';
        const time = new Date().toLocaleTimeString().split(' ')[0];
        line.innerText = `[${time}] ${msg}`;
        
        this.midiLog.insertBefore(line, this.midiLog.firstChild);
        
        if (this.midiLog.children.length > 50) {
            this.midiLog.removeChild(this.midiLog.lastChild);
        }
    }
}