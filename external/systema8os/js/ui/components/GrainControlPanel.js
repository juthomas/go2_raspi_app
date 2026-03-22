export class GrainControlPanel {
    constructor(callbacks) {
        this.callbacks = callbacks;
        this.elements = this.getElements();
        this.init();
    }

    getElements() {
        return {
            grainVol: document.getElementById('grain-vol'),
            grainDur: document.getElementById('grain-dur'),
            grainRadius: document.getElementById('grain-radius'),
            grainRandom: document.getElementById('grain-random'),
            lfoOffset: document.getElementById('lfo-offset'),
            grainVol2D: document.getElementById('grain-vol-2d'),
            grainDur2D: document.getElementById('grain-dur-2d'),
            grainRadius2D: document.getElementById('grain-radius-2d'),
            grainRandom2D: document.getElementById('grain-random-2d'),
            lfoOffset2D: document.getElementById('lfo-offset-2d'),
            grainAdsr: {
                a: document.getElementById('g-adsr-a'),
                d: document.getElementById('g-adsr-d'),
                s: document.getElementById('g-adsr-s'),
                r: document.getElementById('g-adsr-r')
            },
            adsr: {
                a: document.getElementById('adsr-a'),
                d: document.getElementById('adsr-d'),
                s: document.getElementById('adsr-s'),
                r: document.getElementById('adsr-r')
            },
            faderMaster: document.getElementById('master-fader'),
            faderTrans: document.getElementById('trans-fader'),
            faderReaders: document.getElementById('readers-fader'),
            faderReaderSmooth: document.getElementById('r-smooth-fader'),
            faderReaderDist: document.getElementById('r-dist-fader'),
            faderSmooth: document.getElementById('smooth-fader')
        };
    }

    init() {
        const els = this.elements;

        // Faders
        els.faderMaster.addEventListener('input', (e) => this.callbacks.onMasterVol(parseInt(e.target.value) / 100));
        els.faderTrans.addEventListener('input', (e) => this.callbacks.onTransFader(parseInt(e.target.value) / 100));
        els.faderReaders.addEventListener('input', (e) => this.callbacks.onReadersFader(parseInt(e.target.value)));
        els.faderReaderSmooth.addEventListener('input', (e) => this.callbacks.onReaderSmooth(parseInt(e.target.value)));
        els.faderReaderDist.addEventListener('input', (e) => this.callbacks.onReaderDist(parseInt(e.target.value)));
        els.faderSmooth.addEventListener('input', (e) => this.callbacks.onSmoothFader(parseInt(e.target.value)));

        // Grain Params
        const bind = (main, aux, type, transform = v => v) => {
            const handler = (e) => {
                const val = parseInt(e.target.value);
                if (aux) aux.value = val; 
                this.updateGrainParam(type, transform(val));
            };
            main.addEventListener('input', handler);
            if(aux) aux.addEventListener('input', (e) => {
                 const val = parseInt(e.target.value);
                 main.value = val;
                 this.updateGrainParam(type, transform(val));
            });
        };

        bind(els.grainVol, els.grainVol2D, 'vol', v => v / 100);
        bind(els.grainDur, els.grainDur2D, 'dur', v => 0.05 + (v/100) * 1.95);
        bind(els.grainRadius, els.grainRadius2D, 'rad', v => 0.01 + (v/100) * 0.5);
        bind(els.grainRandom, els.grainRandom2D, 'rand', v => v / 100);
        bind(els.lfoOffset, els.lfoOffset2D, 'lfoOffset', v => (v / 100) - 0.5);

        // ADSR
        const handleGrainAdsr = () => {
            const vals = {
                a: parseInt(els.grainAdsr.a.value) / 100,
                d: parseInt(els.grainAdsr.d.value) / 100,
                s: parseInt(els.grainAdsr.s.value) / 100,
                r: parseInt(els.grainAdsr.r.value) / 100
            };
            if (this.callbacks.onGrainAdsr) this.callbacks.onGrainAdsr(vals);
        };
        Object.values(els.grainAdsr).forEach(el => el.addEventListener('input', handleGrainAdsr));

        const handleAdsr = () => {
             const vals = {
                a: parseInt(els.adsr.a.value) / 100,
                d: parseInt(els.adsr.d.value) / 100,
                s: parseInt(els.adsr.s.value) / 100,
                r: parseInt(els.adsr.r.value) / 100 * 2
            };
            if (this.callbacks.onAdsrChange) this.callbacks.onAdsrChange(vals);
        };
        Object.values(els.adsr).forEach(el => el.addEventListener('input', handleAdsr));

        // Force sync params
        this.updateGrainParam('vol', parseInt(els.grainVol.value) / 100);
        this.updateGrainParam('dur', 0.05 + (parseInt(els.grainDur.value)/100) * 1.95);
        this.updateGrainParam('rad', 0.01 + (parseInt(els.grainRadius.value)/100) * 0.5);
        this.updateGrainParam('rand', parseInt(els.grainRandom.value) / 100);
        this.updateGrainParam('lfoOffset', (parseInt(els.lfoOffset.value) / 100) - 0.5);
    }

    updateGrainParam(type, val) {
        if (!this.callbacks.onGrainParams) return;
        const p = {};
        if (type === 'vol') p.volume = val;
        if (type === 'dur') p.duration = val;
        if (type === 'rad') p.radius = val;
        if (type === 'rand') p.random = val;
        if (type === 'lfoOffset') p.lfoOffset = val;
        this.callbacks.onGrainParams(p);
    }
}