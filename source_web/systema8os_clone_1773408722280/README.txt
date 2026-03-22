
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
