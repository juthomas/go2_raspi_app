import JSZip from 'jszip';

export class ExportManager {
    constructor(ui) {
        this.ui = ui;
    }

    async exportSoundPack(store, audio) {
        if (store.frames.length === 0) {
            this.ui.status.innerText = "NO GRAINS TO EXPORT";
            return;
        }

        this.ui.status.innerText = "GENERATING GRAINS...";
        
        try {
            const zip = new JSZip();
            const folder = zip.folder("granular_pack");
            let count = 0;
            const grainDuration = 0.3; 

            for (let i = 0; i < store.frames.length; i++) {
                const frame = store.frames[i];
                if (frame.volume < 0.05) continue;

                const buffer = audio.getSegmentBuffer(frame.time, grainDuration);
                if (buffer) {
                    const blob = audio.encodeToWav(buffer);
                    const safeNote = frame.note ? frame.note.replace('#', 's') : 'NO_NOTE';
                    const pitch = Math.round(frame.pitch);
                    const centroid = frame.centroid || 0.5;
                    
                    let timbreClass = 'NEUTRAL';
                    if (centroid < 0.33) timbreClass = 'DARK';
                    else if (centroid > 0.66) timbreClass = 'BRIGHT';
                    
                    const filename = `${pitch}Hz_${i.toString().padStart(5, '0')}.wav`;
                    const path = `${safeNote}/${timbreClass}/${filename}`;
                    
                    folder.file(path, blob);
                    count++;
                }
                
                if (i % 50 === 0) {
                    this.ui.status.innerText = `PROCESSING ${i}/${store.frames.length}`;
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            if (count > 0) {
                this.ui.status.innerText = `ZIPPING ${count} GRAINS...`;
                const content = await zip.generateAsync({ type: "blob" });
                const url = URL.createObjectURL(content);
                const a = document.createElement('a');
                a.href = url;
                a.download = `granular_pack_${Date.now()}.zip`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                this.ui.status.innerText = `EXPORTED ${count} GRAINS`;
            } else {
                this.ui.status.innerText = "EXPORT FAILED: NO VALID GRAINS";
            }
        } catch(e) {
            console.error(e);
            this.ui.status.innerText = "EXPORT ERROR";
        }
    }

    async exportCodeAsText() {
        this.ui.status.innerText = "GATHERING CODE...";
        const files = [
            'index.html',
            'css/style.css',
            'js/main.js',
            'js/audio/AudioEngine.js',
            'js/audio/Analyzer.js',
            'js/data/Store.js',
            'js/logic/ExportManager.js',
            'js/logic/InputHandler.js',
            'js/logic/TransEngine.js',
            'js/ui/UI.js',
            'js/ui/ScatterPad.js',
            'js/vis/Scene.js',
            'js/vis/Visualizer.js',
            'js/vis/VideoManager.js',
            'js/vis/WebcamMonitor.js',
            'js/vis/FaceMonitor.js',
            'js/vis/components/CursorSystem.js',
            'js/vis/components/GridEnvironment.js',
            'js/vis/components/ImageCloud.js',
            'js/vis/components/Playhead.js',
            'js/vis/components/PointCloud.js',
            'js/ui/components/DevicePanel.js',
            'js/ui/components/GrainControlPanel.js',
            'js/ui/components/ReverbPanel.js',
            'js/ui/components/SpatialPanel.js',
            'js/ui/components/StatsPanel.js',
            'js/ui/components/TransportPanel.js',
            'js/ui/components/LibraryPanel.js',
            'js/ui/components/PeruInstrument.js'
        ];

        let content = "SYSTEMA8OS.XT SOURCE CODE DUMP\nGenerated: " + new Date().toISOString() + "\n\n";

        for (const file of files) {
            try {
                this.ui.status.innerText = `READING ${file}...`;
                const res = await fetch(file);
                if (res.ok) {
                    const text = await res.text();
                    content += "================================================================================\n";
                    content += `FILE: ${file}\n`;
                    content += "================================================================================\n";
                    content += text + "\n\n";
                }
            } catch (e) {
                console.error(e);
            }
        }

        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `systema8os_full_code_${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        this.ui.status.innerText = "CODE DUMP DOWNLOADED";
    }

    async exportApp() {
        this.ui.status.innerText = "GATHERING FILES...";
        const zip = new JSZip();
        
        // List of source files to include
        const files = [
            'index.html',
            'css/style.css',
            'js/main.js',
            'js/audio/AudioEngine.js',
            'js/audio/Analyzer.js',
            'js/data/Store.js',
            'js/logic/ExportManager.js',
            'js/logic/InputHandler.js',
            'js/logic/TransEngine.js',
            'js/ui/UI.js',
            'js/ui/ScatterPad.js',
            'js/vis/Scene.js',
            'js/vis/Visualizer.js',
            'js/vis/VideoManager.js',
            'js/vis/WebcamMonitor.js',
            'js/vis/FaceMonitor.js',
            'js/vis/components/CursorSystem.js',
            'js/vis/components/GridEnvironment.js',
            'js/vis/components/ImageCloud.js',
            'js/vis/components/Playhead.js',
            'js/vis/components/PointCloud.js',
            'js/ui/components/DevicePanel.js',
            'js/ui/components/GrainControlPanel.js',
            'js/ui/components/ReverbPanel.js',
            'js/ui/components/SpatialPanel.js',
            'js/ui/components/StatsPanel.js',
            'js/ui/components/TransportPanel.js',
            'js/ui/components/LibraryPanel.js',
            'js/ui/components/PeruInstrument.js'
        ];

        // Fetch each file
        let loaded = 0;
        for (const file of files) {
            try {
                this.ui.status.innerText = `FETCHING ${file}...`;
                const response = await fetch(file);
                if (response.ok) {
                    const text = await response.text();
                    zip.file(file, text);
                    loaded++;
                } else {
                    console.warn(`Failed to fetch ${file}`);
                }
            } catch (e) {
                console.error(`Error fetching ${file}`, e);
            }
        }

        // Add Java Launcher (Wrapper)
        const javaLauncher = `
import java.awt.Desktop;
import java.io.File;
import java.io.IOException;
import java.net.URI;

public class SystemaLauncher {
    public static void main(String[] args) {
        try {
            File htmlFile = new File("index.html");
            if (htmlFile.exists()) {
                Desktop.getDesktop().browse(htmlFile.toURI());
                System.out.println("Launching Systema8os.xt in default browser...");
            } else {
                System.err.println("Error: index.html not found in current directory.");
            }
        } catch (IOException e) {
            e.printStackTrace();
        }
    }
}
`;
        zip.file("SystemaLauncher.java", javaLauncher);

        // Add Readme
        const readme = `
SYSTEMA8OS.XT - OFFLINE CLONE
-----------------------------

FEATURES:
- Granular Engine (Audio/Video)
- Peru Instrument (Physics-based Granular Collider)
- Spatialization (Binaural/Stereo)
- Neural Face Detection (BlazeFace)

HOW TO RUN:

OPTION 1 (WEB SERVER - RECOMMENDED):
1. Requires Node.js or Python.
2. In this folder, run: "npx serve" OR "python3 -m http.server"
3. Open the localhost URL (usually http://localhost:3000 or http://localhost:8000).

OPTION 2 (JAVA LAUNCHER):
1. Compile: "javac SystemaLauncher.java"
2. Run: "java SystemaLauncher"
3. NOTE: Standard browsers block "ES Modules" on local files (file://). 
   This method may fail unless you launch Chrome with "--allow-file-access-from-files".
   
*** CRITICAL ***
THE RECOMMENDED WAY IS OPTION 1 (WEB SERVER). 
DOUBLE-CLICKING INDEX.HTML WILL LIKELY SHOW A BLANK SCREEN DUE TO BROWSER SECURITY POLICIES (CORS).

REQUIREMENTS:
- Internet connection is required for initial library loading (Three.js, TensorFlow) via ESM.sh CDN.
- WebGL 2.0 compatible GPU for Peru Instrument & Visualizer.
- Camera/Microphone permissions if using capture features.
`;
        zip.file("README.txt", readme);

        if (loaded > 0) {
            this.ui.status.innerText = "ZIPPING APP...";
            const content = await zip.generateAsync({ type: "blob" });
            const url = URL.createObjectURL(content);
            const a = document.createElement('a');
            a.href = url;
            a.download = `systema8os_clone_${Date.now()}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            this.ui.status.innerText = "APP DOWNLOADED";
        } else {
            this.ui.status.innerText = "DOWNLOAD FAILED";
        }
    }

    async loadZip(file, audio, store, visualizer, analyzer) {
        this.ui.status.innerText = "UNZIPPING...";
        try {
            const zip = await JSZip.loadAsync(file);
            let cursorTime = 0;
            const fileEntries = [];

            zip.forEach((relativePath, zipEntry) => {
                if (!zipEntry.dir && (relativePath.toLowerCase().endsWith('.wav') || relativePath.toLowerCase().endsWith('.mp3'))) {
                    fileEntries.push({ path: relativePath, entry: zipEntry });
                }
            });

            this.ui.status.innerText = `FOUND ${fileEntries.length} FILES`;
            
            for (let i = 0; i < fileEntries.length; i++) {
                const { path, entry } = fileEntries[i];
                const arrayBuffer = await entry.async('arraybuffer');
                
                try {
                    const audioBuffer = await audio.decodeAudioData(arrayBuffer);
                    
                    let pitch = 100;
                    let centroid = 0.5;
                    let note = 'C';
                    
                    const pitchMatch = path.match(/(\d+)Hz_/);
                    if (pitchMatch) pitch = parseInt(pitchMatch[1]);
                    
                    if (path.includes('DARK')) centroid = 0.2;
                    else if (path.includes('BRIGHT')) centroid = 0.8;
                    else if (path.includes('NEUTRAL')) centroid = 0.5;
                    
                    if (pitch > 0) note = analyzer.noteFromPitch(pitch);

                    const chan = audioBuffer.getChannelData(0);
                    let sum = 0;
                    const stride = Math.floor(chan.length / 100) || 1;
                    for(let k=0; k<chan.length; k+=stride) sum += chan[k]*chan[k];
                    const rms = Math.sqrt(sum / (chan.length/stride));

                    audio.addClip(audioBuffer, cursorTime);
                    
                    store.addFrame({
                        time: cursorTime + (audioBuffer.duration / 2),
                        volume: Math.min(1.0, rms * 5),
                        pitch: pitch,
                        note: note,
                        centroid: centroid
                    });

                    cursorTime += audioBuffer.duration + 0.1;
                } catch(err) {
                    console.error("Skipped bad file", path, err);
                }

                if (i % 20 === 0) {
                    this.ui.status.innerText = `LOADING ${i}/${fileEntries.length}`;
                    await new Promise(r => setTimeout(r, 0));
                }
            }
            
            visualizer.updatePoints();
            this.ui.status.innerText = `PACK LOADED: ${fileEntries.length} GRAINS`;

        } catch (e) {
            console.error(e);
            this.ui.status.innerText = "ERROR LOADING ZIP";
        }
    }
}