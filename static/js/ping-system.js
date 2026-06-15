/* =========================================================================
   ping-system.js — Live Ping / Laserpointer System via RTDB
   =========================================================================
   Ermöglicht Managern, mit Shift+Linksklick einen visuellen "Ping" auf dem
   Bildschirm zu erzeugen, den alle gerade eingeloggten Nutzer sehen.
   ========================================================================= */

import { auth, rtdb, rtdbRef, rtdbSet, rtdbOnValue } from './firebase-init.js';

// CSS für die Ping-Animation dynamisch in den Header injizieren
const style = document.createElement('style');
style.innerHTML = `
    .live-ping {
        position: absolute;
        width: 20px;
        height: 20px;
        background-color: rgba(239, 68, 68, 0.8); /* Rot */
        border-radius: 50%;
        transform: translate(-50%, -50%);
        pointer-events: none; /* Klicks gehen durch den Ping hindurch */
        z-index: 99999;
        box-shadow: 0 0 10px rgba(239, 68, 68, 0.8);
        animation: ping-fade 2.5s ease-out forwards;
    }
    
    .live-ping::after {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: transparent;
        border: 2px solid rgba(239, 68, 68, 1);
        border-radius: 50%;
        animation: ping-ripple 1s ease-out infinite;
    }
    
    .live-ping-name {
        position: absolute;
        top: 25px;
        left: 50%;
        transform: translateX(-50%);
        color: #fff;
        background: rgba(0, 0, 0, 0.6);
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 11px;
        white-space: nowrap;
        opacity: 0.8;
    }

    @keyframes ping-fade {
        0% { opacity: 1; }
        70% { opacity: 1; }
        100% { opacity: 0; }
    }

    @keyframes ping-ripple {
        0% { transform: scale(1); opacity: 1; }
        100% { transform: scale(3); opacity: 0; }
    }
`;
document.head.appendChild(style);


// Wir warten auf Auth, bevor wir den Listener initialisieren
let currentUser = null;
let pingListenerActive = false;

window.authPromise.then((user) => {
    if (!user) return;
    currentUser = user;
    
    const pingsRef = rtdbRef(rtdb, 'pings');
    
    // Read: Auf neue Pings lauschen
    rtdbOnValue(pingsRef, (snapshot) => {
        const data = snapshot.val();
        if (!data) return;
        
        const now = Date.now();
        
        Object.values(data).forEach(ping => {
            // Aktuelle Seite ermitteln (ohne Unter-Tabs wie &assignments)
            const currentPage = window.location.hash.split('&')[0];
            
            // Nur Pings rendern, die jünger als 3 Sekunden sind UND zur selben Seite gehören
            if (ping && ping.timestamp && (now - ping.timestamp) < 3000 && ping.pageId === currentPage) {
                // Verhindern, dass derselbe Ping mehrfach gezeichnet wird
                const pingId = `ping-${ping.timestamp}-${ping.userId}`;
                if (!document.getElementById(pingId)) {
                    console.log("Ping empfangen und wird gezeichnet:", ping);
                    renderPing(ping, pingId);
                }
            }
        });
    });
});

// Write: Event Listener für den Klick (nur für Manager)
// Wir nutzen mousedown + capture, damit kein anderes Skript das Event verschlucken kann
document.addEventListener('mousedown', (e) => {
    // Nur reagieren bei gedrückter Shift-Taste, Linksklick (button 0) und wenn Manager eingeloggt ist
    if (e.shiftKey && e.button === 0 && window.isManager && currentUser) {
        
        // Verhindern, dass Text markiert wird oder andere Events triggern
        e.preventDefault();
        const target = e.target;
        const targetRect = target.getBoundingClientRect();
        
        // Klick-Position in Prozent *innerhalb* des geklickten Elements berechnen
        const px = (e.clientX - targetRect.left) / targetRect.width;
        const py = (e.clientY - targetRect.top) / targetRect.height;
        
        // Einen eindeutigen CSS-Selektor für das Element generieren
        const selector = getCssPath(target);
        
        const myPingRef = rtdbRef(rtdb, `pings/${currentUser.uid}`);
        
        // Aktuellen Namen ermitteln (falls vorhanden, sonst Fallback)
        const currentManagerUsername = sessionStorage.getItem('currentManager') || 'Manager';
        
        // Aktuelle Seite speichern (damit Pings nicht auf falschen Bossen aufpoppen)
        const currentPage = window.location.hash.split('&')[0];
        
        const pingData = {
            userId: currentUser.uid,
            name: currentManagerUsername,
            selector: selector,
            px: px,
            py: py,
            pageId: currentPage,
            timestamp: Date.now()
        };
        
        // Ping in die RTDB schreiben
        console.log("Sende Ping...", pingData);
        rtdbSet(myPingRef, pingData);
        
        // Den Ping-Knoten nach 3 Sekunden automatisch wieder aus der Datenbank löschen
        setTimeout(() => {
            rtdbSet(myPingRef, null);
        }, 3000);
    }
}, true); // <- capture: true ist wichtig!

function renderPing(pingData, id) {
    const container = document.querySelector('.main-container');
    if (!container || !pingData.selector) return;

    let targetEl;
    try {
        targetEl = document.querySelector(pingData.selector);
    } catch (e) {
        console.warn("Ping-Ziel konnte nicht gefunden werden:", pingData.selector);
        return;
    }
    
    if (!targetEl) return;

    // Position des Ziels und des Containers holen
    const targetRect = targetEl.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    // Zielposition relativ zum Container berechnen
    const relativeLeft = targetRect.left - containerRect.left;
    const relativeTop = targetRect.top - containerRect.top;

    // Exakte Pixel-Position des Pings (Element-Ecke + Prozentualer Offset)
    const x_px = relativeLeft + (pingData.px * targetRect.width);
    const y_px = relativeTop + (pingData.py * targetRect.height);

    const pingEl = document.createElement('div');
    pingEl.className = 'live-ping';
    pingEl.id = id;
    
    // Positionierung exakt in Pixeln relativ zum Container
    pingEl.style.left = `${x_px}px`;
    pingEl.style.top = `${y_px}px`;
    
    // Name des Pinger-Erstellers anzeigen
    const nameEl = document.createElement('div');
    nameEl.className = 'live-ping-name';
    nameEl.textContent = pingData.name;
    pingEl.appendChild(nameEl);
    
    container.appendChild(pingEl);
    
    // DOM Cleanup nach der Animation (2.5 Sekunden)
    setTimeout(() => {
        if (container.contains(pingEl)) {
            container.removeChild(pingEl);
        }
    }, 2500);
}

// Hilfsfunktion: Generiert einen robusten CSS-Pfad zum geklickten Element
function getCssPath(el) {
    if (!(el instanceof Element)) return;
    const path = [];
    while (el.nodeType === Node.ELEMENT_NODE) {
        let selector = el.nodeName.toLowerCase();
        if (el.id) {
            selector += '#' + el.id;
            path.unshift(selector);
            break; // IDs sind eindeutig, wir können hier aufhören
        } else {
            let sib = el, nth = 1;
            while (sib = sib.previousElementSibling) {
                if (sib.nodeName.toLowerCase() == selector) nth++;
            }
            if (nth != 1) selector += `:nth-of-type(${nth})`;
        }
        path.unshift(selector);
        el = el.parentNode;
    }
    return path.join(" > ");
}
