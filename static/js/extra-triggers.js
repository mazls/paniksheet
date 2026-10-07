/*
 * „Gilt auch für“ im CD-Planer: Eine Planer-Zeile kann zusätzlich für weitere Trigger gelten
 * (z. B. Ohrenbetäubendes Kreischen P1 → auch P2 + P3). Gespeichert wird das als normales
 * Zeilenfeld "<prefix>-planner-row<N>-extra" ({ text: "KEY1,KEY2" }) – es wandert also beim
 * Sortieren mit. Für Export, Übersicht und Discord werden die Zeilen per expandExtraTriggers()
 * in Einzelzeilen aufgelöst ("rowNx1", "rowNx2" …), die bestehende Logik bleibt unverändert.
 */
(function () {
  'use strict';

  var ROW_RE = /^(.+-planner-row)(\d+)-extra$/;
  var phaseBase = function (t) { return String(t || '').replace(/\s*P\s?\d{1,2}\s*$/i, '').trim().toLowerCase(); };
  var parseList = function (v) { return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); };

  /** Datenobjekt (Boss-Dokument) um virtuelle Zeilen für die Zusatz-Trigger erweitern. */
  window.expandExtraTriggers = function (data) {
    if (!data) return data;
    var out = Object.assign({}, data);
    Object.keys(data).forEach(function (key) {
      var m = ROW_RE.exec(key);
      if (!m) return;
      var extras = parseList(data[key] && (data[key].text || data[key].player));
      var base = m[1] + m[2];
      var main = data[base + '-trigger'] && data[base + '-trigger'].player;
      if (!main || !extras.length) return;
      var fields = Object.keys(data).filter(function (k) { return k.indexOf(base + '-') === 0 && k !== key; });
      extras.forEach(function (trig, j) {
        if (trig === main) return;
        var vBase = base + 'x' + (j + 1);
        fields.forEach(function (k) {
          var suffix = k.substring(base.length);
          out[vBase + suffix] = suffix === '-trigger' ? Object.assign({}, data[k], { player: trig }) : data[k];
        });
      });
    });
    return out;
  };

  /** Zusatz-Trigger einer Zeile (für die Übersicht, die aus dem DOM liest). */
  window.getRowExtraTriggers = function (rowPrefix) {
    var el = document.querySelector('[data-assignment-id="' + rowPrefix + '-extra"]');
    return el ? parseList(el.value) : [];
  };

  var openPopover = null;
  function closePopover() {
    if (openPopover) { openPopover.remove(); openPopover = null; }
  }
  document.addEventListener('mousedown', function (e) {
    if (openPopover && !openPopover.contains(e.target) && !(e.target.closest && e.target.closest('.extra-trig-btn'))) closePopover();
  });

  function setValue(input, list) {
    input.value = list.join(',');
    input.dispatchEvent(new Event('change', { bubbles: true })); // speichert über handleAssignmentChange
    window.refreshExtraTriggers();
    if (typeof window.updatePlannerSummary === 'function') setTimeout(window.updatePlannerSummary, 150);
  }

  function triggerOptions(select) {
    return Array.from(select.options)
      .filter(function (o) { return o.value && !/_ENC_START$|_HEALTH$/.test(o.value); })
      .map(function (o) { return { val: o.value, text: o.textContent.trim() }; });
  }

  function showPopover(btn, select, input) {
    closePopover();
    var main = select.value;
    var opts = triggerOptions(select).filter(function (o) { return o.val !== main; });
    if (!opts.length) return;
    var current = parseList(input.value);
    var mainText = (select.options[select.selectedIndex] || {}).textContent || '';
    var siblings = opts.filter(function (o) { return phaseBase(o.text) === phaseBase(mainText); });
    var canEdit = !!window.isManager;

    var pop = document.createElement('div');
    pop.className = 'extra-trig-popover';
    pop.style.cssText = 'position:absolute;z-index:60;min-width:15rem;max-height:18rem;overflow:auto;background:#0f172a;border:1px solid #475569;border-radius:6px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.6);font-size:12px;';
    var head = document.createElement('div');
    head.textContent = 'Gilt auch für';
    head.style.cssText = 'padding:2px 6px 4px;color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.05em;';
    pop.appendChild(head);

    function row(label, checked, onChange, bold) {
      var l = document.createElement('label');
      l.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px;cursor:' + (canEdit ? 'pointer' : 'default') + ';color:' + (bold ? '#7dd3fc' : '#e2e8f0') + ';font-weight:' + (bold ? '600' : '400') + ';';
      l.onmouseenter = function () { l.style.background = '#1e293b'; };
      l.onmouseleave = function () { l.style.background = ''; };
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.disabled = !canEdit;
      cb.onchange = function () { onChange(cb.checked); };
      l.appendChild(cb);
      l.appendChild(document.createTextNode(label));
      pop.appendChild(l);
    }

    if (siblings.length) {
      var all = siblings.every(function (o) { return current.indexOf(o.val) >= 0; });
      row('Alle Phasen (' + siblings.length + ')', all, function (on) {
        var ids = siblings.map(function (o) { return o.val; });
        var next = on ? current.concat(ids.filter(function (v) { return current.indexOf(v) < 0; })) : current.filter(function (v) { return ids.indexOf(v) < 0; });
        setValue(input, next);
        showPopover(btn, select, input);
      }, true);
    }
    opts.forEach(function (o) {
      row(o.text, current.indexOf(o.val) >= 0, function (on) {
        var cur = parseList(input.value);
        setValue(input, on ? cur.concat([o.val]) : cur.filter(function (v) { return v !== o.val; }));
        showPopover(btn, select, input);
      });
    });
    if (!canEdit) {
      var hint = document.createElement('div');
      hint.textContent = 'Nur Gildenräte können das ändern.';
      hint.style.cssText = 'padding:4px 6px;color:#64748b;font-size:10px;';
      pop.appendChild(hint);
    }

    var r = btn.getBoundingClientRect();
    pop.style.left = (window.scrollX + r.left) + 'px';
    pop.style.top = (window.scrollY + r.bottom + 4) + 'px';
    document.body.appendChild(pop);
    openPopover = pop;
  }

  /** Beschriftung aller „+“-Buttons aus den versteckten Feldern aktualisieren. */
  window.refreshExtraTriggers = function () {
    document.querySelectorAll('.extra-trig-btn').forEach(function (btn) {
      var wrap = btn.parentNode;
      var input = wrap.querySelector('[data-assignment-id$="-extra"]');
      var select = wrap.querySelector('select[data-assignment-id$="-trigger"]');
      var list = input ? parseList(input.value) : [];
      var hasCustom = select && select.value && !/_ENC_START$|_HEALTH$/.test(select.value);
      btn.style.visibility = hasCustom || list.length ? 'visible' : 'hidden';
      btn.textContent = list.length ? '+' + list.length : '+';
      btn.style.borderColor = list.length ? '#0284c7' : '#475569';
      btn.style.color = list.length ? '#bae6fd' : '#94a3b8';
      btn.style.background = list.length ? 'rgba(8,47,73,.6)' : 'transparent';
      if (select && list.length) {
        var names = list.map(function (v) {
          var o = Array.from(select.options).find(function (x) { return x.value === v; });
          return o ? o.textContent.trim() : v;
        });
        btn.title = 'Gilt auch für: ' + names.join(', ');
      } else {
        btn.title = 'Gilt auch für weitere Trigger/Phasen …';
      }
    });
  };

  /** In jeder Planer-Zeile neben dem Trigger einen „+“-Button + verstecktes Feld anlegen. */
  window.initExtraTriggerButtons = function (container) {
    if (!container) return;
    var stored = window.lastBossAssignments || {};
    container.querySelectorAll('select[data-assignment-id$="-trigger"]').forEach(function (select) {
      if (select.dataset.extraInit) return;
      select.dataset.extraInit = '1';
      var id = select.dataset.assignmentId.replace(/-trigger$/, '-extra');

      // Select + Button in denselben Grid-Platz setzen (sonst verschiebt sich die Zeile)
      var wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;align-items:center;gap:4px;min-width:0;';
      select.parentNode.insertBefore(wrap, select);
      wrap.appendChild(select);
      select.style.minWidth = '0';
      select.style.flex = '1 1 auto';

      var input = document.createElement('input');
      input.type = 'hidden';
      input.className = 'assignment-text-input';
      input.dataset.assignmentId = id;
      input.value = (stored[id] && (stored[id].text || stored[id].player)) || '';
      wrap.appendChild(input);

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'extra-trig-btn';
      btn.style.cssText = 'flex:0 0 auto;border:1px solid #475569;border-radius:4px;padding:0 6px;font-size:11px;line-height:20px;cursor:pointer;';
      btn.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (openPopover) { closePopover(); return; }
        // ID kann sich durch Sortieren geändert haben → aktuelles Feld nehmen
        showPopover(btn, select, wrap.querySelector('[data-assignment-id$="-extra"]'));
      };
      wrap.appendChild(btn);
      select.addEventListener('change', function () { setTimeout(window.refreshExtraTriggers, 0); });
    });
    window.refreshExtraTriggers();
  };
})();
