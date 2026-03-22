export class Analyzer {
    constructor(audioContext) {
        this.ctx = audioContext;
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.bufferLength = this.analyser.frequencyBinCount;
        this.dataArray = new Float32Array(this.bufferLength);
        
        // Config
        this.minVolume = 0.005; // Lower Noise gate
        this.noteStrings = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    }

    connectSource(sourceNode) {
        sourceNode.connect(this.analyser);
        // Don't connect analyser to destination here if we want mute control elsewhere
    }

    getFrameData(currentTime) {
        this.analyser.getFloatTimeDomainData(this.dataArray);
        
        // 1. RMS (Volume)
        let sum = 0;
        for (let i = 0; i < this.bufferLength; i++) {
            sum += this.dataArray[i] * this.dataArray[i];
        }
        const rms = Math.sqrt(sum / this.bufferLength);

        // If below noise floor, return null or empty frame
        if (rms < this.minVolume) {
            return {
                time: currentTime,
                volume: 0,
                pitch: 0,
                note: null,
                centroid: 0
            };
        }

        // 2. Autocorrelation Pitch Detection
        const pitch = this.autoCorrelate(this.dataArray, this.ctx.sampleRate);

        // 3. Spectral Centroid (Brightness)
        // Need frequency data for this
        const freqArray = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(freqArray);
        let numerator = 0;
        let denominator = 0;
        for(let i=0; i<this.bufferLength; i++) {
            numerator += i * freqArray[i];
            denominator += freqArray[i];
        }
        const centroid = denominator === 0 ? 0 : (numerator / denominator) / (this.bufferLength / 2); // Normalized 0-1

        // 4. Chroma Features
        const chroma = this.calculateChroma(freqArray, this.ctx.sampleRate, this.analyser.fftSize);

        // 5. Note Name
        const note = (pitch > 0) ? this.noteFromPitch(pitch) : null;

        return {
            time: currentTime,
            volume: rms,
            pitch: pitch,
            note: note,
            centroid: centroid,
            chroma: chroma
        };
    }

    calculateChroma(freqArray, sampleRate, fftSize) {
        const chroma = new Float32Array(12).fill(0);
        const binSize = sampleRate / fftSize;
        const len = freqArray.length;
        
        // Start from ~50Hz
        const startIndex = Math.floor(50 / binSize);

        for (let i = startIndex; i < len; i++) {
            const mag = freqArray[i];
            if (mag < 10) continue; // Noise gate

            const freq = i * binSize;
            if (freq <= 0) continue;

            // MIDI Note
            const midi = 12 * Math.log2(freq / 440) + 69;
            const noteIndex = Math.round(midi);
            
            // Map to 0-11 (C..B)
            const chromaIndex = (noteIndex % 12 + 12) % 12;
            
            chroma[chromaIndex] += mag;
        }

        // Normalize
        let maxVal = 0;
        for(let i=0; i<12; i++) {
            if (chroma[i] > maxVal) maxVal = chroma[i];
        }
        
        if (maxVal > 0) {
            for(let i=0; i<12; i++) chroma[i] /= maxVal;
        }

        return chroma;
    }

    // Simplified Autocorrelation
    autoCorrelate(buf, sampleRate) {
        let SIZE = buf.length;
        let rms = 0;
        for (let i = 0; i < SIZE; i++) {
            const val = buf[i];
            rms += val * val;
        }
        rms = Math.sqrt(rms / SIZE);
        
        if (rms < 0.01) return -1;

        let r1 = 0, r2 = SIZE - 1;
        const thres = 0.2;
        for (let i = 0; i < SIZE / 2; i++) {
            if (Math.abs(buf[i]) < thres) { r1 = i; break; }
        }
        for (let i = 1; i < SIZE / 2; i++) {
            if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
        }

        buf = buf.slice(r1, r2);
        SIZE = buf.length;

        const c = new Array(SIZE).fill(0);
        for (let i = 0; i < SIZE; i++) {
            for (let j = 0; j < SIZE - i; j++) {
                c[i] = c[i] + buf[j] * buf[j + i];
            }
        }

        let d = 0;
        while (c[d] > c[d + 1]) d++;
        let maxval = -1, maxpos = -1;
        for (let i = d; i < SIZE; i++) {
            if (c[i] > maxval) {
                maxval = c[i];
                maxpos = i;
            }
        }
        let T0 = maxpos;

        // Parabolic interpolation
        let x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
        let a = (x1 + x3 - 2 * x2) / 2;
        let b = (x3 - x1) / 2;
        if (a) T0 = T0 - b / (2 * a);

        return sampleRate / T0;
    }

    noteFromPitch(frequency) {
        if (!frequency || frequency === -1) return null;
        const noteNum = 12 * (Math.log(frequency / 440) / Math.log(2));
        const midi = Math.round(noteNum) + 69;
        return this.noteStrings[midi % 12];
    }
}

