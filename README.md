# PÄNIK Raidsheet - Mein Raid-Planungstool für World of Warcraft

Willkommen beim PÄNIK Raidsheet! Ich habe dieses webbasierte Tool entwickelt, um die Organisation und Planung von Raids für meine Gilde "PÄNIK" in *World of Warcraft: Mists of Pandaria* zu vereinfachen. Es bietet uns eine zentrale Plattform zur Verwaltung der Raid-Aufstellung (Roster), zur Analyse der mitgebrachten Buffs, zur Zuweisung von Aufgaben für spezifische Bosskämpfe und zur Nachverfolgung unserer Loot-Verteilung.

Das gesamte System ist über eine interaktive Weboberfläche zugänglich und nutzt Firebase Firestore als Echtzeit-Datenbank, sodass Änderungen sofort für alle Gildenmitglieder sichtbar sind.

![Hauptansicht](https://i.imgur.com/0y9OvTL.png)

## ✨ Features

- **Echtzeit-Datenbank:** Änderungen an der Aufstellung oder den Zuweisungen werden dank Firebase Firestore sofort für alle Betrachter aktualisiert.
- **Raid-Comp-Verwaltung:**
    - Importieren der Raid-Aufstellung direkt aus dem "Raid-Helper"-Addon-JSON.
    - Manuelles Hinzufügen, Bearbeiten und Löschen von Spielern.
    - Zuweisung von Rollen (Tank, Heiler, DPS) für jeden Spieler.
- **Automatisierte Buff-Analyse:**
    - Zeigt an, welche wichtigen Raid-Buffs (offensiv, defensiv) und Debuffs durch die aktuelle Aufstellung abgedeckt sind.
    - Tooltips geben an, welche Klassen den jeweiligen Buff bereitstellen.
- **Boss-spezifische Taktikseiten:**
    - Detaillierte Zuweisungs-Dropdowns für spezifische Aufgaben bei jedem Boss.
    - Zuweisungen sind nur für authentifizierte Gildenräte änderbar.
- **Loot-Verwaltung & -Analyse:**
    - Import von Loot-Daten aus einem Addon-JSON.
    - Detaillierte Ansicht der vergebenen Items pro Raid-Tag.
    - Spieler-Zusammenfassung zur Analyse, wer wie viele Items (MS, OS, Transmog) erhalten hat.
    - Item-Namen sind direkt mit Wowhead verlinkt.
- **Änderungsverlauf:**
    - Protokolliert alle wichtigen Aktionen (Roster-Änderungen, Zuweisungen, Loot-Importe) mit Zeitstempel und Bearbeiter.
- **Authentifizierungssystem:**
    - Ein "Gildenrat-Login" schützt kritische Funktionen vor unbefugtem Zugriff.
    - Besucher können die Planung einsehen, aber keine Änderungen vornehmen.
- **Dynamische Navigation:**
    - Einfacher Wechsel zwischen verschiedenen Raids und deren Bossen.
- **Anwesenheitsanzeige:** Zeigt an, wie viele Benutzer gerade online sind.

## 🛠️ Verwendete Technologien

- **Frontend:** HTML5, Tailwind CSS, Vanilla JavaScript (ES6 Modules)
- **Backend & Datenbank:** Google Firebase (Firestore für die Echtzeit-Datenbank, Authentication für die Benutzerverwaltung)
- **Hosting:** Kann auf jedem statischen Webhost (z. B. GitHub Pages, Firebase Hosting) oder lokal betrieben werden.

## 📁 Projektstruktur

Das Projekt besteht aus mehreren HTML-Dateien, die dynamisch in die `index.html` geladen werden.

- **`index.html`:** Die Hauptdatei. Sie enthält den Rahmen der Anwendung, die Navigation, das Firebase-Setup und die gesamte JavaScript-Logik zur Steuerung der Anwendung. Alle anderen Inhaltsseiten werden in den `<main id="content-container">`-Bereich dieser Datei geladen.

- **`comp.html`:** Die "Übersichts & Comp"-Seite. Dies ist die Standardansicht.
    - **Funktion:** Hier wird die gesamte Raid-Aufstellung verwaltet. Gildenräte können Spieler per JSON-Import hinzufügen oder manuell verwalten.
    - **Aufbau:** Die Seite ist in drei Hauptbereiche unterteilt:
        1.  **Raid-Helper Import:** Ein Textfeld zum Einfügen des JSON und Buttons zum Importieren, Hinzufügen oder Leeren der Aufstellung.
        2.  **Roster-Anzeige:** Listet alle Spieler nach ihren zugewiesenen Rollen (Tanks, Heiler, DDs) auf. Namen und Klassen können hier direkt bearbeitet werden.
        3.  **Raid Buffs & Cooldowns:** Eine Übersicht aller relevanten Buffs, die automatisch basierend auf der aktuellen Aufstellung als "vorhanden" oder "fehlend" markiert wird.

- **`history.html`:** Die Seite für den Änderungsverlauf.
    - **Funktion:** Zeigt eine chronologische Liste aller wichtigen Änderungen, die im Tool vorgenommen wurden.
    - **Aufbau:** Eine einfache Tabelle mit den Spalten: Boss, Einteilung, Zugewiesener Spieler, Bearbeiter und Datum/Zeit.

- **`loot.html`:** Die Seite für die Loot-Verwaltung.
    - **Funktion:** Ermöglicht den Import von Loot-Daten und deren detaillierte Ansicht.
    - **Aufbau:**
        1.  **Loot-Daten Import:** Ein Bereich für Gildenräte, um JSON-Daten zu importieren.
        2.  **Layout:** Ein Zwei-Spalten-Layout. Links eine Liste der Raid-Daten, für die Loot importiert wurde. Rechts die Detailansicht.
        3.  **Detailansicht:** Zeigt für ein ausgewähltes Datum alle vergebenen Items, den Gewinner und die Würfe aller Teilnehmer.
        4.  **Spieler-Zusammenfassung:** Eine alternative Ansicht, die anzeigt, wie viele Items jeder Spieler über ausgewählte Zeiträume erhalten hat.

- **Boss-spezifische HTML-Dateien (z.B., `feng.html`):**
    - **Funktion:** Diese Seiten enthalten die Taktiken und Zuweisungen für einen bestimmten Boss.
    - **Aufbau:** Typischerweise enthalten diese Seiten:
        1.  Eine kurze Beschreibung der Boss-Strategie.
        2.  Ein oder mehrere Abschnitte für Zuweisungen (z.B., "Tank-Einteilung", "Heiler-Cooldowns").
        3.  Dropdown-Menüs (`<select>`), die dynamisch mit den Spielern aus der aktuellen Aufstellung gefüllt werden, um sie für Aufgaben einzuteilen.

![Boss-Seite](https://i.imgur.com/1OjErIy.png)

![Boss-Seite](https://imgur.com/Yv1wq7O.png)

## 🚀 Setup & Lokales Testen

Um das Projekt lokal zu betreiben und zu testen, benötigst du Python und die Firebase CLI.

### 1. Firebase-Projekt einrichten

1.  **Firebase-Projekt erstellen:** Gehe zur [Firebase Console](https://console.firebase.google.com/) und erstelle ein neues Projekt.
2.  **Firestore-Datenbank erstellen:** Navigiere im Menü zu "Firestore Database" und erstelle eine neue Datenbank im **Testmodus**.
3.  **Authentifizierung aktivieren:** Gehe zu "Authentication" -> "Sign-in method" und aktiviere "Anonym" und "E-Mail/Passwort".
4.  **Web-App registrieren:** Klicke in den Projekteinstellungen (Zahnrad-Symbol) auf "Meine Apps" und füge eine neue Web-App hinzu.
5.  **Firebase-Konfiguration kopieren:** Kopiere das `firebaseConfig`-Objekt. Du musst es in die `index.html` einfügen.
    ```javascript
    // index.html, Zeile ~330
    const firebaseConfig = {
        apiKey: "DEIN_API_KEY",
        authDomain: "DEIN_PROJEKT.firebaseapp.com",
        projectId: "DEIN_PROJEKT_ID",
        storageBucket: "DEIN_PROJEKT.appspot.com",
        messagingSenderId: "DEIN_SENDER_ID",
        appId: "DEINE_APP_ID"
    };
    ```
6.  **Gildenrat-Benutzer anlegen:**
    - Gehe in der Firebase Console zu "Authentication" und lege einen Benutzer mit E-Mail/Passwort an. Dies wird dein Login als Gildenrat sein.
    - Gehe zu "Firestore Database". Erstelle eine neue Sammlung namens `user_profiles`.
    - Füge ein neues Dokument hinzu. Die Dokument-ID kann beliebig sein.
    - Füge die folgenden Felder hinzu:
        - `username` (string): Der Benutzername, den du beim Login verwenden möchtest.
        - `email` (string): Die E-Mail-Adresse, die du in Authentication angelegt hast.
        - `isManager` (boolean): Setze den Wert auf `true`.

### 2. Firebase Local Emulator Suite einrichten

Die Emulator Suite ermöglicht es dir, Firebase-Dienste vollständig lokal zu testen, ohne deine Live-Daten zu beeinflussen.

1.  **Firebase CLI installieren:** Falls noch nicht geschehen, installiere Node.js und dann die Firebase CLI global:
    ```bash
    npm install -g firebase-tools
    ```
2.  **In Firebase einloggen:**
    ```bash
    firebase login
    ```
3.  **Projekt initialisieren:** Navigiere in deinem Terminal zum Projektordner und führe aus:
    ```bash
    firebase init
    ```
    - Wähle "Firestore" und "Emulators".
    - Verbinde das lokale Projekt mit deinem erstellten Firebase-Projekt.
    - Akzeptiere die Standard-Dateinamen für die Regeln.
    - Wähle die Emulatoren "Authentication", "Firestore" und "Functions".
    - Übernimm die Standard-Ports.
    - Aktiviere die Emulator UI.

### 3. Lokalen Server starten

Das Projekt verwendet `fetch()` um die HTML-Seiten zu laden, was einen Webserver erfordert (direktes Öffnen der `index.html` im Browser funktioniert nicht).

1.  **Firebase Emulator starten:** Öffne ein Terminal im Projektverzeichnis und starte die Emulatoren:
    ```bash
    firebase emulators:start
    ```
    - Die Emulatoren laufen jetzt. Die UI ist normalerweise unter `http://localhost:4000` erreichbar.

2.  **Python Webserver starten:** Öffne ein **zweites** Terminal im selben Projektverzeichnis. Python bietet einen einfachen, eingebauten Webserver.
    ```bash
    # Für Python 3
    python -m http.server 8080
    ```
    - Ersetze `8080` durch einen anderen Port, falls dieser belegt ist.

3.  **Projekt aufrufen:** Öffne deinen Browser und navigiere zu:
    `http://localhost:8080`

Jetzt läuft die Anwendung lokal und verbindet sich mit deiner lokalen Firebase Emulator-Instanz.

## 📝 Eine neue Boss-Seite erstellen

Das Hinzufügen einer neuen Boss-Seite ist unkompliziert. Nehmen wir als Beispiel an, wir wollen einen Taktik-Guide für "Jin'rokh der Zerstörer" hinzufügen.

### Schritt 1: Raid-Daten in `index.html` ergänzen

Zuerst musst du den neuen Boss in der `raidData`-Variable in `index.html` registrieren.

```javascript
// index.html, Zeile ~387
throneofthunder: {
    name: "Der Thron des Donners",
    bosses: [
        { id: 'jinrokh', name: 'Jin\'rokh der Zerstörer' }, // <-- Diesen Eintrag hinzufügen
        { id: 'horridon', name: 'Horridon' },
        // ... weitere Bosse
    ]
},
```
- **`id`**: `'feng'` - Dies ist eine eindeutige ID ohne Leerzeichen. Der Dateiname der HTML-Seite muss `feng.html` sein.
- **`name`**: `'Feng der Verfluchte'` - Dies ist der Anzeigename, der im Navigationsbutton erscheint.

### Schritt 2: Die HTML-Datei für den Boss erstellen

Erstelle eine neue Datei im Hauptverzeichnis mit dem Namen `feng.html`. Der Inhalt dieser Datei ist reines HTML und wird dynamisch geladen. Verwende dafür am besten das unten bereitgestellte `Boss-Template.html`.

### Wichtige Punkte für Boss-Seiten:

-   **`data-assignment-id`**: Dies ist das entscheidende Attribut. Es dient als eindeutiger Schlüssel in der Firestore-Datenbank, um die Zuweisung zu speichern.
    -   **Konvention:** Verwende das Format `bossId-aufgabe-nummer`, z.B., `feng-kick-1`. Dies hält deine Datenbank übersichtlich.
    -   Jedes `<select>`-Element, das eine Zuweisung darstellt, **muss** dieses Attribut und die Klasse `assignment-select` haben.
-   **Automatisches Befüllen:** Du musst die `<option>`-Tags nicht manuell hinzufügen. Das JavaScript in `index.html` findet alle Elemente mit der Klasse `assignment-select`, liest die aktuelle Spielerliste aus der Datenbank und füllt die Dropdowns automatisch.
-   **Speicherung:** Wenn ein Gildenrat eine Auswahl trifft, wird die Zuweisung automatisch in Firestore gespeichert.

## Lizenzierung 📜

Dieses Projekt wird unter einem Dual-Licensing-Modell angeboten.

**1. Open Source (AGPLv3)**
Für Open-Source-Projekte und nicht-kommerzielle Nutzung steht dieses Projekt unter der AGPLv3 zur Verfügung. Die Lizenzdetails finden Sie in der `LICENSE`-Datei. Beachten Sie, dass alle abgeleiteten Werke, die über ein Netzwerk angeboten werden, ebenfalls ihren Quellcode unter der AGPLv3 veröffentlichen müssen.

**2. Kommerzielle Lizenz**
Wenn die Bedingungen der AGPLv3 nicht zu Ihrem Vorhaben passen, müssen Sie eine kommerzielle Lizenz erwerben. Diese gewährt Ihnen mehr Flexibilität und befreit Sie von den Pflichten der AGPLv3.

Für Anfragen zu einer kommerziellen Lizenz kontaktieren Sie mich bitte unter: **mazlsuffl@gmx.de**
