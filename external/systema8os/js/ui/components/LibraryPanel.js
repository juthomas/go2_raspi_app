import { PeruInstrument } from './PeruInstrument.js';

export class LibraryPanel {
    constructor(store, audio, callbacks) {
        this.store = store;
        this.audio = audio;
        this.callbacks = callbacks;
        this.container = document.getElementById('library-view');
        this.tableBody = document.querySelector('#grain-table tbody');
        this.searchInput = document.getElementById('lib-search');
        this.btnClose = document.getElementById('btn-close-lib');
        this.btnRefresh = document.getElementById('btn-refresh-lib');
        this.checkAll = document.getElementById('lib-check-all');
        this.selectedCountLabel = document.getElementById('lib-selected-count');
        this.libraryContent = document.querySelector('.library-content'); // Reference to table container

        this.sortCol = 'id';
        this.sortAsc = true;
        this.checked = new Set();
        
        this.peruInstances = [];
        this.activePeru = null;

        this.init();
    }
    
    init() {
        if(this.btnClose) this.btnClose.addEventListener('click', () => this.hide());
        if(this.searchInput) this.searchInput.addEventListener('input', () => this.render());
        if(this.btnRefresh) this.btnRefresh.addEventListener('click', () => this.render());

        // Add Peru Button to header controls
        const controlsDiv = document.querySelector('.library-controls');
        if (controlsDiv) {
            const btnPeru = document.createElement('button');
            btnPeru.innerText = "OPEN PERU";
            btnPeru.style.background = "#660000";
            btnPeru.style.border = "1px solid #ff0000";
            btnPeru.style.marginRight = "10px";
            btnPeru.onclick = () => {
                const selectedFrames = [];
                this.checked.forEach(idx => {
                    if (this.store.frames[idx]) selectedFrames.push(this.store.frames[idx]);
                });
                
                if (this.activePeru && !this.activePeru.container.classList.contains('hidden')) {
                    this.activePeru.initBalls(selectedFrames);
                } else {
                    if (this.peruInstances.length >= 4) {
                        alert("Max 4 Peru windows allowed to prevent GPU crash. Please close some windows.");
                        return;
                    }
                    this.createPeruInstance(selectedFrames);
                }
            };
            // Insert before Refresh button if possible, else append
            if(this.btnRefresh) controlsDiv.insertBefore(btnPeru, this.btnRefresh);
            else controlsDiv.appendChild(btnPeru);
        }
        
        if(this.checkAll) {
            this.checkAll.addEventListener('change', (e) => {
                if(e.target.checked) {
                    // Check all visible
                    const rows = this.getFilteredRows();
                    rows.forEach(r => this.checked.add(r.origIndex));
                } else {
                    this.checked.clear();
                }
                this.render();
            });
        }

        // Headers sorting
        const headers = document.querySelectorAll('#grain-table th');
        headers.forEach(th => {
            if(th.dataset.sort) {
                th.style.cursor = 'pointer';
                th.style.userSelect = 'none';
                th.addEventListener('click', () => {
                    if (this.sortCol === th.dataset.sort) {
                        this.sortAsc = !this.sortAsc;
                    } else {
                        this.sortCol = th.dataset.sort;
                        this.sortAsc = true;
                    }
                    // Visual indicator
                    headers.forEach(h => h.style.textDecoration = 'none');
                    th.style.textDecoration = 'underline';
                    this.render();
                });
            }
        });
    }

    toggle() {
        if (this.container.classList.contains('hidden')) this.show();
        else this.hide();
    }

    show() {
        this.container.classList.remove('hidden');
        document.body.classList.add('view-library');
        this.render();
    }

    hide() {
        // Peru remains active in background even if library closes
        this.container.classList.add('hidden');
        document.body.classList.remove('view-library');
    }

    createPeruInstance(initialFrames = []) {
        const p = new PeruInstrument(this.audio, this.store);
        
        p.onFocus = () => {
            this.setActivePeru(p);
        };
        
        p.onSpawn = () => {
            this.createPeruInstance([]);
        };
        
        p.onClose = () => {
            const idx = this.peruInstances.indexOf(p);
            if (idx > -1) this.peruInstances.splice(idx, 1);
            
            if (this.activePeru === p) {
                this.activePeru = this.peruInstances.length > 0 ? this.peruInstances[this.peruInstances.length - 1] : null;
                if (this.activePeru) this.setActivePeru(this.activePeru);
            }
            // Dispose properly to free WebGL context
            if (p.dispose) p.dispose(); 
            else p.container.remove();
        };
        
        this.peruInstances.push(p);
        p.show(initialFrames);
        this.setActivePeru(p);
        return p;
    }

    setActivePeru(p) {
        this.peruInstances.forEach(inst => inst.setActive(false));
        if (p) {
            p.setActive(true);
            this.activePeru = p;
        }
    }

    getFilteredRows() {
        const filter = this.searchInput ? this.searchInput.value.toLowerCase() : '';
        
        // Map frames to a sortable array with original index
        let rows = this.store.frames.map((f, i) => {
            let hue = 0;
            if (f.pitch > 0) {
                const logPitch = Math.log2(f.pitch);
                hue = ((logPitch * 12) % 12) / 12 * 360;
            }
            return { ...f, origIndex: i, hue: hue };
        });

        // Filter
        if (filter) {
            rows = rows.filter(r => 
                (r.origIndex.toString().includes(filter)) ||
                (r.note && r.note.toLowerCase().includes(filter)) ||
                (Math.round(r.pitch) + 'hz').includes(filter)
            );
        }
        return rows;
    }

    render() {
        if (!this.tableBody) return;
        this.tableBody.innerHTML = '';
        
        // Update Stats
        if (this.selectedCountLabel) {
            this.selectedCountLabel.innerText = `${this.checked.size} SELECTED`;
        }

        let rows = this.getFilteredRows();

        // Sort
        rows.sort((a, b) => {
            let valA, valB;
            switch(this.sortCol) {
                case 'id': valA = a.origIndex; valB = b.origIndex; break;
                case 'note': 
                    valA = a.note || ''; 
                    valB = b.note || ''; 
                    return this.sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
                case 'pitch': valA = a.pitch; valB = b.pitch; break;
                case 'color': valA = a.hue; valB = b.hue; break;
                case 'timbre': valA = a.centroid; valB = b.centroid; break;
                case 'time': valA = a.time; valB = b.time; break;
                case 'created': valA = parseInt(a.id || 0); valB = parseInt(b.id || 0); break;
                default: valA = a.origIndex; valB = b.origIndex;
            }
            return this.sortAsc ? (valA - valB) : (valB - valA);
        });

        // Limit rendering for performance
        const maxRows = 200;
        const renderSet = rows.slice(0, maxRows);

        renderSet.forEach(f => {
            const tr = document.createElement('tr');
            if (this.checked.has(f.origIndex)) tr.classList.add('selected');
            
            // Drag Support
            tr.draggable = true;
            tr.addEventListener('dragstart', (e) => {
                // If dragging a selection
                if (this.checked.has(f.origIndex) && this.checked.size > 1) {
                    const indices = Array.from(this.checked);
                    e.dataTransfer.setData('application/json', JSON.stringify({ indices: indices }));
                    e.dataTransfer.setDragImage(tr, 0, 0); // Visual feedback
                } else {
                    // Single item
                    e.dataTransfer.setData('application/json', JSON.stringify({ index: f.origIndex }));
                }
                e.dataTransfer.effectAllowed = 'copy';
                tr.style.opacity = '0.5';
            });
            tr.addEventListener('dragend', () => {
                tr.style.opacity = '1';
            });

            // Checkbox
            const tdCheck = document.createElement('td');
            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.checked = this.checked.has(f.origIndex);
            chk.onclick = (e) => {
                e.stopPropagation();
                if (chk.checked) {
                    this.checked.add(f.origIndex);
                    tr.classList.add('selected');
                } else {
                    this.checked.delete(f.origIndex);
                    tr.classList.remove('selected');
                }
                if (this.selectedCountLabel) this.selectedCountLabel.innerText = `${this.checked.size} SELECTED`;
            };
            tdCheck.appendChild(chk);
            tr.appendChild(tdCheck);

            // ID
            const tdId = document.createElement('td');
            tdId.innerText = f.origIndex.toString().padStart(4, '0');
            tdId.style.fontFamily = 'monospace';
            tdId.style.color = '#888';
            tr.appendChild(tdId);
            
            // Color Swatch
            const tdColor = document.createElement('td');
            const swatch = document.createElement('div');
            swatch.className = 'color-swatch';
            if (f.pitch > 0) {
                swatch.style.backgroundColor = `hsl(${f.hue}, 80%, 50%)`;
                swatch.style.boxShadow = `0 0 5px hsl(${f.hue}, 80%, 50%)`;
            } else {
                swatch.style.backgroundColor = '#333';
            }
            tdColor.appendChild(swatch);
            tr.appendChild(tdColor);

            // Note
            const tdNote = document.createElement('td');
            tdNote.innerText = f.note || '--';
            tdNote.style.fontWeight = 'bold';
            tr.appendChild(tdNote);

            // Pitch
            const tdPitch = document.createElement('td');
            tdPitch.innerText = Math.round(f.pitch) + ' Hz';
            tr.appendChild(tdPitch);

            // Timbre
            const tdTimbre = document.createElement('td');
            const tVal = Math.round(f.centroid * 100);
            const bar = document.createElement('div');
            bar.className = 'timbre-bar';
            bar.innerHTML = `<div style="width:${tVal}%; background:#fff;"></div>`;
            tdTimbre.appendChild(bar);
            tr.appendChild(tdTimbre);
            
            // Time
            const tdTime = document.createElement('td');
            tdTime.innerText = f.time.toFixed(2) + 's';
            tdTime.style.color = '#666';
            tr.appendChild(tdTime);

            // Created
            const tdCreated = document.createElement('td');
            const dateObj = new Date(parseInt(f.id));
            if (!isNaN(dateObj.getTime())) {
                const h = dateObj.getHours().toString().padStart(2, '0');
                const m = dateObj.getMinutes().toString().padStart(2, '0');
                const s = dateObj.getSeconds().toString().padStart(2, '0');
                tdCreated.innerText = `${h}:${m}:${s}`;
            } else {
                tdCreated.innerText = "--";
            }
            tdCreated.style.color = '#888';
            tdCreated.style.fontSize = '10px';
            tr.appendChild(tdCreated);

            // Action
            const tdAction = document.createElement('td');
            const btnPlay = document.createElement('button');
            btnPlay.innerText = 'PLAY';
            btnPlay.className = 'table-btn';
            btnPlay.onclick = (e) => {
                e.stopPropagation();
                this.playGrain(f);
            };
            tdAction.appendChild(btnPlay);
            tr.appendChild(tdAction);

            tr.onclick = (e) => {
                if (e.target !== chk) {
                    // Click row to play, but don't toggle check to allow precise selection logic
                    // Or maybe we want row selection to check? 
                    // Let's stick to "row click plays and highlights temporarily" but checks are persistent selection
                    this.playGrain(f);
                }
            };

            this.tableBody.appendChild(tr);
        });
        
        if (rows.length > maxRows) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 8;
            td.innerText = `... ${rows.length - maxRows} MORE GRAINS HIDDEN (USE SEARCH) ...`;
            td.className = 'table-info-row';
            tr.appendChild(td);
            this.tableBody.appendChild(tr);
        }
    }

    playGrain(f) {
        const pan = (f.centroid - 0.5) * 2;
        this.audio.playGrain(f.time, 0.2, 0.8, pan, null, null, { bitmap: f.bitmap, sourceId: f.sourceVidId, frame: f });
        
        // Auto-route to Peru
        let target = this.activePeru;
        
        // If no active, try to find ANY existing instance (even hidden) to avoid spamming windows
        if (!target) {
            if (this.peruInstances.length > 0) {
                target = this.peruInstances[this.peruInstances.length - 1]; // Use last created
                this.setActivePeru(target);
            }
        }

        // Check if we found one
        if (target) {
            // Ensure it's open
            if (target.container.classList.contains('hidden')) {
                target.toggleWindow(true);
            }
            // Add to existing
            target.initBalls([f]);
        } else {
            // Auto-open new Peru
            this.createPeruInstance([f]);
        }

        if (this.callbacks.onSelect) {
            this.callbacks.onSelect(f.origIndex);
        }
    }

    selectRow(tr, index) {
        const all = this.tableBody.querySelectorAll('tr');
        all.forEach(r => r.classList.remove('selected'));
        tr.classList.add('selected');
    }
}