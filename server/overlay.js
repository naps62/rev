/**
 * rev visual-review overlay. The visual proxy injects a <script> tag for this
 * file (served at /__rev-overlay.js) into proxied HTML; the /visual dashboard
 * embeds the proxied app in an iframe and talks to this script over
 * postMessage. Self-contained, zero dependencies, every style inline — it
 * runs inside arbitrary apps and must not depend on rev's stylesheet or
 * mutate the app's own elements.
 *
 * Message shapes are hand-mirrored from shared/types.ts
 * (VisualOverlayMessage / VisualHostMessage) — keep both in sync:
 *
 *   overlay → host:
 *     { type: "rev-overlay-ready", url: string }
 *     { type: "rev-pick", x, y, selector?, ex?, ey?, outerHtml? }
 *     { type: "rev-pin-click", id: string }
 *     { type: "rev-route", url: string }
 *
 *   host → overlay:
 *     { type: "rev-mode", pick: boolean }
 *     { type: "rev-pins", pins: [{ id, n, resolved,
 *         anchor: { url, x, y, selector?, ex?, ey?, outerHtml? } }] }
 */
(function () {
  "use strict";
  // Page opened directly, not framed by the dashboard: stay inert.
  if (window.parent === window) return;

  // shared/tuning.ts VISUAL_OUTERHTML_MAX — hardcoded, this file ships alone.
  var OUTERHTML_MAX = 2000;
  var Z_BASE = 2147483000;

  function post(msg) {
    window.parent.postMessage(msg, "*");
  }

  function mount() {
    return document.body || document.documentElement;
  }

  function isOverlayNode(node) {
    return (
      node instanceof Element && node.closest("[data-rev-overlay]") !== null
    );
  }

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // --- selector computation ------------------------------------------------

  function matchesUniquely(sel, el) {
    try {
      var found = document.querySelectorAll(sel);
      return found.length === 1 && found[0] === el;
    } catch (_e) {
      return false;
    }
  }

  /** `#id` when the id is unique in the document, else null. */
  function idSelector(node) {
    if (!node.id) return null;
    var sel = "#" + CSS.escape(node.id);
    return matchesUniquely(sel, node) ? sel : null;
  }

  /**
   * Shortest reliable CSS path: the element's own unique id, else
   * tag:nth-of-type steps composed upward until the selector matches exactly
   * one element, stopping early at an ancestor with a unique id.
   */
  function selectorFor(el) {
    var own = idSelector(el);
    if (own) return own;
    var steps = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var nth = 1;
      var sib = cur;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === cur.tagName) nth++;
      }
      steps.unshift(cur.tagName.toLowerCase() + ":nth-of-type(" + nth + ")");
      var candidate = steps.join(" > ");
      if (matchesUniquely(candidate, el)) return candidate;
      var parent = cur.parentElement;
      if (parent) {
        var anchor = idSelector(parent);
        if (anchor) {
          candidate = anchor + " > " + steps.join(" > ");
          if (matchesUniquely(candidate, el)) return candidate;
        }
      }
      cur = parent;
    }
    // Full chain from the root is unique by construction.
    return "html > " + steps.join(" > ");
  }

  // --- pick mode -----------------------------------------------------------

  var highlight = null;

  function ensureHighlight() {
    if (highlight && highlight.isConnected) return highlight;
    highlight = document.createElement("div");
    highlight.setAttribute("data-rev-overlay", "");
    var s = highlight.style;
    s.position = "fixed";
    s.zIndex = String(Z_BASE);
    s.pointerEvents = "none";
    s.border = "1.5px solid #e2b45c";
    s.background = "rgba(226, 180, 92, 0.12)";
    s.borderRadius = "2px";
    s.display = "none";
    s.margin = "0";
    s.padding = "0";
    s.boxSizing = "border-box";
    mount().appendChild(highlight);
    return highlight;
  }

  function onPickMove(e) {
    var t = e.target;
    var h = ensureHighlight();
    if (!(t instanceof Element) || isOverlayNode(t)) {
      h.style.display = "none";
      return;
    }
    var r = t.getBoundingClientRect();
    h.style.display = "block";
    h.style.left = r.left + "px";
    h.style.top = r.top + "px";
    h.style.width = r.width + "px";
    h.style.height = r.height + "px";
  }

  function onPickClick(e) {
    var t = e.target;
    // Pins keep their own click behavior even in pick mode.
    if (isOverlayNode(t)) return;
    e.preventDefault();
    e.stopPropagation();
    var msg = {
      type: "rev-pick",
      x: clamp01(e.clientX / window.innerWidth),
      y: clamp01(e.clientY / window.innerHeight),
    };
    if (t instanceof Element) {
      var r = t.getBoundingClientRect();
      msg.selector = selectorFor(t);
      msg.ex = r.width ? clamp01((e.clientX - r.left) / r.width) : 0;
      msg.ey = r.height ? clamp01((e.clientY - r.top) / r.height) : 0;
      msg.outerHtml = t.outerHTML.slice(0, OUTERHTML_MAX);
    }
    post(msg);
  }

  var picking = false;
  var prevCursor = "";

  function setPick(on) {
    if (on === picking) return;
    picking = on;
    var root = document.documentElement;
    if (on) {
      prevCursor = root.style.cursor;
      root.style.cursor = "crosshair";
      document.addEventListener("mousemove", onPickMove, true);
      document.addEventListener("click", onPickClick, true);
    } else {
      root.style.cursor = prevCursor;
      document.removeEventListener("mousemove", onPickMove, true);
      document.removeEventListener("click", onPickClick, true);
      if (highlight) highlight.style.display = "none";
    }
  }

  // --- pins ----------------------------------------------------------------

  var pins = []; // { anchor, el }

  function makePinEl(pin) {
    var el = document.createElement("div");
    el.setAttribute("data-rev-overlay", "");
    var s = el.style;
    s.position = "fixed";
    s.zIndex = String(Z_BASE + 1);
    s.width = "22px";
    s.height = "22px";
    s.marginLeft = "-11px";
    s.marginTop = "-11px";
    s.borderRadius = "50%";
    s.background = pin.resolved ? "#8a8f98" : "#e2b45c";
    s.border = "1px solid " + (pin.resolved ? "#6b7078" : "#b78f3d");
    s.color = "#ffffff";
    s.font = "700 11px/20px system-ui, sans-serif";
    s.textAlign = "center";
    s.cursor = "pointer";
    s.boxShadow = "0 1px 4px rgba(0, 0, 0, 0.35)";
    s.userSelect = "none";
    s.opacity = pin.resolved ? "0.75" : "1";
    el.textContent = String(pin.n);
    el.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      post({ type: "rev-pin-click", id: pin.id });
    });
    return el;
  }

  /** Each rev-pins message replaces the previous set wholesale. */
  function renderPins(list) {
    for (var i = 0; i < pins.length; i++) pins[i].el.remove();
    pins = [];
    for (var j = 0; j < list.length; j++) {
      var p = list[j];
      if (!p || typeof p !== "object" || !p.anchor) continue;
      var el = makePinEl(p);
      mount().appendChild(el);
      pins.push({ anchor: p.anchor, el: el });
    }
    positionPins();
  }

  function positionPins() {
    for (var i = 0; i < pins.length; i++) {
      var a = pins[i].anchor;
      var el = pins[i].el;
      var target = null;
      if (a.selector) {
        try {
          target = document.querySelector(a.selector);
        } catch (_e) {
          target = null;
        }
      }
      var left;
      var top;
      if (target) {
        var r = target.getBoundingClientRect();
        left = r.left + (a.ex == null ? 0.5 : a.ex) * r.width;
        top = r.top + (a.ey == null ? 0.5 : a.ey) * r.height;
      } else {
        // Selector gone (or never set): fall back to viewport coordinates.
        left = a.x * window.innerWidth;
        top = a.y * window.innerHeight;
      }
      el.style.left = left + "px";
      el.style.top = top + "px";
    }
  }

  var rafId = 0;

  function schedulePosition() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      positionPins();
    });
  }

  // Capture-phase scroll catches nested scroll containers, not just window.
  window.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("resize", schedulePosition);

  // --- route changes -------------------------------------------------------

  function announceRoute() {
    post({ type: "rev-route", url: location.href });
    schedulePosition();
  }

  var origPush = history.pushState;
  history.pushState = function () {
    var r = origPush.apply(this, arguments);
    announceRoute();
    return r;
  };
  var origReplace = history.replaceState;
  history.replaceState = function () {
    var r = origReplace.apply(this, arguments);
    announceRoute();
    return r;
  };
  window.addEventListener("popstate", announceRoute);
  window.addEventListener("hashchange", announceRoute);

  // --- host messages -------------------------------------------------------

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "rev-mode") {
      setPick(!!d.pick);
    } else if (d.type === "rev-pins" && Array.isArray(d.pins)) {
      renderPins(d.pins);
    }
  });

  post({ type: "rev-overlay-ready", url: location.href });
})();
