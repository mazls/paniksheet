/* =========================================================================
   image-markers.js — Einteilungs-Marker auf Taktik-Bildern
   =========================================================================
   Manager klicken einen Raid-Marker im Einteilungsblock (LaneGroups) an und
   danach auf eine Stelle im Taktik-Bild. Dort erscheint für ALLE Nutzer ein
   farbiger Marker-Punkt. Beim Hovern zeigt ein Tooltip die eingeteilten
   Spieler der Gruppe — live aus dem Einteilungsblock aufgelöst (Spec-Slots,
   Klassenfarben, Bench-Status inklusive).

   - Positionen werden als Prozent-Koordinaten (0..1 relativ zum Bild)
     gespeichert → identische Stelle auf jedem Gerät/jeder Auflösung,
     im kleinen Bild UND in der Lightbox.
   - Speicherung: Firestore raid-tool-data/boss-<slug>, Feld
     "<slug>-image-markers" = { markers: [...], editor, timestamp }.
   - Live-Sync über eigenen onSnapshot-Listener auf dem Boss-Dokument.
   - Manager: Klick auf Lane-Marker = Platzierungs-Modus (ESC bricht ab),
     Punkt ziehen = verschieben, Rechtsklick auf Punkt = entfernen.
   ========================================================================= */

window.ImageMarkers = (function () {
    'use strict';

    const FIELD_SUFFIX = '-image-markers';

    // ── State ────────────────────────────────────────────────────────────
    let bossSlug = null;      // z.B. 'immerseus' (null = keine Boss-Seite aktiv)
    let markers = [];         // [{id, img, x, y, marker, laneTitle, assignmentId, blockIdx, laneIdx}]
    let unsubscribe = null;   // Firestore-Listener der aktuellen Boss-Seite
    let armed = null;         // Platzierungs-Modus: {assignmentId, blockIdx, laneIdx, marker, laneTitle}
    let armedEl = null;       // angeklicktes .lg-marker-display (für Highlight)
    let dragging = null;      // aktiver Drag: {dot, img, id, moved, startX, startY, cur}
    let lastSavedTs = null;   // eigenes Save-Echo vom Snapshot unterscheiden
    let lastDragEnd = 0;      // Klick direkt nach Drag nicht als Platzierung werten

    // ── Helpers ──────────────────────────────────────────────────────────

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function clamp01(v) { return Math.min(1, Math.max(0, v)); }

    // Bild-Schlüssel: Dateiname (klein), unabhängig von Host/Pfad-Präfix —
    // so matchen kleines Bild und Lightbox (voll aufgelöste URL) denselben Key.
    function imageKeyFromSrc(src) {
        if (!src) return '';
        try { src = new URL(src, window.location.href).pathname; } catch (e) { /* relativer Pfad */ }
        const base = String(src).split('?')[0].split('#')[0].split('/').pop() || '';
        try { return decodeURIComponent(base).toLowerCase(); } catch (e) { return base.toLowerCase(); }
    }

    function markerMeta(id) {
        if (window.LaneGroups && typeof window.LaneGroups.getMarkerMeta === 'function') {
            return window.LaneGroups.getMarkerMeta(id);
        }
        return { id: id || '', label: id || 'Marker', file: '', color: '#e2e8f0', emoji: '📍' };
    }

    function markerIconHtml(meta) {
        if (meta.file) {
            return `<img src="raidicons/${meta.file}" alt="${esc(meta.label)}" draggable="false" onerror="this.outerHTML='<span class=&quot;im-emoji&quot;>${meta.emoji}</span>'">`;
        }
        return `<span class="im-emoji">${meta.emoji}</span>`;
    }

    // ── CSS ──────────────────────────────────────────────────────────────

    function injectCss() {
        if (document.getElementById('im-styles')) return;
        const css = `
            .im-wrap { position:relative; display:block; }
            .im-overlay { position:absolute; inset:0; pointer-events:none; z-index:5; }
            .im-dot {
                position:absolute;
                width:26px; height:26px;
                transform:translate(-50%,-50%);
                border-radius:50%;
                border:2px solid var(--im-color,#e2e8f0);
                background:rgba(15,23,42,0.78);
                display:flex; align-items:center; justify-content:center;
                pointer-events:auto;
                box-shadow:0 0 5px rgba(0,0,0,0.9), 0 0 7px var(--im-color, transparent);
                transition:transform 0.1s ease-out;
                touch-action:none;
                z-index:5;
            }
            .im-dot:hover { transform:translate(-50%,-50%) scale(1.25); z-index:10; }
            .im-dot.im-dragging { transition:none; cursor:grabbing; z-index:10; }
            .im-dot img { width:16px; height:16px; pointer-events:none; }
            .im-dot .im-emoji { font-size:13px; line-height:1; pointer-events:none; }
            /* Lightbox: etwas größere Punkte */
            #lightbox-image-wrap { position:relative; display:inline-block; }
            #lightbox-image-wrap .im-dot { width:34px; height:34px; }
            #lightbox-image-wrap .im-dot img { width:22px; height:22px; }
            #lightbox-image-wrap .im-dot .im-emoji { font-size:17px; }
            /* Platzierungs-Modus */
            body.im-placing .im-wrap img,
            body.im-placing #lightbox-image-wrap img { cursor:crosshair !important; }
            .im-banner {
                position:fixed; top:70px; left:50%; transform:translateX(-50%);
                z-index:6000;
                display:flex; align-items:center; gap:12px; flex-wrap:wrap;
                background:#1e293b; border:1px solid #f59e0b; color:#fef3c7;
                padding:8px 14px; border-radius:8px; font-size:0.85rem;
                box-shadow:0 4px 14px rgba(0,0,0,0.6);
                max-width:92vw;
            }
            .im-banner img { width:20px; height:20px; }
            .im-banner .im-emoji { font-size:16px; line-height:1; }
            .im-banner button {
                background:#334155; border:1px solid #64748b; color:#e2e8f0;
                border-radius:4px; padding:2px 8px; cursor:pointer; font-size:0.75rem;
            }
            .im-banner button:hover { filter:brightness(1.2); }
            /* Klick-Affordanz auf den Lane-Markern (nur Manager, per JS gesetzt) */
            .lg-marker-display.im-clickable { cursor:pointer; }
            .lg-marker-display.im-clickable:hover { filter:brightness(1.4) drop-shadow(0 0 3px rgba(250,204,21,0.8)); }
            .lg-marker-display.im-armed { outline:2px solid #f59e0b; outline-offset:2px; border-radius:4px; }
        `;
        const styleEl = document.createElement('style');
        styleEl.id = 'im-styles';
        styleEl.textContent = css;
        document.head.appendChild(styleEl);
    }

    // ── Overlays über den Bildern ────────────────────────────────────────

    // Jedes Taktik-Bild bekommt einen positionierten Wrapper + Overlay-Ebene.
    // Wrapper ist display:block, die Bilder sind alle w-full h-auto — dadurch
    // ist die Wrapper-Box exakt die Bild-Box und Prozent-Punkte sitzen überall
    // an derselben Bildstelle.
    function wrapContentImages() {
        const container = document.getElementById('content-container') || document;
        container.querySelectorAll('img.lightbox-trigger, img.positioning-image').forEach(img => {
            if (img.closest('.im-wrap')) return;
            const wrap = document.createElement('div');
            wrap.className = 'im-wrap';
            img.parentNode.insertBefore(wrap, img);
            wrap.appendChild(img);
            const overlay = document.createElement('div');
            overlay.className = 'im-overlay';
            overlay.dataset.img = imageKeyFromSrc(img.getAttribute('src') || img.src);
            wrap.appendChild(overlay);
            // Bild lädt nicht (onerror ersetzt es ggf. durch einen Platzhalter):
            // keine Punkte auf dem Platzhalter zeichnen.
            img.addEventListener('error', () => { overlay.innerHTML = ''; overlay.dataset.dead = '1'; });
        });
    }

    function renderAll() {
        document.querySelectorAll('.im-overlay').forEach(renderOverlay);
    }

    function renderOverlay(overlay) {
        if (!overlay || overlay.dataset.dead === '1') return;
        const key = overlay.dataset.img;
        overlay.innerHTML = '';
        markers.forEach(mk => {
            if (mk.img === key) overlay.appendChild(buildDot(mk));
        });
    }

    function buildDot(mk) {
        const meta = markerMeta(mk.marker);
        const dot = document.createElement('div');
        dot.className = 'im-dot';
        dot.dataset.id = mk.id;
        dot.style.left = (mk.x * 100) + '%';
        dot.style.top = (mk.y * 100) + '%';
        dot.style.setProperty('--im-color', meta.color);
        dot.innerHTML = markerIconHtml(meta);

        dot.addEventListener('mouseenter', (e) => { showTooltip(mk); moveTooltip(e); });
        dot.addEventListener('mousemove', moveTooltip);
        dot.addEventListener('mouseleave', hideTooltip);
        dot.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            removeMarker(mk);
        });
        return dot;
    }

    // ── Tooltip ──────────────────────────────────────────────────────────
    // Eigenes Element mit reinen Inline-Styles: #global-custom-tooltip wird
    // durch .buff-tooltip (styles.css) auf position:absolute + z-index:100
    // gezwungen — bei gescrollter Seite landet es außerhalb des Viewports
    // und unter der Lightbox. Deshalb hier bewusst unabhängig davon.

    let tipEl = null;
    function tooltipEl() {
        if (tipEl && document.body.contains(tipEl)) return tipEl;
        tipEl = document.getElementById('im-tooltip');
        if (!tipEl) {
            tipEl = document.createElement('div');
            tipEl.id = 'im-tooltip';
            tipEl.style.cssText = [
                'position:fixed', 'display:none', 'z-index:99999',
                'pointer-events:none', 'max-width:280px',
                'background:#1e293b', 'border:1px solid #64748b',
                'border-radius:6px', 'padding:8px 10px',
                'font-size:0.75rem', 'line-height:1.4', 'color:#fff',
                'box-shadow:0 4px 14px rgba(0,0,0,0.6)'
            ].join(';');
            document.body.appendChild(tipEl);
        }
        return tipEl;
    }

    function buildTooltipHtml(mk) {
        const meta = markerMeta(mk.marker);
        const info = (window.LaneGroups && typeof window.LaneGroups.getLaneInfo === 'function')
            ? window.LaneGroups.getLaneInfo(mk.assignmentId, { blockIdx: mk.blockIdx, laneIdx: mk.laneIdx, marker: mk.marker })
            : null;

        const title = (info && (info.title || (info.markerMeta && info.markerMeta.label))) || mk.laneTitle || meta.label;
        let html = `<div style="display:flex; align-items:center; gap:6px; border-bottom:1px solid #475569; padding-bottom:4px; margin-bottom:4px;">`;
        html += markerIconHtml(meta).replace('<img ', '<img style="width:18px;height:18px;" ');
        html += `<strong style="color:${meta.color};">${esc(title)}</strong></div>`;

        if (info && info.players && info.players.length > 0) {
            info.players.forEach(p => {
                const flags = (p.isBench ? '⚠ ' : '') + (p.missing ? '❌ ' : '');
                html += `<div style="color:${p.color}; line-height:1.5;">${flags}${esc(p.name)}</div>`;
            });
        } else {
            html += `<div style="color:#94a3b8; font-style:italic;">Keine Spieler eingeteilt</div>`;
        }
        if (window.isManager) {
            html += `<div style="color:#64748b; font-size:0.65rem; margin-top:5px;">Ziehen = verschieben · Rechtsklick = entfernen</div>`;
        }
        return html;
    }

    function showTooltip(mk) {
        if (dragging) return;
        const el = tooltipEl();
        if (!el) return;
        el.innerHTML = buildTooltipHtml(mk);
        el.style.display = 'block';
    }

    function moveTooltip(e) {
        const el = tooltipEl();
        if (!el || el.style.display === 'none') return;
        const pad = 15;
        let x = e.clientX + pad;
        let y = e.clientY + pad;
        const r = el.getBoundingClientRect();
        if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
        if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
        el.style.left = x + 'px';
        el.style.top = y + 'px';
    }

    function hideTooltip() {
        const el = tooltipEl();
        if (el) el.style.display = 'none';
    }

    // ── Platzierungs-Modus (Manager) ─────────────────────────────────────

    function arm(data, el) {
        disarm();
        armed = data;
        armedEl = el || null;
        if (armedEl) armedEl.classList.add('im-armed');
        document.body.classList.add('im-placing');
        showBanner();
    }

    function disarm() {
        armed = null;
        if (armedEl) { armedEl.classList.remove('im-armed'); armedEl = null; }
        document.body.classList.remove('im-placing');
        removeBanner();
    }

    function showBanner() {
        removeBanner();
        if (!armed) return;
        const meta = markerMeta(armed.marker);
        const div = document.createElement('div');
        div.className = 'im-banner';
        div.id = 'im-banner';
        div.innerHTML = `
            <span style="display:inline-flex; align-items:center; gap:6px;">${markerIconHtml(meta)}<strong>${esc(armed.laneTitle || meta.label)}</strong></span>
            <span>📍 Klicke im Taktik-Bild auf die gewünschte Position (klein oder vergrößert)</span>
            <button type="button" id="im-banner-cancel">✕ Abbrechen (ESC)</button>`;
        document.body.appendChild(div);
        div.querySelector('#im-banner-cancel').addEventListener('click', disarm);
    }

    function removeBanner() {
        const b = document.getElementById('im-banner');
        if (b) b.remove();
    }

    // ── Datenoperationen ─────────────────────────────────────────────────

    async function save(logText) {
        if (!window.isManager || !bossSlug) return;
        const fb = window.firebaseTools;
        if (!fb || !fb.db || !fb.doc || !fb.setDoc) return;
        const editor = sessionStorage.getItem('currentManager') || 'Unbekannt';
        const timestamp = new Date().toISOString();
        lastSavedTs = timestamp;
        try {
            const docRef = fb.doc(fb.db, 'raid-tool-data', 'boss-' + bossSlug);
            await fb.setDoc(docRef, {
                [bossSlug + FIELD_SUFFIX]: {
                    markers: JSON.parse(JSON.stringify(markers)),
                    editor: editor,
                    timestamp: timestamp
                }
            }, { merge: true });
            if (typeof window.logHistory === 'function' && logText) {
                const bossName = bossSlug.charAt(0).toUpperCase() + bossSlug.slice(1);
                window.logHistory(bossName, 'Bild-Marker', logText, editor);
            }
        } catch (err) {
            console.error('[ImageMarkers] Speichern fehlgeschlagen:', err);
            if (typeof window.showModal === 'function') {
                window.showModal('Bild-Marker konnte nicht gespeichert werden: ' + (err && err.message ? err.message : err));
            }
        }
    }

    async function placeMarker(imgKey, x, y) {
        if (!window.isManager || !armed || !bossSlug || !imgKey) return;
        const a = armed;
        disarm();
        const meta = markerMeta(a.marker);
        // Pro Lane und Bild genau ein Marker: erneutes Platzieren verschiebt ihn.
        let mk = markers.find(m =>
            m.img === imgKey && m.assignmentId === a.assignmentId &&
            m.blockIdx === a.blockIdx && m.laneIdx === a.laneIdx
        );
        let action;
        if (mk) {
            mk.x = x; mk.y = y; mk.marker = a.marker; mk.laneTitle = a.laneTitle;
            action = 'verschoben';
        } else {
            mk = {
                id: 'im-' + Math.random().toString(36).slice(2, 10),
                img: imgKey, x: x, y: y,
                marker: a.marker, laneTitle: a.laneTitle,
                assignmentId: a.assignmentId, blockIdx: a.blockIdx, laneIdx: a.laneIdx
            };
            markers.push(mk);
            action = 'platziert';
        }
        renderAll();
        await save(`${meta.emoji} ${a.laneTitle || meta.label} ${action} (${imgKey})`);
    }

    async function removeMarker(mk) {
        if (!window.isManager) return;
        const meta = markerMeta(mk.marker);
        const label = mk.laneTitle || meta.label;
        const ok = await Promise.resolve(
            typeof window.showModal === 'function'
                ? window.showModal(`Marker "${meta.emoji} ${esc(label)}" vom Bild entfernen?`, true)
                : window.confirm(`Marker "${label}" vom Bild entfernen?`)
        );
        if (!ok) return;
        markers = markers.filter(m => m.id !== mk.id);
        hideTooltip();
        renderAll();
        await save(`${meta.emoji} ${label} entfernt (${mk.img})`);
    }

    // ── Globale Event-Verdrahtung (einmalig) ─────────────────────────────

    // 1) Klick auf einen Lane-Marker im Einteilungsblock → Platzierungs-Modus.
    document.addEventListener('click', (e) => {
        const disp = e.target.closest('.lg-marker-display');
        if (!disp || !window.isManager || !bossSlug || !window.LaneGroups) return;
        const laneEl = disp.closest('.lg-lane');
        if (!laneEl) return;

        // LaneGroups-Instanz suchen, deren Container das Element enthält
        let inst = null;
        window.LaneGroups._instances.forEach(i => {
            if (!inst && i.container && i.container.contains(laneEl)) inst = i;
        });
        if (!inst) return;

        const bi = +laneEl.dataset.blockIdx;
        const li = +laneEl.dataset.laneIdx;
        const lane = inst.blocks[bi] && inst.blocks[bi].lanes && inst.blocks[bi].lanes[li];
        if (!lane) return;
        if (!lane.marker) {
            if (typeof window.showModal === 'function') {
                window.showModal('Diese Spalte hat keinen Marker — bitte zuerst im Layout einen Marker wählen.');
            }
            return;
        }

        // Erneuter Klick auf denselben Marker → Modus beenden
        if (armed && armedEl === disp) { disarm(); return; }

        arm({
            assignmentId: inst.assignmentId,
            blockIdx: bi,
            laneIdx: li,
            marker: lane.marker,
            laneTitle: lane.title || ''
        }, disp);
    });

    // 2) Platzierungs-Klick auf ein Bild (Capture, damit z.B. das Öffnen der
    //    Lightbox unterdrückt wird, solange der Platzierungs-Modus aktiv ist).
    document.addEventListener('click', (e) => {
        if (!armed || e.shiftKey || e.button !== 0) return;              // Shift = Ping-System
        if (Date.now() - lastDragEnd < 300) return;                      // Klick-Echo nach Drag
        if (e.target.closest('#im-banner')) return;                      // Banner-Buttons
        if (e.target.closest('.lg-marker-display')) return;              // erneute Marker-Wahl

        const wrap = e.target.closest('.im-wrap, #lightbox-image-wrap');
        if (!wrap) return;
        const img = wrap.querySelector('img');
        const overlay = wrap.querySelector('.im-overlay');
        if (!img || !overlay || overlay.dataset.dead === '1') return;

        e.preventDefault();
        e.stopPropagation();

        const r = img.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const x = clamp01((e.clientX - r.left) / r.width);
        const y = clamp01((e.clientY - r.top) / r.height);
        placeMarker(overlay.dataset.img, x, y);
    }, true);

    // 3) ESC beendet den Platzierungs-Modus.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && armed) disarm();
    });

    // 4) Punkte per Drag verschieben (nur Manager).
    document.addEventListener('pointerdown', (e) => {
        const dot = e.target.closest('.im-dot');
        if (!dot || !window.isManager || e.button !== 0 || e.shiftKey || armed) return;
        const wrap = dot.closest('.im-wrap, #lightbox-image-wrap');
        const img = wrap && wrap.querySelector('img');
        if (!img) return;
        e.preventDefault();
        dragging = { dot: dot, img: img, id: dot.dataset.id, moved: false, startX: e.clientX, startY: e.clientY, cur: null };
        try { dot.setPointerCapture(e.pointerId); } catch (err) { /* optional */ }
    });

    document.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        if (!dragging.moved && Math.abs(e.clientX - dragging.startX) + Math.abs(e.clientY - dragging.startY) > 4) {
            dragging.moved = true;
            hideTooltip();
            dragging.dot.classList.add('im-dragging');
        }
        if (!dragging.moved) return;
        const r = dragging.img.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const x = clamp01((e.clientX - r.left) / r.width);
        const y = clamp01((e.clientY - r.top) / r.height);
        dragging.cur = { x: x, y: y };
        dragging.dot.style.left = (x * 100) + '%';
        dragging.dot.style.top = (y * 100) + '%';
    });

    document.addEventListener('pointerup', () => {
        if (!dragging) return;
        const d = dragging;
        dragging = null;
        d.dot.classList.remove('im-dragging');
        if (d.moved && d.cur) {
            lastDragEnd = Date.now();
            const mk = markers.find(m => m.id === d.id);
            if (mk) {
                mk.x = d.cur.x;
                mk.y = d.cur.y;
                renderAll();
                const meta = markerMeta(mk.marker);
                save(`${meta.emoji} ${mk.laneTitle || meta.label} verschoben (${mk.img})`);
            }
        }
    });

    // 5) Klick-Affordanz: Lane-Marker bekommen für Manager Cursor + Tooltip.
    document.addEventListener('mouseover', (e) => {
        const disp = e.target.closest('.lg-marker-display');
        if (!disp || disp.classList.contains('im-clickable')) return;
        if (!window.isManager || !bossSlug) return;
        disp.classList.add('im-clickable');
        disp.title = 'Klicken: Marker auf dem Taktik-Bild platzieren';
    });

    // ── Lifecycle ────────────────────────────────────────────────────────

    // Wird von main.js nach dem Laden einer Boss-Seite aufgerufen.
    function initForBoss(slug) {
        teardown();
        if (!slug) return;
        bossSlug = slug;
        injectCss();
        wrapContentImages();

        const fb = window.firebaseTools;
        if (!fb || !fb.db || !fb.doc) {
            console.error('[ImageMarkers] window.firebaseTools unvollständig — Marker können nicht geladen werden.');
            return;
        }
        const docRef = fb.doc(fb.db, 'raid-tool-data', 'boss-' + slug);
        const applySnapshot = (data) => {
            const saved = data[slug + FIELD_SUFFIX];
            // Eigenes Save-Echo bzw. älterer Stand darf frischere lokale Edits
            // nicht überschreiben (gleiche Logik wie bei LaneGroups).
            if (saved && saved.timestamp && lastSavedTs && saved.timestamp <= lastSavedTs) return;
            const incoming = (saved && Array.isArray(saved.markers)) ? saved.markers : [];
            if (JSON.stringify(incoming) === JSON.stringify(markers)) return;
            markers = incoming;
            renderAll();
        };
        if (typeof fb.onSnapshot === 'function') {
            unsubscribe = fb.onSnapshot(docRef, (snap) => {
                applySnapshot(snap.exists() ? snap.data() : {});
            }, (err) => console.error('[ImageMarkers] Snapshot-Fehler:', err));
        } else if (typeof fb.getDoc === 'function') {
            // Fallback ohne Live-Sync: Marker wenigstens einmalig laden.
            console.error('[ImageMarkers] onSnapshot fehlt in window.firebaseTools — Fallback auf einmaliges Laden (kein Live-Sync).');
            fb.getDoc(docRef)
                .then(snap => applySnapshot(snap.exists() ? snap.data() : {}))
                .catch(err => console.error('[ImageMarkers] Laden fehlgeschlagen:', err));
        }
    }

    // Wird von main.js beim Seitenwechsel aufgerufen (vor dem Laden neuer Inhalte).
    function teardown() {
        if (unsubscribe) { try { unsubscribe(); } catch (e) { /* egal */ } unsubscribe = null; }
        disarm();
        hideTooltip();
        dragging = null;
        markers = [];
        lastSavedTs = null;
        bossSlug = null;
        // Lightbox-Overlay entfernen (Content-Overlays verschwinden mit dem Seitenwechsel)
        const lbOverlay = document.querySelector('#lightbox-image-wrap .im-overlay');
        if (lbOverlay) lbOverlay.remove();
    }

    // Wird von window.openLightbox aufgerufen: Overlay für das vergrößerte Bild.
    function syncLightbox(src) {
        const wrap = document.getElementById('lightbox-image-wrap');
        if (!wrap) return;
        injectCss();
        let overlay = wrap.querySelector('.im-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'im-overlay';
            wrap.appendChild(overlay);
        }
        overlay.dataset.img = imageKeyFromSrc(src);
        renderOverlay(overlay);
    }

    return {
        initForBoss,
        teardown,
        syncLightbox,
        renderAll
    };

})();
