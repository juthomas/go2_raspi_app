export class Store {
    constructor() {
        this.frames = []; // Array of { time, pitch, volume, centroid, note }
        this.segments = []; // Array of { startTime, endTime, avgPitch, note, id }
        this.families = {}; // Map noteName -> array of segment IDs
        this.duration = 0;
    }

    reset() {
        // Close old bitmaps to free memory
        this.frames.forEach(f => {
            if(f.bitmap && f.bitmap.close) f.bitmap.close();
        });
        
        this.frames = [];
        this.segments = [];
        this.families = {};
        this.duration = 0;
    }

    addFrame(frameData) {
        this.frames.push(frameData);
        // Extend duration if live
        if (frameData.time > this.duration) this.duration = frameData.time;
    }

    addSegment(segment) {
        this.segments.push(segment);
        
        // Add to family
        if (!this.families[segment.note]) {
            this.families[segment.note] = [];
        }
        this.families[segment.note].push(segment);
    }

    removeLastFrame() {
        if (this.frames.length > 0) {
            const removed = this.frames.pop();
            // Update duration to new last frame time or 0
            if (this.frames.length > 0) {
                this.duration = this.frames[this.frames.length - 1].time;
            } else {
                this.duration = 0;
            }
            return removed;
        }
        return null;
    }

    removeFramesInTimeRange(start, end) {
        const kept = [];
        const removed = [];
        let maxTime = 0;
        
        for (const f of this.frames) {
            // Check overlap with tolerance
            if (f.time >= start - 0.1 && f.time <= end + 0.1) {
                removed.push(f);
            } else {
                kept.push(f);
                if (f.time > maxTime) maxTime = f.time;
            }
        }
        this.frames = kept;
        this.duration = maxTime;
        
        // Cleanup segments
        this.segments = this.segments.filter(s => s.startTime < start - 0.1 || s.startTime > end + 0.1);
        this.rebuildFamilies();
        
        return removed;
    }

    rebuildFamilies() {
        this.families = {};
        this.segments.forEach(s => {
            if (!this.families[s.note]) this.families[s.note] = [];
            this.families[s.note].push(s);
        });
    }

    getSegmentsByFamily(note) {
        return this.families[note] || [];
    }

    findNearestFrames(pitch, centroid, count = 1) {
        if (this.frames.length === 0) return [];

        const candidates = [];
        const targetLogPitch = pitch > 0 ? Math.log2(pitch) : 0;
        const stride = this.frames.length > 5000 ? 5 : 1;

        for(let i=0; i<this.frames.length; i+=stride) {
            const f = this.frames[i];
            // Skip silent/unpitched frames
            if(f.pitch <= 0 || f.volume < 0.01) continue;

            const fLogPitch = Math.log2(f.pitch);
            
            // Euclidean distance in feature space
            const pitchDist = Math.abs(fLogPitch - targetLogPitch);
            const timbreDist = Math.abs(f.centroid - centroid);
            
            const score = (pitchDist * 2.0) + (timbreDist * 1.0);
            
            candidates.push({ frame: f, score: score, index: i });
        }
        
        // Sort by score (ascending, lower is better)
        candidates.sort((a, b) => a.score - b.score);
        
        // Return top count
        return candidates.slice(0, count).map(c => {
            // Attach index for visualizer reference
            c.frame.index = c.index;
            return c.frame;
        });
    }

    findClosestFrame(pitch, centroid) {
        if (this.frames.length === 0) return null;

        let closest = null;
        let minScore = Infinity;
        
        // Log scale for pitch (musical distance)
        const targetLogPitch = pitch > 0 ? Math.log2(pitch) : 0;
        
        // Optimization: Stride
        const stride = this.frames.length > 5000 ? 5 : 1;

        for(let i=0; i<this.frames.length; i+=stride) {
            const f = this.frames[i];
            // Skip silent/unpitched frames in store
            if(f.pitch <= 0 || f.volume < 0.01) continue;

            const fLogPitch = Math.log2(f.pitch);
            
            // Euclidean distance in feature space
            // Weight Pitch more heavily than Timbre (Centroid)
            const pitchDist = Math.abs(fLogPitch - targetLogPitch);
            const timbreDist = Math.abs(f.centroid - centroid);
            
            // Heuristic weights: 1 octave (1.0 log) ~= 0.5 centroid difference
            const score = (pitchDist * 2.0) + (timbreDist * 1.0);
            
            if(score < minScore) {
                minScore = score;
                closest = f;
                closest.index = i;
            }
        }
        
        return closest;
    }
}

