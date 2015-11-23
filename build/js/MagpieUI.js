// CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: http://codemirror.net/LICENSE

// This is CodeMirror (http://codemirror.net), a code editor
// implemented in JavaScript on top of the browser's DOM.
//
// You can find some technical background for some of the code below
// at http://marijnhaverbeke.nl/blog/#cm-internals .

(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    module.exports = mod();
  else if (typeof define == "function" && define.amd) // AMD
    return define([], mod);
  else // Plain browser env
    this.CodeMirror = mod();
})(function() {
  "use strict";

  // BROWSER SNIFFING

  // Kludges for bugs and behavior differences that can't be feature
  // detected are enabled based on userAgent etc sniffing.
  var userAgent = navigator.userAgent;
  var platform = navigator.platform;

  var gecko = /gecko\/\d/i.test(userAgent);
  var ie_upto10 = /MSIE \d/.test(userAgent);
  var ie_11up = /Trident\/(?:[7-9]|\d{2,})\..*rv:(\d+)/.exec(userAgent);
  var ie = ie_upto10 || ie_11up;
  var ie_version = ie && (ie_upto10 ? document.documentMode || 6 : ie_11up[1]);
  var webkit = /WebKit\//.test(userAgent);
  var qtwebkit = webkit && /Qt\/\d+\.\d+/.test(userAgent);
  var chrome = /Chrome\//.test(userAgent);
  var presto = /Opera\//.test(userAgent);
  var safari = /Apple Computer/.test(navigator.vendor);
  var mac_geMountainLion = /Mac OS X 1\d\D([8-9]|\d\d)\D/.test(userAgent);
  var phantom = /PhantomJS/.test(userAgent);

  var ios = /AppleWebKit/.test(userAgent) && /Mobile\/\w+/.test(userAgent);
  // This is woefully incomplete. Suggestions for alternative methods welcome.
  var mobile = ios || /Android|webOS|BlackBerry|Opera Mini|Opera Mobi|IEMobile/i.test(userAgent);
  var mac = ios || /Mac/.test(platform);
  var windows = /win/i.test(platform);

  var presto_version = presto && userAgent.match(/Version\/(\d*\.\d*)/);
  if (presto_version) presto_version = Number(presto_version[1]);
  if (presto_version && presto_version >= 15) { presto = false; webkit = true; }
  // Some browsers use the wrong event properties to signal cmd/ctrl on OS X
  var flipCtrlCmd = mac && (qtwebkit || presto && (presto_version == null || presto_version < 12.11));
  var captureRightClick = gecko || (ie && ie_version >= 9);

  // Optimize some code when these features are not used.
  var sawReadOnlySpans = false, sawCollapsedSpans = false;

  // EDITOR CONSTRUCTOR

  // A CodeMirror instance represents an editor. This is the object
  // that user code is usually dealing with.

  function CodeMirror(place, options) {
    if (!(this instanceof CodeMirror)) return new CodeMirror(place, options);

    this.options = options = options ? copyObj(options) : {};
    // Determine effective options based on given values and defaults.
    copyObj(defaults, options, false);
    setGuttersForLineNumbers(options);

    var doc = options.value;
    if (typeof doc == "string") doc = new Doc(doc, options.mode, null, options.lineSeparator);
    this.doc = doc;

    var input = new CodeMirror.inputStyles[options.inputStyle](this);
    var display = this.display = new Display(place, doc, input);
    display.wrapper.CodeMirror = this;
    updateGutters(this);
    themeChanged(this);
    if (options.lineWrapping)
      this.display.wrapper.className += " CodeMirror-wrap";
    if (options.autofocus && !mobile) display.input.focus();
    initScrollbars(this);

    this.state = {
      keyMaps: [],  // stores maps added by addKeyMap
      overlays: [], // highlighting overlays, as added by addOverlay
      modeGen: 0,   // bumped when mode/overlay changes, used to invalidate highlighting info
      overwrite: false,
      delayingBlurEvent: false,
      focused: false,
      suppressEdits: false, // used to disable editing during key handlers when in readOnly mode
      pasteIncoming: false, cutIncoming: false, // help recognize paste/cut edits in input.poll
      selectingText: false,
      draggingText: false,
      highlight: new Delayed(), // stores highlight worker timeout
      keySeq: null,  // Unfinished key sequence
      specialChars: null
    };

    var cm = this;

    // Override magic textarea content restore that IE sometimes does
    // on our hidden textarea on reload
    if (ie && ie_version < 11) setTimeout(function() { cm.display.input.reset(true); }, 20);

    registerEventHandlers(this);
    ensureGlobalHandlers();

    startOperation(this);
    this.curOp.forceUpdate = true;
    attachDoc(this, doc);

    if ((options.autofocus && !mobile) || cm.hasFocus())
      setTimeout(bind(onFocus, this), 20);
    else
      onBlur(this);

    for (var opt in optionHandlers) if (optionHandlers.hasOwnProperty(opt))
      optionHandlers[opt](this, options[opt], Init);
    maybeUpdateLineNumberWidth(this);
    if (options.finishInit) options.finishInit(this);
    for (var i = 0; i < initHooks.length; ++i) initHooks[i](this);
    endOperation(this);
    // Suppress optimizelegibility in Webkit, since it breaks text
    // measuring on line wrapping boundaries.
    if (webkit && options.lineWrapping &&
        getComputedStyle(display.lineDiv).textRendering == "optimizelegibility")
      display.lineDiv.style.textRendering = "auto";
  }

  // DISPLAY CONSTRUCTOR

  // The display handles the DOM integration, both for input reading
  // and content drawing. It holds references to DOM nodes and
  // display-related state.

  function Display(place, doc, input) {
    var d = this;
    this.input = input;

    // Covers bottom-right square when both scrollbars are present.
    d.scrollbarFiller = elt("div", null, "CodeMirror-scrollbar-filler");
    d.scrollbarFiller.setAttribute("cm-not-content", "true");
    // Covers bottom of gutter when coverGutterNextToScrollbar is on
    // and h scrollbar is present.
    d.gutterFiller = elt("div", null, "CodeMirror-gutter-filler");
    d.gutterFiller.setAttribute("cm-not-content", "true");
    // Will contain the actual code, positioned to cover the viewport.
    d.lineDiv = elt("div", null, "CodeMirror-code");
    // Elements are added to these to represent selection and cursors.
    d.selectionDiv = elt("div", null, null, "position: relative; z-index: 1");
    d.cursorDiv = elt("div", null, "CodeMirror-cursors");
    // A visibility: hidden element used to find the size of things.
    d.measure = elt("div", null, "CodeMirror-measure");
    // When lines outside of the viewport are measured, they are drawn in this.
    d.lineMeasure = elt("div", null, "CodeMirror-measure");
    // Wraps everything that needs to exist inside the vertically-padded coordinate system
    d.lineSpace = elt("div", [d.measure, d.lineMeasure, d.selectionDiv, d.cursorDiv, d.lineDiv],
                      null, "position: relative; outline: none");
    // Moved around its parent to cover visible view.
    d.mover = elt("div", [elt("div", [d.lineSpace], "CodeMirror-lines")], null, "position: relative");
    // Set to the height of the document, allowing scrolling.
    d.sizer = elt("div", [d.mover], "CodeMirror-sizer");
    d.sizerWidth = null;
    // Behavior of elts with overflow: auto and padding is
    // inconsistent across browsers. This is used to ensure the
    // scrollable area is big enough.
    d.heightForcer = elt("div", null, null, "position: absolute; height: " + scrollerGap + "px; width: 1px;");
    // Will contain the gutters, if any.
    d.gutters = elt("div", null, "CodeMirror-gutters");
    d.lineGutter = null;
    // Actual scrollable element.
    d.scroller = elt("div", [d.sizer, d.heightForcer, d.gutters], "CodeMirror-scroll");
    d.scroller.setAttribute("tabIndex", "-1");
    // The element in which the editor lives.
    d.wrapper = elt("div", [d.scrollbarFiller, d.gutterFiller, d.scroller], "CodeMirror");

    // Work around IE7 z-index bug (not perfect, hence IE7 not really being supported)
    if (ie && ie_version < 8) { d.gutters.style.zIndex = -1; d.scroller.style.paddingRight = 0; }
    if (!webkit && !(gecko && mobile)) d.scroller.draggable = true;

    if (place) {
      if (place.appendChild) place.appendChild(d.wrapper);
      else place(d.wrapper);
    }

    // Current rendered range (may be bigger than the view window).
    d.viewFrom = d.viewTo = doc.first;
    d.reportedViewFrom = d.reportedViewTo = doc.first;
    // Information about the rendered lines.
    d.view = [];
    d.renderedView = null;
    // Holds info about a single rendered line when it was rendered
    // for measurement, while not in view.
    d.externalMeasured = null;
    // Empty space (in pixels) above the view
    d.viewOffset = 0;
    d.lastWrapHeight = d.lastWrapWidth = 0;
    d.updateLineNumbers = null;

    d.nativeBarWidth = d.barHeight = d.barWidth = 0;
    d.scrollbarsClipped = false;

    // Used to only resize the line number gutter when necessary (when
    // the amount of lines crosses a boundary that makes its width change)
    d.lineNumWidth = d.lineNumInnerWidth = d.lineNumChars = null;
    // Set to true when a non-horizontal-scrolling line widget is
    // added. As an optimization, line widget aligning is skipped when
    // this is false.
    d.alignWidgets = false;

    d.cachedCharWidth = d.cachedTextHeight = d.cachedPaddingH = null;

    // Tracks the maximum line length so that the horizontal scrollbar
    // can be kept static when scrolling.
    d.maxLine = null;
    d.maxLineLength = 0;
    d.maxLineChanged = false;

    // Used for measuring wheel scrolling granularity
    d.wheelDX = d.wheelDY = d.wheelStartX = d.wheelStartY = null;

    // True when shift is held down.
    d.shift = false;

    // Used to track whether anything happened since the context menu
    // was opened.
    d.selForContextMenu = null;

    d.activeTouch = null;

    input.init(d);
  }

  // STATE UPDATES

  // Used to get the editor into a consistent state again when options change.

  function loadMode(cm) {
    cm.doc.mode = CodeMirror.getMode(cm.options, cm.doc.modeOption);
    resetModeState(cm);
  }

  function resetModeState(cm) {
    cm.doc.iter(function(line) {
      if (line.stateAfter) line.stateAfter = null;
      if (line.styles) line.styles = null;
    });
    cm.doc.frontier = cm.doc.first;
    startWorker(cm, 100);
    cm.state.modeGen++;
    if (cm.curOp) regChange(cm);
  }

  function wrappingChanged(cm) {
    if (cm.options.lineWrapping) {
      addClass(cm.display.wrapper, "CodeMirror-wrap");
      cm.display.sizer.style.minWidth = "";
      cm.display.sizerWidth = null;
    } else {
      rmClass(cm.display.wrapper, "CodeMirror-wrap");
      findMaxLine(cm);
    }
    estimateLineHeights(cm);
    regChange(cm);
    clearCaches(cm);
    setTimeout(function(){updateScrollbars(cm);}, 100);
  }

  // Returns a function that estimates the height of a line, to use as
  // first approximation until the line becomes visible (and is thus
  // properly measurable).
  function estimateHeight(cm) {
    var th = textHeight(cm.display), wrapping = cm.options.lineWrapping;
    var perLine = wrapping && Math.max(5, cm.display.scroller.clientWidth / charWidth(cm.display) - 3);
    return function(line) {
      if (lineIsHidden(cm.doc, line)) return 0;

      var widgetsHeight = 0;
      if (line.widgets) for (var i = 0; i < line.widgets.length; i++) {
        if (line.widgets[i].height) widgetsHeight += line.widgets[i].height;
      }

      if (wrapping)
        return widgetsHeight + (Math.ceil(line.text.length / perLine) || 1) * th;
      else
        return widgetsHeight + th;
    };
  }

  function estimateLineHeights(cm) {
    var doc = cm.doc, est = estimateHeight(cm);
    doc.iter(function(line) {
      var estHeight = est(line);
      if (estHeight != line.height) updateLineHeight(line, estHeight);
    });
  }

  function themeChanged(cm) {
    cm.display.wrapper.className = cm.display.wrapper.className.replace(/\s*cm-s-\S+/g, "") +
      cm.options.theme.replace(/(^|\s)\s*/g, " cm-s-");
    clearCaches(cm);
  }

  function guttersChanged(cm) {
    updateGutters(cm);
    regChange(cm);
    setTimeout(function(){alignHorizontally(cm);}, 20);
  }

  // Rebuild the gutter elements, ensure the margin to the left of the
  // code matches their width.
  function updateGutters(cm) {
    var gutters = cm.display.gutters, specs = cm.options.gutters;
    removeChildren(gutters);
    for (var i = 0; i < specs.length; ++i) {
      var gutterClass = specs[i];
      var gElt = gutters.appendChild(elt("div", null, "CodeMirror-gutter " + gutterClass));
      if (gutterClass == "CodeMirror-linenumbers") {
        cm.display.lineGutter = gElt;
        gElt.style.width = (cm.display.lineNumWidth || 1) + "px";
      }
    }
    gutters.style.display = i ? "" : "none";
    updateGutterSpace(cm);
  }

  function updateGutterSpace(cm) {
    var width = cm.display.gutters.offsetWidth;
    cm.display.sizer.style.marginLeft = width + "px";
  }

  // Compute the character length of a line, taking into account
  // collapsed ranges (see markText) that might hide parts, and join
  // other lines onto it.
  function lineLength(line) {
    if (line.height == 0) return 0;
    var len = line.text.length, merged, cur = line;
    while (merged = collapsedSpanAtStart(cur)) {
      var found = merged.find(0, true);
      cur = found.from.line;
      len += found.from.ch - found.to.ch;
    }
    cur = line;
    while (merged = collapsedSpanAtEnd(cur)) {
      var found = merged.find(0, true);
      len -= cur.text.length - found.from.ch;
      cur = found.to.line;
      len += cur.text.length - found.to.ch;
    }
    return len;
  }

  // Find the longest line in the document.
  function findMaxLine(cm) {
    var d = cm.display, doc = cm.doc;
    d.maxLine = getLine(doc, doc.first);
    d.maxLineLength = lineLength(d.maxLine);
    d.maxLineChanged = true;
    doc.iter(function(line) {
      var len = lineLength(line);
      if (len > d.maxLineLength) {
        d.maxLineLength = len;
        d.maxLine = line;
      }
    });
  }

  // Make sure the gutters options contains the element
  // "CodeMirror-linenumbers" when the lineNumbers option is true.
  function setGuttersForLineNumbers(options) {
    var found = indexOf(options.gutters, "CodeMirror-linenumbers");
    if (found == -1 && options.lineNumbers) {
      options.gutters = options.gutters.concat(["CodeMirror-linenumbers"]);
    } else if (found > -1 && !options.lineNumbers) {
      options.gutters = options.gutters.slice(0);
      options.gutters.splice(found, 1);
    }
  }

  // SCROLLBARS

  // Prepare DOM reads needed to update the scrollbars. Done in one
  // shot to minimize update/measure roundtrips.
  function measureForScrollbars(cm) {
    var d = cm.display, gutterW = d.gutters.offsetWidth;
    var docH = Math.round(cm.doc.height + paddingVert(cm.display));
    return {
      clientHeight: d.scroller.clientHeight,
      viewHeight: d.wrapper.clientHeight,
      scrollWidth: d.scroller.scrollWidth, clientWidth: d.scroller.clientWidth,
      viewWidth: d.wrapper.clientWidth,
      barLeft: cm.options.fixedGutter ? gutterW : 0,
      docHeight: docH,
      scrollHeight: docH + scrollGap(cm) + d.barHeight,
      nativeBarWidth: d.nativeBarWidth,
      gutterWidth: gutterW
    };
  }

  function NativeScrollbars(place, scroll, cm) {
    this.cm = cm;
    var vert = this.vert = elt("div", [elt("div", null, null, "min-width: 1px")], "CodeMirror-vscrollbar");
    var horiz = this.horiz = elt("div", [elt("div", null, null, "height: 100%; min-height: 1px")], "CodeMirror-hscrollbar");
    place(vert); place(horiz);

    on(vert, "scroll", function() {
      if (vert.clientHeight) scroll(vert.scrollTop, "vertical");
    });
    on(horiz, "scroll", function() {
      if (horiz.clientWidth) scroll(horiz.scrollLeft, "horizontal");
    });

    this.checkedOverlay = false;
    // Need to set a minimum width to see the scrollbar on IE7 (but must not set it on IE8).
    if (ie && ie_version < 8) this.horiz.style.minHeight = this.vert.style.minWidth = "18px";
  }

  NativeScrollbars.prototype = copyObj({
    update: function(measure) {
      var needsH = measure.scrollWidth > measure.clientWidth + 1;
      var needsV = measure.scrollHeight > measure.clientHeight + 1;
      var sWidth = measure.nativeBarWidth;

      if (needsV) {
        this.vert.style.display = "block";
        this.vert.style.bottom = needsH ? sWidth + "px" : "0";
        var totalHeight = measure.viewHeight - (needsH ? sWidth : 0);
        // A bug in IE8 can cause this value to be negative, so guard it.
        this.vert.firstChild.style.height =
          Math.max(0, measure.scrollHeight - measure.clientHeight + totalHeight) + "px";
      } else {
        this.vert.style.display = "";
        this.vert.firstChild.style.height = "0";
      }

      if (needsH) {
        this.horiz.style.display = "block";
        this.horiz.style.right = needsV ? sWidth + "px" : "0";
        this.horiz.style.left = measure.barLeft + "px";
        var totalWidth = measure.viewWidth - measure.barLeft - (needsV ? sWidth : 0);
        this.horiz.firstChild.style.width =
          (measure.scrollWidth - measure.clientWidth + totalWidth) + "px";
      } else {
        this.horiz.style.display = "";
        this.horiz.firstChild.style.width = "0";
      }

      if (!this.checkedOverlay && measure.clientHeight > 0) {
        if (sWidth == 0) this.overlayHack();
        this.checkedOverlay = true;
      }

      return {right: needsV ? sWidth : 0, bottom: needsH ? sWidth : 0};
    },
    setScrollLeft: function(pos) {
      if (this.horiz.scrollLeft != pos) this.horiz.scrollLeft = pos;
    },
    setScrollTop: function(pos) {
      if (this.vert.scrollTop != pos) this.vert.scrollTop = pos;
    },
    overlayHack: function() {
      var w = mac && !mac_geMountainLion ? "12px" : "18px";
      this.horiz.style.minHeight = this.vert.style.minWidth = w;
      var self = this;
      var barMouseDown = function(e) {
        if (e_target(e) != self.vert && e_target(e) != self.horiz)
          operation(self.cm, onMouseDown)(e);
      };
      on(this.vert, "mousedown", barMouseDown);
      on(this.horiz, "mousedown", barMouseDown);
    },
    clear: function() {
      var parent = this.horiz.parentNode;
      parent.removeChild(this.horiz);
      parent.removeChild(this.vert);
    }
  }, NativeScrollbars.prototype);

  function NullScrollbars() {}

  NullScrollbars.prototype = copyObj({
    update: function() { return {bottom: 0, right: 0}; },
    setScrollLeft: function() {},
    setScrollTop: function() {},
    clear: function() {}
  }, NullScrollbars.prototype);

  CodeMirror.scrollbarModel = {"native": NativeScrollbars, "null": NullScrollbars};

  function initScrollbars(cm) {
    if (cm.display.scrollbars) {
      cm.display.scrollbars.clear();
      if (cm.display.scrollbars.addClass)
        rmClass(cm.display.wrapper, cm.display.scrollbars.addClass);
    }

    cm.display.scrollbars = new CodeMirror.scrollbarModel[cm.options.scrollbarStyle](function(node) {
      cm.display.wrapper.insertBefore(node, cm.display.scrollbarFiller);
      // Prevent clicks in the scrollbars from killing focus
      on(node, "mousedown", function() {
        if (cm.state.focused) setTimeout(function() { cm.display.input.focus(); }, 0);
      });
      node.setAttribute("cm-not-content", "true");
    }, function(pos, axis) {
      if (axis == "horizontal") setScrollLeft(cm, pos);
      else setScrollTop(cm, pos);
    }, cm);
    if (cm.display.scrollbars.addClass)
      addClass(cm.display.wrapper, cm.display.scrollbars.addClass);
  }

  function updateScrollbars(cm, measure) {
    if (!measure) measure = measureForScrollbars(cm);
    var startWidth = cm.display.barWidth, startHeight = cm.display.barHeight;
    updateScrollbarsInner(cm, measure);
    for (var i = 0; i < 4 && startWidth != cm.display.barWidth || startHeight != cm.display.barHeight; i++) {
      if (startWidth != cm.display.barWidth && cm.options.lineWrapping)
        updateHeightsInViewport(cm);
      updateScrollbarsInner(cm, measureForScrollbars(cm));
      startWidth = cm.display.barWidth; startHeight = cm.display.barHeight;
    }
  }

  // Re-synchronize the fake scrollbars with the actual size of the
  // content.
  function updateScrollbarsInner(cm, measure) {
    var d = cm.display;
    var sizes = d.scrollbars.update(measure);

    d.sizer.style.paddingRight = (d.barWidth = sizes.right) + "px";
    d.sizer.style.paddingBottom = (d.barHeight = sizes.bottom) + "px";

    if (sizes.right && sizes.bottom) {
      d.scrollbarFiller.style.display = "block";
      d.scrollbarFiller.style.height = sizes.bottom + "px";
      d.scrollbarFiller.style.width = sizes.right + "px";
    } else d.scrollbarFiller.style.display = "";
    if (sizes.bottom && cm.options.coverGutterNextToScrollbar && cm.options.fixedGutter) {
      d.gutterFiller.style.display = "block";
      d.gutterFiller.style.height = sizes.bottom + "px";
      d.gutterFiller.style.width = measure.gutterWidth + "px";
    } else d.gutterFiller.style.display = "";
  }

  // Compute the lines that are visible in a given viewport (defaults
  // the the current scroll position). viewport may contain top,
  // height, and ensure (see op.scrollToPos) properties.
  function visibleLines(display, doc, viewport) {
    var top = viewport && viewport.top != null ? Math.max(0, viewport.top) : display.scroller.scrollTop;
    top = Math.floor(top - paddingTop(display));
    var bottom = viewport && viewport.bottom != null ? viewport.bottom : top + display.wrapper.clientHeight;

    var from = lineAtHeight(doc, top), to = lineAtHeight(doc, bottom);
    // Ensure is a {from: {line, ch}, to: {line, ch}} object, and
    // forces those lines into the viewport (if possible).
    if (viewport && viewport.ensure) {
      var ensureFrom = viewport.ensure.from.line, ensureTo = viewport.ensure.to.line;
      if (ensureFrom < from) {
        from = ensureFrom;
        to = lineAtHeight(doc, heightAtLine(getLine(doc, ensureFrom)) + display.wrapper.clientHeight);
      } else if (Math.min(ensureTo, doc.lastLine()) >= to) {
        from = lineAtHeight(doc, heightAtLine(getLine(doc, ensureTo)) - display.wrapper.clientHeight);
        to = ensureTo;
      }
    }
    return {from: from, to: Math.max(to, from + 1)};
  }

  // LINE NUMBERS

  // Re-align line numbers and gutter marks to compensate for
  // horizontal scrolling.
  function alignHorizontally(cm) {
    var display = cm.display, view = display.view;
    if (!display.alignWidgets && (!display.gutters.firstChild || !cm.options.fixedGutter)) return;
    var comp = compensateForHScroll(display) - display.scroller.scrollLeft + cm.doc.scrollLeft;
    var gutterW = display.gutters.offsetWidth, left = comp + "px";
    for (var i = 0; i < view.length; i++) if (!view[i].hidden) {
      if (cm.options.fixedGutter && view[i].gutter)
        view[i].gutter.style.left = left;
      var align = view[i].alignable;
      if (align) for (var j = 0; j < align.length; j++)
        align[j].style.left = left;
    }
    if (cm.options.fixedGutter)
      display.gutters.style.left = (comp + gutterW) + "px";
  }

  // Used to ensure that the line number gutter is still the right
  // size for the current document size. Returns true when an update
  // is needed.
  function maybeUpdateLineNumberWidth(cm) {
    if (!cm.options.lineNumbers) return false;
    var doc = cm.doc, last = lineNumberFor(cm.options, doc.first + doc.size - 1), display = cm.display;
    if (last.length != display.lineNumChars) {
      var test = display.measure.appendChild(elt("div", [elt("div", last)],
                                                 "CodeMirror-linenumber CodeMirror-gutter-elt"));
      var innerW = test.firstChild.offsetWidth, padding = test.offsetWidth - innerW;
      display.lineGutter.style.width = "";
      display.lineNumInnerWidth = Math.max(innerW, display.lineGutter.offsetWidth - padding) + 1;
      display.lineNumWidth = display.lineNumInnerWidth + padding;
      display.lineNumChars = display.lineNumInnerWidth ? last.length : -1;
      display.lineGutter.style.width = display.lineNumWidth + "px";
      updateGutterSpace(cm);
      return true;
    }
    return false;
  }

  function lineNumberFor(options, i) {
    return String(options.lineNumberFormatter(i + options.firstLineNumber));
  }

  // Computes display.scroller.scrollLeft + display.gutters.offsetWidth,
  // but using getBoundingClientRect to get a sub-pixel-accurate
  // result.
  function compensateForHScroll(display) {
    return display.scroller.getBoundingClientRect().left - display.sizer.getBoundingClientRect().left;
  }

  // DISPLAY DRAWING

  function DisplayUpdate(cm, viewport, force) {
    var display = cm.display;

    this.viewport = viewport;
    // Store some values that we'll need later (but don't want to force a relayout for)
    this.visible = visibleLines(display, cm.doc, viewport);
    this.editorIsHidden = !display.wrapper.offsetWidth;
    this.wrapperHeight = display.wrapper.clientHeight;
    this.wrapperWidth = display.wrapper.clientWidth;
    this.oldDisplayWidth = displayWidth(cm);
    this.force = force;
    this.dims = getDimensions(cm);
    this.events = [];
  }

  DisplayUpdate.prototype.signal = function(emitter, type) {
    if (hasHandler(emitter, type))
      this.events.push(arguments);
  };
  DisplayUpdate.prototype.finish = function() {
    for (var i = 0; i < this.events.length; i++)
      signal.apply(null, this.events[i]);
  };

  function maybeClipScrollbars(cm) {
    var display = cm.display;
    if (!display.scrollbarsClipped && display.scroller.offsetWidth) {
      display.nativeBarWidth = display.scroller.offsetWidth - display.scroller.clientWidth;
      display.heightForcer.style.height = scrollGap(cm) + "px";
      display.sizer.style.marginBottom = -display.nativeBarWidth + "px";
      display.sizer.style.borderRightWidth = scrollGap(cm) + "px";
      display.scrollbarsClipped = true;
    }
  }

  // Does the actual updating of the line display. Bails out
  // (returning false) when there is nothing to be done and forced is
  // false.
  function updateDisplayIfNeeded(cm, update) {
    var display = cm.display, doc = cm.doc;

    if (update.editorIsHidden) {
      resetView(cm);
      return false;
    }

    // Bail out if the visible area is already rendered and nothing changed.
    if (!update.force &&
        update.visible.from >= display.viewFrom && update.visible.to <= display.viewTo &&
        (display.updateLineNumbers == null || display.updateLineNumbers >= display.viewTo) &&
        display.renderedView == display.view && countDirtyView(cm) == 0)
      return false;

    if (maybeUpdateLineNumberWidth(cm)) {
      resetView(cm);
      update.dims = getDimensions(cm);
    }

    // Compute a suitable new viewport (from & to)
    var end = doc.first + doc.size;
    var from = Math.max(update.visible.from - cm.options.viewportMargin, doc.first);
    var to = Math.min(end, update.visible.to + cm.options.viewportMargin);
    if (display.viewFrom < from && from - display.viewFrom < 20) from = Math.max(doc.first, display.viewFrom);
    if (display.viewTo > to && display.viewTo - to < 20) to = Math.min(end, display.viewTo);
    if (sawCollapsedSpans) {
      from = visualLineNo(cm.doc, from);
      to = visualLineEndNo(cm.doc, to);
    }

    var different = from != display.viewFrom || to != display.viewTo ||
      display.lastWrapHeight != update.wrapperHeight || display.lastWrapWidth != update.wrapperWidth;
    adjustView(cm, from, to);

    display.viewOffset = heightAtLine(getLine(cm.doc, display.viewFrom));
    // Position the mover div to align with the current scroll position
    cm.display.mover.style.top = display.viewOffset + "px";

    var toUpdate = countDirtyView(cm);
    if (!different && toUpdate == 0 && !update.force && display.renderedView == display.view &&
        (display.updateLineNumbers == null || display.updateLineNumbers >= display.viewTo))
      return false;

    // For big changes, we hide the enclosing element during the
    // update, since that speeds up the operations on most browsers.
    var focused = activeElt();
    if (toUpdate > 4) display.lineDiv.style.display = "none";
    patchDisplay(cm, display.updateLineNumbers, update.dims);
    if (toUpdate > 4) display.lineDiv.style.display = "";
    display.renderedView = display.view;
    // There might have been a widget with a focused element that got
    // hidden or updated, if so re-focus it.
    if (focused && activeElt() != focused && focused.offsetHeight) focused.focus();

    // Prevent selection and cursors from interfering with the scroll
    // width and height.
    removeChildren(display.cursorDiv);
    removeChildren(display.selectionDiv);
    display.gutters.style.height = display.sizer.style.minHeight = 0;

    if (different) {
      display.lastWrapHeight = update.wrapperHeight;
      display.lastWrapWidth = update.wrapperWidth;
      startWorker(cm, 400);
    }

    display.updateLineNumbers = null;

    return true;
  }

  function postUpdateDisplay(cm, update) {
    var viewport = update.viewport;
    for (var first = true;; first = false) {
      if (!first || !cm.options.lineWrapping || update.oldDisplayWidth == displayWidth(cm)) {
        // Clip forced viewport to actual scrollable area.
        if (viewport && viewport.top != null)
          viewport = {top: Math.min(cm.doc.height + paddingVert(cm.display) - displayHeight(cm), viewport.top)};
        // Updated line heights might result in the drawn area not
        // actually covering the viewport. Keep looping until it does.
        update.visible = visibleLines(cm.display, cm.doc, viewport);
        if (update.visible.from >= cm.display.viewFrom && update.visible.to <= cm.display.viewTo)
          break;
      }
      if (!updateDisplayIfNeeded(cm, update)) break;
      updateHeightsInViewport(cm);
      var barMeasure = measureForScrollbars(cm);
      updateSelection(cm);
      setDocumentHeight(cm, barMeasure);
      updateScrollbars(cm, barMeasure);
    }

    update.signal(cm, "update", cm);
    if (cm.display.viewFrom != cm.display.reportedViewFrom || cm.display.viewTo != cm.display.reportedViewTo) {
      update.signal(cm, "viewportChange", cm, cm.display.viewFrom, cm.display.viewTo);
      cm.display.reportedViewFrom = cm.display.viewFrom; cm.display.reportedViewTo = cm.display.viewTo;
    }
  }

  function updateDisplaySimple(cm, viewport) {
    var update = new DisplayUpdate(cm, viewport);
    if (updateDisplayIfNeeded(cm, update)) {
      updateHeightsInViewport(cm);
      postUpdateDisplay(cm, update);
      var barMeasure = measureForScrollbars(cm);
      updateSelection(cm);
      setDocumentHeight(cm, barMeasure);
      updateScrollbars(cm, barMeasure);
      update.finish();
    }
  }

  function setDocumentHeight(cm, measure) {
    cm.display.sizer.style.minHeight = measure.docHeight + "px";
    var total = measure.docHeight + cm.display.barHeight;
    cm.display.heightForcer.style.top = total + "px";
    cm.display.gutters.style.height = Math.max(total + scrollGap(cm), measure.clientHeight) + "px";
  }

  // Read the actual heights of the rendered lines, and update their
  // stored heights to match.
  function updateHeightsInViewport(cm) {
    var display = cm.display;
    var prevBottom = display.lineDiv.offsetTop;
    for (var i = 0; i < display.view.length; i++) {
      var cur = display.view[i], height;
      if (cur.hidden) continue;
      if (ie && ie_version < 8) {
        var bot = cur.node.offsetTop + cur.node.offsetHeight;
        height = bot - prevBottom;
        prevBottom = bot;
      } else {
        var box = cur.node.getBoundingClientRect();
        height = box.bottom - box.top;
      }
      var diff = cur.line.height - height;
      if (height < 2) height = textHeight(display);
      if (diff > .001 || diff < -.001) {
        updateLineHeight(cur.line, height);
        updateWidgetHeight(cur.line);
        if (cur.rest) for (var j = 0; j < cur.rest.length; j++)
          updateWidgetHeight(cur.rest[j]);
      }
    }
  }

  // Read and store the height of line widgets associated with the
  // given line.
  function updateWidgetHeight(line) {
    if (line.widgets) for (var i = 0; i < line.widgets.length; ++i)
      line.widgets[i].height = line.widgets[i].node.offsetHeight;
  }

  // Do a bulk-read of the DOM positions and sizes needed to draw the
  // view, so that we don't interleave reading and writing to the DOM.
  function getDimensions(cm) {
    var d = cm.display, left = {}, width = {};
    var gutterLeft = d.gutters.clientLeft;
    for (var n = d.gutters.firstChild, i = 0; n; n = n.nextSibling, ++i) {
      left[cm.options.gutters[i]] = n.offsetLeft + n.clientLeft + gutterLeft;
      width[cm.options.gutters[i]] = n.clientWidth;
    }
    return {fixedPos: compensateForHScroll(d),
            gutterTotalWidth: d.gutters.offsetWidth,
            gutterLeft: left,
            gutterWidth: width,
            wrapperWidth: d.wrapper.clientWidth};
  }

  // Sync the actual display DOM structure with display.view, removing
  // nodes for lines that are no longer in view, and creating the ones
  // that are not there yet, and updating the ones that are out of
  // date.
  function patchDisplay(cm, updateNumbersFrom, dims) {
    var display = cm.display, lineNumbers = cm.options.lineNumbers;
    var container = display.lineDiv, cur = container.firstChild;

    function rm(node) {
      var next = node.nextSibling;
      // Works around a throw-scroll bug in OS X Webkit
      if (webkit && mac && cm.display.currentWheelTarget == node)
        node.style.display = "none";
      else
        node.parentNode.removeChild(node);
      return next;
    }

    var view = display.view, lineN = display.viewFrom;
    // Loop over the elements in the view, syncing cur (the DOM nodes
    // in display.lineDiv) with the view as we go.
    for (var i = 0; i < view.length; i++) {
      var lineView = view[i];
      if (lineView.hidden) {
      } else if (!lineView.node || lineView.node.parentNode != container) { // Not drawn yet
        var node = buildLineElement(cm, lineView, lineN, dims);
        container.insertBefore(node, cur);
      } else { // Already drawn
        while (cur != lineView.node) cur = rm(cur);
        var updateNumber = lineNumbers && updateNumbersFrom != null &&
          updateNumbersFrom <= lineN && lineView.lineNumber;
        if (lineView.changes) {
          if (indexOf(lineView.changes, "gutter") > -1) updateNumber = false;
          updateLineForChanges(cm, lineView, lineN, dims);
        }
        if (updateNumber) {
          removeChildren(lineView.lineNumber);
          lineView.lineNumber.appendChild(document.createTextNode(lineNumberFor(cm.options, lineN)));
        }
        cur = lineView.node.nextSibling;
      }
      lineN += lineView.size;
    }
    while (cur) cur = rm(cur);
  }

  // When an aspect of a line changes, a string is added to
  // lineView.changes. This updates the relevant part of the line's
  // DOM structure.
  function updateLineForChanges(cm, lineView, lineN, dims) {
    for (var j = 0; j < lineView.changes.length; j++) {
      var type = lineView.changes[j];
      if (type == "text") updateLineText(cm, lineView);
      else if (type == "gutter") updateLineGutter(cm, lineView, lineN, dims);
      else if (type == "class") updateLineClasses(lineView);
      else if (type == "widget") updateLineWidgets(cm, lineView, dims);
    }
    lineView.changes = null;
  }

  // Lines with gutter elements, widgets or a background class need to
  // be wrapped, and have the extra elements added to the wrapper div
  function ensureLineWrapped(lineView) {
    if (lineView.node == lineView.text) {
      lineView.node = elt("div", null, null, "position: relative");
      if (lineView.text.parentNode)
        lineView.text.parentNode.replaceChild(lineView.node, lineView.text);
      lineView.node.appendChild(lineView.text);
      if (ie && ie_version < 8) lineView.node.style.zIndex = 2;
    }
    return lineView.node;
  }

  function updateLineBackground(lineView) {
    var cls = lineView.bgClass ? lineView.bgClass + " " + (lineView.line.bgClass || "") : lineView.line.bgClass;
    if (cls) cls += " CodeMirror-linebackground";
    if (lineView.background) {
      if (cls) lineView.background.className = cls;
      else { lineView.background.parentNode.removeChild(lineView.background); lineView.background = null; }
    } else if (cls) {
      var wrap = ensureLineWrapped(lineView);
      lineView.background = wrap.insertBefore(elt("div", null, cls), wrap.firstChild);
    }
  }

  // Wrapper around buildLineContent which will reuse the structure
  // in display.externalMeasured when possible.
  function getLineContent(cm, lineView) {
    var ext = cm.display.externalMeasured;
    if (ext && ext.line == lineView.line) {
      cm.display.externalMeasured = null;
      lineView.measure = ext.measure;
      return ext.built;
    }
    return buildLineContent(cm, lineView);
  }

  // Redraw the line's text. Interacts with the background and text
  // classes because the mode may output tokens that influence these
  // classes.
  function updateLineText(cm, lineView) {
    var cls = lineView.text.className;
    var built = getLineContent(cm, lineView);
    if (lineView.text == lineView.node) lineView.node = built.pre;
    lineView.text.parentNode.replaceChild(built.pre, lineView.text);
    lineView.text = built.pre;
    if (built.bgClass != lineView.bgClass || built.textClass != lineView.textClass) {
      lineView.bgClass = built.bgClass;
      lineView.textClass = built.textClass;
      updateLineClasses(lineView);
    } else if (cls) {
      lineView.text.className = cls;
    }
  }

  function updateLineClasses(lineView) {
    updateLineBackground(lineView);
    if (lineView.line.wrapClass)
      ensureLineWrapped(lineView).className = lineView.line.wrapClass;
    else if (lineView.node != lineView.text)
      lineView.node.className = "";
    var textClass = lineView.textClass ? lineView.textClass + " " + (lineView.line.textClass || "") : lineView.line.textClass;
    lineView.text.className = textClass || "";
  }

  function updateLineGutter(cm, lineView, lineN, dims) {
    if (lineView.gutter) {
      lineView.node.removeChild(lineView.gutter);
      lineView.gutter = null;
    }
    if (lineView.gutterBackground) {
      lineView.node.removeChild(lineView.gutterBackground);
      lineView.gutterBackground = null;
    }
    if (lineView.line.gutterClass) {
      var wrap = ensureLineWrapped(lineView);
      lineView.gutterBackground = elt("div", null, "CodeMirror-gutter-background " + lineView.line.gutterClass,
                                      "left: " + (cm.options.fixedGutter ? dims.fixedPos : -dims.gutterTotalWidth) +
                                      "px; width: " + dims.gutterTotalWidth + "px");
      wrap.insertBefore(lineView.gutterBackground, lineView.text);
    }
    var markers = lineView.line.gutterMarkers;
    if (cm.options.lineNumbers || markers) {
      var wrap = ensureLineWrapped(lineView);
      var gutterWrap = lineView.gutter = elt("div", null, "CodeMirror-gutter-wrapper", "left: " +
                                             (cm.options.fixedGutter ? dims.fixedPos : -dims.gutterTotalWidth) + "px");
      cm.display.input.setUneditable(gutterWrap);
      wrap.insertBefore(gutterWrap, lineView.text);
      if (lineView.line.gutterClass)
        gutterWrap.className += " " + lineView.line.gutterClass;
      if (cm.options.lineNumbers && (!markers || !markers["CodeMirror-linenumbers"]))
        lineView.lineNumber = gutterWrap.appendChild(
          elt("div", lineNumberFor(cm.options, lineN),
              "CodeMirror-linenumber CodeMirror-gutter-elt",
              "left: " + dims.gutterLeft["CodeMirror-linenumbers"] + "px; width: "
              + cm.display.lineNumInnerWidth + "px"));
      if (markers) for (var k = 0; k < cm.options.gutters.length; ++k) {
        var id = cm.options.gutters[k], found = markers.hasOwnProperty(id) && markers[id];
        if (found)
          gutterWrap.appendChild(elt("div", [found], "CodeMirror-gutter-elt", "left: " +
                                     dims.gutterLeft[id] + "px; width: " + dims.gutterWidth[id] + "px"));
      }
    }
  }

  function updateLineWidgets(cm, lineView, dims) {
    if (lineView.alignable) lineView.alignable = null;
    for (var node = lineView.node.firstChild, next; node; node = next) {
      var next = node.nextSibling;
      if (node.className == "CodeMirror-linewidget")
        lineView.node.removeChild(node);
    }
    insertLineWidgets(cm, lineView, dims);
  }

  // Build a line's DOM representation from scratch
  function buildLineElement(cm, lineView, lineN, dims) {
    var built = getLineContent(cm, lineView);
    lineView.text = lineView.node = built.pre;
    if (built.bgClass) lineView.bgClass = built.bgClass;
    if (built.textClass) lineView.textClass = built.textClass;

    updateLineClasses(lineView);
    updateLineGutter(cm, lineView, lineN, dims);
    insertLineWidgets(cm, lineView, dims);
    return lineView.node;
  }

  // A lineView may contain multiple logical lines (when merged by
  // collapsed spans). The widgets for all of them need to be drawn.
  function insertLineWidgets(cm, lineView, dims) {
    insertLineWidgetsFor(cm, lineView.line, lineView, dims, true);
    if (lineView.rest) for (var i = 0; i < lineView.rest.length; i++)
      insertLineWidgetsFor(cm, lineView.rest[i], lineView, dims, false);
  }

  function insertLineWidgetsFor(cm, line, lineView, dims, allowAbove) {
    if (!line.widgets) return;
    var wrap = ensureLineWrapped(lineView);
    for (var i = 0, ws = line.widgets; i < ws.length; ++i) {
      var widget = ws[i], node = elt("div", [widget.node], "CodeMirror-linewidget");
      if (!widget.handleMouseEvents) node.setAttribute("cm-ignore-events", "true");
      positionLineWidget(widget, node, lineView, dims);
      cm.display.input.setUneditable(node);
      if (allowAbove && widget.above)
        wrap.insertBefore(node, lineView.gutter || lineView.text);
      else
        wrap.appendChild(node);
      signalLater(widget, "redraw");
    }
  }

  function positionLineWidget(widget, node, lineView, dims) {
    if (widget.noHScroll) {
      (lineView.alignable || (lineView.alignable = [])).push(node);
      var width = dims.wrapperWidth;
      node.style.left = dims.fixedPos + "px";
      if (!widget.coverGutter) {
        width -= dims.gutterTotalWidth;
        node.style.paddingLeft = dims.gutterTotalWidth + "px";
      }
      node.style.width = width + "px";
    }
    if (widget.coverGutter) {
      node.style.zIndex = 5;
      node.style.position = "relative";
      if (!widget.noHScroll) node.style.marginLeft = -dims.gutterTotalWidth + "px";
    }
  }

  // POSITION OBJECT

  // A Pos instance represents a position within the text.
  var Pos = CodeMirror.Pos = function(line, ch) {
    if (!(this instanceof Pos)) return new Pos(line, ch);
    this.line = line; this.ch = ch;
  };

  // Compare two positions, return 0 if they are the same, a negative
  // number when a is less, and a positive number otherwise.
  var cmp = CodeMirror.cmpPos = function(a, b) { return a.line - b.line || a.ch - b.ch; };

  function copyPos(x) {return Pos(x.line, x.ch);}
  function maxPos(a, b) { return cmp(a, b) < 0 ? b : a; }
  function minPos(a, b) { return cmp(a, b) < 0 ? a : b; }

  // INPUT HANDLING

  function ensureFocus(cm) {
    if (!cm.state.focused) { cm.display.input.focus(); onFocus(cm); }
  }

  function isReadOnly(cm) {
    return cm.options.readOnly || cm.doc.cantEdit;
  }

  // This will be set to an array of strings when copying, so that,
  // when pasting, we know what kind of selections the copied text
  // was made out of.
  var lastCopied = null;

  function applyTextInput(cm, inserted, deleted, sel, origin) {
    var doc = cm.doc;
    cm.display.shift = false;
    if (!sel) sel = doc.sel;

    var paste = cm.state.pasteIncoming || origin == "paste";
    var textLines = doc.splitLines(inserted), multiPaste = null;
    // When pasing N lines into N selections, insert one line per selection
    if (paste && sel.ranges.length > 1) {
      if (lastCopied && lastCopied.join("\n") == inserted) {
        if (sel.ranges.length % lastCopied.length == 0) {
          multiPaste = [];
          for (var i = 0; i < lastCopied.length; i++)
            multiPaste.push(doc.splitLines(lastCopied[i]));
        }
      } else if (textLines.length == sel.ranges.length) {
        multiPaste = map(textLines, function(l) { return [l]; });
      }
    }

    // Normal behavior is to insert the new text into every selection
    for (var i = sel.ranges.length - 1; i >= 0; i--) {
      var range = sel.ranges[i];
      var from = range.from(), to = range.to();
      if (range.empty()) {
        if (deleted && deleted > 0) // Handle deletion
          from = Pos(from.line, from.ch - deleted);
        else if (cm.state.overwrite && !paste) // Handle overwrite
          to = Pos(to.line, Math.min(getLine(doc, to.line).text.length, to.ch + lst(textLines).length));
      }
      var updateInput = cm.curOp.updateInput;
      var changeEvent = {from: from, to: to, text: multiPaste ? multiPaste[i % multiPaste.length] : textLines,
                         origin: origin || (paste ? "paste" : cm.state.cutIncoming ? "cut" : "+input")};
      makeChange(cm.doc, changeEvent);
      signalLater(cm, "inputRead", cm, changeEvent);
    }
    if (inserted && !paste)
      triggerElectric(cm, inserted);

    ensureCursorVisible(cm);
    cm.curOp.updateInput = updateInput;
    cm.curOp.typing = true;
    cm.state.pasteIncoming = cm.state.cutIncoming = false;
  }

  function handlePaste(e, cm) {
    var pasted = e.clipboardData && e.clipboardData.getData("text/plain");
    if (pasted) {
      e.preventDefault();
      if (!isReadOnly(cm) && !cm.options.disableInput)
        runInOp(cm, function() { applyTextInput(cm, pasted, 0, null, "paste"); });
      return true;
    }
  }

  function triggerElectric(cm, inserted) {
    // When an 'electric' character is inserted, immediately trigger a reindent
    if (!cm.options.electricChars || !cm.options.smartIndent) return;
    var sel = cm.doc.sel;

    for (var i = sel.ranges.length - 1; i >= 0; i--) {
      var range = sel.ranges[i];
      if (range.head.ch > 100 || (i && sel.ranges[i - 1].head.line == range.head.line)) continue;
      var mode = cm.getModeAt(range.head);
      var indented = false;
      if (mode.electricChars) {
        for (var j = 0; j < mode.electricChars.length; j++)
          if (inserted.indexOf(mode.electricChars.charAt(j)) > -1) {
            indented = indentLine(cm, range.head.line, "smart");
            break;
          }
      } else if (mode.electricInput) {
        if (mode.electricInput.test(getLine(cm.doc, range.head.line).text.slice(0, range.head.ch)))
          indented = indentLine(cm, range.head.line, "smart");
      }
      if (indented) signalLater(cm, "electricInput", cm, range.head.line);
    }
  }

  function copyableRanges(cm) {
    var text = [], ranges = [];
    for (var i = 0; i < cm.doc.sel.ranges.length; i++) {
      var line = cm.doc.sel.ranges[i].head.line;
      var lineRange = {anchor: Pos(line, 0), head: Pos(line + 1, 0)};
      ranges.push(lineRange);
      text.push(cm.getRange(lineRange.anchor, lineRange.head));
    }
    return {text: text, ranges: ranges};
  }

  function disableBrowserMagic(field) {
    field.setAttribute("autocorrect", "off");
    field.setAttribute("autocapitalize", "off");
    field.setAttribute("spellcheck", "false");
  }

  // TEXTAREA INPUT STYLE

  function TextareaInput(cm) {
    this.cm = cm;
    // See input.poll and input.reset
    this.prevInput = "";

    // Flag that indicates whether we expect input to appear real soon
    // now (after some event like 'keypress' or 'input') and are
    // polling intensively.
    this.pollingFast = false;
    // Self-resetting timeout for the poller
    this.polling = new Delayed();
    // Tracks when input.reset has punted to just putting a short
    // string into the textarea instead of the full selection.
    this.inaccurateSelection = false;
    // Used to work around IE issue with selection being forgotten when focus moves away from textarea
    this.hasSelection = false;
    this.composing = null;
  };

  function hiddenTextarea() {
    var te = elt("textarea", null, null, "position: absolute; padding: 0; width: 1px; height: 1em; outline: none");
    var div = elt("div", [te], null, "overflow: hidden; position: relative; width: 3px; height: 0px;");
    // The textarea is kept positioned near the cursor to prevent the
    // fact that it'll be scrolled into view on input from scrolling
    // our fake cursor out of view. On webkit, when wrap=off, paste is
    // very slow. So make the area wide instead.
    if (webkit) te.style.width = "1000px";
    else te.setAttribute("wrap", "off");
    // If border: 0; -- iOS fails to open keyboard (issue #1287)
    if (ios) te.style.border = "1px solid black";
    disableBrowserMagic(te);
    return div;
  }

  TextareaInput.prototype = copyObj({
    init: function(display) {
      var input = this, cm = this.cm;

      // Wraps and hides input textarea
      var div = this.wrapper = hiddenTextarea();
      // The semihidden textarea that is focused when the editor is
      // focused, and receives input.
      var te = this.textarea = div.firstChild;
      display.wrapper.insertBefore(div, display.wrapper.firstChild);

      // Needed to hide big blue blinking cursor on Mobile Safari (doesn't seem to work in iOS 8 anymore)
      if (ios) te.style.width = "0px";

      on(te, "input", function() {
        if (ie && ie_version >= 9 && input.hasSelection) input.hasSelection = null;
        input.poll();
      });

      on(te, "paste", function(e) {
        if (handlePaste(e, cm)) return true;

        cm.state.pasteIncoming = true;
        input.fastPoll();
      });

      function prepareCopyCut(e) {
        if (cm.somethingSelected()) {
          lastCopied = cm.getSelections();
          if (input.inaccurateSelection) {
            input.prevInput = "";
            input.inaccurateSelection = false;
            te.value = lastCopied.join("\n");
            selectInput(te);
          }
        } else if (!cm.options.lineWiseCopyCut) {
          return;
        } else {
          var ranges = copyableRanges(cm);
          lastCopied = ranges.text;
          if (e.type == "cut") {
            cm.setSelections(ranges.ranges, null, sel_dontScroll);
          } else {
            input.prevInput = "";
            te.value = ranges.text.join("\n");
            selectInput(te);
          }
        }
        if (e.type == "cut") cm.state.cutIncoming = true;
      }
      on(te, "cut", prepareCopyCut);
      on(te, "copy", prepareCopyCut);

      on(display.scroller, "paste", function(e) {
        if (eventInWidget(display, e)) return;
        cm.state.pasteIncoming = true;
        input.focus();
      });

      // Prevent normal selection in the editor (we handle our own)
      on(display.lineSpace, "selectstart", function(e) {
        if (!eventInWidget(display, e)) e_preventDefault(e);
      });

      on(te, "compositionstart", function() {
        var start = cm.getCursor("from");
        if (input.composing) input.composing.range.clear()
        input.composing = {
          start: start,
          range: cm.markText(start, cm.getCursor("to"), {className: "CodeMirror-composing"})
        };
      });
      on(te, "compositionend", function() {
        if (input.composing) {
          input.poll();
          input.composing.range.clear();
          input.composing = null;
        }
      });
    },

    prepareSelection: function() {
      // Redraw the selection and/or cursor
      var cm = this.cm, display = cm.display, doc = cm.doc;
      var result = prepareSelection(cm);

      // Move the hidden textarea near the cursor to prevent scrolling artifacts
      if (cm.options.moveInputWithCursor) {
        var headPos = cursorCoords(cm, doc.sel.primary().head, "div");
        var wrapOff = display.wrapper.getBoundingClientRect(), lineOff = display.lineDiv.getBoundingClientRect();
        result.teTop = Math.max(0, Math.min(display.wrapper.clientHeight - 10,
                                            headPos.top + lineOff.top - wrapOff.top));
        result.teLeft = Math.max(0, Math.min(display.wrapper.clientWidth - 10,
                                             headPos.left + lineOff.left - wrapOff.left));
      }

      return result;
    },

    showSelection: function(drawn) {
      var cm = this.cm, display = cm.display;
      removeChildrenAndAdd(display.cursorDiv, drawn.cursors);
      removeChildrenAndAdd(display.selectionDiv, drawn.selection);
      if (drawn.teTop != null) {
        this.wrapper.style.top = drawn.teTop + "px";
        this.wrapper.style.left = drawn.teLeft + "px";
      }
    },

    // Reset the input to correspond to the selection (or to be empty,
    // when not typing and nothing is selected)
    reset: function(typing) {
      if (this.contextMenuPending) return;
      var minimal, selected, cm = this.cm, doc = cm.doc;
      if (cm.somethingSelected()) {
        this.prevInput = "";
        var range = doc.sel.primary();
        minimal = hasCopyEvent &&
          (range.to().line - range.from().line > 100 || (selected = cm.getSelection()).length > 1000);
        var content = minimal ? "-" : selected || cm.getSelection();
        this.textarea.value = content;
        if (cm.state.focused) selectInput(this.textarea);
        if (ie && ie_version >= 9) this.hasSelection = content;
      } else if (!typing) {
        this.prevInput = this.textarea.value = "";
        if (ie && ie_version >= 9) this.hasSelection = null;
      }
      this.inaccurateSelection = minimal;
    },

    getField: function() { return this.textarea; },

    supportsTouch: function() { return false; },

    focus: function() {
      if (this.cm.options.readOnly != "nocursor" && (!mobile || activeElt() != this.textarea)) {
        try { this.textarea.focus(); }
        catch (e) {} // IE8 will throw if the textarea is display: none or not in DOM
      }
    },

    blur: function() { this.textarea.blur(); },

    resetPosition: function() {
      this.wrapper.style.top = this.wrapper.style.left = 0;
    },

    receivedFocus: function() { this.slowPoll(); },

    // Poll for input changes, using the normal rate of polling. This
    // runs as long as the editor is focused.
    slowPoll: function() {
      var input = this;
      if (input.pollingFast) return;
      input.polling.set(this.cm.options.pollInterval, function() {
        input.poll();
        if (input.cm.state.focused) input.slowPoll();
      });
    },

    // When an event has just come in that is likely to add or change
    // something in the input textarea, we poll faster, to ensure that
    // the change appears on the screen quickly.
    fastPoll: function() {
      var missed = false, input = this;
      input.pollingFast = true;
      function p() {
        var changed = input.poll();
        if (!changed && !missed) {missed = true; input.polling.set(60, p);}
        else {input.pollingFast = false; input.slowPoll();}
      }
      input.polling.set(20, p);
    },

    // Read input from the textarea, and update the document to match.
    // When something is selected, it is present in the textarea, and
    // selected (unless it is huge, in which case a placeholder is
    // used). When nothing is selected, the cursor sits after previously
    // seen text (can be empty), which is stored in prevInput (we must
    // not reset the textarea when typing, because that breaks IME).
    poll: function() {
      var cm = this.cm, input = this.textarea, prevInput = this.prevInput;
      // Since this is called a *lot*, try to bail out as cheaply as
      // possible when it is clear that nothing happened. hasSelection
      // will be the case when there is a lot of text in the textarea,
      // in which case reading its value would be expensive.
      if (this.contextMenuPending || !cm.state.focused ||
          (hasSelection(input) && !prevInput && !this.composing) ||
          isReadOnly(cm) || cm.options.disableInput || cm.state.keySeq)
        return false;

      var text = input.value;
      // If nothing changed, bail.
      if (text == prevInput && !cm.somethingSelected()) return false;
      // Work around nonsensical selection resetting in IE9/10, and
      // inexplicable appearance of private area unicode characters on
      // some key combos in Mac (#2689).
      if (ie && ie_version >= 9 && this.hasSelection === text ||
          mac && /[\uf700-\uf7ff]/.test(text)) {
        cm.display.input.reset();
        return false;
      }

      if (cm.doc.sel == cm.display.selForContextMenu) {
        var first = text.charCodeAt(0);
        if (first == 0x200b && !prevInput) prevInput = "\u200b";
        if (first == 0x21da) { this.reset(); return this.cm.execCommand("undo"); }
      }
      // Find the part of the input that is actually new
      var same = 0, l = Math.min(prevInput.length, text.length);
      while (same < l && prevInput.charCodeAt(same) == text.charCodeAt(same)) ++same;

      var self = this;
      runInOp(cm, function() {
        applyTextInput(cm, text.slice(same), prevInput.length - same,
                       null, self.composing ? "*compose" : null);

        // Don't leave long text in the textarea, since it makes further polling slow
        if (text.length > 1000 || text.indexOf("\n") > -1) input.value = self.prevInput = "";
        else self.prevInput = text;

        if (self.composing) {
          self.composing.range.clear();
          self.composing.range = cm.markText(self.composing.start, cm.getCursor("to"),
                                             {className: "CodeMirror-composing"});
        }
      });
      return true;
    },

    ensurePolled: function() {
      if (this.pollingFast && this.poll()) this.pollingFast = false;
    },

    onKeyPress: function() {
      if (ie && ie_version >= 9) this.hasSelection = null;
      this.fastPoll();
    },

    onContextMenu: function(e) {
      var input = this, cm = input.cm, display = cm.display, te = input.textarea;
      var pos = posFromMouse(cm, e), scrollPos = display.scroller.scrollTop;
      if (!pos || presto) return; // Opera is difficult.

      // Reset the current text selection only if the click is done outside of the selection
      // and 'resetSelectionOnContextMenu' option is true.
      var reset = cm.options.resetSelectionOnContextMenu;
      if (reset && cm.doc.sel.contains(pos) == -1)
        operation(cm, setSelection)(cm.doc, simpleSelection(pos), sel_dontScroll);

      var oldCSS = te.style.cssText;
      input.wrapper.style.position = "absolute";
      te.style.cssText = "position: fixed; width: 30px; height: 30px; top: " + (e.clientY - 5) +
        "px; left: " + (e.clientX - 5) + "px; z-index: 1000; background: " +
        (ie ? "rgba(255, 255, 255, .05)" : "transparent") +
        "; outline: none; border-width: 0; outline: none; overflow: hidden; opacity: .05; filter: alpha(opacity=5);";
      if (webkit) var oldScrollY = window.scrollY; // Work around Chrome issue (#2712)
      display.input.focus();
      if (webkit) window.scrollTo(null, oldScrollY);
      display.input.reset();
      // Adds "Select all" to context menu in FF
      if (!cm.somethingSelected()) te.value = input.prevInput = " ";
      input.contextMenuPending = true;
      display.selForContextMenu = cm.doc.sel;
      clearTimeout(display.detectingSelectAll);

      // Select-all will be greyed out if there's nothing to select, so
      // this adds a zero-width space so that we can later check whether
      // it got selected.
      function prepareSelectAllHack() {
        if (te.selectionStart != null) {
          var selected = cm.somethingSelected();
          var extval = "\u200b" + (selected ? te.value : "");
          te.value = "\u21da"; // Used to catch context-menu undo
          te.value = extval;
          input.prevInput = selected ? "" : "\u200b";
          te.selectionStart = 1; te.selectionEnd = extval.length;
          // Re-set this, in case some other handler touched the
          // selection in the meantime.
          display.selForContextMenu = cm.doc.sel;
        }
      }
      function rehide() {
        input.contextMenuPending = false;
        input.wrapper.style.position = "relative";
        te.style.cssText = oldCSS;
        if (ie && ie_version < 9) display.scrollbars.setScrollTop(display.scroller.scrollTop = scrollPos);

        // Try to detect the user choosing select-all
        if (te.selectionStart != null) {
          if (!ie || (ie && ie_version < 9)) prepareSelectAllHack();
          var i = 0, poll = function() {
            if (display.selForContextMenu == cm.doc.sel && te.selectionStart == 0 &&
                te.selectionEnd > 0 && input.prevInput == "\u200b")
              operation(cm, commands.selectAll)(cm);
            else if (i++ < 10) display.detectingSelectAll = setTimeout(poll, 500);
            else display.input.reset();
          };
          display.detectingSelectAll = setTimeout(poll, 200);
        }
      }

      if (ie && ie_version >= 9) prepareSelectAllHack();
      if (captureRightClick) {
        e_stop(e);
        var mouseup = function() {
          off(window, "mouseup", mouseup);
          setTimeout(rehide, 20);
        };
        on(window, "mouseup", mouseup);
      } else {
        setTimeout(rehide, 50);
      }
    },

    readOnlyChanged: function(val) {
      if (!val) this.reset();
    },

    setUneditable: nothing,

    needsContentAttribute: false
  }, TextareaInput.prototype);

  // CONTENTEDITABLE INPUT STYLE

  function ContentEditableInput(cm) {
    this.cm = cm;
    this.lastAnchorNode = this.lastAnchorOffset = this.lastFocusNode = this.lastFocusOffset = null;
    this.polling = new Delayed();
    this.gracePeriod = false;
  }

  ContentEditableInput.prototype = copyObj({
    init: function(display) {
      var input = this, cm = input.cm;
      var div = input.div = display.lineDiv;
      disableBrowserMagic(div);

      on(div, "paste", function(e) { handlePaste(e, cm); })

      on(div, "compositionstart", function(e) {
        var data = e.data;
        input.composing = {sel: cm.doc.sel, data: data, startData: data};
        if (!data) return;
        var prim = cm.doc.sel.primary();
        var line = cm.getLine(prim.head.line);
        var found = line.indexOf(data, Math.max(0, prim.head.ch - data.length));
        if (found > -1 && found <= prim.head.ch)
          input.composing.sel = simpleSelection(Pos(prim.head.line, found),
                                                Pos(prim.head.line, found + data.length));
      });
      on(div, "compositionupdate", function(e) {
        input.composing.data = e.data;
      });
      on(div, "compositionend", function(e) {
        var ours = input.composing;
        if (!ours) return;
        if (e.data != ours.startData && !/\u200b/.test(e.data))
          ours.data = e.data;
        // Need a small delay to prevent other code (input event,
        // selection polling) from doing damage when fired right after
        // compositionend.
        setTimeout(function() {
          if (!ours.handled)
            input.applyComposition(ours);
          if (input.composing == ours)
            input.composing = null;
        }, 50);
      });

      on(div, "touchstart", function() {
        input.forceCompositionEnd();
      });

      on(div, "input", function() {
        if (input.composing) return;
        if (isReadOnly(cm) || !input.pollContent())
          runInOp(input.cm, function() {regChange(cm);});
      });

      function onCopyCut(e) {
        if (cm.somethingSelected()) {
          lastCopied = cm.getSelections();
          if (e.type == "cut") cm.replaceSelection("", null, "cut");
        } else if (!cm.options.lineWiseCopyCut) {
          return;
        } else {
          var ranges = copyableRanges(cm);
          lastCopied = ranges.text;
          if (e.type == "cut") {
            cm.operation(function() {
              cm.setSelections(ranges.ranges, 0, sel_dontScroll);
              cm.replaceSelection("", null, "cut");
            });
          }
        }
        // iOS exposes the clipboard API, but seems to discard content inserted into it
        if (e.clipboardData && !ios) {
          e.preventDefault();
          e.clipboardData.clearData();
          e.clipboardData.setData("text/plain", lastCopied.join("\n"));
        } else {
          // Old-fashioned briefly-focus-a-textarea hack
          var kludge = hiddenTextarea(), te = kludge.firstChild;
          cm.display.lineSpace.insertBefore(kludge, cm.display.lineSpace.firstChild);
          te.value = lastCopied.join("\n");
          var hadFocus = document.activeElement;
          selectInput(te);
          setTimeout(function() {
            cm.display.lineSpace.removeChild(kludge);
            hadFocus.focus();
          }, 50);
        }
      }
      on(div, "copy", onCopyCut);
      on(div, "cut", onCopyCut);
    },

    prepareSelection: function() {
      var result = prepareSelection(this.cm, false);
      result.focus = this.cm.state.focused;
      return result;
    },

    showSelection: function(info) {
      if (!info || !this.cm.display.view.length) return;
      if (info.focus) this.showPrimarySelection();
      this.showMultipleSelections(info);
    },

    showPrimarySelection: function() {
      var sel = window.getSelection(), prim = this.cm.doc.sel.primary();
      var curAnchor = domToPos(this.cm, sel.anchorNode, sel.anchorOffset);
      var curFocus = domToPos(this.cm, sel.focusNode, sel.focusOffset);
      if (curAnchor && !curAnchor.bad && curFocus && !curFocus.bad &&
          cmp(minPos(curAnchor, curFocus), prim.from()) == 0 &&
          cmp(maxPos(curAnchor, curFocus), prim.to()) == 0)
        return;

      var start = posToDOM(this.cm, prim.from());
      var end = posToDOM(this.cm, prim.to());
      if (!start && !end) return;

      var view = this.cm.display.view;
      var old = sel.rangeCount && sel.getRangeAt(0);
      if (!start) {
        start = {node: view[0].measure.map[2], offset: 0};
      } else if (!end) { // FIXME dangerously hacky
        var measure = view[view.length - 1].measure;
        var map = measure.maps ? measure.maps[measure.maps.length - 1] : measure.map;
        end = {node: map[map.length - 1], offset: map[map.length - 2] - map[map.length - 3]};
      }

      try { var rng = range(start.node, start.offset, end.offset, end.node); }
      catch(e) {} // Our model of the DOM might be outdated, in which case the range we try to set can be impossible
      if (rng) {
        sel.removeAllRanges();
        sel.addRange(rng);
        if (old && sel.anchorNode == null) sel.addRange(old);
        else if (gecko) this.startGracePeriod();
      }
      this.rememberSelection();
    },

    startGracePeriod: function() {
      var input = this;
      clearTimeout(this.gracePeriod);
      this.gracePeriod = setTimeout(function() {
        input.gracePeriod = false;
        if (input.selectionChanged())
          input.cm.operation(function() { input.cm.curOp.selectionChanged = true; });
      }, 20);
    },

    showMultipleSelections: function(info) {
      removeChildrenAndAdd(this.cm.display.cursorDiv, info.cursors);
      removeChildrenAndAdd(this.cm.display.selectionDiv, info.selection);
    },

    rememberSelection: function() {
      var sel = window.getSelection();
      this.lastAnchorNode = sel.anchorNode; this.lastAnchorOffset = sel.anchorOffset;
      this.lastFocusNode = sel.focusNode; this.lastFocusOffset = sel.focusOffset;
    },

    selectionInEditor: function() {
      var sel = window.getSelection();
      if (!sel.rangeCount) return false;
      var node = sel.getRangeAt(0).commonAncestorContainer;
      return contains(this.div, node);
    },

    focus: function() {
      if (this.cm.options.readOnly != "nocursor") this.div.focus();
    },
    blur: function() { this.div.blur(); },
    getField: function() { return this.div; },

    supportsTouch: function() { return true; },

    receivedFocus: function() {
      var input = this;
      if (this.selectionInEditor())
        this.pollSelection();
      else
        runInOp(this.cm, function() { input.cm.curOp.selectionChanged = true; });

      function poll() {
        if (input.cm.state.focused) {
          input.pollSelection();
          input.polling.set(input.cm.options.pollInterval, poll);
        }
      }
      this.polling.set(this.cm.options.pollInterval, poll);
    },

    selectionChanged: function() {
      var sel = window.getSelection();
      return sel.anchorNode != this.lastAnchorNode || sel.anchorOffset != this.lastAnchorOffset ||
        sel.focusNode != this.lastFocusNode || sel.focusOffset != this.lastFocusOffset;
    },

    pollSelection: function() {
      if (!this.composing && !this.gracePeriod && this.selectionChanged()) {
        var sel = window.getSelection(), cm = this.cm;
        this.rememberSelection();
        var anchor = domToPos(cm, sel.anchorNode, sel.anchorOffset);
        var head = domToPos(cm, sel.focusNode, sel.focusOffset);
        if (anchor && head) runInOp(cm, function() {
          setSelection(cm.doc, simpleSelection(anchor, head), sel_dontScroll);
          if (anchor.bad || head.bad) cm.curOp.selectionChanged = true;
        });
      }
    },

    pollContent: function() {
      var cm = this.cm, display = cm.display, sel = cm.doc.sel.primary();
      var from = sel.from(), to = sel.to();
      if (from.line < display.viewFrom || to.line > display.viewTo - 1) return false;

      var fromIndex;
      if (from.line == display.viewFrom || (fromIndex = findViewIndex(cm, from.line)) == 0) {
        var fromLine = lineNo(display.view[0].line);
        var fromNode = display.view[0].node;
      } else {
        var fromLine = lineNo(display.view[fromIndex].line);
        var fromNode = display.view[fromIndex - 1].node.nextSibling;
      }
      var toIndex = findViewIndex(cm, to.line);
      if (toIndex == display.view.length - 1) {
        var toLine = display.viewTo - 1;
        var toNode = display.lineDiv.lastChild;
      } else {
        var toLine = lineNo(display.view[toIndex + 1].line) - 1;
        var toNode = display.view[toIndex + 1].node.previousSibling;
      }

      var newText = cm.doc.splitLines(domTextBetween(cm, fromNode, toNode, fromLine, toLine));
      var oldText = getBetween(cm.doc, Pos(fromLine, 0), Pos(toLine, getLine(cm.doc, toLine).text.length));
      while (newText.length > 1 && oldText.length > 1) {
        if (lst(newText) == lst(oldText)) { newText.pop(); oldText.pop(); toLine--; }
        else if (newText[0] == oldText[0]) { newText.shift(); oldText.shift(); fromLine++; }
        else break;
      }

      var cutFront = 0, cutEnd = 0;
      var newTop = newText[0], oldTop = oldText[0], maxCutFront = Math.min(newTop.length, oldTop.length);
      while (cutFront < maxCutFront && newTop.charCodeAt(cutFront) == oldTop.charCodeAt(cutFront))
        ++cutFront;
      var newBot = lst(newText), oldBot = lst(oldText);
      var maxCutEnd = Math.min(newBot.length - (newText.length == 1 ? cutFront : 0),
                               oldBot.length - (oldText.length == 1 ? cutFront : 0));
      while (cutEnd < maxCutEnd &&
             newBot.charCodeAt(newBot.length - cutEnd - 1) == oldBot.charCodeAt(oldBot.length - cutEnd - 1))
        ++cutEnd;

      newText[newText.length - 1] = newBot.slice(0, newBot.length - cutEnd);
      newText[0] = newText[0].slice(cutFront);

      var chFrom = Pos(fromLine, cutFront);
      var chTo = Pos(toLine, oldText.length ? lst(oldText).length - cutEnd : 0);
      if (newText.length > 1 || newText[0] || cmp(chFrom, chTo)) {
        replaceRange(cm.doc, newText, chFrom, chTo, "+input");
        return true;
      }
    },

    ensurePolled: function() {
      this.forceCompositionEnd();
    },
    reset: function() {
      this.forceCompositionEnd();
    },
    forceCompositionEnd: function() {
      if (!this.composing || this.composing.handled) return;
      this.applyComposition(this.composing);
      this.composing.handled = true;
      this.div.blur();
      this.div.focus();
    },
    applyComposition: function(composing) {
      if (isReadOnly(this.cm))
        operation(this.cm, regChange)(this.cm)
      else if (composing.data && composing.data != composing.startData)
        operation(this.cm, applyTextInput)(this.cm, composing.data, 0, composing.sel);
    },

    setUneditable: function(node) {
      node.contentEditable = "false"
    },

    onKeyPress: function(e) {
      e.preventDefault();
      if (!isReadOnly(this.cm))
        operation(this.cm, applyTextInput)(this.cm, String.fromCharCode(e.charCode == null ? e.keyCode : e.charCode), 0);
    },

    readOnlyChanged: function(val) {
      this.div.contentEditable = String(val != "nocursor")
    },

    onContextMenu: nothing,
    resetPosition: nothing,

    needsContentAttribute: true
  }, ContentEditableInput.prototype);

  function posToDOM(cm, pos) {
    var view = findViewForLine(cm, pos.line);
    if (!view || view.hidden) return null;
    var line = getLine(cm.doc, pos.line);
    var info = mapFromLineView(view, line, pos.line);

    var order = getOrder(line), side = "left";
    if (order) {
      var partPos = getBidiPartAt(order, pos.ch);
      side = partPos % 2 ? "right" : "left";
    }
    var result = nodeAndOffsetInLineMap(info.map, pos.ch, side);
    result.offset = result.collapse == "right" ? result.end : result.start;
    return result;
  }

  function badPos(pos, bad) { if (bad) pos.bad = true; return pos; }

  function domToPos(cm, node, offset) {
    var lineNode;
    if (node == cm.display.lineDiv) {
      lineNode = cm.display.lineDiv.childNodes[offset];
      if (!lineNode) return badPos(cm.clipPos(Pos(cm.display.viewTo - 1)), true);
      node = null; offset = 0;
    } else {
      for (lineNode = node;; lineNode = lineNode.parentNode) {
        if (!lineNode || lineNode == cm.display.lineDiv) return null;
        if (lineNode.parentNode && lineNode.parentNode == cm.display.lineDiv) break;
      }
    }
    for (var i = 0; i < cm.display.view.length; i++) {
      var lineView = cm.display.view[i];
      if (lineView.node == lineNode)
        return locateNodeInLineView(lineView, node, offset);
    }
  }

  function locateNodeInLineView(lineView, node, offset) {
    var wrapper = lineView.text.firstChild, bad = false;
    if (!node || !contains(wrapper, node)) return badPos(Pos(lineNo(lineView.line), 0), true);
    if (node == wrapper) {
      bad = true;
      node = wrapper.childNodes[offset];
      offset = 0;
      if (!node) {
        var line = lineView.rest ? lst(lineView.rest) : lineView.line;
        return badPos(Pos(lineNo(line), line.text.length), bad);
      }
    }

    var textNode = node.nodeType == 3 ? node : null, topNode = node;
    if (!textNode && node.childNodes.length == 1 && node.firstChild.nodeType == 3) {
      textNode = node.firstChild;
      if (offset) offset = textNode.nodeValue.length;
    }
    while (topNode.parentNode != wrapper) topNode = topNode.parentNode;
    var measure = lineView.measure, maps = measure.maps;

    function find(textNode, topNode, offset) {
      for (var i = -1; i < (maps ? maps.length : 0); i++) {
        var map = i < 0 ? measure.map : maps[i];
        for (var j = 0; j < map.length; j += 3) {
          var curNode = map[j + 2];
          if (curNode == textNode || curNode == topNode) {
            var line = lineNo(i < 0 ? lineView.line : lineView.rest[i]);
            var ch = map[j] + offset;
            if (offset < 0 || curNode != textNode) ch = map[j + (offset ? 1 : 0)];
            return Pos(line, ch);
          }
        }
      }
    }
    var found = find(textNode, topNode, offset);
    if (found) return badPos(found, bad);

    // FIXME this is all really shaky. might handle the few cases it needs to handle, but likely to cause problems
    for (var after = topNode.nextSibling, dist = textNode ? textNode.nodeValue.length - offset : 0; after; after = after.nextSibling) {
      found = find(after, after.firstChild, 0);
      if (found)
        return badPos(Pos(found.line, found.ch - dist), bad);
      else
        dist += after.textContent.length;
    }
    for (var before = topNode.previousSibling, dist = offset; before; before = before.previousSibling) {
      found = find(before, before.firstChild, -1);
      if (found)
        return badPos(Pos(found.line, found.ch + dist), bad);
      else
        dist += after.textContent.length;
    }
  }

  function domTextBetween(cm, from, to, fromLine, toLine) {
    var text = "", closing = false, lineSep = cm.doc.lineSeparator();
    function recognizeMarker(id) { return function(marker) { return marker.id == id; }; }
    function walk(node) {
      if (node.nodeType == 1) {
        var cmText = node.getAttribute("cm-text");
        if (cmText != null) {
          if (cmText == "") cmText = node.textContent.replace(/\u200b/g, "");
          text += cmText;
          return;
        }
        var markerID = node.getAttribute("cm-marker"), range;
        if (markerID) {
          var found = cm.findMarks(Pos(fromLine, 0), Pos(toLine + 1, 0), recognizeMarker(+markerID));
          if (found.length && (range = found[0].find()))
            text += getBetween(cm.doc, range.from, range.to).join(lineSep);
          return;
        }
        if (node.getAttribute("contenteditable") == "false") return;
        for (var i = 0; i < node.childNodes.length; i++)
          walk(node.childNodes[i]);
        if (/^(pre|div|p)$/i.test(node.nodeName))
          closing = true;
      } else if (node.nodeType == 3) {
        var val = node.nodeValue;
        if (!val) return;
        if (closing) {
          text += lineSep;
          closing = false;
        }
        text += val;
      }
    }
    for (;;) {
      walk(from);
      if (from == to) break;
      from = from.nextSibling;
    }
    return text;
  }

  CodeMirror.inputStyles = {"textarea": TextareaInput, "contenteditable": ContentEditableInput};

  // SELECTION / CURSOR

  // Selection objects are immutable. A new one is created every time
  // the selection changes. A selection is one or more non-overlapping
  // (and non-touching) ranges, sorted, and an integer that indicates
  // which one is the primary selection (the one that's scrolled into
  // view, that getCursor returns, etc).
  function Selection(ranges, primIndex) {
    this.ranges = ranges;
    this.primIndex = primIndex;
  }

  Selection.prototype = {
    primary: function() { return this.ranges[this.primIndex]; },
    equals: function(other) {
      if (other == this) return true;
      if (other.primIndex != this.primIndex || other.ranges.length != this.ranges.length) return false;
      for (var i = 0; i < this.ranges.length; i++) {
        var here = this.ranges[i], there = other.ranges[i];
        if (cmp(here.anchor, there.anchor) != 0 || cmp(here.head, there.head) != 0) return false;
      }
      return true;
    },
    deepCopy: function() {
      for (var out = [], i = 0; i < this.ranges.length; i++)
        out[i] = new Range(copyPos(this.ranges[i].anchor), copyPos(this.ranges[i].head));
      return new Selection(out, this.primIndex);
    },
    somethingSelected: function() {
      for (var i = 0; i < this.ranges.length; i++)
        if (!this.ranges[i].empty()) return true;
      return false;
    },
    contains: function(pos, end) {
      if (!end) end = pos;
      for (var i = 0; i < this.ranges.length; i++) {
        var range = this.ranges[i];
        if (cmp(end, range.from()) >= 0 && cmp(pos, range.to()) <= 0)
          return i;
      }
      return -1;
    }
  };

  function Range(anchor, head) {
    this.anchor = anchor; this.head = head;
  }

  Range.prototype = {
    from: function() { return minPos(this.anchor, this.head); },
    to: function() { return maxPos(this.anchor, this.head); },
    empty: function() {
      return this.head.line == this.anchor.line && this.head.ch == this.anchor.ch;
    }
  };

  // Take an unsorted, potentially overlapping set of ranges, and
  // build a selection out of it. 'Consumes' ranges array (modifying
  // it).
  function normalizeSelection(ranges, primIndex) {
    var prim = ranges[primIndex];
    ranges.sort(function(a, b) { return cmp(a.from(), b.from()); });
    primIndex = indexOf(ranges, prim);
    for (var i = 1; i < ranges.length; i++) {
      var cur = ranges[i], prev = ranges[i - 1];
      if (cmp(prev.to(), cur.from()) >= 0) {
        var from = minPos(prev.from(), cur.from()), to = maxPos(prev.to(), cur.to());
        var inv = prev.empty() ? cur.from() == cur.head : prev.from() == prev.head;
        if (i <= primIndex) --primIndex;
        ranges.splice(--i, 2, new Range(inv ? to : from, inv ? from : to));
      }
    }
    return new Selection(ranges, primIndex);
  }

  function simpleSelection(anchor, head) {
    return new Selection([new Range(anchor, head || anchor)], 0);
  }

  // Most of the external API clips given positions to make sure they
  // actually exist within the document.
  function clipLine(doc, n) {return Math.max(doc.first, Math.min(n, doc.first + doc.size - 1));}
  function clipPos(doc, pos) {
    if (pos.line < doc.first) return Pos(doc.first, 0);
    var last = doc.first + doc.size - 1;
    if (pos.line > last) return Pos(last, getLine(doc, last).text.length);
    return clipToLen(pos, getLine(doc, pos.line).text.length);
  }
  function clipToLen(pos, linelen) {
    var ch = pos.ch;
    if (ch == null || ch > linelen) return Pos(pos.line, linelen);
    else if (ch < 0) return Pos(pos.line, 0);
    else return pos;
  }
  function isLine(doc, l) {return l >= doc.first && l < doc.first + doc.size;}
  function clipPosArray(doc, array) {
    for (var out = [], i = 0; i < array.length; i++) out[i] = clipPos(doc, array[i]);
    return out;
  }

  // SELECTION UPDATES

  // The 'scroll' parameter given to many of these indicated whether
  // the new cursor position should be scrolled into view after
  // modifying the selection.

  // If shift is held or the extend flag is set, extends a range to
  // include a given position (and optionally a second position).
  // Otherwise, simply returns the range between the given positions.
  // Used for cursor motion and such.
  function extendRange(doc, range, head, other) {
    if (doc.cm && doc.cm.display.shift || doc.extend) {
      var anchor = range.anchor;
      if (other) {
        var posBefore = cmp(head, anchor) < 0;
        if (posBefore != (cmp(other, anchor) < 0)) {
          anchor = head;
          head = other;
        } else if (posBefore != (cmp(head, other) < 0)) {
          head = other;
        }
      }
      return new Range(anchor, head);
    } else {
      return new Range(other || head, head);
    }
  }

  // Extend the primary selection range, discard the rest.
  function extendSelection(doc, head, other, options) {
    setSelection(doc, new Selection([extendRange(doc, doc.sel.primary(), head, other)], 0), options);
  }

  // Extend all selections (pos is an array of selections with length
  // equal the number of selections)
  function extendSelections(doc, heads, options) {
    for (var out = [], i = 0; i < doc.sel.ranges.length; i++)
      out[i] = extendRange(doc, doc.sel.ranges[i], heads[i], null);
    var newSel = normalizeSelection(out, doc.sel.primIndex);
    setSelection(doc, newSel, options);
  }

  // Updates a single range in the selection.
  function replaceOneSelection(doc, i, range, options) {
    var ranges = doc.sel.ranges.slice(0);
    ranges[i] = range;
    setSelection(doc, normalizeSelection(ranges, doc.sel.primIndex), options);
  }

  // Reset the selection to a single range.
  function setSimpleSelection(doc, anchor, head, options) {
    setSelection(doc, simpleSelection(anchor, head), options);
  }

  // Give beforeSelectionChange handlers a change to influence a
  // selection update.
  function filterSelectionChange(doc, sel) {
    var obj = {
      ranges: sel.ranges,
      update: function(ranges) {
        this.ranges = [];
        for (var i = 0; i < ranges.length; i++)
          this.ranges[i] = new Range(clipPos(doc, ranges[i].anchor),
                                     clipPos(doc, ranges[i].head));
      }
    };
    signal(doc, "beforeSelectionChange", doc, obj);
    if (doc.cm) signal(doc.cm, "beforeSelectionChange", doc.cm, obj);
    if (obj.ranges != sel.ranges) return normalizeSelection(obj.ranges, obj.ranges.length - 1);
    else return sel;
  }

  function setSelectionReplaceHistory(doc, sel, options) {
    var done = doc.history.done, last = lst(done);
    if (last && last.ranges) {
      done[done.length - 1] = sel;
      setSelectionNoUndo(doc, sel, options);
    } else {
      setSelection(doc, sel, options);
    }
  }

  // Set a new selection.
  function setSelection(doc, sel, options) {
    setSelectionNoUndo(doc, sel, options);
    addSelectionToHistory(doc, doc.sel, doc.cm ? doc.cm.curOp.id : NaN, options);
  }

  function setSelectionNoUndo(doc, sel, options) {
    if (hasHandler(doc, "beforeSelectionChange") || doc.cm && hasHandler(doc.cm, "beforeSelectionChange"))
      sel = filterSelectionChange(doc, sel);

    var bias = options && options.bias ||
      (cmp(sel.primary().head, doc.sel.primary().head) < 0 ? -1 : 1);
    setSelectionInner(doc, skipAtomicInSelection(doc, sel, bias, true));

    if (!(options && options.scroll === false) && doc.cm)
      ensureCursorVisible(doc.cm);
  }

  function setSelectionInner(doc, sel) {
    if (sel.equals(doc.sel)) return;

    doc.sel = sel;

    if (doc.cm) {
      doc.cm.curOp.updateInput = doc.cm.curOp.selectionChanged = true;
      signalCursorActivity(doc.cm);
    }
    signalLater(doc, "cursorActivity", doc);
  }

  // Verify that the selection does not partially select any atomic
  // marked ranges.
  function reCheckSelection(doc) {
    setSelectionInner(doc, skipAtomicInSelection(doc, doc.sel, null, false), sel_dontScroll);
  }

  // Return a selection that does not partially select any atomic
  // ranges.
  function skipAtomicInSelection(doc, sel, bias, mayClear) {
    var out;
    for (var i = 0; i < sel.ranges.length; i++) {
      var range = sel.ranges[i];
      var newAnchor = skipAtomic(doc, range.anchor, bias, mayClear);
      var newHead = skipAtomic(doc, range.head, bias, mayClear);
      if (out || newAnchor != range.anchor || newHead != range.head) {
        if (!out) out = sel.ranges.slice(0, i);
        out[i] = new Range(newAnchor, newHead);
      }
    }
    return out ? normalizeSelection(out, sel.primIndex) : sel;
  }

  // Ensure a given position is not inside an atomic range.
  function skipAtomic(doc, pos, bias, mayClear) {
    var flipped = false, curPos = pos;
    var dir = bias || 1;
    doc.cantEdit = false;
    search: for (;;) {
      var line = getLine(doc, curPos.line);
      if (line.markedSpans) {
        for (var i = 0; i < line.markedSpans.length; ++i) {
          var sp = line.markedSpans[i], m = sp.marker;
          if ((sp.from == null || (m.inclusiveLeft ? sp.from <= curPos.ch : sp.from < curPos.ch)) &&
              (sp.to == null || (m.inclusiveRight ? sp.to >= curPos.ch : sp.to > curPos.ch))) {
            if (mayClear) {
              signal(m, "beforeCursorEnter");
              if (m.explicitlyCleared) {
                if (!line.markedSpans) break;
                else {--i; continue;}
              }
            }
            if (!m.atomic) continue;
            var newPos = m.find(dir < 0 ? -1 : 1);
            if (cmp(newPos, curPos) == 0) {
              newPos.ch += dir;
              if (newPos.ch < 0) {
                if (newPos.line > doc.first) newPos = clipPos(doc, Pos(newPos.line - 1));
                else newPos = null;
              } else if (newPos.ch > line.text.length) {
                if (newPos.line < doc.first + doc.size - 1) newPos = Pos(newPos.line + 1, 0);
                else newPos = null;
              }
              if (!newPos) {
                if (flipped) {
                  // Driven in a corner -- no valid cursor position found at all
                  // -- try again *with* clearing, if we didn't already
                  if (!mayClear) return skipAtomic(doc, pos, bias, true);
                  // Otherwise, turn off editing until further notice, and return the start of the doc
                  doc.cantEdit = true;
                  return Pos(doc.first, 0);
                }
                flipped = true; newPos = pos; dir = -dir;
              }
            }
            curPos = newPos;
            continue search;
          }
        }
      }
      return curPos;
    }
  }

  // SELECTION DRAWING

  function updateSelection(cm) {
    cm.display.input.showSelection(cm.display.input.prepareSelection());
  }

  function prepareSelection(cm, primary) {
    var doc = cm.doc, result = {};
    var curFragment = result.cursors = document.createDocumentFragment();
    var selFragment = result.selection = document.createDocumentFragment();

    for (var i = 0; i < doc.sel.ranges.length; i++) {
      if (primary === false && i == doc.sel.primIndex) continue;
      var range = doc.sel.ranges[i];
      var collapsed = range.empty();
      if (collapsed || cm.options.showCursorWhenSelecting)
        drawSelectionCursor(cm, range.head, curFragment);
      if (!collapsed)
        drawSelectionRange(cm, range, selFragment);
    }
    return result;
  }

  // Draws a cursor for the given range
  function drawSelectionCursor(cm, head, output) {
    var pos = cursorCoords(cm, head, "div", null, null, !cm.options.singleCursorHeightPerLine);

    var cursor = output.appendChild(elt("div", "\u00a0", "CodeMirror-cursor"));
    cursor.style.left = pos.left + "px";
    cursor.style.top = pos.top + "px";
    cursor.style.height = Math.max(0, pos.bottom - pos.top) * cm.options.cursorHeight + "px";

    if (pos.other) {
      // Secondary cursor, shown when on a 'jump' in bi-directional text
      var otherCursor = output.appendChild(elt("div", "\u00a0", "CodeMirror-cursor CodeMirror-secondarycursor"));
      otherCursor.style.display = "";
      otherCursor.style.left = pos.other.left + "px";
      otherCursor.style.top = pos.other.top + "px";
      otherCursor.style.height = (pos.other.bottom - pos.other.top) * .85 + "px";
    }
  }

  // Draws the given range as a highlighted selection
  function drawSelectionRange(cm, range, output) {
    var display = cm.display, doc = cm.doc;
    var fragment = document.createDocumentFragment();
    var padding = paddingH(cm.display), leftSide = padding.left;
    var rightSide = Math.max(display.sizerWidth, displayWidth(cm) - display.sizer.offsetLeft) - padding.right;

    function add(left, top, width, bottom) {
      if (top < 0) top = 0;
      top = Math.round(top);
      bottom = Math.round(bottom);
      fragment.appendChild(elt("div", null, "CodeMirror-selected", "position: absolute; left: " + left +
                               "px; top: " + top + "px; width: " + (width == null ? rightSide - left : width) +
                               "px; height: " + (bottom - top) + "px"));
    }

    function drawForLine(line, fromArg, toArg) {
      var lineObj = getLine(doc, line);
      var lineLen = lineObj.text.length;
      var start, end;
      function coords(ch, bias) {
        return charCoords(cm, Pos(line, ch), "div", lineObj, bias);
      }

      iterateBidiSections(getOrder(lineObj), fromArg || 0, toArg == null ? lineLen : toArg, function(from, to, dir) {
        var leftPos = coords(from, "left"), rightPos, left, right;
        if (from == to) {
          rightPos = leftPos;
          left = right = leftPos.left;
        } else {
          rightPos = coords(to - 1, "right");
          if (dir == "rtl") { var tmp = leftPos; leftPos = rightPos; rightPos = tmp; }
          left = leftPos.left;
          right = rightPos.right;
        }
        if (fromArg == null && from == 0) left = leftSide;
        if (rightPos.top - leftPos.top > 3) { // Different lines, draw top part
          add(left, leftPos.top, null, leftPos.bottom);
          left = leftSide;
          if (leftPos.bottom < rightPos.top) add(left, leftPos.bottom, null, rightPos.top);
        }
        if (toArg == null && to == lineLen) right = rightSide;
        if (!start || leftPos.top < start.top || leftPos.top == start.top && leftPos.left < start.left)
          start = leftPos;
        if (!end || rightPos.bottom > end.bottom || rightPos.bottom == end.bottom && rightPos.right > end.right)
          end = rightPos;
        if (left < leftSide + 1) left = leftSide;
        add(left, rightPos.top, right - left, rightPos.bottom);
      });
      return {start: start, end: end};
    }

    var sFrom = range.from(), sTo = range.to();
    if (sFrom.line == sTo.line) {
      drawForLine(sFrom.line, sFrom.ch, sTo.ch);
    } else {
      var fromLine = getLine(doc, sFrom.line), toLine = getLine(doc, sTo.line);
      var singleVLine = visualLine(fromLine) == visualLine(toLine);
      var leftEnd = drawForLine(sFrom.line, sFrom.ch, singleVLine ? fromLine.text.length + 1 : null).end;
      var rightStart = drawForLine(sTo.line, singleVLine ? 0 : null, sTo.ch).start;
      if (singleVLine) {
        if (leftEnd.top < rightStart.top - 2) {
          add(leftEnd.right, leftEnd.top, null, leftEnd.bottom);
          add(leftSide, rightStart.top, rightStart.left, rightStart.bottom);
        } else {
          add(leftEnd.right, leftEnd.top, rightStart.left - leftEnd.right, leftEnd.bottom);
        }
      }
      if (leftEnd.bottom < rightStart.top)
        add(leftSide, leftEnd.bottom, null, rightStart.top);
    }

    output.appendChild(fragment);
  }

  // Cursor-blinking
  function restartBlink(cm) {
    if (!cm.state.focused) return;
    var display = cm.display;
    clearInterval(display.blinker);
    var on = true;
    display.cursorDiv.style.visibility = "";
    if (cm.options.cursorBlinkRate > 0)
      display.blinker = setInterval(function() {
        display.cursorDiv.style.visibility = (on = !on) ? "" : "hidden";
      }, cm.options.cursorBlinkRate);
    else if (cm.options.cursorBlinkRate < 0)
      display.cursorDiv.style.visibility = "hidden";
  }

  // HIGHLIGHT WORKER

  function startWorker(cm, time) {
    if (cm.doc.mode.startState && cm.doc.frontier < cm.display.viewTo)
      cm.state.highlight.set(time, bind(highlightWorker, cm));
  }

  function highlightWorker(cm) {
    var doc = cm.doc;
    if (doc.frontier < doc.first) doc.frontier = doc.first;
    if (doc.frontier >= cm.display.viewTo) return;
    var end = +new Date + cm.options.workTime;
    var state = copyState(doc.mode, getStateBefore(cm, doc.frontier));
    var changedLines = [];

    doc.iter(doc.frontier, Math.min(doc.first + doc.size, cm.display.viewTo + 500), function(line) {
      if (doc.frontier >= cm.display.viewFrom) { // Visible
        var oldStyles = line.styles, tooLong = line.text.length > cm.options.maxHighlightLength;
        var highlighted = highlightLine(cm, line, tooLong ? copyState(doc.mode, state) : state, true);
        line.styles = highlighted.styles;
        var oldCls = line.styleClasses, newCls = highlighted.classes;
        if (newCls) line.styleClasses = newCls;
        else if (oldCls) line.styleClasses = null;
        var ischange = !oldStyles || oldStyles.length != line.styles.length ||
          oldCls != newCls && (!oldCls || !newCls || oldCls.bgClass != newCls.bgClass || oldCls.textClass != newCls.textClass);
        for (var i = 0; !ischange && i < oldStyles.length; ++i) ischange = oldStyles[i] != line.styles[i];
        if (ischange) changedLines.push(doc.frontier);
        line.stateAfter = tooLong ? state : copyState(doc.mode, state);
      } else {
        if (line.text.length <= cm.options.maxHighlightLength)
          processLine(cm, line.text, state);
        line.stateAfter = doc.frontier % 5 == 0 ? copyState(doc.mode, state) : null;
      }
      ++doc.frontier;
      if (+new Date > end) {
        startWorker(cm, cm.options.workDelay);
        return true;
      }
    });
    if (changedLines.length) runInOp(cm, function() {
      for (var i = 0; i < changedLines.length; i++)
        regLineChange(cm, changedLines[i], "text");
    });
  }

  // Finds the line to start with when starting a parse. Tries to
  // find a line with a stateAfter, so that it can start with a
  // valid state. If that fails, it returns the line with the
  // smallest indentation, which tends to need the least context to
  // parse correctly.
  function findStartLine(cm, n, precise) {
    var minindent, minline, doc = cm.doc;
    var lim = precise ? -1 : n - (cm.doc.mode.innerMode ? 1000 : 100);
    for (var search = n; search > lim; --search) {
      if (search <= doc.first) return doc.first;
      var line = getLine(doc, search - 1);
      if (line.stateAfter && (!precise || search <= doc.frontier)) return search;
      var indented = countColumn(line.text, null, cm.options.tabSize);
      if (minline == null || minindent > indented) {
        minline = search - 1;
        minindent = indented;
      }
    }
    return minline;
  }

  function getStateBefore(cm, n, precise) {
    var doc = cm.doc, display = cm.display;
    if (!doc.mode.startState) return true;
    var pos = findStartLine(cm, n, precise), state = pos > doc.first && getLine(doc, pos-1).stateAfter;
    if (!state) state = startState(doc.mode);
    else state = copyState(doc.mode, state);
    doc.iter(pos, n, function(line) {
      processLine(cm, line.text, state);
      var save = pos == n - 1 || pos % 5 == 0 || pos >= display.viewFrom && pos < display.viewTo;
      line.stateAfter = save ? copyState(doc.mode, state) : null;
      ++pos;
    });
    if (precise) doc.frontier = pos;
    return state;
  }

  // POSITION MEASUREMENT

  function paddingTop(display) {return display.lineSpace.offsetTop;}
  function paddingVert(display) {return display.mover.offsetHeight - display.lineSpace.offsetHeight;}
  function paddingH(display) {
    if (display.cachedPaddingH) return display.cachedPaddingH;
    var e = removeChildrenAndAdd(display.measure, elt("pre", "x"));
    var style = window.getComputedStyle ? window.getComputedStyle(e) : e.currentStyle;
    var data = {left: parseInt(style.paddingLeft), right: parseInt(style.paddingRight)};
    if (!isNaN(data.left) && !isNaN(data.right)) display.cachedPaddingH = data;
    return data;
  }

  function scrollGap(cm) { return scrollerGap - cm.display.nativeBarWidth; }
  function displayWidth(cm) {
    return cm.display.scroller.clientWidth - scrollGap(cm) - cm.display.barWidth;
  }
  function displayHeight(cm) {
    return cm.display.scroller.clientHeight - scrollGap(cm) - cm.display.barHeight;
  }

  // Ensure the lineView.wrapping.heights array is populated. This is
  // an array of bottom offsets for the lines that make up a drawn
  // line. When lineWrapping is on, there might be more than one
  // height.
  function ensureLineHeights(cm, lineView, rect) {
    var wrapping = cm.options.lineWrapping;
    var curWidth = wrapping && displayWidth(cm);
    if (!lineView.measure.heights || wrapping && lineView.measure.width != curWidth) {
      var heights = lineView.measure.heights = [];
      if (wrapping) {
        lineView.measure.width = curWidth;
        var rects = lineView.text.firstChild.getClientRects();
        for (var i = 0; i < rects.length - 1; i++) {
          var cur = rects[i], next = rects[i + 1];
          if (Math.abs(cur.bottom - next.bottom) > 2)
            heights.push((cur.bottom + next.top) / 2 - rect.top);
        }
      }
      heights.push(rect.bottom - rect.top);
    }
  }

  // Find a line map (mapping character offsets to text nodes) and a
  // measurement cache for the given line number. (A line view might
  // contain multiple lines when collapsed ranges are present.)
  function mapFromLineView(lineView, line, lineN) {
    if (lineView.line == line)
      return {map: lineView.measure.map, cache: lineView.measure.cache};
    for (var i = 0; i < lineView.rest.length; i++)
      if (lineView.rest[i] == line)
        return {map: lineView.measure.maps[i], cache: lineView.measure.caches[i]};
    for (var i = 0; i < lineView.rest.length; i++)
      if (lineNo(lineView.rest[i]) > lineN)
        return {map: lineView.measure.maps[i], cache: lineView.measure.caches[i], before: true};
  }

  // Render a line into the hidden node display.externalMeasured. Used
  // when measurement is needed for a line that's not in the viewport.
  function updateExternalMeasurement(cm, line) {
    line = visualLine(line);
    var lineN = lineNo(line);
    var view = cm.display.externalMeasured = new LineView(cm.doc, line, lineN);
    view.lineN = lineN;
    var built = view.built = buildLineContent(cm, view);
    view.text = built.pre;
    removeChildrenAndAdd(cm.display.lineMeasure, built.pre);
    return view;
  }

  // Get a {top, bottom, left, right} box (in line-local coordinates)
  // for a given character.
  function measureChar(cm, line, ch, bias) {
    return measureCharPrepared(cm, prepareMeasureForLine(cm, line), ch, bias);
  }

  // Find a line view that corresponds to the given line number.
  function findViewForLine(cm, lineN) {
    if (lineN >= cm.display.viewFrom && lineN < cm.display.viewTo)
      return cm.display.view[findViewIndex(cm, lineN)];
    var ext = cm.display.externalMeasured;
    if (ext && lineN >= ext.lineN && lineN < ext.lineN + ext.size)
      return ext;
  }

  // Measurement can be split in two steps, the set-up work that
  // applies to the whole line, and the measurement of the actual
  // character. Functions like coordsChar, that need to do a lot of
  // measurements in a row, can thus ensure that the set-up work is
  // only done once.
  function prepareMeasureForLine(cm, line) {
    var lineN = lineNo(line);
    var view = findViewForLine(cm, lineN);
    if (view && !view.text) {
      view = null;
    } else if (view && view.changes) {
      updateLineForChanges(cm, view, lineN, getDimensions(cm));
      cm.curOp.forceUpdate = true;
    }
    if (!view)
      view = updateExternalMeasurement(cm, line);

    var info = mapFromLineView(view, line, lineN);
    return {
      line: line, view: view, rect: null,
      map: info.map, cache: info.cache, before: info.before,
      hasHeights: false
    };
  }

  // Given a prepared measurement object, measures the position of an
  // actual character (or fetches it from the cache).
  function measureCharPrepared(cm, prepared, ch, bias, varHeight) {
    if (prepared.before) ch = -1;
    var key = ch + (bias || ""), found;
    if (prepared.cache.hasOwnProperty(key)) {
      found = prepared.cache[key];
    } else {
      if (!prepared.rect)
        prepared.rect = prepared.view.text.getBoundingClientRect();
      if (!prepared.hasHeights) {
        ensureLineHeights(cm, prepared.view, prepared.rect);
        prepared.hasHeights = true;
      }
      found = measureCharInner(cm, prepared, ch, bias);
      if (!found.bogus) prepared.cache[key] = found;
    }
    return {left: found.left, right: found.right,
            top: varHeight ? found.rtop : found.top,
            bottom: varHeight ? found.rbottom : found.bottom};
  }

  var nullRect = {left: 0, right: 0, top: 0, bottom: 0};

  function nodeAndOffsetInLineMap(map, ch, bias) {
    var node, start, end, collapse;
    // First, search the line map for the text node corresponding to,
    // or closest to, the target character.
    for (var i = 0; i < map.length; i += 3) {
      var mStart = map[i], mEnd = map[i + 1];
      if (ch < mStart) {
        start = 0; end = 1;
        collapse = "left";
      } else if (ch < mEnd) {
        start = ch - mStart;
        end = start + 1;
      } else if (i == map.length - 3 || ch == mEnd && map[i + 3] > ch) {
        end = mEnd - mStart;
        start = end - 1;
        if (ch >= mEnd) collapse = "right";
      }
      if (start != null) {
        node = map[i + 2];
        if (mStart == mEnd && bias == (node.insertLeft ? "left" : "right"))
          collapse = bias;
        if (bias == "left" && start == 0)
          while (i && map[i - 2] == map[i - 3] && map[i - 1].insertLeft) {
            node = map[(i -= 3) + 2];
            collapse = "left";
          }
        if (bias == "right" && start == mEnd - mStart)
          while (i < map.length - 3 && map[i + 3] == map[i + 4] && !map[i + 5].insertLeft) {
            node = map[(i += 3) + 2];
            collapse = "right";
          }
        break;
      }
    }
    return {node: node, start: start, end: end, collapse: collapse, coverStart: mStart, coverEnd: mEnd};
  }

  function measureCharInner(cm, prepared, ch, bias) {
    var place = nodeAndOffsetInLineMap(prepared.map, ch, bias);
    var node = place.node, start = place.start, end = place.end, collapse = place.collapse;

    var rect;
    if (node.nodeType == 3) { // If it is a text node, use a range to retrieve the coordinates.
      for (var i = 0; i < 4; i++) { // Retry a maximum of 4 times when nonsense rectangles are returned
        while (start && isExtendingChar(prepared.line.text.charAt(place.coverStart + start))) --start;
        while (place.coverStart + end < place.coverEnd && isExtendingChar(prepared.line.text.charAt(place.coverStart + end))) ++end;
        if (ie && ie_version < 9 && start == 0 && end == place.coverEnd - place.coverStart) {
          rect = node.parentNode.getBoundingClientRect();
        } else if (ie && cm.options.lineWrapping) {
          var rects = range(node, start, end).getClientRects();
          if (rects.length)
            rect = rects[bias == "right" ? rects.length - 1 : 0];
          else
            rect = nullRect;
        } else {
          rect = range(node, start, end).getBoundingClientRect() || nullRect;
        }
        if (rect.left || rect.right || start == 0) break;
        end = start;
        start = start - 1;
        collapse = "right";
      }
      if (ie && ie_version < 11) rect = maybeUpdateRectForZooming(cm.display.measure, rect);
    } else { // If it is a widget, simply get the box for the whole widget.
      if (start > 0) collapse = bias = "right";
      var rects;
      if (cm.options.lineWrapping && (rects = node.getClientRects()).length > 1)
        rect = rects[bias == "right" ? rects.length - 1 : 0];
      else
        rect = node.getBoundingClientRect();
    }
    if (ie && ie_version < 9 && !start && (!rect || !rect.left && !rect.right)) {
      var rSpan = node.parentNode.getClientRects()[0];
      if (rSpan)
        rect = {left: rSpan.left, right: rSpan.left + charWidth(cm.display), top: rSpan.top, bottom: rSpan.bottom};
      else
        rect = nullRect;
    }

    var rtop = rect.top - prepared.rect.top, rbot = rect.bottom - prepared.rect.top;
    var mid = (rtop + rbot) / 2;
    var heights = prepared.view.measure.heights;
    for (var i = 0; i < heights.length - 1; i++)
      if (mid < heights[i]) break;
    var top = i ? heights[i - 1] : 0, bot = heights[i];
    var result = {left: (collapse == "right" ? rect.right : rect.left) - prepared.rect.left,
                  right: (collapse == "left" ? rect.left : rect.right) - prepared.rect.left,
                  top: top, bottom: bot};
    if (!rect.left && !rect.right) result.bogus = true;
    if (!cm.options.singleCursorHeightPerLine) { result.rtop = rtop; result.rbottom = rbot; }

    return result;
  }

  // Work around problem with bounding client rects on ranges being
  // returned incorrectly when zoomed on IE10 and below.
  function maybeUpdateRectForZooming(measure, rect) {
    if (!window.screen || screen.logicalXDPI == null ||
        screen.logicalXDPI == screen.deviceXDPI || !hasBadZoomedRects(measure))
      return rect;
    var scaleX = screen.logicalXDPI / screen.deviceXDPI;
    var scaleY = screen.logicalYDPI / screen.deviceYDPI;
    return {left: rect.left * scaleX, right: rect.right * scaleX,
            top: rect.top * scaleY, bottom: rect.bottom * scaleY};
  }

  function clearLineMeasurementCacheFor(lineView) {
    if (lineView.measure) {
      lineView.measure.cache = {};
      lineView.measure.heights = null;
      if (lineView.rest) for (var i = 0; i < lineView.rest.length; i++)
        lineView.measure.caches[i] = {};
    }
  }

  function clearLineMeasurementCache(cm) {
    cm.display.externalMeasure = null;
    removeChildren(cm.display.lineMeasure);
    for (var i = 0; i < cm.display.view.length; i++)
      clearLineMeasurementCacheFor(cm.display.view[i]);
  }

  function clearCaches(cm) {
    clearLineMeasurementCache(cm);
    cm.display.cachedCharWidth = cm.display.cachedTextHeight = cm.display.cachedPaddingH = null;
    if (!cm.options.lineWrapping) cm.display.maxLineChanged = true;
    cm.display.lineNumChars = null;
  }

  function pageScrollX() { return window.pageXOffset || (document.documentElement || document.body).scrollLeft; }
  function pageScrollY() { return window.pageYOffset || (document.documentElement || document.body).scrollTop; }

  // Converts a {top, bottom, left, right} box from line-local
  // coordinates into another coordinate system. Context may be one of
  // "line", "div" (display.lineDiv), "local"/null (editor), "window",
  // or "page".
  function intoCoordSystem(cm, lineObj, rect, context) {
    if (lineObj.widgets) for (var i = 0; i < lineObj.widgets.length; ++i) if (lineObj.widgets[i].above) {
      var size = widgetHeight(lineObj.widgets[i]);
      rect.top += size; rect.bottom += size;
    }
    if (context == "line") return rect;
    if (!context) context = "local";
    var yOff = heightAtLine(lineObj);
    if (context == "local") yOff += paddingTop(cm.display);
    else yOff -= cm.display.viewOffset;
    if (context == "page" || context == "window") {
      var lOff = cm.display.lineSpace.getBoundingClientRect();
      yOff += lOff.top + (context == "window" ? 0 : pageScrollY());
      var xOff = lOff.left + (context == "window" ? 0 : pageScrollX());
      rect.left += xOff; rect.right += xOff;
    }
    rect.top += yOff; rect.bottom += yOff;
    return rect;
  }

  // Coverts a box from "div" coords to another coordinate system.
  // Context may be "window", "page", "div", or "local"/null.
  function fromCoordSystem(cm, coords, context) {
    if (context == "div") return coords;
    var left = coords.left, top = coords.top;
    // First move into "page" coordinate system
    if (context == "page") {
      left -= pageScrollX();
      top -= pageScrollY();
    } else if (context == "local" || !context) {
      var localBox = cm.display.sizer.getBoundingClientRect();
      left += localBox.left;
      top += localBox.top;
    }

    var lineSpaceBox = cm.display.lineSpace.getBoundingClientRect();
    return {left: left - lineSpaceBox.left, top: top - lineSpaceBox.top};
  }

  function charCoords(cm, pos, context, lineObj, bias) {
    if (!lineObj) lineObj = getLine(cm.doc, pos.line);
    return intoCoordSystem(cm, lineObj, measureChar(cm, lineObj, pos.ch, bias), context);
  }

  // Returns a box for a given cursor position, which may have an
  // 'other' property containing the position of the secondary cursor
  // on a bidi boundary.
  function cursorCoords(cm, pos, context, lineObj, preparedMeasure, varHeight) {
    lineObj = lineObj || getLine(cm.doc, pos.line);
    if (!preparedMeasure) preparedMeasure = prepareMeasureForLine(cm, lineObj);
    function get(ch, right) {
      var m = measureCharPrepared(cm, preparedMeasure, ch, right ? "right" : "left", varHeight);
      if (right) m.left = m.right; else m.right = m.left;
      return intoCoordSystem(cm, lineObj, m, context);
    }
    function getBidi(ch, partPos) {
      var part = order[partPos], right = part.level % 2;
      if (ch == bidiLeft(part) && partPos && part.level < order[partPos - 1].level) {
        part = order[--partPos];
        ch = bidiRight(part) - (part.level % 2 ? 0 : 1);
        right = true;
      } else if (ch == bidiRight(part) && partPos < order.length - 1 && part.level < order[partPos + 1].level) {
        part = order[++partPos];
        ch = bidiLeft(part) - part.level % 2;
        right = false;
      }
      if (right && ch == part.to && ch > part.from) return get(ch - 1);
      return get(ch, right);
    }
    var order = getOrder(lineObj), ch = pos.ch;
    if (!order) return get(ch);
    var partPos = getBidiPartAt(order, ch);
    var val = getBidi(ch, partPos);
    if (bidiOther != null) val.other = getBidi(ch, bidiOther);
    return val;
  }

  // Used to cheaply estimate the coordinates for a position. Used for
  // intermediate scroll updates.
  function estimateCoords(cm, pos) {
    var left = 0, pos = clipPos(cm.doc, pos);
    if (!cm.options.lineWrapping) left = charWidth(cm.display) * pos.ch;
    var lineObj = getLine(cm.doc, pos.line);
    var top = heightAtLine(lineObj) + paddingTop(cm.display);
    return {left: left, right: left, top: top, bottom: top + lineObj.height};
  }

  // Positions returned by coordsChar contain some extra information.
  // xRel is the relative x position of the input coordinates compared
  // to the found position (so xRel > 0 means the coordinates are to
  // the right of the character position, for example). When outside
  // is true, that means the coordinates lie outside the line's
  // vertical range.
  function PosWithInfo(line, ch, outside, xRel) {
    var pos = Pos(line, ch);
    pos.xRel = xRel;
    if (outside) pos.outside = true;
    return pos;
  }

  // Compute the character position closest to the given coordinates.
  // Input must be lineSpace-local ("div" coordinate system).
  function coordsChar(cm, x, y) {
    var doc = cm.doc;
    y += cm.display.viewOffset;
    if (y < 0) return PosWithInfo(doc.first, 0, true, -1);
    var lineN = lineAtHeight(doc, y), last = doc.first + doc.size - 1;
    if (lineN > last)
      return PosWithInfo(doc.first + doc.size - 1, getLine(doc, last).text.length, true, 1);
    if (x < 0) x = 0;

    var lineObj = getLine(doc, lineN);
    for (;;) {
      var found = coordsCharInner(cm, lineObj, lineN, x, y);
      var merged = collapsedSpanAtEnd(lineObj);
      var mergedPos = merged && merged.find(0, true);
      if (merged && (found.ch > mergedPos.from.ch || found.ch == mergedPos.from.ch && found.xRel > 0))
        lineN = lineNo(lineObj = mergedPos.to.line);
      else
        return found;
    }
  }

  function coordsCharInner(cm, lineObj, lineNo, x, y) {
    var innerOff = y - heightAtLine(lineObj);
    var wrongLine = false, adjust = 2 * cm.display.wrapper.clientWidth;
    var preparedMeasure = prepareMeasureForLine(cm, lineObj);

    function getX(ch) {
      var sp = cursorCoords(cm, Pos(lineNo, ch), "line", lineObj, preparedMeasure);
      wrongLine = true;
      if (innerOff > sp.bottom) return sp.left - adjust;
      else if (innerOff < sp.top) return sp.left + adjust;
      else wrongLine = false;
      return sp.left;
    }

    var bidi = getOrder(lineObj), dist = lineObj.text.length;
    var from = lineLeft(lineObj), to = lineRight(lineObj);
    var fromX = getX(from), fromOutside = wrongLine, toX = getX(to), toOutside = wrongLine;

    if (x > toX) return PosWithInfo(lineNo, to, toOutside, 1);
    // Do a binary search between these bounds.
    for (;;) {
      if (bidi ? to == from || to == moveVisually(lineObj, from, 1) : to - from <= 1) {
        var ch = x < fromX || x - fromX <= toX - x ? from : to;
        var xDiff = x - (ch == from ? fromX : toX);
        while (isExtendingChar(lineObj.text.charAt(ch))) ++ch;
        var pos = PosWithInfo(lineNo, ch, ch == from ? fromOutside : toOutside,
                              xDiff < -1 ? -1 : xDiff > 1 ? 1 : 0);
        return pos;
      }
      var step = Math.ceil(dist / 2), middle = from + step;
      if (bidi) {
        middle = from;
        for (var i = 0; i < step; ++i) middle = moveVisually(lineObj, middle, 1);
      }
      var middleX = getX(middle);
      if (middleX > x) {to = middle; toX = middleX; if (toOutside = wrongLine) toX += 1000; dist = step;}
      else {from = middle; fromX = middleX; fromOutside = wrongLine; dist -= step;}
    }
  }

  var measureText;
  // Compute the default text height.
  function textHeight(display) {
    if (display.cachedTextHeight != null) return display.cachedTextHeight;
    if (measureText == null) {
      measureText = elt("pre");
      // Measure a bunch of lines, for browsers that compute
      // fractional heights.
      for (var i = 0; i < 49; ++i) {
        measureText.appendChild(document.createTextNode("x"));
        measureText.appendChild(elt("br"));
      }
      measureText.appendChild(document.createTextNode("x"));
    }
    removeChildrenAndAdd(display.measure, measureText);
    var height = measureText.offsetHeight / 50;
    if (height > 3) display.cachedTextHeight = height;
    removeChildren(display.measure);
    return height || 1;
  }

  // Compute the default character width.
  function charWidth(display) {
    if (display.cachedCharWidth != null) return display.cachedCharWidth;
    var anchor = elt("span", "xxxxxxxxxx");
    var pre = elt("pre", [anchor]);
    removeChildrenAndAdd(display.measure, pre);
    var rect = anchor.getBoundingClientRect(), width = (rect.right - rect.left) / 10;
    if (width > 2) display.cachedCharWidth = width;
    return width || 10;
  }

  // OPERATIONS

  // Operations are used to wrap a series of changes to the editor
  // state in such a way that each change won't have to update the
  // cursor and display (which would be awkward, slow, and
  // error-prone). Instead, display updates are batched and then all
  // combined and executed at once.

  var operationGroup = null;

  var nextOpId = 0;
  // Start a new operation.
  function startOperation(cm) {
    cm.curOp = {
      cm: cm,
      viewChanged: false,      // Flag that indicates that lines might need to be redrawn
      startHeight: cm.doc.height, // Used to detect need to update scrollbar
      forceUpdate: false,      // Used to force a redraw
      updateInput: null,       // Whether to reset the input textarea
      typing: false,           // Whether this reset should be careful to leave existing text (for compositing)
      changeObjs: null,        // Accumulated changes, for firing change events
      cursorActivityHandlers: null, // Set of handlers to fire cursorActivity on
      cursorActivityCalled: 0, // Tracks which cursorActivity handlers have been called already
      selectionChanged: false, // Whether the selection needs to be redrawn
      updateMaxLine: false,    // Set when the widest line needs to be determined anew
      scrollLeft: null, scrollTop: null, // Intermediate scroll position, not pushed to DOM yet
      scrollToPos: null,       // Used to scroll to a specific position
      focus: false,
      id: ++nextOpId           // Unique ID
    };
    if (operationGroup) {
      operationGroup.ops.push(cm.curOp);
    } else {
      cm.curOp.ownsGroup = operationGroup = {
        ops: [cm.curOp],
        delayedCallbacks: []
      };
    }
  }

  function fireCallbacksForOps(group) {
    // Calls delayed callbacks and cursorActivity handlers until no
    // new ones appear
    var callbacks = group.delayedCallbacks, i = 0;
    do {
      for (; i < callbacks.length; i++)
        callbacks[i].call(null);
      for (var j = 0; j < group.ops.length; j++) {
        var op = group.ops[j];
        if (op.cursorActivityHandlers)
          while (op.cursorActivityCalled < op.cursorActivityHandlers.length)
            op.cursorActivityHandlers[op.cursorActivityCalled++].call(null, op.cm);
      }
    } while (i < callbacks.length);
  }

  // Finish an operation, updating the display and signalling delayed events
  function endOperation(cm) {
    var op = cm.curOp, group = op.ownsGroup;
    if (!group) return;

    try { fireCallbacksForOps(group); }
    finally {
      operationGroup = null;
      for (var i = 0; i < group.ops.length; i++)
        group.ops[i].cm.curOp = null;
      endOperations(group);
    }
  }

  // The DOM updates done when an operation finishes are batched so
  // that the minimum number of relayouts are required.
  function endOperations(group) {
    var ops = group.ops;
    for (var i = 0; i < ops.length; i++) // Read DOM
      endOperation_R1(ops[i]);
    for (var i = 0; i < ops.length; i++) // Write DOM (maybe)
      endOperation_W1(ops[i]);
    for (var i = 0; i < ops.length; i++) // Read DOM
      endOperation_R2(ops[i]);
    for (var i = 0; i < ops.length; i++) // Write DOM (maybe)
      endOperation_W2(ops[i]);
    for (var i = 0; i < ops.length; i++) // Read DOM
      endOperation_finish(ops[i]);
  }

  function endOperation_R1(op) {
    var cm = op.cm, display = cm.display;
    maybeClipScrollbars(cm);
    if (op.updateMaxLine) findMaxLine(cm);

    op.mustUpdate = op.viewChanged || op.forceUpdate || op.scrollTop != null ||
      op.scrollToPos && (op.scrollToPos.from.line < display.viewFrom ||
                         op.scrollToPos.to.line >= display.viewTo) ||
      display.maxLineChanged && cm.options.lineWrapping;
    op.update = op.mustUpdate &&
      new DisplayUpdate(cm, op.mustUpdate && {top: op.scrollTop, ensure: op.scrollToPos}, op.forceUpdate);
  }

  function endOperation_W1(op) {
    op.updatedDisplay = op.mustUpdate && updateDisplayIfNeeded(op.cm, op.update);
  }

  function endOperation_R2(op) {
    var cm = op.cm, display = cm.display;
    if (op.updatedDisplay) updateHeightsInViewport(cm);

    op.barMeasure = measureForScrollbars(cm);

    // If the max line changed since it was last measured, measure it,
    // and ensure the document's width matches it.
    // updateDisplay_W2 will use these properties to do the actual resizing
    if (display.maxLineChanged && !cm.options.lineWrapping) {
      op.adjustWidthTo = measureChar(cm, display.maxLine, display.maxLine.text.length).left + 3;
      cm.display.sizerWidth = op.adjustWidthTo;
      op.barMeasure.scrollWidth =
        Math.max(display.scroller.clientWidth, display.sizer.offsetLeft + op.adjustWidthTo + scrollGap(cm) + cm.display.barWidth);
      op.maxScrollLeft = Math.max(0, display.sizer.offsetLeft + op.adjustWidthTo - displayWidth(cm));
    }

    if (op.updatedDisplay || op.selectionChanged)
      op.preparedSelection = display.input.prepareSelection();
  }

  function endOperation_W2(op) {
    var cm = op.cm;

    if (op.adjustWidthTo != null) {
      cm.display.sizer.style.minWidth = op.adjustWidthTo + "px";
      if (op.maxScrollLeft < cm.doc.scrollLeft)
        setScrollLeft(cm, Math.min(cm.display.scroller.scrollLeft, op.maxScrollLeft), true);
      cm.display.maxLineChanged = false;
    }

    if (op.preparedSelection)
      cm.display.input.showSelection(op.preparedSelection);
    if (op.updatedDisplay)
      setDocumentHeight(cm, op.barMeasure);
    if (op.updatedDisplay || op.startHeight != cm.doc.height)
      updateScrollbars(cm, op.barMeasure);

    if (op.selectionChanged) restartBlink(cm);

    if (cm.state.focused && op.updateInput)
      cm.display.input.reset(op.typing);
    if (op.focus && op.focus == activeElt()) ensureFocus(op.cm);
  }

  function endOperation_finish(op) {
    var cm = op.cm, display = cm.display, doc = cm.doc;

    if (op.updatedDisplay) postUpdateDisplay(cm, op.update);

    // Abort mouse wheel delta measurement, when scrolling explicitly
    if (display.wheelStartX != null && (op.scrollTop != null || op.scrollLeft != null || op.scrollToPos))
      display.wheelStartX = display.wheelStartY = null;

    // Propagate the scroll position to the actual DOM scroller
    if (op.scrollTop != null && (display.scroller.scrollTop != op.scrollTop || op.forceScroll)) {
      doc.scrollTop = Math.max(0, Math.min(display.scroller.scrollHeight - display.scroller.clientHeight, op.scrollTop));
      display.scrollbars.setScrollTop(doc.scrollTop);
      display.scroller.scrollTop = doc.scrollTop;
    }
    if (op.scrollLeft != null && (display.scroller.scrollLeft != op.scrollLeft || op.forceScroll)) {
      doc.scrollLeft = Math.max(0, Math.min(display.scroller.scrollWidth - displayWidth(cm), op.scrollLeft));
      display.scrollbars.setScrollLeft(doc.scrollLeft);
      display.scroller.scrollLeft = doc.scrollLeft;
      alignHorizontally(cm);
    }
    // If we need to scroll a specific position into view, do so.
    if (op.scrollToPos) {
      var coords = scrollPosIntoView(cm, clipPos(doc, op.scrollToPos.from),
                                     clipPos(doc, op.scrollToPos.to), op.scrollToPos.margin);
      if (op.scrollToPos.isCursor && cm.state.focused) maybeScrollWindow(cm, coords);
    }

    // Fire events for markers that are hidden/unidden by editing or
    // undoing
    var hidden = op.maybeHiddenMarkers, unhidden = op.maybeUnhiddenMarkers;
    if (hidden) for (var i = 0; i < hidden.length; ++i)
      if (!hidden[i].lines.length) signal(hidden[i], "hide");
    if (unhidden) for (var i = 0; i < unhidden.length; ++i)
      if (unhidden[i].lines.length) signal(unhidden[i], "unhide");

    if (display.wrapper.offsetHeight)
      doc.scrollTop = cm.display.scroller.scrollTop;

    // Fire change events, and delayed event handlers
    if (op.changeObjs)
      signal(cm, "changes", cm, op.changeObjs);
    if (op.update)
      op.update.finish();
  }

  // Run the given function in an operation
  function runInOp(cm, f) {
    if (cm.curOp) return f();
    startOperation(cm);
    try { return f(); }
    finally { endOperation(cm); }
  }
  // Wraps a function in an operation. Returns the wrapped function.
  function operation(cm, f) {
    return function() {
      if (cm.curOp) return f.apply(cm, arguments);
      startOperation(cm);
      try { return f.apply(cm, arguments); }
      finally { endOperation(cm); }
    };
  }
  // Used to add methods to editor and doc instances, wrapping them in
  // operations.
  function methodOp(f) {
    return function() {
      if (this.curOp) return f.apply(this, arguments);
      startOperation(this);
      try { return f.apply(this, arguments); }
      finally { endOperation(this); }
    };
  }
  function docMethodOp(f) {
    return function() {
      var cm = this.cm;
      if (!cm || cm.curOp) return f.apply(this, arguments);
      startOperation(cm);
      try { return f.apply(this, arguments); }
      finally { endOperation(cm); }
    };
  }

  // VIEW TRACKING

  // These objects are used to represent the visible (currently drawn)
  // part of the document. A LineView may correspond to multiple
  // logical lines, if those are connected by collapsed ranges.
  function LineView(doc, line, lineN) {
    // The starting line
    this.line = line;
    // Continuing lines, if any
    this.rest = visualLineContinued(line);
    // Number of logical lines in this visual line
    this.size = this.rest ? lineNo(lst(this.rest)) - lineN + 1 : 1;
    this.node = this.text = null;
    this.hidden = lineIsHidden(doc, line);
  }

  // Create a range of LineView objects for the given lines.
  function buildViewArray(cm, from, to) {
    var array = [], nextPos;
    for (var pos = from; pos < to; pos = nextPos) {
      var view = new LineView(cm.doc, getLine(cm.doc, pos), pos);
      nextPos = pos + view.size;
      array.push(view);
    }
    return array;
  }

  // Updates the display.view data structure for a given change to the
  // document. From and to are in pre-change coordinates. Lendiff is
  // the amount of lines added or subtracted by the change. This is
  // used for changes that span multiple lines, or change the way
  // lines are divided into visual lines. regLineChange (below)
  // registers single-line changes.
  function regChange(cm, from, to, lendiff) {
    if (from == null) from = cm.doc.first;
    if (to == null) to = cm.doc.first + cm.doc.size;
    if (!lendiff) lendiff = 0;

    var display = cm.display;
    if (lendiff && to < display.viewTo &&
        (display.updateLineNumbers == null || display.updateLineNumbers > from))
      display.updateLineNumbers = from;

    cm.curOp.viewChanged = true;

    if (from >= display.viewTo) { // Change after
      if (sawCollapsedSpans && visualLineNo(cm.doc, from) < display.viewTo)
        resetView(cm);
    } else if (to <= display.viewFrom) { // Change before
      if (sawCollapsedSpans && visualLineEndNo(cm.doc, to + lendiff) > display.viewFrom) {
        resetView(cm);
      } else {
        display.viewFrom += lendiff;
        display.viewTo += lendiff;
      }
    } else if (from <= display.viewFrom && to >= display.viewTo) { // Full overlap
      resetView(cm);
    } else if (from <= display.viewFrom) { // Top overlap
      var cut = viewCuttingPoint(cm, to, to + lendiff, 1);
      if (cut) {
        display.view = display.view.slice(cut.index);
        display.viewFrom = cut.lineN;
        display.viewTo += lendiff;
      } else {
        resetView(cm);
      }
    } else if (to >= display.viewTo) { // Bottom overlap
      var cut = viewCuttingPoint(cm, from, from, -1);
      if (cut) {
        display.view = display.view.slice(0, cut.index);
        display.viewTo = cut.lineN;
      } else {
        resetView(cm);
      }
    } else { // Gap in the middle
      var cutTop = viewCuttingPoint(cm, from, from, -1);
      var cutBot = viewCuttingPoint(cm, to, to + lendiff, 1);
      if (cutTop && cutBot) {
        display.view = display.view.slice(0, cutTop.index)
          .concat(buildViewArray(cm, cutTop.lineN, cutBot.lineN))
          .concat(display.view.slice(cutBot.index));
        display.viewTo += lendiff;
      } else {
        resetView(cm);
      }
    }

    var ext = display.externalMeasured;
    if (ext) {
      if (to < ext.lineN)
        ext.lineN += lendiff;
      else if (from < ext.lineN + ext.size)
        display.externalMeasured = null;
    }
  }

  // Register a change to a single line. Type must be one of "text",
  // "gutter", "class", "widget"
  function regLineChange(cm, line, type) {
    cm.curOp.viewChanged = true;
    var display = cm.display, ext = cm.display.externalMeasured;
    if (ext && line >= ext.lineN && line < ext.lineN + ext.size)
      display.externalMeasured = null;

    if (line < display.viewFrom || line >= display.viewTo) return;
    var lineView = display.view[findViewIndex(cm, line)];
    if (lineView.node == null) return;
    var arr = lineView.changes || (lineView.changes = []);
    if (indexOf(arr, type) == -1) arr.push(type);
  }

  // Clear the view.
  function resetView(cm) {
    cm.display.viewFrom = cm.display.viewTo = cm.doc.first;
    cm.display.view = [];
    cm.display.viewOffset = 0;
  }

  // Find the view element corresponding to a given line. Return null
  // when the line isn't visible.
  function findViewIndex(cm, n) {
    if (n >= cm.display.viewTo) return null;
    n -= cm.display.viewFrom;
    if (n < 0) return null;
    var view = cm.display.view;
    for (var i = 0; i < view.length; i++) {
      n -= view[i].size;
      if (n < 0) return i;
    }
  }

  function viewCuttingPoint(cm, oldN, newN, dir) {
    var index = findViewIndex(cm, oldN), diff, view = cm.display.view;
    if (!sawCollapsedSpans || newN == cm.doc.first + cm.doc.size)
      return {index: index, lineN: newN};
    for (var i = 0, n = cm.display.viewFrom; i < index; i++)
      n += view[i].size;
    if (n != oldN) {
      if (dir > 0) {
        if (index == view.length - 1) return null;
        diff = (n + view[index].size) - oldN;
        index++;
      } else {
        diff = n - oldN;
      }
      oldN += diff; newN += diff;
    }
    while (visualLineNo(cm.doc, newN) != newN) {
      if (index == (dir < 0 ? 0 : view.length - 1)) return null;
      newN += dir * view[index - (dir < 0 ? 1 : 0)].size;
      index += dir;
    }
    return {index: index, lineN: newN};
  }

  // Force the view to cover a given range, adding empty view element
  // or clipping off existing ones as needed.
  function adjustView(cm, from, to) {
    var display = cm.display, view = display.view;
    if (view.length == 0 || from >= display.viewTo || to <= display.viewFrom) {
      display.view = buildViewArray(cm, from, to);
      display.viewFrom = from;
    } else {
      if (display.viewFrom > from)
        display.view = buildViewArray(cm, from, display.viewFrom).concat(display.view);
      else if (display.viewFrom < from)
        display.view = display.view.slice(findViewIndex(cm, from));
      display.viewFrom = from;
      if (display.viewTo < to)
        display.view = display.view.concat(buildViewArray(cm, display.viewTo, to));
      else if (display.viewTo > to)
        display.view = display.view.slice(0, findViewIndex(cm, to));
    }
    display.viewTo = to;
  }

  // Count the number of lines in the view whose DOM representation is
  // out of date (or nonexistent).
  function countDirtyView(cm) {
    var view = cm.display.view, dirty = 0;
    for (var i = 0; i < view.length; i++) {
      var lineView = view[i];
      if (!lineView.hidden && (!lineView.node || lineView.changes)) ++dirty;
    }
    return dirty;
  }

  // EVENT HANDLERS

  // Attach the necessary event handlers when initializing the editor
  function registerEventHandlers(cm) {
    var d = cm.display;
    on(d.scroller, "mousedown", operation(cm, onMouseDown));
    // Older IE's will not fire a second mousedown for a double click
    if (ie && ie_version < 11)
      on(d.scroller, "dblclick", operation(cm, function(e) {
        if (signalDOMEvent(cm, e)) return;
        var pos = posFromMouse(cm, e);
        if (!pos || clickInGutter(cm, e) || eventInWidget(cm.display, e)) return;
        e_preventDefault(e);
        var word = cm.findWordAt(pos);
        extendSelection(cm.doc, word.anchor, word.head);
      }));
    else
      on(d.scroller, "dblclick", function(e) { signalDOMEvent(cm, e) || e_preventDefault(e); });
    // Some browsers fire contextmenu *after* opening the menu, at
    // which point we can't mess with it anymore. Context menu is
    // handled in onMouseDown for these browsers.
    if (!captureRightClick) on(d.scroller, "contextmenu", function(e) {onContextMenu(cm, e);});

    // Used to suppress mouse event handling when a touch happens
    var touchFinished, prevTouch = {end: 0};
    function finishTouch() {
      if (d.activeTouch) {
        touchFinished = setTimeout(function() {d.activeTouch = null;}, 1000);
        prevTouch = d.activeTouch;
        prevTouch.end = +new Date;
      }
    };
    function isMouseLikeTouchEvent(e) {
      if (e.touches.length != 1) return false;
      var touch = e.touches[0];
      return touch.radiusX <= 1 && touch.radiusY <= 1;
    }
    function farAway(touch, other) {
      if (other.left == null) return true;
      var dx = other.left - touch.left, dy = other.top - touch.top;
      return dx * dx + dy * dy > 20 * 20;
    }
    on(d.scroller, "touchstart", function(e) {
      if (!isMouseLikeTouchEvent(e)) {
        clearTimeout(touchFinished);
        var now = +new Date;
        d.activeTouch = {start: now, moved: false,
                         prev: now - prevTouch.end <= 300 ? prevTouch : null};
        if (e.touches.length == 1) {
          d.activeTouch.left = e.touches[0].pageX;
          d.activeTouch.top = e.touches[0].pageY;
        }
      }
    });
    on(d.scroller, "touchmove", function() {
      if (d.activeTouch) d.activeTouch.moved = true;
    });
    on(d.scroller, "touchend", function(e) {
      var touch = d.activeTouch;
      if (touch && !eventInWidget(d, e) && touch.left != null &&
          !touch.moved && new Date - touch.start < 300) {
        var pos = cm.coordsChar(d.activeTouch, "page"), range;
        if (!touch.prev || farAway(touch, touch.prev)) // Single tap
          range = new Range(pos, pos);
        else if (!touch.prev.prev || farAway(touch, touch.prev.prev)) // Double tap
          range = cm.findWordAt(pos);
        else // Triple tap
          range = new Range(Pos(pos.line, 0), clipPos(cm.doc, Pos(pos.line + 1, 0)));
        cm.setSelection(range.anchor, range.head);
        cm.focus();
        e_preventDefault(e);
      }
      finishTouch();
    });
    on(d.scroller, "touchcancel", finishTouch);

    // Sync scrolling between fake scrollbars and real scrollable
    // area, ensure viewport is updated when scrolling.
    on(d.scroller, "scroll", function() {
      if (d.scroller.clientHeight) {
        setScrollTop(cm, d.scroller.scrollTop);
        setScrollLeft(cm, d.scroller.scrollLeft, true);
        signal(cm, "scroll", cm);
      }
    });

    // Listen to wheel events in order to try and update the viewport on time.
    on(d.scroller, "mousewheel", function(e){onScrollWheel(cm, e);});
    on(d.scroller, "DOMMouseScroll", function(e){onScrollWheel(cm, e);});

    // Prevent wrapper from ever scrolling
    on(d.wrapper, "scroll", function() { d.wrapper.scrollTop = d.wrapper.scrollLeft = 0; });

    d.dragFunctions = {
      enter: function(e) {if (!signalDOMEvent(cm, e)) e_stop(e);},
      over: function(e) {if (!signalDOMEvent(cm, e)) { onDragOver(cm, e); e_stop(e); }},
      start: function(e){onDragStart(cm, e);},
      drop: operation(cm, onDrop),
      leave: function() {clearDragCursor(cm);}
    };

    var inp = d.input.getField();
    on(inp, "keyup", function(e) { onKeyUp.call(cm, e); });
    on(inp, "keydown", operation(cm, onKeyDown));
    on(inp, "keypress", operation(cm, onKeyPress));
    on(inp, "focus", bind(onFocus, cm));
    on(inp, "blur", bind(onBlur, cm));
  }

  function dragDropChanged(cm, value, old) {
    var wasOn = old && old != CodeMirror.Init;
    if (!value != !wasOn) {
      var funcs = cm.display.dragFunctions;
      var toggle = value ? on : off;
      toggle(cm.display.scroller, "dragstart", funcs.start);
      toggle(cm.display.scroller, "dragenter", funcs.enter);
      toggle(cm.display.scroller, "dragover", funcs.over);
      toggle(cm.display.scroller, "dragleave", funcs.leave);
      toggle(cm.display.scroller, "drop", funcs.drop);
    }
  }

  // Called when the window resizes
  function onResize(cm) {
    var d = cm.display;
    if (d.lastWrapHeight == d.wrapper.clientHeight && d.lastWrapWidth == d.wrapper.clientWidth)
      return;
    // Might be a text scaling operation, clear size caches.
    d.cachedCharWidth = d.cachedTextHeight = d.cachedPaddingH = null;
    d.scrollbarsClipped = false;
    cm.setSize();
  }

  // MOUSE EVENTS

  // Return true when the given mouse event happened in a widget
  function eventInWidget(display, e) {
    for (var n = e_target(e); n != display.wrapper; n = n.parentNode) {
      if (!n || (n.nodeType == 1 && n.getAttribute("cm-ignore-events") == "true") ||
          (n.parentNode == display.sizer && n != display.mover))
        return true;
    }
  }

  // Given a mouse event, find the corresponding position. If liberal
  // is false, it checks whether a gutter or scrollbar was clicked,
  // and returns null if it was. forRect is used by rectangular
  // selections, and tries to estimate a character position even for
  // coordinates beyond the right of the text.
  function posFromMouse(cm, e, liberal, forRect) {
    var display = cm.display;
    if (!liberal && e_target(e).getAttribute("cm-not-content") == "true") return null;

    var x, y, space = display.lineSpace.getBoundingClientRect();
    // Fails unpredictably on IE[67] when mouse is dragged around quickly.
    try { x = e.clientX - space.left; y = e.clientY - space.top; }
    catch (e) { return null; }
    var coords = coordsChar(cm, x, y), line;
    if (forRect && coords.xRel == 1 && (line = getLine(cm.doc, coords.line).text).length == coords.ch) {
      var colDiff = countColumn(line, line.length, cm.options.tabSize) - line.length;
      coords = Pos(coords.line, Math.max(0, Math.round((x - paddingH(cm.display).left) / charWidth(cm.display)) - colDiff));
    }
    return coords;
  }

  // A mouse down can be a single click, double click, triple click,
  // start of selection drag, start of text drag, new cursor
  // (ctrl-click), rectangle drag (alt-drag), or xwin
  // middle-click-paste. Or it might be a click on something we should
  // not interfere with, such as a scrollbar or widget.
  function onMouseDown(e) {
    var cm = this, display = cm.display;
    if (display.activeTouch && display.input.supportsTouch() || signalDOMEvent(cm, e)) return;
    display.shift = e.shiftKey;

    if (eventInWidget(display, e)) {
      if (!webkit) {
        // Briefly turn off draggability, to allow widgets to do
        // normal dragging things.
        display.scroller.draggable = false;
        setTimeout(function(){display.scroller.draggable = true;}, 100);
      }
      return;
    }
    if (clickInGutter(cm, e)) return;
    var start = posFromMouse(cm, e);
    window.focus();

    switch (e_button(e)) {
    case 1:
      // #3261: make sure, that we're not starting a second selection
      if (cm.state.selectingText)
        cm.state.selectingText(e);
      else if (start)
        leftButtonDown(cm, e, start);
      else if (e_target(e) == display.scroller)
        e_preventDefault(e);
      break;
    case 2:
      if (webkit) cm.state.lastMiddleDown = +new Date;
      if (start) extendSelection(cm.doc, start);
      setTimeout(function() {display.input.focus();}, 20);
      e_preventDefault(e);
      break;
    case 3:
      if (captureRightClick) onContextMenu(cm, e);
      else delayBlurEvent(cm);
      break;
    }
  }

  var lastClick, lastDoubleClick;
  function leftButtonDown(cm, e, start) {
    if (ie) setTimeout(bind(ensureFocus, cm), 0);
    else cm.curOp.focus = activeElt();

    var now = +new Date, type;
    if (lastDoubleClick && lastDoubleClick.time > now - 400 && cmp(lastDoubleClick.pos, start) == 0) {
      type = "triple";
    } else if (lastClick && lastClick.time > now - 400 && cmp(lastClick.pos, start) == 0) {
      type = "double";
      lastDoubleClick = {time: now, pos: start};
    } else {
      type = "single";
      lastClick = {time: now, pos: start};
    }

    var sel = cm.doc.sel, modifier = mac ? e.metaKey : e.ctrlKey, contained;
    if (cm.options.dragDrop && dragAndDrop && !isReadOnly(cm) &&
        type == "single" && (contained = sel.contains(start)) > -1 &&
        (cmp((contained = sel.ranges[contained]).from(), start) < 0 || start.xRel > 0) &&
        (cmp(contained.to(), start) > 0 || start.xRel < 0))
      leftButtonStartDrag(cm, e, start, modifier);
    else
      leftButtonSelect(cm, e, start, type, modifier);
  }

  // Start a text drag. When it ends, see if any dragging actually
  // happen, and treat as a click if it didn't.
  function leftButtonStartDrag(cm, e, start, modifier) {
    var display = cm.display, startTime = +new Date;
    var dragEnd = operation(cm, function(e2) {
      if (webkit) display.scroller.draggable = false;
      cm.state.draggingText = false;
      off(document, "mouseup", dragEnd);
      off(display.scroller, "drop", dragEnd);
      if (Math.abs(e.clientX - e2.clientX) + Math.abs(e.clientY - e2.clientY) < 10) {
        e_preventDefault(e2);
        if (!modifier && +new Date - 200 < startTime)
          extendSelection(cm.doc, start);
        // Work around unexplainable focus problem in IE9 (#2127) and Chrome (#3081)
        if (webkit || ie && ie_version == 9)
          setTimeout(function() {document.body.focus(); display.input.focus();}, 20);
        else
          display.input.focus();
      }
    });
    // Let the drag handler handle this.
    if (webkit) display.scroller.draggable = true;
    cm.state.draggingText = dragEnd;
    // IE's approach to draggable
    if (display.scroller.dragDrop) display.scroller.dragDrop();
    on(document, "mouseup", dragEnd);
    on(display.scroller, "drop", dragEnd);
  }

  // Normal selection, as opposed to text dragging.
  function leftButtonSelect(cm, e, start, type, addNew) {
    var display = cm.display, doc = cm.doc;
    e_preventDefault(e);

    var ourRange, ourIndex, startSel = doc.sel, ranges = startSel.ranges;
    if (addNew && !e.shiftKey) {
      ourIndex = doc.sel.contains(start);
      if (ourIndex > -1)
        ourRange = ranges[ourIndex];
      else
        ourRange = new Range(start, start);
    } else {
      ourRange = doc.sel.primary();
      ourIndex = doc.sel.primIndex;
    }

    if (e.altKey) {
      type = "rect";
      if (!addNew) ourRange = new Range(start, start);
      start = posFromMouse(cm, e, true, true);
      ourIndex = -1;
    } else if (type == "double") {
      var word = cm.findWordAt(start);
      if (cm.display.shift || doc.extend)
        ourRange = extendRange(doc, ourRange, word.anchor, word.head);
      else
        ourRange = word;
    } else if (type == "triple") {
      var line = new Range(Pos(start.line, 0), clipPos(doc, Pos(start.line + 1, 0)));
      if (cm.display.shift || doc.extend)
        ourRange = extendRange(doc, ourRange, line.anchor, line.head);
      else
        ourRange = line;
    } else {
      ourRange = extendRange(doc, ourRange, start);
    }

    if (!addNew) {
      ourIndex = 0;
      setSelection(doc, new Selection([ourRange], 0), sel_mouse);
      startSel = doc.sel;
    } else if (ourIndex == -1) {
      ourIndex = ranges.length;
      setSelection(doc, normalizeSelection(ranges.concat([ourRange]), ourIndex),
                   {scroll: false, origin: "*mouse"});
    } else if (ranges.length > 1 && ranges[ourIndex].empty() && type == "single" && !e.shiftKey) {
      setSelection(doc, normalizeSelection(ranges.slice(0, ourIndex).concat(ranges.slice(ourIndex + 1)), 0),
                   {scroll: false, origin: "*mouse"});
      startSel = doc.sel;
    } else {
      replaceOneSelection(doc, ourIndex, ourRange, sel_mouse);
    }

    var lastPos = start;
    function extendTo(pos) {
      if (cmp(lastPos, pos) == 0) return;
      lastPos = pos;

      if (type == "rect") {
        var ranges = [], tabSize = cm.options.tabSize;
        var startCol = countColumn(getLine(doc, start.line).text, start.ch, tabSize);
        var posCol = countColumn(getLine(doc, pos.line).text, pos.ch, tabSize);
        var left = Math.min(startCol, posCol), right = Math.max(startCol, posCol);
        for (var line = Math.min(start.line, pos.line), end = Math.min(cm.lastLine(), Math.max(start.line, pos.line));
             line <= end; line++) {
          var text = getLine(doc, line).text, leftPos = findColumn(text, left, tabSize);
          if (left == right)
            ranges.push(new Range(Pos(line, leftPos), Pos(line, leftPos)));
          else if (text.length > leftPos)
            ranges.push(new Range(Pos(line, leftPos), Pos(line, findColumn(text, right, tabSize))));
        }
        if (!ranges.length) ranges.push(new Range(start, start));
        setSelection(doc, normalizeSelection(startSel.ranges.slice(0, ourIndex).concat(ranges), ourIndex),
                     {origin: "*mouse", scroll: false});
        cm.scrollIntoView(pos);
      } else {
        var oldRange = ourRange;
        var anchor = oldRange.anchor, head = pos;
        if (type != "single") {
          if (type == "double")
            var range = cm.findWordAt(pos);
          else
            var range = new Range(Pos(pos.line, 0), clipPos(doc, Pos(pos.line + 1, 0)));
          if (cmp(range.anchor, anchor) > 0) {
            head = range.head;
            anchor = minPos(oldRange.from(), range.anchor);
          } else {
            head = range.anchor;
            anchor = maxPos(oldRange.to(), range.head);
          }
        }
        var ranges = startSel.ranges.slice(0);
        ranges[ourIndex] = new Range(clipPos(doc, anchor), head);
        setSelection(doc, normalizeSelection(ranges, ourIndex), sel_mouse);
      }
    }

    var editorSize = display.wrapper.getBoundingClientRect();
    // Used to ensure timeout re-tries don't fire when another extend
    // happened in the meantime (clearTimeout isn't reliable -- at
    // least on Chrome, the timeouts still happen even when cleared,
    // if the clear happens after their scheduled firing time).
    var counter = 0;

    function extend(e) {
      var curCount = ++counter;
      var cur = posFromMouse(cm, e, true, type == "rect");
      if (!cur) return;
      if (cmp(cur, lastPos) != 0) {
        cm.curOp.focus = activeElt();
        extendTo(cur);
        var visible = visibleLines(display, doc);
        if (cur.line >= visible.to || cur.line < visible.from)
          setTimeout(operation(cm, function(){if (counter == curCount) extend(e);}), 150);
      } else {
        var outside = e.clientY < editorSize.top ? -20 : e.clientY > editorSize.bottom ? 20 : 0;
        if (outside) setTimeout(operation(cm, function() {
          if (counter != curCount) return;
          display.scroller.scrollTop += outside;
          extend(e);
        }), 50);
      }
    }

    function done(e) {
      cm.state.selectingText = false;
      counter = Infinity;
      e_preventDefault(e);
      display.input.focus();
      off(document, "mousemove", move);
      off(document, "mouseup", up);
      doc.history.lastSelOrigin = null;
    }

    var move = operation(cm, function(e) {
      if (!e_button(e)) done(e);
      else extend(e);
    });
    var up = operation(cm, done);
    cm.state.selectingText = up;
    on(document, "mousemove", move);
    on(document, "mouseup", up);
  }

  // Determines whether an event happened in the gutter, and fires the
  // handlers for the corresponding event.
  function gutterEvent(cm, e, type, prevent, signalfn) {
    try { var mX = e.clientX, mY = e.clientY; }
    catch(e) { return false; }
    if (mX >= Math.floor(cm.display.gutters.getBoundingClientRect().right)) return false;
    if (prevent) e_preventDefault(e);

    var display = cm.display;
    var lineBox = display.lineDiv.getBoundingClientRect();

    if (mY > lineBox.bottom || !hasHandler(cm, type)) return e_defaultPrevented(e);
    mY -= lineBox.top - display.viewOffset;

    for (var i = 0; i < cm.options.gutters.length; ++i) {
      var g = display.gutters.childNodes[i];
      if (g && g.getBoundingClientRect().right >= mX) {
        var line = lineAtHeight(cm.doc, mY);
        var gutter = cm.options.gutters[i];
        signalfn(cm, type, cm, line, gutter, e);
        return e_defaultPrevented(e);
      }
    }
  }

  function clickInGutter(cm, e) {
    return gutterEvent(cm, e, "gutterClick", true, signalLater);
  }

  // Kludge to work around strange IE behavior where it'll sometimes
  // re-fire a series of drag-related events right after the drop (#1551)
  var lastDrop = 0;

  function onDrop(e) {
    var cm = this;
    clearDragCursor(cm);
    if (signalDOMEvent(cm, e) || eventInWidget(cm.display, e))
      return;
    e_preventDefault(e);
    if (ie) lastDrop = +new Date;
    var pos = posFromMouse(cm, e, true), files = e.dataTransfer.files;
    if (!pos || isReadOnly(cm)) return;
    // Might be a file drop, in which case we simply extract the text
    // and insert it.
    if (files && files.length && window.FileReader && window.File) {
      var n = files.length, text = Array(n), read = 0;
      var loadFile = function(file, i) {
        if (cm.options.allowDropFileTypes &&
            indexOf(cm.options.allowDropFileTypes, file.type) == -1)
          return;

        var reader = new FileReader;
        reader.onload = operation(cm, function() {
          var content = reader.result;
          if (/[\x00-\x08\x0e-\x1f]{2}/.test(content)) content = "";
          text[i] = content;
          if (++read == n) {
            pos = clipPos(cm.doc, pos);
            var change = {from: pos, to: pos,
                          text: cm.doc.splitLines(text.join(cm.doc.lineSeparator())),
                          origin: "paste"};
            makeChange(cm.doc, change);
            setSelectionReplaceHistory(cm.doc, simpleSelection(pos, changeEnd(change)));
          }
        });
        reader.readAsText(file);
      };
      for (var i = 0; i < n; ++i) loadFile(files[i], i);
    } else { // Normal drop
      // Don't do a replace if the drop happened inside of the selected text.
      if (cm.state.draggingText && cm.doc.sel.contains(pos) > -1) {
        cm.state.draggingText(e);
        // Ensure the editor is re-focused
        setTimeout(function() {cm.display.input.focus();}, 20);
        return;
      }
      try {
        var text = e.dataTransfer.getData("Text");
        if (text) {
          if (cm.state.draggingText && !(mac ? e.altKey : e.ctrlKey))
            var selected = cm.listSelections();
          setSelectionNoUndo(cm.doc, simpleSelection(pos, pos));
          if (selected) for (var i = 0; i < selected.length; ++i)
            replaceRange(cm.doc, "", selected[i].anchor, selected[i].head, "drag");
          cm.replaceSelection(text, "around", "paste");
          cm.display.input.focus();
        }
      }
      catch(e){}
    }
  }

  function onDragStart(cm, e) {
    if (ie && (!cm.state.draggingText || +new Date - lastDrop < 100)) { e_stop(e); return; }
    if (signalDOMEvent(cm, e) || eventInWidget(cm.display, e)) return;

    e.dataTransfer.setData("Text", cm.getSelection());

    // Use dummy image instead of default browsers image.
    // Recent Safari (~6.0.2) have a tendency to segfault when this happens, so we don't do it there.
    if (e.dataTransfer.setDragImage && !safari) {
      var img = elt("img", null, null, "position: fixed; left: 0; top: 0;");
      img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
      if (presto) {
        img.width = img.height = 1;
        cm.display.wrapper.appendChild(img);
        // Force a relayout, or Opera won't use our image for some obscure reason
        img._top = img.offsetTop;
      }
      e.dataTransfer.setDragImage(img, 0, 0);
      if (presto) img.parentNode.removeChild(img);
    }
  }

  function onDragOver(cm, e) {
    var pos = posFromMouse(cm, e);
    if (!pos) return;
    var frag = document.createDocumentFragment();
    drawSelectionCursor(cm, pos, frag);
    if (!cm.display.dragCursor) {
      cm.display.dragCursor = elt("div", null, "CodeMirror-cursors CodeMirror-dragcursors");
      cm.display.lineSpace.insertBefore(cm.display.dragCursor, cm.display.cursorDiv);
    }
    removeChildrenAndAdd(cm.display.dragCursor, frag);
  }

  function clearDragCursor(cm) {
    if (cm.display.dragCursor) {
      cm.display.lineSpace.removeChild(cm.display.dragCursor);
      cm.display.dragCursor = null;
    }
  }

  // SCROLL EVENTS

  // Sync the scrollable area and scrollbars, ensure the viewport
  // covers the visible area.
  function setScrollTop(cm, val) {
    if (Math.abs(cm.doc.scrollTop - val) < 2) return;
    cm.doc.scrollTop = val;
    if (!gecko) updateDisplaySimple(cm, {top: val});
    if (cm.display.scroller.scrollTop != val) cm.display.scroller.scrollTop = val;
    cm.display.scrollbars.setScrollTop(val);
    if (gecko) updateDisplaySimple(cm);
    startWorker(cm, 100);
  }
  // Sync scroller and scrollbar, ensure the gutter elements are
  // aligned.
  function setScrollLeft(cm, val, isScroller) {
    if (isScroller ? val == cm.doc.scrollLeft : Math.abs(cm.doc.scrollLeft - val) < 2) return;
    val = Math.min(val, cm.display.scroller.scrollWidth - cm.display.scroller.clientWidth);
    cm.doc.scrollLeft = val;
    alignHorizontally(cm);
    if (cm.display.scroller.scrollLeft != val) cm.display.scroller.scrollLeft = val;
    cm.display.scrollbars.setScrollLeft(val);
  }

  // Since the delta values reported on mouse wheel events are
  // unstandardized between browsers and even browser versions, and
  // generally horribly unpredictable, this code starts by measuring
  // the scroll effect that the first few mouse wheel events have,
  // and, from that, detects the way it can convert deltas to pixel
  // offsets afterwards.
  //
  // The reason we want to know the amount a wheel event will scroll
  // is that it gives us a chance to update the display before the
  // actual scrolling happens, reducing flickering.

  var wheelSamples = 0, wheelPixelsPerUnit = null;
  // Fill in a browser-detected starting value on browsers where we
  // know one. These don't have to be accurate -- the result of them
  // being wrong would just be a slight flicker on the first wheel
  // scroll (if it is large enough).
  if (ie) wheelPixelsPerUnit = -.53;
  else if (gecko) wheelPixelsPerUnit = 15;
  else if (chrome) wheelPixelsPerUnit = -.7;
  else if (safari) wheelPixelsPerUnit = -1/3;

  var wheelEventDelta = function(e) {
    var dx = e.wheelDeltaX, dy = e.wheelDeltaY;
    if (dx == null && e.detail && e.axis == e.HORIZONTAL_AXIS) dx = e.detail;
    if (dy == null && e.detail && e.axis == e.VERTICAL_AXIS) dy = e.detail;
    else if (dy == null) dy = e.wheelDelta;
    return {x: dx, y: dy};
  };
  CodeMirror.wheelEventPixels = function(e) {
    var delta = wheelEventDelta(e);
    delta.x *= wheelPixelsPerUnit;
    delta.y *= wheelPixelsPerUnit;
    return delta;
  };

  function onScrollWheel(cm, e) {
    var delta = wheelEventDelta(e), dx = delta.x, dy = delta.y;

    var display = cm.display, scroll = display.scroller;
    // Quit if there's nothing to scroll here
    var canScrollX = scroll.scrollWidth > scroll.clientWidth;
    var canScrollY = scroll.scrollHeight > scroll.clientHeight;
    if (!(dx && canScrollX || dy && canScrollY)) return;

    // Webkit browsers on OS X abort momentum scrolls when the target
    // of the scroll event is removed from the scrollable element.
    // This hack (see related code in patchDisplay) makes sure the
    // element is kept around.
    if (dy && mac && webkit) {
      outer: for (var cur = e.target, view = display.view; cur != scroll; cur = cur.parentNode) {
        for (var i = 0; i < view.length; i++) {
          if (view[i].node == cur) {
            cm.display.currentWheelTarget = cur;
            break outer;
          }
        }
      }
    }

    // On some browsers, horizontal scrolling will cause redraws to
    // happen before the gutter has been realigned, causing it to
    // wriggle around in a most unseemly way. When we have an
    // estimated pixels/delta value, we just handle horizontal
    // scrolling entirely here. It'll be slightly off from native, but
    // better than glitching out.
    if (dx && !gecko && !presto && wheelPixelsPerUnit != null) {
      if (dy && canScrollY)
        setScrollTop(cm, Math.max(0, Math.min(scroll.scrollTop + dy * wheelPixelsPerUnit, scroll.scrollHeight - scroll.clientHeight)));
      setScrollLeft(cm, Math.max(0, Math.min(scroll.scrollLeft + dx * wheelPixelsPerUnit, scroll.scrollWidth - scroll.clientWidth)));
      // Only prevent default scrolling if vertical scrolling is
      // actually possible. Otherwise, it causes vertical scroll
      // jitter on OSX trackpads when deltaX is small and deltaY
      // is large (issue #3579)
      if (!dy || (dy && canScrollY))
        e_preventDefault(e);
      display.wheelStartX = null; // Abort measurement, if in progress
      return;
    }

    // 'Project' the visible viewport to cover the area that is being
    // scrolled into view (if we know enough to estimate it).
    if (dy && wheelPixelsPerUnit != null) {
      var pixels = dy * wheelPixelsPerUnit;
      var top = cm.doc.scrollTop, bot = top + display.wrapper.clientHeight;
      if (pixels < 0) top = Math.max(0, top + pixels - 50);
      else bot = Math.min(cm.doc.height, bot + pixels + 50);
      updateDisplaySimple(cm, {top: top, bottom: bot});
    }

    if (wheelSamples < 20) {
      if (display.wheelStartX == null) {
        display.wheelStartX = scroll.scrollLeft; display.wheelStartY = scroll.scrollTop;
        display.wheelDX = dx; display.wheelDY = dy;
        setTimeout(function() {
          if (display.wheelStartX == null) return;
          var movedX = scroll.scrollLeft - display.wheelStartX;
          var movedY = scroll.scrollTop - display.wheelStartY;
          var sample = (movedY && display.wheelDY && movedY / display.wheelDY) ||
            (movedX && display.wheelDX && movedX / display.wheelDX);
          display.wheelStartX = display.wheelStartY = null;
          if (!sample) return;
          wheelPixelsPerUnit = (wheelPixelsPerUnit * wheelSamples + sample) / (wheelSamples + 1);
          ++wheelSamples;
        }, 200);
      } else {
        display.wheelDX += dx; display.wheelDY += dy;
      }
    }
  }

  // KEY EVENTS

  // Run a handler that was bound to a key.
  function doHandleBinding(cm, bound, dropShift) {
    if (typeof bound == "string") {
      bound = commands[bound];
      if (!bound) return false;
    }
    // Ensure previous input has been read, so that the handler sees a
    // consistent view of the document
    cm.display.input.ensurePolled();
    var prevShift = cm.display.shift, done = false;
    try {
      if (isReadOnly(cm)) cm.state.suppressEdits = true;
      if (dropShift) cm.display.shift = false;
      done = bound(cm) != Pass;
    } finally {
      cm.display.shift = prevShift;
      cm.state.suppressEdits = false;
    }
    return done;
  }

  function lookupKeyForEditor(cm, name, handle) {
    for (var i = 0; i < cm.state.keyMaps.length; i++) {
      var result = lookupKey(name, cm.state.keyMaps[i], handle, cm);
      if (result) return result;
    }
    return (cm.options.extraKeys && lookupKey(name, cm.options.extraKeys, handle, cm))
      || lookupKey(name, cm.options.keyMap, handle, cm);
  }

  var stopSeq = new Delayed;
  function dispatchKey(cm, name, e, handle) {
    var seq = cm.state.keySeq;
    if (seq) {
      if (isModifierKey(name)) return "handled";
      stopSeq.set(50, function() {
        if (cm.state.keySeq == seq) {
          cm.state.keySeq = null;
          cm.display.input.reset();
        }
      });
      name = seq + " " + name;
    }
    var result = lookupKeyForEditor(cm, name, handle);

    if (result == "multi")
      cm.state.keySeq = name;
    if (result == "handled")
      signalLater(cm, "keyHandled", cm, name, e);

    if (result == "handled" || result == "multi") {
      e_preventDefault(e);
      restartBlink(cm);
    }

    if (seq && !result && /\'$/.test(name)) {
      e_preventDefault(e);
      return true;
    }
    return !!result;
  }

  // Handle a key from the keydown event.
  function handleKeyBinding(cm, e) {
    var name = keyName(e, true);
    if (!name) return false;

    if (e.shiftKey && !cm.state.keySeq) {
      // First try to resolve full name (including 'Shift-'). Failing
      // that, see if there is a cursor-motion command (starting with
      // 'go') bound to the keyname without 'Shift-'.
      return dispatchKey(cm, "Shift-" + name, e, function(b) {return doHandleBinding(cm, b, true);})
          || dispatchKey(cm, name, e, function(b) {
               if (typeof b == "string" ? /^go[A-Z]/.test(b) : b.motion)
                 return doHandleBinding(cm, b);
             });
    } else {
      return dispatchKey(cm, name, e, function(b) { return doHandleBinding(cm, b); });
    }
  }

  // Handle a key from the keypress event
  function handleCharBinding(cm, e, ch) {
    return dispatchKey(cm, "'" + ch + "'", e,
                       function(b) { return doHandleBinding(cm, b, true); });
  }

  var lastStoppedKey = null;
  function onKeyDown(e) {
    var cm = this;
    cm.curOp.focus = activeElt();
    if (signalDOMEvent(cm, e)) return;
    // IE does strange things with escape.
    if (ie && ie_version < 11 && e.keyCode == 27) e.returnValue = false;
    var code = e.keyCode;
    cm.display.shift = code == 16 || e.shiftKey;
    var handled = handleKeyBinding(cm, e);
    if (presto) {
      lastStoppedKey = handled ? code : null;
      // Opera has no cut event... we try to at least catch the key combo
      if (!handled && code == 88 && !hasCopyEvent && (mac ? e.metaKey : e.ctrlKey))
        cm.replaceSelection("", null, "cut");
    }

    // Turn mouse into crosshair when Alt is held on Mac.
    if (code == 18 && !/\bCodeMirror-crosshair\b/.test(cm.display.lineDiv.className))
      showCrossHair(cm);
  }

  function showCrossHair(cm) {
    var lineDiv = cm.display.lineDiv;
    addClass(lineDiv, "CodeMirror-crosshair");

    function up(e) {
      if (e.keyCode == 18 || !e.altKey) {
        rmClass(lineDiv, "CodeMirror-crosshair");
        off(document, "keyup", up);
        off(document, "mouseover", up);
      }
    }
    on(document, "keyup", up);
    on(document, "mouseover", up);
  }

  function onKeyUp(e) {
    if (e.keyCode == 16) this.doc.sel.shift = false;
    signalDOMEvent(this, e);
  }

  function onKeyPress(e) {
    var cm = this;
    if (eventInWidget(cm.display, e) || signalDOMEvent(cm, e) || e.ctrlKey && !e.altKey || mac && e.metaKey) return;
    var keyCode = e.keyCode, charCode = e.charCode;
    if (presto && keyCode == lastStoppedKey) {lastStoppedKey = null; e_preventDefault(e); return;}
    if ((presto && (!e.which || e.which < 10)) && handleKeyBinding(cm, e)) return;
    var ch = String.fromCharCode(charCode == null ? keyCode : charCode);
    if (handleCharBinding(cm, e, ch)) return;
    cm.display.input.onKeyPress(e);
  }

  // FOCUS/BLUR EVENTS

  function delayBlurEvent(cm) {
    cm.state.delayingBlurEvent = true;
    setTimeout(function() {
      if (cm.state.delayingBlurEvent) {
        cm.state.delayingBlurEvent = false;
        onBlur(cm);
      }
    }, 100);
  }

  function onFocus(cm) {
    if (cm.state.delayingBlurEvent) cm.state.delayingBlurEvent = false;

    if (cm.options.readOnly == "nocursor") return;
    if (!cm.state.focused) {
      signal(cm, "focus", cm);
      cm.state.focused = true;
      addClass(cm.display.wrapper, "CodeMirror-focused");
      // This test prevents this from firing when a context
      // menu is closed (since the input reset would kill the
      // select-all detection hack)
      if (!cm.curOp && cm.display.selForContextMenu != cm.doc.sel) {
        cm.display.input.reset();
        if (webkit) setTimeout(function() { cm.display.input.reset(true); }, 20); // Issue #1730
      }
      cm.display.input.receivedFocus();
    }
    restartBlink(cm);
  }
  function onBlur(cm) {
    if (cm.state.delayingBlurEvent) return;

    if (cm.state.focused) {
      signal(cm, "blur", cm);
      cm.state.focused = false;
      rmClass(cm.display.wrapper, "CodeMirror-focused");
    }
    clearInterval(cm.display.blinker);
    setTimeout(function() {if (!cm.state.focused) cm.display.shift = false;}, 150);
  }

  // CONTEXT MENU HANDLING

  // To make the context menu work, we need to briefly unhide the
  // textarea (making it as unobtrusive as possible) to let the
  // right-click take effect on it.
  function onContextMenu(cm, e) {
    if (eventInWidget(cm.display, e) || contextMenuInGutter(cm, e)) return;
    if (signalDOMEvent(cm, e, "contextmenu")) return;
    cm.display.input.onContextMenu(e);
  }

  function contextMenuInGutter(cm, e) {
    if (!hasHandler(cm, "gutterContextMenu")) return false;
    return gutterEvent(cm, e, "gutterContextMenu", false, signal);
  }

  // UPDATING

  // Compute the position of the end of a change (its 'to' property
  // refers to the pre-change end).
  var changeEnd = CodeMirror.changeEnd = function(change) {
    if (!change.text) return change.to;
    return Pos(change.from.line + change.text.length - 1,
               lst(change.text).length + (change.text.length == 1 ? change.from.ch : 0));
  };

  // Adjust a position to refer to the post-change position of the
  // same text, or the end of the change if the change covers it.
  function adjustForChange(pos, change) {
    if (cmp(pos, change.from) < 0) return pos;
    if (cmp(pos, change.to) <= 0) return changeEnd(change);

    var line = pos.line + change.text.length - (change.to.line - change.from.line) - 1, ch = pos.ch;
    if (pos.line == change.to.line) ch += changeEnd(change).ch - change.to.ch;
    return Pos(line, ch);
  }

  function computeSelAfterChange(doc, change) {
    var out = [];
    for (var i = 0; i < doc.sel.ranges.length; i++) {
      var range = doc.sel.ranges[i];
      out.push(new Range(adjustForChange(range.anchor, change),
                         adjustForChange(range.head, change)));
    }
    return normalizeSelection(out, doc.sel.primIndex);
  }

  function offsetPos(pos, old, nw) {
    if (pos.line == old.line)
      return Pos(nw.line, pos.ch - old.ch + nw.ch);
    else
      return Pos(nw.line + (pos.line - old.line), pos.ch);
  }

  // Used by replaceSelections to allow moving the selection to the
  // start or around the replaced test. Hint may be "start" or "around".
  function computeReplacedSel(doc, changes, hint) {
    var out = [];
    var oldPrev = Pos(doc.first, 0), newPrev = oldPrev;
    for (var i = 0; i < changes.length; i++) {
      var change = changes[i];
      var from = offsetPos(change.from, oldPrev, newPrev);
      var to = offsetPos(changeEnd(change), oldPrev, newPrev);
      oldPrev = change.to;
      newPrev = to;
      if (hint == "around") {
        var range = doc.sel.ranges[i], inv = cmp(range.head, range.anchor) < 0;
        out[i] = new Range(inv ? to : from, inv ? from : to);
      } else {
        out[i] = new Range(from, from);
      }
    }
    return new Selection(out, doc.sel.primIndex);
  }

  // Allow "beforeChange" event handlers to influence a change
  function filterChange(doc, change, update) {
    var obj = {
      canceled: false,
      from: change.from,
      to: change.to,
      text: change.text,
      origin: change.origin,
      cancel: function() { this.canceled = true; }
    };
    if (update) obj.update = function(from, to, text, origin) {
      if (from) this.from = clipPos(doc, from);
      if (to) this.to = clipPos(doc, to);
      if (text) this.text = text;
      if (origin !== undefined) this.origin = origin;
    };
    signal(doc, "beforeChange", doc, obj);
    if (doc.cm) signal(doc.cm, "beforeChange", doc.cm, obj);

    if (obj.canceled) return null;
    return {from: obj.from, to: obj.to, text: obj.text, origin: obj.origin};
  }

  // Apply a change to a document, and add it to the document's
  // history, and propagating it to all linked documents.
  function makeChange(doc, change, ignoreReadOnly) {
    if (doc.cm) {
      if (!doc.cm.curOp) return operation(doc.cm, makeChange)(doc, change, ignoreReadOnly);
      if (doc.cm.state.suppressEdits) return;
    }

    if (hasHandler(doc, "beforeChange") || doc.cm && hasHandler(doc.cm, "beforeChange")) {
      change = filterChange(doc, change, true);
      if (!change) return;
    }

    // Possibly split or suppress the update based on the presence
    // of read-only spans in its range.
    var split = sawReadOnlySpans && !ignoreReadOnly && removeReadOnlyRanges(doc, change.from, change.to);
    if (split) {
      for (var i = split.length - 1; i >= 0; --i)
        makeChangeInner(doc, {from: split[i].from, to: split[i].to, text: i ? [""] : change.text});
    } else {
      makeChangeInner(doc, change);
    }
  }

  function makeChangeInner(doc, change) {
    if (change.text.length == 1 && change.text[0] == "" && cmp(change.from, change.to) == 0) return;
    var selAfter = computeSelAfterChange(doc, change);
    addChangeToHistory(doc, change, selAfter, doc.cm ? doc.cm.curOp.id : NaN);

    makeChangeSingleDoc(doc, change, selAfter, stretchSpansOverChange(doc, change));
    var rebased = [];

    linkedDocs(doc, function(doc, sharedHist) {
      if (!sharedHist && indexOf(rebased, doc.history) == -1) {
        rebaseHist(doc.history, change);
        rebased.push(doc.history);
      }
      makeChangeSingleDoc(doc, change, null, stretchSpansOverChange(doc, change));
    });
  }

  // Revert a change stored in a document's history.
  function makeChangeFromHistory(doc, type, allowSelectionOnly) {
    if (doc.cm && doc.cm.state.suppressEdits) return;

    var hist = doc.history, event, selAfter = doc.sel;
    var source = type == "undo" ? hist.done : hist.undone, dest = type == "undo" ? hist.undone : hist.done;

    // Verify that there is a useable event (so that ctrl-z won't
    // needlessly clear selection events)
    for (var i = 0; i < source.length; i++) {
      event = source[i];
      if (allowSelectionOnly ? event.ranges && !event.equals(doc.sel) : !event.ranges)
        break;
    }
    if (i == source.length) return;
    hist.lastOrigin = hist.lastSelOrigin = null;

    for (;;) {
      event = source.pop();
      if (event.ranges) {
        pushSelectionToHistory(event, dest);
        if (allowSelectionOnly && !event.equals(doc.sel)) {
          setSelection(doc, event, {clearRedo: false});
          return;
        }
        selAfter = event;
      }
      else break;
    }

    // Build up a reverse change object to add to the opposite history
    // stack (redo when undoing, and vice versa).
    var antiChanges = [];
    pushSelectionToHistory(selAfter, dest);
    dest.push({changes: antiChanges, generation: hist.generation});
    hist.generation = event.generation || ++hist.maxGeneration;

    var filter = hasHandler(doc, "beforeChange") || doc.cm && hasHandler(doc.cm, "beforeChange");

    for (var i = event.changes.length - 1; i >= 0; --i) {
      var change = event.changes[i];
      change.origin = type;
      if (filter && !filterChange(doc, change, false)) {
        source.length = 0;
        return;
      }

      antiChanges.push(historyChangeFromChange(doc, change));

      var after = i ? computeSelAfterChange(doc, change) : lst(source);
      makeChangeSingleDoc(doc, change, after, mergeOldSpans(doc, change));
      if (!i && doc.cm) doc.cm.scrollIntoView({from: change.from, to: changeEnd(change)});
      var rebased = [];

      // Propagate to the linked documents
      linkedDocs(doc, function(doc, sharedHist) {
        if (!sharedHist && indexOf(rebased, doc.history) == -1) {
          rebaseHist(doc.history, change);
          rebased.push(doc.history);
        }
        makeChangeSingleDoc(doc, change, null, mergeOldSpans(doc, change));
      });
    }
  }

  // Sub-views need their line numbers shifted when text is added
  // above or below them in the parent document.
  function shiftDoc(doc, distance) {
    if (distance == 0) return;
    doc.first += distance;
    doc.sel = new Selection(map(doc.sel.ranges, function(range) {
      return new Range(Pos(range.anchor.line + distance, range.anchor.ch),
                       Pos(range.head.line + distance, range.head.ch));
    }), doc.sel.primIndex);
    if (doc.cm) {
      regChange(doc.cm, doc.first, doc.first - distance, distance);
      for (var d = doc.cm.display, l = d.viewFrom; l < d.viewTo; l++)
        regLineChange(doc.cm, l, "gutter");
    }
  }

  // More lower-level change function, handling only a single document
  // (not linked ones).
  function makeChangeSingleDoc(doc, change, selAfter, spans) {
    if (doc.cm && !doc.cm.curOp)
      return operation(doc.cm, makeChangeSingleDoc)(doc, change, selAfter, spans);

    if (change.to.line < doc.first) {
      shiftDoc(doc, change.text.length - 1 - (change.to.line - change.from.line));
      return;
    }
    if (change.from.line > doc.lastLine()) return;

    // Clip the change to the size of this doc
    if (change.from.line < doc.first) {
      var shift = change.text.length - 1 - (doc.first - change.from.line);
      shiftDoc(doc, shift);
      change = {from: Pos(doc.first, 0), to: Pos(change.to.line + shift, change.to.ch),
                text: [lst(change.text)], origin: change.origin};
    }
    var last = doc.lastLine();
    if (change.to.line > last) {
      change = {from: change.from, to: Pos(last, getLine(doc, last).text.length),
                text: [change.text[0]], origin: change.origin};
    }

    change.removed = getBetween(doc, change.from, change.to);

    if (!selAfter) selAfter = computeSelAfterChange(doc, change);
    if (doc.cm) makeChangeSingleDocInEditor(doc.cm, change, spans);
    else updateDoc(doc, change, spans);
    setSelectionNoUndo(doc, selAfter, sel_dontScroll);
  }

  // Handle the interaction of a change to a document with the editor
  // that this document is part of.
  function makeChangeSingleDocInEditor(cm, change, spans) {
    var doc = cm.doc, display = cm.display, from = change.from, to = change.to;

    var recomputeMaxLength = false, checkWidthStart = from.line;
    if (!cm.options.lineWrapping) {
      checkWidthStart = lineNo(visualLine(getLine(doc, from.line)));
      doc.iter(checkWidthStart, to.line + 1, function(line) {
        if (line == display.maxLine) {
          recomputeMaxLength = true;
          return true;
        }
      });
    }

    if (doc.sel.contains(change.from, change.to) > -1)
      signalCursorActivity(cm);

    updateDoc(doc, change, spans, estimateHeight(cm));

    if (!cm.options.lineWrapping) {
      doc.iter(checkWidthStart, from.line + change.text.length, function(line) {
        var len = lineLength(line);
        if (len > display.maxLineLength) {
          display.maxLine = line;
          display.maxLineLength = len;
          display.maxLineChanged = true;
          recomputeMaxLength = false;
        }
      });
      if (recomputeMaxLength) cm.curOp.updateMaxLine = true;
    }

    // Adjust frontier, schedule worker
    doc.frontier = Math.min(doc.frontier, from.line);
    startWorker(cm, 400);

    var lendiff = change.text.length - (to.line - from.line) - 1;
    // Remember that these lines changed, for updating the display
    if (change.full)
      regChange(cm);
    else if (from.line == to.line && change.text.length == 1 && !isWholeLineUpdate(cm.doc, change))
      regLineChange(cm, from.line, "text");
    else
      regChange(cm, from.line, to.line + 1, lendiff);

    var changesHandler = hasHandler(cm, "changes"), changeHandler = hasHandler(cm, "change");
    if (changeHandler || changesHandler) {
      var obj = {
        from: from, to: to,
        text: change.text,
        removed: change.removed,
        origin: change.origin
      };
      if (changeHandler) signalLater(cm, "change", cm, obj);
      if (changesHandler) (cm.curOp.changeObjs || (cm.curOp.changeObjs = [])).push(obj);
    }
    cm.display.selForContextMenu = null;
  }

  function replaceRange(doc, code, from, to, origin) {
    if (!to) to = from;
    if (cmp(to, from) < 0) { var tmp = to; to = from; from = tmp; }
    if (typeof code == "string") code = doc.splitLines(code);
    makeChange(doc, {from: from, to: to, text: code, origin: origin});
  }

  // SCROLLING THINGS INTO VIEW

  // If an editor sits on the top or bottom of the window, partially
  // scrolled out of view, this ensures that the cursor is visible.
  function maybeScrollWindow(cm, coords) {
    if (signalDOMEvent(cm, "scrollCursorIntoView")) return;

    var display = cm.display, box = display.sizer.getBoundingClientRect(), doScroll = null;
    if (coords.top + box.top < 0) doScroll = true;
    else if (coords.bottom + box.top > (window.innerHeight || document.documentElement.clientHeight)) doScroll = false;
    if (doScroll != null && !phantom) {
      var scrollNode = elt("div", "\u200b", null, "position: absolute; top: " +
                           (coords.top - display.viewOffset - paddingTop(cm.display)) + "px; height: " +
                           (coords.bottom - coords.top + scrollGap(cm) + display.barHeight) + "px; left: " +
                           coords.left + "px; width: 2px;");
      cm.display.lineSpace.appendChild(scrollNode);
      scrollNode.scrollIntoView(doScroll);
      cm.display.lineSpace.removeChild(scrollNode);
    }
  }

  // Scroll a given position into view (immediately), verifying that
  // it actually became visible (as line heights are accurately
  // measured, the position of something may 'drift' during drawing).
  function scrollPosIntoView(cm, pos, end, margin) {
    if (margin == null) margin = 0;
    for (var limit = 0; limit < 5; limit++) {
      var changed = false, coords = cursorCoords(cm, pos);
      var endCoords = !end || end == pos ? coords : cursorCoords(cm, end);
      var scrollPos = calculateScrollPos(cm, Math.min(coords.left, endCoords.left),
                                         Math.min(coords.top, endCoords.top) - margin,
                                         Math.max(coords.left, endCoords.left),
                                         Math.max(coords.bottom, endCoords.bottom) + margin);
      var startTop = cm.doc.scrollTop, startLeft = cm.doc.scrollLeft;
      if (scrollPos.scrollTop != null) {
        setScrollTop(cm, scrollPos.scrollTop);
        if (Math.abs(cm.doc.scrollTop - startTop) > 1) changed = true;
      }
      if (scrollPos.scrollLeft != null) {
        setScrollLeft(cm, scrollPos.scrollLeft);
        if (Math.abs(cm.doc.scrollLeft - startLeft) > 1) changed = true;
      }
      if (!changed) break;
    }
    return coords;
  }

  // Scroll a given set of coordinates into view (immediately).
  function scrollIntoView(cm, x1, y1, x2, y2) {
    var scrollPos = calculateScrollPos(cm, x1, y1, x2, y2);
    if (scrollPos.scrollTop != null) setScrollTop(cm, scrollPos.scrollTop);
    if (scrollPos.scrollLeft != null) setScrollLeft(cm, scrollPos.scrollLeft);
  }

  // Calculate a new scroll position needed to scroll the given
  // rectangle into view. Returns an object with scrollTop and
  // scrollLeft properties. When these are undefined, the
  // vertical/horizontal position does not need to be adjusted.
  function calculateScrollPos(cm, x1, y1, x2, y2) {
    var display = cm.display, snapMargin = textHeight(cm.display);
    if (y1 < 0) y1 = 0;
    var screentop = cm.curOp && cm.curOp.scrollTop != null ? cm.curOp.scrollTop : display.scroller.scrollTop;
    var screen = displayHeight(cm), result = {};
    if (y2 - y1 > screen) y2 = y1 + screen;
    var docBottom = cm.doc.height + paddingVert(display);
    var atTop = y1 < snapMargin, atBottom = y2 > docBottom - snapMargin;
    if (y1 < screentop) {
      result.scrollTop = atTop ? 0 : y1;
    } else if (y2 > screentop + screen) {
      var newTop = Math.min(y1, (atBottom ? docBottom : y2) - screen);
      if (newTop != screentop) result.scrollTop = newTop;
    }

    var screenleft = cm.curOp && cm.curOp.scrollLeft != null ? cm.curOp.scrollLeft : display.scroller.scrollLeft;
    var screenw = displayWidth(cm) - (cm.options.fixedGutter ? display.gutters.offsetWidth : 0);
    var tooWide = x2 - x1 > screenw;
    if (tooWide) x2 = x1 + screenw;
    if (x1 < 10)
      result.scrollLeft = 0;
    else if (x1 < screenleft)
      result.scrollLeft = Math.max(0, x1 - (tooWide ? 0 : 10));
    else if (x2 > screenw + screenleft - 3)
      result.scrollLeft = x2 + (tooWide ? 0 : 10) - screenw;
    return result;
  }

  // Store a relative adjustment to the scroll position in the current
  // operation (to be applied when the operation finishes).
  function addToScrollPos(cm, left, top) {
    if (left != null || top != null) resolveScrollToPos(cm);
    if (left != null)
      cm.curOp.scrollLeft = (cm.curOp.scrollLeft == null ? cm.doc.scrollLeft : cm.curOp.scrollLeft) + left;
    if (top != null)
      cm.curOp.scrollTop = (cm.curOp.scrollTop == null ? cm.doc.scrollTop : cm.curOp.scrollTop) + top;
  }

  // Make sure that at the end of the operation the current cursor is
  // shown.
  function ensureCursorVisible(cm) {
    resolveScrollToPos(cm);
    var cur = cm.getCursor(), from = cur, to = cur;
    if (!cm.options.lineWrapping) {
      from = cur.ch ? Pos(cur.line, cur.ch - 1) : cur;
      to = Pos(cur.line, cur.ch + 1);
    }
    cm.curOp.scrollToPos = {from: from, to: to, margin: cm.options.cursorScrollMargin, isCursor: true};
  }

  // When an operation has its scrollToPos property set, and another
  // scroll action is applied before the end of the operation, this
  // 'simulates' scrolling that position into view in a cheap way, so
  // that the effect of intermediate scroll commands is not ignored.
  function resolveScrollToPos(cm) {
    var range = cm.curOp.scrollToPos;
    if (range) {
      cm.curOp.scrollToPos = null;
      var from = estimateCoords(cm, range.from), to = estimateCoords(cm, range.to);
      var sPos = calculateScrollPos(cm, Math.min(from.left, to.left),
                                    Math.min(from.top, to.top) - range.margin,
                                    Math.max(from.right, to.right),
                                    Math.max(from.bottom, to.bottom) + range.margin);
      cm.scrollTo(sPos.scrollLeft, sPos.scrollTop);
    }
  }

  // API UTILITIES

  // Indent the given line. The how parameter can be "smart",
  // "add"/null, "subtract", or "prev". When aggressive is false
  // (typically set to true for forced single-line indents), empty
  // lines are not indented, and places where the mode returns Pass
  // are left alone.
  function indentLine(cm, n, how, aggressive) {
    var doc = cm.doc, state;
    if (how == null) how = "add";
    if (how == "smart") {
      // Fall back to "prev" when the mode doesn't have an indentation
      // method.
      if (!doc.mode.indent) how = "prev";
      else state = getStateBefore(cm, n);
    }

    var tabSize = cm.options.tabSize;
    var line = getLine(doc, n), curSpace = countColumn(line.text, null, tabSize);
    if (line.stateAfter) line.stateAfter = null;
    var curSpaceString = line.text.match(/^\s*/)[0], indentation;
    if (!aggressive && !/\S/.test(line.text)) {
      indentation = 0;
      how = "not";
    } else if (how == "smart") {
      indentation = doc.mode.indent(state, line.text.slice(curSpaceString.length), line.text);
      if (indentation == Pass || indentation > 150) {
        if (!aggressive) return;
        how = "prev";
      }
    }
    if (how == "prev") {
      if (n > doc.first) indentation = countColumn(getLine(doc, n-1).text, null, tabSize);
      else indentation = 0;
    } else if (how == "add") {
      indentation = curSpace + cm.options.indentUnit;
    } else if (how == "subtract") {
      indentation = curSpace - cm.options.indentUnit;
    } else if (typeof how == "number") {
      indentation = curSpace + how;
    }
    indentation = Math.max(0, indentation);

    var indentString = "", pos = 0;
    if (cm.options.indentWithTabs)
      for (var i = Math.floor(indentation / tabSize); i; --i) {pos += tabSize; indentString += "\t";}
    if (pos < indentation) indentString += spaceStr(indentation - pos);

    if (indentString != curSpaceString) {
      replaceRange(doc, indentString, Pos(n, 0), Pos(n, curSpaceString.length), "+input");
      line.stateAfter = null;
      return true;
    } else {
      // Ensure that, if the cursor was in the whitespace at the start
      // of the line, it is moved to the end of that space.
      for (var i = 0; i < doc.sel.ranges.length; i++) {
        var range = doc.sel.ranges[i];
        if (range.head.line == n && range.head.ch < curSpaceString.length) {
          var pos = Pos(n, curSpaceString.length);
          replaceOneSelection(doc, i, new Range(pos, pos));
          break;
        }
      }
    }
  }

  // Utility for applying a change to a line by handle or number,
  // returning the number and optionally registering the line as
  // changed.
  function changeLine(doc, handle, changeType, op) {
    var no = handle, line = handle;
    if (typeof handle == "number") line = getLine(doc, clipLine(doc, handle));
    else no = lineNo(handle);
    if (no == null) return null;
    if (op(line, no) && doc.cm) regLineChange(doc.cm, no, changeType);
    return line;
  }

  // Helper for deleting text near the selection(s), used to implement
  // backspace, delete, and similar functionality.
  function deleteNearSelection(cm, compute) {
    var ranges = cm.doc.sel.ranges, kill = [];
    // Build up a set of ranges to kill first, merging overlapping
    // ranges.
    for (var i = 0; i < ranges.length; i++) {
      var toKill = compute(ranges[i]);
      while (kill.length && cmp(toKill.from, lst(kill).to) <= 0) {
        var replaced = kill.pop();
        if (cmp(replaced.from, toKill.from) < 0) {
          toKill.from = replaced.from;
          break;
        }
      }
      kill.push(toKill);
    }
    // Next, remove those actual ranges.
    runInOp(cm, function() {
      for (var i = kill.length - 1; i >= 0; i--)
        replaceRange(cm.doc, "", kill[i].from, kill[i].to, "+delete");
      ensureCursorVisible(cm);
    });
  }

  // Used for horizontal relative motion. Dir is -1 or 1 (left or
  // right), unit can be "char", "column" (like char, but doesn't
  // cross line boundaries), "word" (across next word), or "group" (to
  // the start of next group of word or non-word-non-whitespace
  // chars). The visually param controls whether, in right-to-left
  // text, direction 1 means to move towards the next index in the
  // string, or towards the character to the right of the current
  // position. The resulting position will have a hitSide=true
  // property if it reached the end of the document.
  function findPosH(doc, pos, dir, unit, visually) {
    var line = pos.line, ch = pos.ch, origDir = dir;
    var lineObj = getLine(doc, line);
    var possible = true;
    function findNextLine() {
      var l = line + dir;
      if (l < doc.first || l >= doc.first + doc.size) return (possible = false);
      line = l;
      return lineObj = getLine(doc, l);
    }
    function moveOnce(boundToLine) {
      var next = (visually ? moveVisually : moveLogically)(lineObj, ch, dir, true);
      if (next == null) {
        if (!boundToLine && findNextLine()) {
          if (visually) ch = (dir < 0 ? lineRight : lineLeft)(lineObj);
          else ch = dir < 0 ? lineObj.text.length : 0;
        } else return (possible = false);
      } else ch = next;
      return true;
    }

    if (unit == "char") moveOnce();
    else if (unit == "column") moveOnce(true);
    else if (unit == "word" || unit == "group") {
      var sawType = null, group = unit == "group";
      var helper = doc.cm && doc.cm.getHelper(pos, "wordChars");
      for (var first = true;; first = false) {
        if (dir < 0 && !moveOnce(!first)) break;
        var cur = lineObj.text.charAt(ch) || "\n";
        var type = isWordChar(cur, helper) ? "w"
          : group && cur == "\n" ? "n"
          : !group || /\s/.test(cur) ? null
          : "p";
        if (group && !first && !type) type = "s";
        if (sawType && sawType != type) {
          if (dir < 0) {dir = 1; moveOnce();}
          break;
        }

        if (type) sawType = type;
        if (dir > 0 && !moveOnce(!first)) break;
      }
    }
    var result = skipAtomic(doc, Pos(line, ch), origDir, true);
    if (!possible) result.hitSide = true;
    return result;
  }

  // For relative vertical movement. Dir may be -1 or 1. Unit can be
  // "page" or "line". The resulting position will have a hitSide=true
  // property if it reached the end of the document.
  function findPosV(cm, pos, dir, unit) {
    var doc = cm.doc, x = pos.left, y;
    if (unit == "page") {
      var pageSize = Math.min(cm.display.wrapper.clientHeight, window.innerHeight || document.documentElement.clientHeight);
      y = pos.top + dir * (pageSize - (dir < 0 ? 1.5 : .5) * textHeight(cm.display));
    } else if (unit == "line") {
      y = dir > 0 ? pos.bottom + 3 : pos.top - 3;
    }
    for (;;) {
      var target = coordsChar(cm, x, y);
      if (!target.outside) break;
      if (dir < 0 ? y <= 0 : y >= doc.height) { target.hitSide = true; break; }
      y += dir * 5;
    }
    return target;
  }

  // EDITOR METHODS

  // The publicly visible API. Note that methodOp(f) means
  // 'wrap f in an operation, performed on its `this` parameter'.

  // This is not the complete set of editor methods. Most of the
  // methods defined on the Doc type are also injected into
  // CodeMirror.prototype, for backwards compatibility and
  // convenience.

  CodeMirror.prototype = {
    constructor: CodeMirror,
    focus: function(){window.focus(); this.display.input.focus();},

    setOption: function(option, value) {
      var options = this.options, old = options[option];
      if (options[option] == value && option != "mode") return;
      options[option] = value;
      if (optionHandlers.hasOwnProperty(option))
        operation(this, optionHandlers[option])(this, value, old);
    },

    getOption: function(option) {return this.options[option];},
    getDoc: function() {return this.doc;},

    addKeyMap: function(map, bottom) {
      this.state.keyMaps[bottom ? "push" : "unshift"](getKeyMap(map));
    },
    removeKeyMap: function(map) {
      var maps = this.state.keyMaps;
      for (var i = 0; i < maps.length; ++i)
        if (maps[i] == map || maps[i].name == map) {
          maps.splice(i, 1);
          return true;
        }
    },

    addOverlay: methodOp(function(spec, options) {
      var mode = spec.token ? spec : CodeMirror.getMode(this.options, spec);
      if (mode.startState) throw new Error("Overlays may not be stateful.");
      this.state.overlays.push({mode: mode, modeSpec: spec, opaque: options && options.opaque});
      this.state.modeGen++;
      regChange(this);
    }),
    removeOverlay: methodOp(function(spec) {
      var overlays = this.state.overlays;
      for (var i = 0; i < overlays.length; ++i) {
        var cur = overlays[i].modeSpec;
        if (cur == spec || typeof spec == "string" && cur.name == spec) {
          overlays.splice(i, 1);
          this.state.modeGen++;
          regChange(this);
          return;
        }
      }
    }),

    indentLine: methodOp(function(n, dir, aggressive) {
      if (typeof dir != "string" && typeof dir != "number") {
        if (dir == null) dir = this.options.smartIndent ? "smart" : "prev";
        else dir = dir ? "add" : "subtract";
      }
      if (isLine(this.doc, n)) indentLine(this, n, dir, aggressive);
    }),
    indentSelection: methodOp(function(how) {
      var ranges = this.doc.sel.ranges, end = -1;
      for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        if (!range.empty()) {
          var from = range.from(), to = range.to();
          var start = Math.max(end, from.line);
          end = Math.min(this.lastLine(), to.line - (to.ch ? 0 : 1)) + 1;
          for (var j = start; j < end; ++j)
            indentLine(this, j, how);
          var newRanges = this.doc.sel.ranges;
          if (from.ch == 0 && ranges.length == newRanges.length && newRanges[i].from().ch > 0)
            replaceOneSelection(this.doc, i, new Range(from, newRanges[i].to()), sel_dontScroll);
        } else if (range.head.line > end) {
          indentLine(this, range.head.line, how, true);
          end = range.head.line;
          if (i == this.doc.sel.primIndex) ensureCursorVisible(this);
        }
      }
    }),

    // Fetch the parser token for a given character. Useful for hacks
    // that want to inspect the mode state (say, for completion).
    getTokenAt: function(pos, precise) {
      return takeToken(this, pos, precise);
    },

    getLineTokens: function(line, precise) {
      return takeToken(this, Pos(line), precise, true);
    },

    getTokenTypeAt: function(pos) {
      pos = clipPos(this.doc, pos);
      var styles = getLineStyles(this, getLine(this.doc, pos.line));
      var before = 0, after = (styles.length - 1) / 2, ch = pos.ch;
      var type;
      if (ch == 0) type = styles[2];
      else for (;;) {
        var mid = (before + after) >> 1;
        if ((mid ? styles[mid * 2 - 1] : 0) >= ch) after = mid;
        else if (styles[mid * 2 + 1] < ch) before = mid + 1;
        else { type = styles[mid * 2 + 2]; break; }
      }
      var cut = type ? type.indexOf("cm-overlay ") : -1;
      return cut < 0 ? type : cut == 0 ? null : type.slice(0, cut - 1);
    },

    getModeAt: function(pos) {
      var mode = this.doc.mode;
      if (!mode.innerMode) return mode;
      return CodeMirror.innerMode(mode, this.getTokenAt(pos).state).mode;
    },

    getHelper: function(pos, type) {
      return this.getHelpers(pos, type)[0];
    },

    getHelpers: function(pos, type) {
      var found = [];
      if (!helpers.hasOwnProperty(type)) return found;
      var help = helpers[type], mode = this.getModeAt(pos);
      if (typeof mode[type] == "string") {
        if (help[mode[type]]) found.push(help[mode[type]]);
      } else if (mode[type]) {
        for (var i = 0; i < mode[type].length; i++) {
          var val = help[mode[type][i]];
          if (val) found.push(val);
        }
      } else if (mode.helperType && help[mode.helperType]) {
        found.push(help[mode.helperType]);
      } else if (help[mode.name]) {
        found.push(help[mode.name]);
      }
      for (var i = 0; i < help._global.length; i++) {
        var cur = help._global[i];
        if (cur.pred(mode, this) && indexOf(found, cur.val) == -1)
          found.push(cur.val);
      }
      return found;
    },

    getStateAfter: function(line, precise) {
      var doc = this.doc;
      line = clipLine(doc, line == null ? doc.first + doc.size - 1: line);
      return getStateBefore(this, line + 1, precise);
    },

    cursorCoords: function(start, mode) {
      var pos, range = this.doc.sel.primary();
      if (start == null) pos = range.head;
      else if (typeof start == "object") pos = clipPos(this.doc, start);
      else pos = start ? range.from() : range.to();
      return cursorCoords(this, pos, mode || "page");
    },

    charCoords: function(pos, mode) {
      return charCoords(this, clipPos(this.doc, pos), mode || "page");
    },

    coordsChar: function(coords, mode) {
      coords = fromCoordSystem(this, coords, mode || "page");
      return coordsChar(this, coords.left, coords.top);
    },

    lineAtHeight: function(height, mode) {
      height = fromCoordSystem(this, {top: height, left: 0}, mode || "page").top;
      return lineAtHeight(this.doc, height + this.display.viewOffset);
    },
    heightAtLine: function(line, mode) {
      var end = false, lineObj;
      if (typeof line == "number") {
        var last = this.doc.first + this.doc.size - 1;
        if (line < this.doc.first) line = this.doc.first;
        else if (line > last) { line = last; end = true; }
        lineObj = getLine(this.doc, line);
      } else {
        lineObj = line;
      }
      return intoCoordSystem(this, lineObj, {top: 0, left: 0}, mode || "page").top +
        (end ? this.doc.height - heightAtLine(lineObj) : 0);
    },

    defaultTextHeight: function() { return textHeight(this.display); },
    defaultCharWidth: function() { return charWidth(this.display); },

    setGutterMarker: methodOp(function(line, gutterID, value) {
      return changeLine(this.doc, line, "gutter", function(line) {
        var markers = line.gutterMarkers || (line.gutterMarkers = {});
        markers[gutterID] = value;
        if (!value && isEmpty(markers)) line.gutterMarkers = null;
        return true;
      });
    }),

    clearGutter: methodOp(function(gutterID) {
      var cm = this, doc = cm.doc, i = doc.first;
      doc.iter(function(line) {
        if (line.gutterMarkers && line.gutterMarkers[gutterID]) {
          line.gutterMarkers[gutterID] = null;
          regLineChange(cm, i, "gutter");
          if (isEmpty(line.gutterMarkers)) line.gutterMarkers = null;
        }
        ++i;
      });
    }),

    lineInfo: function(line) {
      if (typeof line == "number") {
        if (!isLine(this.doc, line)) return null;
        var n = line;
        line = getLine(this.doc, line);
        if (!line) return null;
      } else {
        var n = lineNo(line);
        if (n == null) return null;
      }
      return {line: n, handle: line, text: line.text, gutterMarkers: line.gutterMarkers,
              textClass: line.textClass, bgClass: line.bgClass, wrapClass: line.wrapClass,
              widgets: line.widgets};
    },

    getViewport: function() { return {from: this.display.viewFrom, to: this.display.viewTo};},

    addWidget: function(pos, node, scroll, vert, horiz) {
      var display = this.display;
      pos = cursorCoords(this, clipPos(this.doc, pos));
      var top = pos.bottom, left = pos.left;
      node.style.position = "absolute";
      node.setAttribute("cm-ignore-events", "true");
      this.display.input.setUneditable(node);
      display.sizer.appendChild(node);
      if (vert == "over") {
        top = pos.top;
      } else if (vert == "above" || vert == "near") {
        var vspace = Math.max(display.wrapper.clientHeight, this.doc.height),
        hspace = Math.max(display.sizer.clientWidth, display.lineSpace.clientWidth);
        // Default to positioning above (if specified and possible); otherwise default to positioning below
        if ((vert == 'above' || pos.bottom + node.offsetHeight > vspace) && pos.top > node.offsetHeight)
          top = pos.top - node.offsetHeight;
        else if (pos.bottom + node.offsetHeight <= vspace)
          top = pos.bottom;
        if (left + node.offsetWidth > hspace)
          left = hspace - node.offsetWidth;
      }
      node.style.top = top + "px";
      node.style.left = node.style.right = "";
      if (horiz == "right") {
        left = display.sizer.clientWidth - node.offsetWidth;
        node.style.right = "0px";
      } else {
        if (horiz == "left") left = 0;
        else if (horiz == "middle") left = (display.sizer.clientWidth - node.offsetWidth) / 2;
        node.style.left = left + "px";
      }
      if (scroll)
        scrollIntoView(this, left, top, left + node.offsetWidth, top + node.offsetHeight);
    },

    triggerOnKeyDown: methodOp(onKeyDown),
    triggerOnKeyPress: methodOp(onKeyPress),
    triggerOnKeyUp: onKeyUp,

    execCommand: function(cmd) {
      if (commands.hasOwnProperty(cmd))
        return commands[cmd].call(null, this);
    },

    triggerElectric: methodOp(function(text) { triggerElectric(this, text); }),

    findPosH: function(from, amount, unit, visually) {
      var dir = 1;
      if (amount < 0) { dir = -1; amount = -amount; }
      for (var i = 0, cur = clipPos(this.doc, from); i < amount; ++i) {
        cur = findPosH(this.doc, cur, dir, unit, visually);
        if (cur.hitSide) break;
      }
      return cur;
    },

    moveH: methodOp(function(dir, unit) {
      var cm = this;
      cm.extendSelectionsBy(function(range) {
        if (cm.display.shift || cm.doc.extend || range.empty())
          return findPosH(cm.doc, range.head, dir, unit, cm.options.rtlMoveVisually);
        else
          return dir < 0 ? range.from() : range.to();
      }, sel_move);
    }),

    deleteH: methodOp(function(dir, unit) {
      var sel = this.doc.sel, doc = this.doc;
      if (sel.somethingSelected())
        doc.replaceSelection("", null, "+delete");
      else
        deleteNearSelection(this, function(range) {
          var other = findPosH(doc, range.head, dir, unit, false);
          return dir < 0 ? {from: other, to: range.head} : {from: range.head, to: other};
        });
    }),

    findPosV: function(from, amount, unit, goalColumn) {
      var dir = 1, x = goalColumn;
      if (amount < 0) { dir = -1; amount = -amount; }
      for (var i = 0, cur = clipPos(this.doc, from); i < amount; ++i) {
        var coords = cursorCoords(this, cur, "div");
        if (x == null) x = coords.left;
        else coords.left = x;
        cur = findPosV(this, coords, dir, unit);
        if (cur.hitSide) break;
      }
      return cur;
    },

    moveV: methodOp(function(dir, unit) {
      var cm = this, doc = this.doc, goals = [];
      var collapse = !cm.display.shift && !doc.extend && doc.sel.somethingSelected();
      doc.extendSelectionsBy(function(range) {
        if (collapse)
          return dir < 0 ? range.from() : range.to();
        var headPos = cursorCoords(cm, range.head, "div");
        if (range.goalColumn != null) headPos.left = range.goalColumn;
        goals.push(headPos.left);
        var pos = findPosV(cm, headPos, dir, unit);
        if (unit == "page" && range == doc.sel.primary())
          addToScrollPos(cm, null, charCoords(cm, pos, "div").top - headPos.top);
        return pos;
      }, sel_move);
      if (goals.length) for (var i = 0; i < doc.sel.ranges.length; i++)
        doc.sel.ranges[i].goalColumn = goals[i];
    }),

    // Find the word at the given position (as returned by coordsChar).
    findWordAt: function(pos) {
      var doc = this.doc, line = getLine(doc, pos.line).text;
      var start = pos.ch, end = pos.ch;
      if (line) {
        var helper = this.getHelper(pos, "wordChars");
        if ((pos.xRel < 0 || end == line.length) && start) --start; else ++end;
        var startChar = line.charAt(start);
        var check = isWordChar(startChar, helper)
          ? function(ch) { return isWordChar(ch, helper); }
          : /\s/.test(startChar) ? function(ch) {return /\s/.test(ch);}
          : function(ch) {return !/\s/.test(ch) && !isWordChar(ch);};
        while (start > 0 && check(line.charAt(start - 1))) --start;
        while (end < line.length && check(line.charAt(end))) ++end;
      }
      return new Range(Pos(pos.line, start), Pos(pos.line, end));
    },

    toggleOverwrite: function(value) {
      if (value != null && value == this.state.overwrite) return;
      if (this.state.overwrite = !this.state.overwrite)
        addClass(this.display.cursorDiv, "CodeMirror-overwrite");
      else
        rmClass(this.display.cursorDiv, "CodeMirror-overwrite");

      signal(this, "overwriteToggle", this, this.state.overwrite);
    },
    hasFocus: function() { return this.display.input.getField() == activeElt(); },

    scrollTo: methodOp(function(x, y) {
      if (x != null || y != null) resolveScrollToPos(this);
      if (x != null) this.curOp.scrollLeft = x;
      if (y != null) this.curOp.scrollTop = y;
    }),
    getScrollInfo: function() {
      var scroller = this.display.scroller;
      return {left: scroller.scrollLeft, top: scroller.scrollTop,
              height: scroller.scrollHeight - scrollGap(this) - this.display.barHeight,
              width: scroller.scrollWidth - scrollGap(this) - this.display.barWidth,
              clientHeight: displayHeight(this), clientWidth: displayWidth(this)};
    },

    scrollIntoView: methodOp(function(range, margin) {
      if (range == null) {
        range = {from: this.doc.sel.primary().head, to: null};
        if (margin == null) margin = this.options.cursorScrollMargin;
      } else if (typeof range == "number") {
        range = {from: Pos(range, 0), to: null};
      } else if (range.from == null) {
        range = {from: range, to: null};
      }
      if (!range.to) range.to = range.from;
      range.margin = margin || 0;

      if (range.from.line != null) {
        resolveScrollToPos(this);
        this.curOp.scrollToPos = range;
      } else {
        var sPos = calculateScrollPos(this, Math.min(range.from.left, range.to.left),
                                      Math.min(range.from.top, range.to.top) - range.margin,
                                      Math.max(range.from.right, range.to.right),
                                      Math.max(range.from.bottom, range.to.bottom) + range.margin);
        this.scrollTo(sPos.scrollLeft, sPos.scrollTop);
      }
    }),

    setSize: methodOp(function(width, height) {
      var cm = this;
      function interpret(val) {
        return typeof val == "number" || /^\d+$/.test(String(val)) ? val + "px" : val;
      }
      if (width != null) cm.display.wrapper.style.width = interpret(width);
      if (height != null) cm.display.wrapper.style.height = interpret(height);
      if (cm.options.lineWrapping) clearLineMeasurementCache(this);
      var lineNo = cm.display.viewFrom;
      cm.doc.iter(lineNo, cm.display.viewTo, function(line) {
        if (line.widgets) for (var i = 0; i < line.widgets.length; i++)
          if (line.widgets[i].noHScroll) { regLineChange(cm, lineNo, "widget"); break; }
        ++lineNo;
      });
      cm.curOp.forceUpdate = true;
      signal(cm, "refresh", this);
    }),

    operation: function(f){return runInOp(this, f);},

    refresh: methodOp(function() {
      var oldHeight = this.display.cachedTextHeight;
      regChange(this);
      this.curOp.forceUpdate = true;
      clearCaches(this);
      this.scrollTo(this.doc.scrollLeft, this.doc.scrollTop);
      updateGutterSpace(this);
      if (oldHeight == null || Math.abs(oldHeight - textHeight(this.display)) > .5)
        estimateLineHeights(this);
      signal(this, "refresh", this);
    }),

    swapDoc: methodOp(function(doc) {
      var old = this.doc;
      old.cm = null;
      attachDoc(this, doc);
      clearCaches(this);
      this.display.input.reset();
      this.scrollTo(doc.scrollLeft, doc.scrollTop);
      this.curOp.forceScroll = true;
      signalLater(this, "swapDoc", this, old);
      return old;
    }),

    getInputField: function(){return this.display.input.getField();},
    getWrapperElement: function(){return this.display.wrapper;},
    getScrollerElement: function(){return this.display.scroller;},
    getGutterElement: function(){return this.display.gutters;}
  };
  eventMixin(CodeMirror);

  // OPTION DEFAULTS

  // The default configuration options.
  var defaults = CodeMirror.defaults = {};
  // Functions to run when options are changed.
  var optionHandlers = CodeMirror.optionHandlers = {};

  function option(name, deflt, handle, notOnInit) {
    CodeMirror.defaults[name] = deflt;
    if (handle) optionHandlers[name] =
      notOnInit ? function(cm, val, old) {if (old != Init) handle(cm, val, old);} : handle;
  }

  // Passed to option handlers when there is no old value.
  var Init = CodeMirror.Init = {toString: function(){return "CodeMirror.Init";}};

  // These two are, on init, called from the constructor because they
  // have to be initialized before the editor can start at all.
  option("value", "", function(cm, val) {
    cm.setValue(val);
  }, true);
  option("mode", null, function(cm, val) {
    cm.doc.modeOption = val;
    loadMode(cm);
  }, true);

  option("indentUnit", 2, loadMode, true);
  option("indentWithTabs", false);
  option("smartIndent", true);
  option("tabSize", 4, function(cm) {
    resetModeState(cm);
    clearCaches(cm);
    regChange(cm);
  }, true);
  option("lineSeparator", null, function(cm, val) {
    cm.doc.lineSep = val;
    if (!val) return;
    var newBreaks = [], lineNo = cm.doc.first;
    cm.doc.iter(function(line) {
      for (var pos = 0;;) {
        var found = line.text.indexOf(val, pos);
        if (found == -1) break;
        pos = found + val.length;
        newBreaks.push(Pos(lineNo, found));
      }
      lineNo++;
    });
    for (var i = newBreaks.length - 1; i >= 0; i--)
      replaceRange(cm.doc, val, newBreaks[i], Pos(newBreaks[i].line, newBreaks[i].ch + val.length))
  });
  option("specialChars", /[\t\u0000-\u0019\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, function(cm, val, old) {
    cm.state.specialChars = new RegExp(val.source + (val.test("\t") ? "" : "|\t"), "g");
    if (old != CodeMirror.Init) cm.refresh();
  });
  option("specialCharPlaceholder", defaultSpecialCharPlaceholder, function(cm) {cm.refresh();}, true);
  option("electricChars", true);
  option("inputStyle", mobile ? "contenteditable" : "textarea", function() {
    throw new Error("inputStyle can not (yet) be changed in a running editor"); // FIXME
  }, true);
  option("rtlMoveVisually", !windows);
  option("wholeLineUpdateBefore", true);

  option("theme", "default", function(cm) {
    themeChanged(cm);
    guttersChanged(cm);
  }, true);
  option("keyMap", "default", function(cm, val, old) {
    var next = getKeyMap(val);
    var prev = old != CodeMirror.Init && getKeyMap(old);
    if (prev && prev.detach) prev.detach(cm, next);
    if (next.attach) next.attach(cm, prev || null);
  });
  option("extraKeys", null);

  option("lineWrapping", false, wrappingChanged, true);
  option("gutters", [], function(cm) {
    setGuttersForLineNumbers(cm.options);
    guttersChanged(cm);
  }, true);
  option("fixedGutter", true, function(cm, val) {
    cm.display.gutters.style.left = val ? compensateForHScroll(cm.display) + "px" : "0";
    cm.refresh();
  }, true);
  option("coverGutterNextToScrollbar", false, function(cm) {updateScrollbars(cm);}, true);
  option("scrollbarStyle", "native", function(cm) {
    initScrollbars(cm);
    updateScrollbars(cm);
    cm.display.scrollbars.setScrollTop(cm.doc.scrollTop);
    cm.display.scrollbars.setScrollLeft(cm.doc.scrollLeft);
  }, true);
  option("lineNumbers", false, function(cm) {
    setGuttersForLineNumbers(cm.options);
    guttersChanged(cm);
  }, true);
  option("firstLineNumber", 1, guttersChanged, true);
  option("lineNumberFormatter", function(integer) {return integer;}, guttersChanged, true);
  option("showCursorWhenSelecting", false, updateSelection, true);

  option("resetSelectionOnContextMenu", true);
  option("lineWiseCopyCut", true);

  option("readOnly", false, function(cm, val) {
    if (val == "nocursor") {
      onBlur(cm);
      cm.display.input.blur();
      cm.display.disabled = true;
    } else {
      cm.display.disabled = false;
    }
    cm.display.input.readOnlyChanged(val)
  });
  option("disableInput", false, function(cm, val) {if (!val) cm.display.input.reset();}, true);
  option("dragDrop", true, dragDropChanged);
  option("allowDropFileTypes", null);

  option("cursorBlinkRate", 530);
  option("cursorScrollMargin", 0);
  option("cursorHeight", 1, updateSelection, true);
  option("singleCursorHeightPerLine", true, updateSelection, true);
  option("workTime", 100);
  option("workDelay", 100);
  option("flattenSpans", true, resetModeState, true);
  option("addModeClass", false, resetModeState, true);
  option("pollInterval", 100);
  option("undoDepth", 200, function(cm, val){cm.doc.history.undoDepth = val;});
  option("historyEventDelay", 1250);
  option("viewportMargin", 10, function(cm){cm.refresh();}, true);
  option("maxHighlightLength", 10000, resetModeState, true);
  option("moveInputWithCursor", true, function(cm, val) {
    if (!val) cm.display.input.resetPosition();
  });

  option("tabindex", null, function(cm, val) {
    cm.display.input.getField().tabIndex = val || "";
  });
  option("autofocus", null);

  // MODE DEFINITION AND QUERYING

  // Known modes, by name and by MIME
  var modes = CodeMirror.modes = {}, mimeModes = CodeMirror.mimeModes = {};

  // Extra arguments are stored as the mode's dependencies, which is
  // used by (legacy) mechanisms like loadmode.js to automatically
  // load a mode. (Preferred mechanism is the require/define calls.)
  CodeMirror.defineMode = function(name, mode) {
    if (!CodeMirror.defaults.mode && name != "null") CodeMirror.defaults.mode = name;
    if (arguments.length > 2)
      mode.dependencies = Array.prototype.slice.call(arguments, 2);
    modes[name] = mode;
  };

  CodeMirror.defineMIME = function(mime, spec) {
    mimeModes[mime] = spec;
  };

  // Given a MIME type, a {name, ...options} config object, or a name
  // string, return a mode config object.
  CodeMirror.resolveMode = function(spec) {
    if (typeof spec == "string" && mimeModes.hasOwnProperty(spec)) {
      spec = mimeModes[spec];
    } else if (spec && typeof spec.name == "string" && mimeModes.hasOwnProperty(spec.name)) {
      var found = mimeModes[spec.name];
      if (typeof found == "string") found = {name: found};
      spec = createObj(found, spec);
      spec.name = found.name;
    } else if (typeof spec == "string" && /^[\w\-]+\/[\w\-]+\+xml$/.test(spec)) {
      return CodeMirror.resolveMode("application/xml");
    }
    if (typeof spec == "string") return {name: spec};
    else return spec || {name: "null"};
  };

  // Given a mode spec (anything that resolveMode accepts), find and
  // initialize an actual mode object.
  CodeMirror.getMode = function(options, spec) {
    var spec = CodeMirror.resolveMode(spec);
    var mfactory = modes[spec.name];
    if (!mfactory) return CodeMirror.getMode(options, "text/plain");
    var modeObj = mfactory(options, spec);
    if (modeExtensions.hasOwnProperty(spec.name)) {
      var exts = modeExtensions[spec.name];
      for (var prop in exts) {
        if (!exts.hasOwnProperty(prop)) continue;
        if (modeObj.hasOwnProperty(prop)) modeObj["_" + prop] = modeObj[prop];
        modeObj[prop] = exts[prop];
      }
    }
    modeObj.name = spec.name;
    if (spec.helperType) modeObj.helperType = spec.helperType;
    if (spec.modeProps) for (var prop in spec.modeProps)
      modeObj[prop] = spec.modeProps[prop];

    return modeObj;
  };

  // Minimal default mode.
  CodeMirror.defineMode("null", function() {
    return {token: function(stream) {stream.skipToEnd();}};
  });
  CodeMirror.defineMIME("text/plain", "null");

  // This can be used to attach properties to mode objects from
  // outside the actual mode definition.
  var modeExtensions = CodeMirror.modeExtensions = {};
  CodeMirror.extendMode = function(mode, properties) {
    var exts = modeExtensions.hasOwnProperty(mode) ? modeExtensions[mode] : (modeExtensions[mode] = {});
    copyObj(properties, exts);
  };

  // EXTENSIONS

  CodeMirror.defineExtension = function(name, func) {
    CodeMirror.prototype[name] = func;
  };
  CodeMirror.defineDocExtension = function(name, func) {
    Doc.prototype[name] = func;
  };
  CodeMirror.defineOption = option;

  var initHooks = [];
  CodeMirror.defineInitHook = function(f) {initHooks.push(f);};

  var helpers = CodeMirror.helpers = {};
  CodeMirror.registerHelper = function(type, name, value) {
    if (!helpers.hasOwnProperty(type)) helpers[type] = CodeMirror[type] = {_global: []};
    helpers[type][name] = value;
  };
  CodeMirror.registerGlobalHelper = function(type, name, predicate, value) {
    CodeMirror.registerHelper(type, name, value);
    helpers[type]._global.push({pred: predicate, val: value});
  };

  // MODE STATE HANDLING

  // Utility functions for working with state. Exported because nested
  // modes need to do this for their inner modes.

  var copyState = CodeMirror.copyState = function(mode, state) {
    if (state === true) return state;
    if (mode.copyState) return mode.copyState(state);
    var nstate = {};
    for (var n in state) {
      var val = state[n];
      if (val instanceof Array) val = val.concat([]);
      nstate[n] = val;
    }
    return nstate;
  };

  var startState = CodeMirror.startState = function(mode, a1, a2) {
    return mode.startState ? mode.startState(a1, a2) : true;
  };

  // Given a mode and a state (for that mode), find the inner mode and
  // state at the position that the state refers to.
  CodeMirror.innerMode = function(mode, state) {
    while (mode.innerMode) {
      var info = mode.innerMode(state);
      if (!info || info.mode == mode) break;
      state = info.state;
      mode = info.mode;
    }
    return info || {mode: mode, state: state};
  };

  // STANDARD COMMANDS

  // Commands are parameter-less actions that can be performed on an
  // editor, mostly used for keybindings.
  var commands = CodeMirror.commands = {
    selectAll: function(cm) {cm.setSelection(Pos(cm.firstLine(), 0), Pos(cm.lastLine()), sel_dontScroll);},
    singleSelection: function(cm) {
      cm.setSelection(cm.getCursor("anchor"), cm.getCursor("head"), sel_dontScroll);
    },
    killLine: function(cm) {
      deleteNearSelection(cm, function(range) {
        if (range.empty()) {
          var len = getLine(cm.doc, range.head.line).text.length;
          if (range.head.ch == len && range.head.line < cm.lastLine())
            return {from: range.head, to: Pos(range.head.line + 1, 0)};
          else
            return {from: range.head, to: Pos(range.head.line, len)};
        } else {
          return {from: range.from(), to: range.to()};
        }
      });
    },
    deleteLine: function(cm) {
      deleteNearSelection(cm, function(range) {
        return {from: Pos(range.from().line, 0),
                to: clipPos(cm.doc, Pos(range.to().line + 1, 0))};
      });
    },
    delLineLeft: function(cm) {
      deleteNearSelection(cm, function(range) {
        return {from: Pos(range.from().line, 0), to: range.from()};
      });
    },
    delWrappedLineLeft: function(cm) {
      deleteNearSelection(cm, function(range) {
        var top = cm.charCoords(range.head, "div").top + 5;
        var leftPos = cm.coordsChar({left: 0, top: top}, "div");
        return {from: leftPos, to: range.from()};
      });
    },
    delWrappedLineRight: function(cm) {
      deleteNearSelection(cm, function(range) {
        var top = cm.charCoords(range.head, "div").top + 5;
        var rightPos = cm.coordsChar({left: cm.display.lineDiv.offsetWidth + 100, top: top}, "div");
        return {from: range.from(), to: rightPos };
      });
    },
    undo: function(cm) {cm.undo();},
    redo: function(cm) {cm.redo();},
    undoSelection: function(cm) {cm.undoSelection();},
    redoSelection: function(cm) {cm.redoSelection();},
    goDocStart: function(cm) {cm.extendSelection(Pos(cm.firstLine(), 0));},
    goDocEnd: function(cm) {cm.extendSelection(Pos(cm.lastLine()));},
    goLineStart: function(cm) {
      cm.extendSelectionsBy(function(range) { return lineStart(cm, range.head.line); },
                            {origin: "+move", bias: 1});
    },
    goLineStartSmart: function(cm) {
      cm.extendSelectionsBy(function(range) {
        return lineStartSmart(cm, range.head);
      }, {origin: "+move", bias: 1});
    },
    goLineEnd: function(cm) {
      cm.extendSelectionsBy(function(range) { return lineEnd(cm, range.head.line); },
                            {origin: "+move", bias: -1});
    },
    goLineRight: function(cm) {
      cm.extendSelectionsBy(function(range) {
        var top = cm.charCoords(range.head, "div").top + 5;
        return cm.coordsChar({left: cm.display.lineDiv.offsetWidth + 100, top: top}, "div");
      }, sel_move);
    },
    goLineLeft: function(cm) {
      cm.extendSelectionsBy(function(range) {
        var top = cm.charCoords(range.head, "div").top + 5;
        return cm.coordsChar({left: 0, top: top}, "div");
      }, sel_move);
    },
    goLineLeftSmart: function(cm) {
      cm.extendSelectionsBy(function(range) {
        var top = cm.charCoords(range.head, "div").top + 5;
        var pos = cm.coordsChar({left: 0, top: top}, "div");
        if (pos.ch < cm.getLine(pos.line).search(/\S/)) return lineStartSmart(cm, range.head);
        return pos;
      }, sel_move);
    },
    goLineUp: function(cm) {cm.moveV(-1, "line");},
    goLineDown: function(cm) {cm.moveV(1, "line");},
    goPageUp: function(cm) {cm.moveV(-1, "page");},
    goPageDown: function(cm) {cm.moveV(1, "page");},
    goCharLeft: function(cm) {cm.moveH(-1, "char");},
    goCharRight: function(cm) {cm.moveH(1, "char");},
    goColumnLeft: function(cm) {cm.moveH(-1, "column");},
    goColumnRight: function(cm) {cm.moveH(1, "column");},
    goWordLeft: function(cm) {cm.moveH(-1, "word");},
    goGroupRight: function(cm) {cm.moveH(1, "group");},
    goGroupLeft: function(cm) {cm.moveH(-1, "group");},
    goWordRight: function(cm) {cm.moveH(1, "word");},
    delCharBefore: function(cm) {cm.deleteH(-1, "char");},
    delCharAfter: function(cm) {cm.deleteH(1, "char");},
    delWordBefore: function(cm) {cm.deleteH(-1, "word");},
    delWordAfter: function(cm) {cm.deleteH(1, "word");},
    delGroupBefore: function(cm) {cm.deleteH(-1, "group");},
    delGroupAfter: function(cm) {cm.deleteH(1, "group");},
    indentAuto: function(cm) {cm.indentSelection("smart");},
    indentMore: function(cm) {cm.indentSelection("add");},
    indentLess: function(cm) {cm.indentSelection("subtract");},
    insertTab: function(cm) {cm.replaceSelection("\t");},
    insertSoftTab: function(cm) {
      var spaces = [], ranges = cm.listSelections(), tabSize = cm.options.tabSize;
      for (var i = 0; i < ranges.length; i++) {
        var pos = ranges[i].from();
        var col = countColumn(cm.getLine(pos.line), pos.ch, tabSize);
        spaces.push(new Array(tabSize - col % tabSize + 1).join(" "));
      }
      cm.replaceSelections(spaces);
    },
    defaultTab: function(cm) {
      if (cm.somethingSelected()) cm.indentSelection("add");
      else cm.execCommand("insertTab");
    },
    transposeChars: function(cm) {
      runInOp(cm, function() {
        var ranges = cm.listSelections(), newSel = [];
        for (var i = 0; i < ranges.length; i++) {
          var cur = ranges[i].head, line = getLine(cm.doc, cur.line).text;
          if (line) {
            if (cur.ch == line.length) cur = new Pos(cur.line, cur.ch - 1);
            if (cur.ch > 0) {
              cur = new Pos(cur.line, cur.ch + 1);
              cm.replaceRange(line.charAt(cur.ch - 1) + line.charAt(cur.ch - 2),
                              Pos(cur.line, cur.ch - 2), cur, "+transpose");
            } else if (cur.line > cm.doc.first) {
              var prev = getLine(cm.doc, cur.line - 1).text;
              if (prev)
                cm.replaceRange(line.charAt(0) + cm.doc.lineSeparator() +
                                prev.charAt(prev.length - 1),
                                Pos(cur.line - 1, prev.length - 1), Pos(cur.line, 1), "+transpose");
            }
          }
          newSel.push(new Range(cur, cur));
        }
        cm.setSelections(newSel);
      });
    },
    newlineAndIndent: function(cm) {
      runInOp(cm, function() {
        var len = cm.listSelections().length;
        for (var i = 0; i < len; i++) {
          var range = cm.listSelections()[i];
          cm.replaceRange(cm.doc.lineSeparator(), range.anchor, range.head, "+input");
          cm.indentLine(range.from().line + 1, null, true);
        }
        ensureCursorVisible(cm);
      });
    },
    toggleOverwrite: function(cm) {cm.toggleOverwrite();}
  };


  // STANDARD KEYMAPS

  var keyMap = CodeMirror.keyMap = {};

  keyMap.basic = {
    "Left": "goCharLeft", "Right": "goCharRight", "Up": "goLineUp", "Down": "goLineDown",
    "End": "goLineEnd", "Home": "goLineStartSmart", "PageUp": "goPageUp", "PageDown": "goPageDown",
    "Delete": "delCharAfter", "Backspace": "delCharBefore", "Shift-Backspace": "delCharBefore",
    "Tab": "defaultTab", "Shift-Tab": "indentAuto",
    "Enter": "newlineAndIndent", "Insert": "toggleOverwrite",
    "Esc": "singleSelection"
  };
  // Note that the save and find-related commands aren't defined by
  // default. User code or addons can define them. Unknown commands
  // are simply ignored.
  keyMap.pcDefault = {
    "Ctrl-A": "selectAll", "Ctrl-D": "deleteLine", "Ctrl-Z": "undo", "Shift-Ctrl-Z": "redo", "Ctrl-Y": "redo",
    "Ctrl-Home": "goDocStart", "Ctrl-End": "goDocEnd", "Ctrl-Up": "goLineUp", "Ctrl-Down": "goLineDown",
    "Ctrl-Left": "goGroupLeft", "Ctrl-Right": "goGroupRight", "Alt-Left": "goLineStart", "Alt-Right": "goLineEnd",
    "Ctrl-Backspace": "delGroupBefore", "Ctrl-Delete": "delGroupAfter", "Ctrl-S": "save", "Ctrl-F": "find",
    "Ctrl-G": "findNext", "Shift-Ctrl-G": "findPrev", "Shift-Ctrl-F": "replace", "Shift-Ctrl-R": "replaceAll",
    "Ctrl-[": "indentLess", "Ctrl-]": "indentMore",
    "Ctrl-U": "undoSelection", "Shift-Ctrl-U": "redoSelection", "Alt-U": "redoSelection",
    fallthrough: "basic"
  };
  // Very basic readline/emacs-style bindings, which are standard on Mac.
  keyMap.emacsy = {
    "Ctrl-F": "goCharRight", "Ctrl-B": "goCharLeft", "Ctrl-P": "goLineUp", "Ctrl-N": "goLineDown",
    "Alt-F": "goWordRight", "Alt-B": "goWordLeft", "Ctrl-A": "goLineStart", "Ctrl-E": "goLineEnd",
    "Ctrl-V": "goPageDown", "Shift-Ctrl-V": "goPageUp", "Ctrl-D": "delCharAfter", "Ctrl-H": "delCharBefore",
    "Alt-D": "delWordAfter", "Alt-Backspace": "delWordBefore", "Ctrl-K": "killLine", "Ctrl-T": "transposeChars"
  };
  keyMap.macDefault = {
    "Cmd-A": "selectAll", "Cmd-D": "deleteLine", "Cmd-Z": "undo", "Shift-Cmd-Z": "redo", "Cmd-Y": "redo",
    "Cmd-Home": "goDocStart", "Cmd-Up": "goDocStart", "Cmd-End": "goDocEnd", "Cmd-Down": "goDocEnd", "Alt-Left": "goGroupLeft",
    "Alt-Right": "goGroupRight", "Cmd-Left": "goLineLeft", "Cmd-Right": "goLineRight", "Alt-Backspace": "delGroupBefore",
    "Ctrl-Alt-Backspace": "delGroupAfter", "Alt-Delete": "delGroupAfter", "Cmd-S": "save", "Cmd-F": "find",
    "Cmd-G": "findNext", "Shift-Cmd-G": "findPrev", "Cmd-Alt-F": "replace", "Shift-Cmd-Alt-F": "replaceAll",
    "Cmd-[": "indentLess", "Cmd-]": "indentMore", "Cmd-Backspace": "delWrappedLineLeft", "Cmd-Delete": "delWrappedLineRight",
    "Cmd-U": "undoSelection", "Shift-Cmd-U": "redoSelection", "Ctrl-Up": "goDocStart", "Ctrl-Down": "goDocEnd",
    fallthrough: ["basic", "emacsy"]
  };
  keyMap["default"] = mac ? keyMap.macDefault : keyMap.pcDefault;

  // KEYMAP DISPATCH

  function normalizeKeyName(name) {
    var parts = name.split(/-(?!$)/), name = parts[parts.length - 1];
    var alt, ctrl, shift, cmd;
    for (var i = 0; i < parts.length - 1; i++) {
      var mod = parts[i];
      if (/^(cmd|meta|m)$/i.test(mod)) cmd = true;
      else if (/^a(lt)?$/i.test(mod)) alt = true;
      else if (/^(c|ctrl|control)$/i.test(mod)) ctrl = true;
      else if (/^s(hift)$/i.test(mod)) shift = true;
      else throw new Error("Unrecognized modifier name: " + mod);
    }
    if (alt) name = "Alt-" + name;
    if (ctrl) name = "Ctrl-" + name;
    if (cmd) name = "Cmd-" + name;
    if (shift) name = "Shift-" + name;
    return name;
  }

  // This is a kludge to keep keymaps mostly working as raw objects
  // (backwards compatibility) while at the same time support features
  // like normalization and multi-stroke key bindings. It compiles a
  // new normalized keymap, and then updates the old object to reflect
  // this.
  CodeMirror.normalizeKeyMap = function(keymap) {
    var copy = {};
    for (var keyname in keymap) if (keymap.hasOwnProperty(keyname)) {
      var value = keymap[keyname];
      if (/^(name|fallthrough|(de|at)tach)$/.test(keyname)) continue;
      if (value == "...") { delete keymap[keyname]; continue; }

      var keys = map(keyname.split(" "), normalizeKeyName);
      for (var i = 0; i < keys.length; i++) {
        var val, name;
        if (i == keys.length - 1) {
          name = keys.join(" ");
          val = value;
        } else {
          name = keys.slice(0, i + 1).join(" ");
          val = "...";
        }
        var prev = copy[name];
        if (!prev) copy[name] = val;
        else if (prev != val) throw new Error("Inconsistent bindings for " + name);
      }
      delete keymap[keyname];
    }
    for (var prop in copy) keymap[prop] = copy[prop];
    return keymap;
  };

  var lookupKey = CodeMirror.lookupKey = function(key, map, handle, context) {
    map = getKeyMap(map);
    var found = map.call ? map.call(key, context) : map[key];
    if (found === false) return "nothing";
    if (found === "...") return "multi";
    if (found != null && handle(found)) return "handled";

    if (map.fallthrough) {
      if (Object.prototype.toString.call(map.fallthrough) != "[object Array]")
        return lookupKey(key, map.fallthrough, handle, context);
      for (var i = 0; i < map.fallthrough.length; i++) {
        var result = lookupKey(key, map.fallthrough[i], handle, context);
        if (result) return result;
      }
    }
  };

  // Modifier key presses don't count as 'real' key presses for the
  // purpose of keymap fallthrough.
  var isModifierKey = CodeMirror.isModifierKey = function(value) {
    var name = typeof value == "string" ? value : keyNames[value.keyCode];
    return name == "Ctrl" || name == "Alt" || name == "Shift" || name == "Mod";
  };

  // Look up the name of a key as indicated by an event object.
  var keyName = CodeMirror.keyName = function(event, noShift) {
    if (presto && event.keyCode == 34 && event["char"]) return false;
    var base = keyNames[event.keyCode], name = base;
    if (name == null || event.altGraphKey) return false;
    if (event.altKey && base != "Alt") name = "Alt-" + name;
    if ((flipCtrlCmd ? event.metaKey : event.ctrlKey) && base != "Ctrl") name = "Ctrl-" + name;
    if ((flipCtrlCmd ? event.ctrlKey : event.metaKey) && base != "Cmd") name = "Cmd-" + name;
    if (!noShift && event.shiftKey && base != "Shift") name = "Shift-" + name;
    return name;
  };

  function getKeyMap(val) {
    return typeof val == "string" ? keyMap[val] : val;
  }

  // FROMTEXTAREA

  CodeMirror.fromTextArea = function(textarea, options) {
    options = options ? copyObj(options) : {};
    options.value = textarea.value;
    if (!options.tabindex && textarea.tabIndex)
      options.tabindex = textarea.tabIndex;
    if (!options.placeholder && textarea.placeholder)
      options.placeholder = textarea.placeholder;
    // Set autofocus to true if this textarea is focused, or if it has
    // autofocus and no other element is focused.
    if (options.autofocus == null) {
      var hasFocus = activeElt();
      options.autofocus = hasFocus == textarea ||
        textarea.getAttribute("autofocus") != null && hasFocus == document.body;
    }

    function save() {textarea.value = cm.getValue();}
    if (textarea.form) {
      on(textarea.form, "submit", save);
      // Deplorable hack to make the submit method do the right thing.
      if (!options.leaveSubmitMethodAlone) {
        var form = textarea.form, realSubmit = form.submit;
        try {
          var wrappedSubmit = form.submit = function() {
            save();
            form.submit = realSubmit;
            form.submit();
            form.submit = wrappedSubmit;
          };
        } catch(e) {}
      }
    }

    options.finishInit = function(cm) {
      cm.save = save;
      cm.getTextArea = function() { return textarea; };
      cm.toTextArea = function() {
        cm.toTextArea = isNaN; // Prevent this from being ran twice
        save();
        textarea.parentNode.removeChild(cm.getWrapperElement());
        textarea.style.display = "";
        if (textarea.form) {
          off(textarea.form, "submit", save);
          if (typeof textarea.form.submit == "function")
            textarea.form.submit = realSubmit;
        }
      };
    };

    textarea.style.display = "none";
    var cm = CodeMirror(function(node) {
      textarea.parentNode.insertBefore(node, textarea.nextSibling);
    }, options);
    return cm;
  };

  // STRING STREAM

  // Fed to the mode parsers, provides helper functions to make
  // parsers more succinct.

  var StringStream = CodeMirror.StringStream = function(string, tabSize) {
    this.pos = this.start = 0;
    this.string = string;
    this.tabSize = tabSize || 8;
    this.lastColumnPos = this.lastColumnValue = 0;
    this.lineStart = 0;
  };

  StringStream.prototype = {
    eol: function() {return this.pos >= this.string.length;},
    sol: function() {return this.pos == this.lineStart;},
    peek: function() {return this.string.charAt(this.pos) || undefined;},
    next: function() {
      if (this.pos < this.string.length)
        return this.string.charAt(this.pos++);
    },
    eat: function(match) {
      var ch = this.string.charAt(this.pos);
      if (typeof match == "string") var ok = ch == match;
      else var ok = ch && (match.test ? match.test(ch) : match(ch));
      if (ok) {++this.pos; return ch;}
    },
    eatWhile: function(match) {
      var start = this.pos;
      while (this.eat(match)){}
      return this.pos > start;
    },
    eatSpace: function() {
      var start = this.pos;
      while (/[\s\u00a0]/.test(this.string.charAt(this.pos))) ++this.pos;
      return this.pos > start;
    },
    skipToEnd: function() {this.pos = this.string.length;},
    skipTo: function(ch) {
      var found = this.string.indexOf(ch, this.pos);
      if (found > -1) {this.pos = found; return true;}
    },
    backUp: function(n) {this.pos -= n;},
    column: function() {
      if (this.lastColumnPos < this.start) {
        this.lastColumnValue = countColumn(this.string, this.start, this.tabSize, this.lastColumnPos, this.lastColumnValue);
        this.lastColumnPos = this.start;
      }
      return this.lastColumnValue - (this.lineStart ? countColumn(this.string, this.lineStart, this.tabSize) : 0);
    },
    indentation: function() {
      return countColumn(this.string, null, this.tabSize) -
        (this.lineStart ? countColumn(this.string, this.lineStart, this.tabSize) : 0);
    },
    match: function(pattern, consume, caseInsensitive) {
      if (typeof pattern == "string") {
        var cased = function(str) {return caseInsensitive ? str.toLowerCase() : str;};
        var substr = this.string.substr(this.pos, pattern.length);
        if (cased(substr) == cased(pattern)) {
          if (consume !== false) this.pos += pattern.length;
          return true;
        }
      } else {
        var match = this.string.slice(this.pos).match(pattern);
        if (match && match.index > 0) return null;
        if (match && consume !== false) this.pos += match[0].length;
        return match;
      }
    },
    current: function(){return this.string.slice(this.start, this.pos);},
    hideFirstChars: function(n, inner) {
      this.lineStart += n;
      try { return inner(); }
      finally { this.lineStart -= n; }
    }
  };

  // TEXTMARKERS

  // Created with markText and setBookmark methods. A TextMarker is a
  // handle that can be used to clear or find a marked position in the
  // document. Line objects hold arrays (markedSpans) containing
  // {from, to, marker} object pointing to such marker objects, and
  // indicating that such a marker is present on that line. Multiple
  // lines may point to the same marker when it spans across lines.
  // The spans will have null for their from/to properties when the
  // marker continues beyond the start/end of the line. Markers have
  // links back to the lines they currently touch.

  var nextMarkerId = 0;

  var TextMarker = CodeMirror.TextMarker = function(doc, type) {
    this.lines = [];
    this.type = type;
    this.doc = doc;
    this.id = ++nextMarkerId;
  };
  eventMixin(TextMarker);

  // Clear the marker.
  TextMarker.prototype.clear = function() {
    if (this.explicitlyCleared) return;
    var cm = this.doc.cm, withOp = cm && !cm.curOp;
    if (withOp) startOperation(cm);
    if (hasHandler(this, "clear")) {
      var found = this.find();
      if (found) signalLater(this, "clear", found.from, found.to);
    }
    var min = null, max = null;
    for (var i = 0; i < this.lines.length; ++i) {
      var line = this.lines[i];
      var span = getMarkedSpanFor(line.markedSpans, this);
      if (cm && !this.collapsed) regLineChange(cm, lineNo(line), "text");
      else if (cm) {
        if (span.to != null) max = lineNo(line);
        if (span.from != null) min = lineNo(line);
      }
      line.markedSpans = removeMarkedSpan(line.markedSpans, span);
      if (span.from == null && this.collapsed && !lineIsHidden(this.doc, line) && cm)
        updateLineHeight(line, textHeight(cm.display));
    }
    if (cm && this.collapsed && !cm.options.lineWrapping) for (var i = 0; i < this.lines.length; ++i) {
      var visual = visualLine(this.lines[i]), len = lineLength(visual);
      if (len > cm.display.maxLineLength) {
        cm.display.maxLine = visual;
        cm.display.maxLineLength = len;
        cm.display.maxLineChanged = true;
      }
    }

    if (min != null && cm && this.collapsed) regChange(cm, min, max + 1);
    this.lines.length = 0;
    this.explicitlyCleared = true;
    if (this.atomic && this.doc.cantEdit) {
      this.doc.cantEdit = false;
      if (cm) reCheckSelection(cm.doc);
    }
    if (cm) signalLater(cm, "markerCleared", cm, this);
    if (withOp) endOperation(cm);
    if (this.parent) this.parent.clear();
  };

  // Find the position of the marker in the document. Returns a {from,
  // to} object by default. Side can be passed to get a specific side
  // -- 0 (both), -1 (left), or 1 (right). When lineObj is true, the
  // Pos objects returned contain a line object, rather than a line
  // number (used to prevent looking up the same line twice).
  TextMarker.prototype.find = function(side, lineObj) {
    if (side == null && this.type == "bookmark") side = 1;
    var from, to;
    for (var i = 0; i < this.lines.length; ++i) {
      var line = this.lines[i];
      var span = getMarkedSpanFor(line.markedSpans, this);
      if (span.from != null) {
        from = Pos(lineObj ? line : lineNo(line), span.from);
        if (side == -1) return from;
      }
      if (span.to != null) {
        to = Pos(lineObj ? line : lineNo(line), span.to);
        if (side == 1) return to;
      }
    }
    return from && {from: from, to: to};
  };

  // Signals that the marker's widget changed, and surrounding layout
  // should be recomputed.
  TextMarker.prototype.changed = function() {
    var pos = this.find(-1, true), widget = this, cm = this.doc.cm;
    if (!pos || !cm) return;
    runInOp(cm, function() {
      var line = pos.line, lineN = lineNo(pos.line);
      var view = findViewForLine(cm, lineN);
      if (view) {
        clearLineMeasurementCacheFor(view);
        cm.curOp.selectionChanged = cm.curOp.forceUpdate = true;
      }
      cm.curOp.updateMaxLine = true;
      if (!lineIsHidden(widget.doc, line) && widget.height != null) {
        var oldHeight = widget.height;
        widget.height = null;
        var dHeight = widgetHeight(widget) - oldHeight;
        if (dHeight)
          updateLineHeight(line, line.height + dHeight);
      }
    });
  };

  TextMarker.prototype.attachLine = function(line) {
    if (!this.lines.length && this.doc.cm) {
      var op = this.doc.cm.curOp;
      if (!op.maybeHiddenMarkers || indexOf(op.maybeHiddenMarkers, this) == -1)
        (op.maybeUnhiddenMarkers || (op.maybeUnhiddenMarkers = [])).push(this);
    }
    this.lines.push(line);
  };
  TextMarker.prototype.detachLine = function(line) {
    this.lines.splice(indexOf(this.lines, line), 1);
    if (!this.lines.length && this.doc.cm) {
      var op = this.doc.cm.curOp;
      (op.maybeHiddenMarkers || (op.maybeHiddenMarkers = [])).push(this);
    }
  };

  // Collapsed markers have unique ids, in order to be able to order
  // them, which is needed for uniquely determining an outer marker
  // when they overlap (they may nest, but not partially overlap).
  var nextMarkerId = 0;

  // Create a marker, wire it up to the right lines, and
  function markText(doc, from, to, options, type) {
    // Shared markers (across linked documents) are handled separately
    // (markTextShared will call out to this again, once per
    // document).
    if (options && options.shared) return markTextShared(doc, from, to, options, type);
    // Ensure we are in an operation.
    if (doc.cm && !doc.cm.curOp) return operation(doc.cm, markText)(doc, from, to, options, type);

    var marker = new TextMarker(doc, type), diff = cmp(from, to);
    if (options) copyObj(options, marker, false);
    // Don't connect empty markers unless clearWhenEmpty is false
    if (diff > 0 || diff == 0 && marker.clearWhenEmpty !== false)
      return marker;
    if (marker.replacedWith) {
      // Showing up as a widget implies collapsed (widget replaces text)
      marker.collapsed = true;
      marker.widgetNode = elt("span", [marker.replacedWith], "CodeMirror-widget");
      if (!options.handleMouseEvents) marker.widgetNode.setAttribute("cm-ignore-events", "true");
      if (options.insertLeft) marker.widgetNode.insertLeft = true;
    }
    if (marker.collapsed) {
      if (conflictingCollapsedRange(doc, from.line, from, to, marker) ||
          from.line != to.line && conflictingCollapsedRange(doc, to.line, from, to, marker))
        throw new Error("Inserting collapsed marker partially overlapping an existing one");
      sawCollapsedSpans = true;
    }

    if (marker.addToHistory)
      addChangeToHistory(doc, {from: from, to: to, origin: "markText"}, doc.sel, NaN);

    var curLine = from.line, cm = doc.cm, updateMaxLine;
    doc.iter(curLine, to.line + 1, function(line) {
      if (cm && marker.collapsed && !cm.options.lineWrapping && visualLine(line) == cm.display.maxLine)
        updateMaxLine = true;
      if (marker.collapsed && curLine != from.line) updateLineHeight(line, 0);
      addMarkedSpan(line, new MarkedSpan(marker,
                                         curLine == from.line ? from.ch : null,
                                         curLine == to.line ? to.ch : null));
      ++curLine;
    });
    // lineIsHidden depends on the presence of the spans, so needs a second pass
    if (marker.collapsed) doc.iter(from.line, to.line + 1, function(line) {
      if (lineIsHidden(doc, line)) updateLineHeight(line, 0);
    });

    if (marker.clearOnEnter) on(marker, "beforeCursorEnter", function() { marker.clear(); });

    if (marker.readOnly) {
      sawReadOnlySpans = true;
      if (doc.history.done.length || doc.history.undone.length)
        doc.clearHistory();
    }
    if (marker.collapsed) {
      marker.id = ++nextMarkerId;
      marker.atomic = true;
    }
    if (cm) {
      // Sync editor state
      if (updateMaxLine) cm.curOp.updateMaxLine = true;
      if (marker.collapsed)
        regChange(cm, from.line, to.line + 1);
      else if (marker.className || marker.title || marker.startStyle || marker.endStyle || marker.css)
        for (var i = from.line; i <= to.line; i++) regLineChange(cm, i, "text");
      if (marker.atomic) reCheckSelection(cm.doc);
      signalLater(cm, "markerAdded", cm, marker);
    }
    return marker;
  }

  // SHARED TEXTMARKERS

  // A shared marker spans multiple linked documents. It is
  // implemented as a meta-marker-object controlling multiple normal
  // markers.
  var SharedTextMarker = CodeMirror.SharedTextMarker = function(markers, primary) {
    this.markers = markers;
    this.primary = primary;
    for (var i = 0; i < markers.length; ++i)
      markers[i].parent = this;
  };
  eventMixin(SharedTextMarker);

  SharedTextMarker.prototype.clear = function() {
    if (this.explicitlyCleared) return;
    this.explicitlyCleared = true;
    for (var i = 0; i < this.markers.length; ++i)
      this.markers[i].clear();
    signalLater(this, "clear");
  };
  SharedTextMarker.prototype.find = function(side, lineObj) {
    return this.primary.find(side, lineObj);
  };

  function markTextShared(doc, from, to, options, type) {
    options = copyObj(options);
    options.shared = false;
    var markers = [markText(doc, from, to, options, type)], primary = markers[0];
    var widget = options.widgetNode;
    linkedDocs(doc, function(doc) {
      if (widget) options.widgetNode = widget.cloneNode(true);
      markers.push(markText(doc, clipPos(doc, from), clipPos(doc, to), options, type));
      for (var i = 0; i < doc.linked.length; ++i)
        if (doc.linked[i].isParent) return;
      primary = lst(markers);
    });
    return new SharedTextMarker(markers, primary);
  }

  function findSharedMarkers(doc) {
    return doc.findMarks(Pos(doc.first, 0), doc.clipPos(Pos(doc.lastLine())),
                         function(m) { return m.parent; });
  }

  function copySharedMarkers(doc, markers) {
    for (var i = 0; i < markers.length; i++) {
      var marker = markers[i], pos = marker.find();
      var mFrom = doc.clipPos(pos.from), mTo = doc.clipPos(pos.to);
      if (cmp(mFrom, mTo)) {
        var subMark = markText(doc, mFrom, mTo, marker.primary, marker.primary.type);
        marker.markers.push(subMark);
        subMark.parent = marker;
      }
    }
  }

  function detachSharedMarkers(markers) {
    for (var i = 0; i < markers.length; i++) {
      var marker = markers[i], linked = [marker.primary.doc];;
      linkedDocs(marker.primary.doc, function(d) { linked.push(d); });
      for (var j = 0; j < marker.markers.length; j++) {
        var subMarker = marker.markers[j];
        if (indexOf(linked, subMarker.doc) == -1) {
          subMarker.parent = null;
          marker.markers.splice(j--, 1);
        }
      }
    }
  }

  // TEXTMARKER SPANS

  function MarkedSpan(marker, from, to) {
    this.marker = marker;
    this.from = from; this.to = to;
  }

  // Search an array of spans for a span matching the given marker.
  function getMarkedSpanFor(spans, marker) {
    if (spans) for (var i = 0; i < spans.length; ++i) {
      var span = spans[i];
      if (span.marker == marker) return span;
    }
  }
  // Remove a span from an array, returning undefined if no spans are
  // left (we don't store arrays for lines without spans).
  function removeMarkedSpan(spans, span) {
    for (var r, i = 0; i < spans.length; ++i)
      if (spans[i] != span) (r || (r = [])).push(spans[i]);
    return r;
  }
  // Add a span to a line.
  function addMarkedSpan(line, span) {
    line.markedSpans = line.markedSpans ? line.markedSpans.concat([span]) : [span];
    span.marker.attachLine(line);
  }

  // Used for the algorithm that adjusts markers for a change in the
  // document. These functions cut an array of spans at a given
  // character position, returning an array of remaining chunks (or
  // undefined if nothing remains).
  function markedSpansBefore(old, startCh, isInsert) {
    if (old) for (var i = 0, nw; i < old.length; ++i) {
      var span = old[i], marker = span.marker;
      var startsBefore = span.from == null || (marker.inclusiveLeft ? span.from <= startCh : span.from < startCh);
      if (startsBefore || span.from == startCh && marker.type == "bookmark" && (!isInsert || !span.marker.insertLeft)) {
        var endsAfter = span.to == null || (marker.inclusiveRight ? span.to >= startCh : span.to > startCh);
        (nw || (nw = [])).push(new MarkedSpan(marker, span.from, endsAfter ? null : span.to));
      }
    }
    return nw;
  }
  function markedSpansAfter(old, endCh, isInsert) {
    if (old) for (var i = 0, nw; i < old.length; ++i) {
      var span = old[i], marker = span.marker;
      var endsAfter = span.to == null || (marker.inclusiveRight ? span.to >= endCh : span.to > endCh);
      if (endsAfter || span.from == endCh && marker.type == "bookmark" && (!isInsert || span.marker.insertLeft)) {
        var startsBefore = span.from == null || (marker.inclusiveLeft ? span.from <= endCh : span.from < endCh);
        (nw || (nw = [])).push(new MarkedSpan(marker, startsBefore ? null : span.from - endCh,
                                              span.to == null ? null : span.to - endCh));
      }
    }
    return nw;
  }

  // Given a change object, compute the new set of marker spans that
  // cover the line in which the change took place. Removes spans
  // entirely within the change, reconnects spans belonging to the
  // same marker that appear on both sides of the change, and cuts off
  // spans partially within the change. Returns an array of span
  // arrays with one element for each line in (after) the change.
  function stretchSpansOverChange(doc, change) {
    if (change.full) return null;
    var oldFirst = isLine(doc, change.from.line) && getLine(doc, change.from.line).markedSpans;
    var oldLast = isLine(doc, change.to.line) && getLine(doc, change.to.line).markedSpans;
    if (!oldFirst && !oldLast) return null;

    var startCh = change.from.ch, endCh = change.to.ch, isInsert = cmp(change.from, change.to) == 0;
    // Get the spans that 'stick out' on both sides
    var first = markedSpansBefore(oldFirst, startCh, isInsert);
    var last = markedSpansAfter(oldLast, endCh, isInsert);

    // Next, merge those two ends
    var sameLine = change.text.length == 1, offset = lst(change.text).length + (sameLine ? startCh : 0);
    if (first) {
      // Fix up .to properties of first
      for (var i = 0; i < first.length; ++i) {
        var span = first[i];
        if (span.to == null) {
          var found = getMarkedSpanFor(last, span.marker);
          if (!found) span.to = startCh;
          else if (sameLine) span.to = found.to == null ? null : found.to + offset;
        }
      }
    }
    if (last) {
      // Fix up .from in last (or move them into first in case of sameLine)
      for (var i = 0; i < last.length; ++i) {
        var span = last[i];
        if (span.to != null) span.to += offset;
        if (span.from == null) {
          var found = getMarkedSpanFor(first, span.marker);
          if (!found) {
            span.from = offset;
            if (sameLine) (first || (first = [])).push(span);
          }
        } else {
          span.from += offset;
          if (sameLine) (first || (first = [])).push(span);
        }
      }
    }
    // Make sure we didn't create any zero-length spans
    if (first) first = clearEmptySpans(first);
    if (last && last != first) last = clearEmptySpans(last);

    var newMarkers = [first];
    if (!sameLine) {
      // Fill gap with whole-line-spans
      var gap = change.text.length - 2, gapMarkers;
      if (gap > 0 && first)
        for (var i = 0; i < first.length; ++i)
          if (first[i].to == null)
            (gapMarkers || (gapMarkers = [])).push(new MarkedSpan(first[i].marker, null, null));
      for (var i = 0; i < gap; ++i)
        newMarkers.push(gapMarkers);
      newMarkers.push(last);
    }
    return newMarkers;
  }

  // Remove spans that are empty and don't have a clearWhenEmpty
  // option of false.
  function clearEmptySpans(spans) {
    for (var i = 0; i < spans.length; ++i) {
      var span = spans[i];
      if (span.from != null && span.from == span.to && span.marker.clearWhenEmpty !== false)
        spans.splice(i--, 1);
    }
    if (!spans.length) return null;
    return spans;
  }

  // Used for un/re-doing changes from the history. Combines the
  // result of computing the existing spans with the set of spans that
  // existed in the history (so that deleting around a span and then
  // undoing brings back the span).
  function mergeOldSpans(doc, change) {
    var old = getOldSpans(doc, change);
    var stretched = stretchSpansOverChange(doc, change);
    if (!old) return stretched;
    if (!stretched) return old;

    for (var i = 0; i < old.length; ++i) {
      var oldCur = old[i], stretchCur = stretched[i];
      if (oldCur && stretchCur) {
        spans: for (var j = 0; j < stretchCur.length; ++j) {
          var span = stretchCur[j];
          for (var k = 0; k < oldCur.length; ++k)
            if (oldCur[k].marker == span.marker) continue spans;
          oldCur.push(span);
        }
      } else if (stretchCur) {
        old[i] = stretchCur;
      }
    }
    return old;
  }

  // Used to 'clip' out readOnly ranges when making a change.
  function removeReadOnlyRanges(doc, from, to) {
    var markers = null;
    doc.iter(from.line, to.line + 1, function(line) {
      if (line.markedSpans) for (var i = 0; i < line.markedSpans.length; ++i) {
        var mark = line.markedSpans[i].marker;
        if (mark.readOnly && (!markers || indexOf(markers, mark) == -1))
          (markers || (markers = [])).push(mark);
      }
    });
    if (!markers) return null;
    var parts = [{from: from, to: to}];
    for (var i = 0; i < markers.length; ++i) {
      var mk = markers[i], m = mk.find(0);
      for (var j = 0; j < parts.length; ++j) {
        var p = parts[j];
        if (cmp(p.to, m.from) < 0 || cmp(p.from, m.to) > 0) continue;
        var newParts = [j, 1], dfrom = cmp(p.from, m.from), dto = cmp(p.to, m.to);
        if (dfrom < 0 || !mk.inclusiveLeft && !dfrom)
          newParts.push({from: p.from, to: m.from});
        if (dto > 0 || !mk.inclusiveRight && !dto)
          newParts.push({from: m.to, to: p.to});
        parts.splice.apply(parts, newParts);
        j += newParts.length - 1;
      }
    }
    return parts;
  }

  // Connect or disconnect spans from a line.
  function detachMarkedSpans(line) {
    var spans = line.markedSpans;
    if (!spans) return;
    for (var i = 0; i < spans.length; ++i)
      spans[i].marker.detachLine(line);
    line.markedSpans = null;
  }
  function attachMarkedSpans(line, spans) {
    if (!spans) return;
    for (var i = 0; i < spans.length; ++i)
      spans[i].marker.attachLine(line);
    line.markedSpans = spans;
  }

  // Helpers used when computing which overlapping collapsed span
  // counts as the larger one.
  function extraLeft(marker) { return marker.inclusiveLeft ? -1 : 0; }
  function extraRight(marker) { return marker.inclusiveRight ? 1 : 0; }

  // Returns a number indicating which of two overlapping collapsed
  // spans is larger (and thus includes the other). Falls back to
  // comparing ids when the spans cover exactly the same range.
  function compareCollapsedMarkers(a, b) {
    var lenDiff = a.lines.length - b.lines.length;
    if (lenDiff != 0) return lenDiff;
    var aPos = a.find(), bPos = b.find();
    var fromCmp = cmp(aPos.from, bPos.from) || extraLeft(a) - extraLeft(b);
    if (fromCmp) return -fromCmp;
    var toCmp = cmp(aPos.to, bPos.to) || extraRight(a) - extraRight(b);
    if (toCmp) return toCmp;
    return b.id - a.id;
  }

  // Find out whether a line ends or starts in a collapsed span. If
  // so, return the marker for that span.
  function collapsedSpanAtSide(line, start) {
    var sps = sawCollapsedSpans && line.markedSpans, found;
    if (sps) for (var sp, i = 0; i < sps.length; ++i) {
      sp = sps[i];
      if (sp.marker.collapsed && (start ? sp.from : sp.to) == null &&
          (!found || compareCollapsedMarkers(found, sp.marker) < 0))
        found = sp.marker;
    }
    return found;
  }
  function collapsedSpanAtStart(line) { return collapsedSpanAtSide(line, true); }
  function collapsedSpanAtEnd(line) { return collapsedSpanAtSide(line, false); }

  // Test whether there exists a collapsed span that partially
  // overlaps (covers the start or end, but not both) of a new span.
  // Such overlap is not allowed.
  function conflictingCollapsedRange(doc, lineNo, from, to, marker) {
    var line = getLine(doc, lineNo);
    var sps = sawCollapsedSpans && line.markedSpans;
    if (sps) for (var i = 0; i < sps.length; ++i) {
      var sp = sps[i];
      if (!sp.marker.collapsed) continue;
      var found = sp.marker.find(0);
      var fromCmp = cmp(found.from, from) || extraLeft(sp.marker) - extraLeft(marker);
      var toCmp = cmp(found.to, to) || extraRight(sp.marker) - extraRight(marker);
      if (fromCmp >= 0 && toCmp <= 0 || fromCmp <= 0 && toCmp >= 0) continue;
      if (fromCmp <= 0 && (cmp(found.to, from) > 0 || (sp.marker.inclusiveRight && marker.inclusiveLeft)) ||
          fromCmp >= 0 && (cmp(found.from, to) < 0 || (sp.marker.inclusiveLeft && marker.inclusiveRight)))
        return true;
    }
  }

  // A visual line is a line as drawn on the screen. Folding, for
  // example, can cause multiple logical lines to appear on the same
  // visual line. This finds the start of the visual line that the
  // given line is part of (usually that is the line itself).
  function visualLine(line) {
    var merged;
    while (merged = collapsedSpanAtStart(line))
      line = merged.find(-1, true).line;
    return line;
  }

  // Returns an array of logical lines that continue the visual line
  // started by the argument, or undefined if there are no such lines.
  function visualLineContinued(line) {
    var merged, lines;
    while (merged = collapsedSpanAtEnd(line)) {
      line = merged.find(1, true).line;
      (lines || (lines = [])).push(line);
    }
    return lines;
  }

  // Get the line number of the start of the visual line that the
  // given line number is part of.
  function visualLineNo(doc, lineN) {
    var line = getLine(doc, lineN), vis = visualLine(line);
    if (line == vis) return lineN;
    return lineNo(vis);
  }
  // Get the line number of the start of the next visual line after
  // the given line.
  function visualLineEndNo(doc, lineN) {
    if (lineN > doc.lastLine()) return lineN;
    var line = getLine(doc, lineN), merged;
    if (!lineIsHidden(doc, line)) return lineN;
    while (merged = collapsedSpanAtEnd(line))
      line = merged.find(1, true).line;
    return lineNo(line) + 1;
  }

  // Compute whether a line is hidden. Lines count as hidden when they
  // are part of a visual line that starts with another line, or when
  // they are entirely covered by collapsed, non-widget span.
  function lineIsHidden(doc, line) {
    var sps = sawCollapsedSpans && line.markedSpans;
    if (sps) for (var sp, i = 0; i < sps.length; ++i) {
      sp = sps[i];
      if (!sp.marker.collapsed) continue;
      if (sp.from == null) return true;
      if (sp.marker.widgetNode) continue;
      if (sp.from == 0 && sp.marker.inclusiveLeft && lineIsHiddenInner(doc, line, sp))
        return true;
    }
  }
  function lineIsHiddenInner(doc, line, span) {
    if (span.to == null) {
      var end = span.marker.find(1, true);
      return lineIsHiddenInner(doc, end.line, getMarkedSpanFor(end.line.markedSpans, span.marker));
    }
    if (span.marker.inclusiveRight && span.to == line.text.length)
      return true;
    for (var sp, i = 0; i < line.markedSpans.length; ++i) {
      sp = line.markedSpans[i];
      if (sp.marker.collapsed && !sp.marker.widgetNode && sp.from == span.to &&
          (sp.to == null || sp.to != span.from) &&
          (sp.marker.inclusiveLeft || span.marker.inclusiveRight) &&
          lineIsHiddenInner(doc, line, sp)) return true;
    }
  }

  // LINE WIDGETS

  // Line widgets are block elements displayed above or below a line.

  var LineWidget = CodeMirror.LineWidget = function(doc, node, options) {
    if (options) for (var opt in options) if (options.hasOwnProperty(opt))
      this[opt] = options[opt];
    this.doc = doc;
    this.node = node;
  };
  eventMixin(LineWidget);

  function adjustScrollWhenAboveVisible(cm, line, diff) {
    if (heightAtLine(line) < ((cm.curOp && cm.curOp.scrollTop) || cm.doc.scrollTop))
      addToScrollPos(cm, null, diff);
  }

  LineWidget.prototype.clear = function() {
    var cm = this.doc.cm, ws = this.line.widgets, line = this.line, no = lineNo(line);
    if (no == null || !ws) return;
    for (var i = 0; i < ws.length; ++i) if (ws[i] == this) ws.splice(i--, 1);
    if (!ws.length) line.widgets = null;
    var height = widgetHeight(this);
    updateLineHeight(line, Math.max(0, line.height - height));
    if (cm) runInOp(cm, function() {
      adjustScrollWhenAboveVisible(cm, line, -height);
      regLineChange(cm, no, "widget");
    });
  };
  LineWidget.prototype.changed = function() {
    var oldH = this.height, cm = this.doc.cm, line = this.line;
    this.height = null;
    var diff = widgetHeight(this) - oldH;
    if (!diff) return;
    updateLineHeight(line, line.height + diff);
    if (cm) runInOp(cm, function() {
      cm.curOp.forceUpdate = true;
      adjustScrollWhenAboveVisible(cm, line, diff);
    });
  };

  function widgetHeight(widget) {
    if (widget.height != null) return widget.height;
    var cm = widget.doc.cm;
    if (!cm) return 0;
    if (!contains(document.body, widget.node)) {
      var parentStyle = "position: relative;";
      if (widget.coverGutter)
        parentStyle += "margin-left: -" + cm.display.gutters.offsetWidth + "px;";
      if (widget.noHScroll)
        parentStyle += "width: " + cm.display.wrapper.clientWidth + "px;";
      removeChildrenAndAdd(cm.display.measure, elt("div", [widget.node], null, parentStyle));
    }
    return widget.height = widget.node.offsetHeight;
  }

  function addLineWidget(doc, handle, node, options) {
    var widget = new LineWidget(doc, node, options);
    var cm = doc.cm;
    if (cm && widget.noHScroll) cm.display.alignWidgets = true;
    changeLine(doc, handle, "widget", function(line) {
      var widgets = line.widgets || (line.widgets = []);
      if (widget.insertAt == null) widgets.push(widget);
      else widgets.splice(Math.min(widgets.length - 1, Math.max(0, widget.insertAt)), 0, widget);
      widget.line = line;
      if (cm && !lineIsHidden(doc, line)) {
        var aboveVisible = heightAtLine(line) < doc.scrollTop;
        updateLineHeight(line, line.height + widgetHeight(widget));
        if (aboveVisible) addToScrollPos(cm, null, widget.height);
        cm.curOp.forceUpdate = true;
      }
      return true;
    });
    return widget;
  }

  // LINE DATA STRUCTURE

  // Line objects. These hold state related to a line, including
  // highlighting info (the styles array).
  var Line = CodeMirror.Line = function(text, markedSpans, estimateHeight) {
    this.text = text;
    attachMarkedSpans(this, markedSpans);
    this.height = estimateHeight ? estimateHeight(this) : 1;
  };
  eventMixin(Line);
  Line.prototype.lineNo = function() { return lineNo(this); };

  // Change the content (text, markers) of a line. Automatically
  // invalidates cached information and tries to re-estimate the
  // line's height.
  function updateLine(line, text, markedSpans, estimateHeight) {
    line.text = text;
    if (line.stateAfter) line.stateAfter = null;
    if (line.styles) line.styles = null;
    if (line.order != null) line.order = null;
    detachMarkedSpans(line);
    attachMarkedSpans(line, markedSpans);
    var estHeight = estimateHeight ? estimateHeight(line) : 1;
    if (estHeight != line.height) updateLineHeight(line, estHeight);
  }

  // Detach a line from the document tree and its markers.
  function cleanUpLine(line) {
    line.parent = null;
    detachMarkedSpans(line);
  }

  function extractLineClasses(type, output) {
    if (type) for (;;) {
      var lineClass = type.match(/(?:^|\s+)line-(background-)?(\S+)/);
      if (!lineClass) break;
      type = type.slice(0, lineClass.index) + type.slice(lineClass.index + lineClass[0].length);
      var prop = lineClass[1] ? "bgClass" : "textClass";
      if (output[prop] == null)
        output[prop] = lineClass[2];
      else if (!(new RegExp("(?:^|\s)" + lineClass[2] + "(?:$|\s)")).test(output[prop]))
        output[prop] += " " + lineClass[2];
    }
    return type;
  }

  function callBlankLine(mode, state) {
    if (mode.blankLine) return mode.blankLine(state);
    if (!mode.innerMode) return;
    var inner = CodeMirror.innerMode(mode, state);
    if (inner.mode.blankLine) return inner.mode.blankLine(inner.state);
  }

  function readToken(mode, stream, state, inner) {
    for (var i = 0; i < 10; i++) {
      if (inner) inner[0] = CodeMirror.innerMode(mode, state).mode;
      var style = mode.token(stream, state);
      if (stream.pos > stream.start) return style;
    }
    throw new Error("Mode " + mode.name + " failed to advance stream.");
  }

  // Utility for getTokenAt and getLineTokens
  function takeToken(cm, pos, precise, asArray) {
    function getObj(copy) {
      return {start: stream.start, end: stream.pos,
              string: stream.current(),
              type: style || null,
              state: copy ? copyState(doc.mode, state) : state};
    }

    var doc = cm.doc, mode = doc.mode, style;
    pos = clipPos(doc, pos);
    var line = getLine(doc, pos.line), state = getStateBefore(cm, pos.line, precise);
    var stream = new StringStream(line.text, cm.options.tabSize), tokens;
    if (asArray) tokens = [];
    while ((asArray || stream.pos < pos.ch) && !stream.eol()) {
      stream.start = stream.pos;
      style = readToken(mode, stream, state);
      if (asArray) tokens.push(getObj(true));
    }
    return asArray ? tokens : getObj();
  }

  // Run the given mode's parser over a line, calling f for each token.
  function runMode(cm, text, mode, state, f, lineClasses, forceToEnd) {
    var flattenSpans = mode.flattenSpans;
    if (flattenSpans == null) flattenSpans = cm.options.flattenSpans;
    var curStart = 0, curStyle = null;
    var stream = new StringStream(text, cm.options.tabSize), style;
    var inner = cm.options.addModeClass && [null];
    if (text == "") extractLineClasses(callBlankLine(mode, state), lineClasses);
    while (!stream.eol()) {
      if (stream.pos > cm.options.maxHighlightLength) {
        flattenSpans = false;
        if (forceToEnd) processLine(cm, text, state, stream.pos);
        stream.pos = text.length;
        style = null;
      } else {
        style = extractLineClasses(readToken(mode, stream, state, inner), lineClasses);
      }
      if (inner) {
        var mName = inner[0].name;
        if (mName) style = "m-" + (style ? mName + " " + style : mName);
      }
      if (!flattenSpans || curStyle != style) {
        while (curStart < stream.start) {
          curStart = Math.min(stream.start, curStart + 50000);
          f(curStart, curStyle);
        }
        curStyle = style;
      }
      stream.start = stream.pos;
    }
    while (curStart < stream.pos) {
      // Webkit seems to refuse to render text nodes longer than 57444 characters
      var pos = Math.min(stream.pos, curStart + 50000);
      f(pos, curStyle);
      curStart = pos;
    }
  }

  // Compute a style array (an array starting with a mode generation
  // -- for invalidation -- followed by pairs of end positions and
  // style strings), which is used to highlight the tokens on the
  // line.
  function highlightLine(cm, line, state, forceToEnd) {
    // A styles array always starts with a number identifying the
    // mode/overlays that it is based on (for easy invalidation).
    var st = [cm.state.modeGen], lineClasses = {};
    // Compute the base array of styles
    runMode(cm, line.text, cm.doc.mode, state, function(end, style) {
      st.push(end, style);
    }, lineClasses, forceToEnd);

    // Run overlays, adjust style array.
    for (var o = 0; o < cm.state.overlays.length; ++o) {
      var overlay = cm.state.overlays[o], i = 1, at = 0;
      runMode(cm, line.text, overlay.mode, true, function(end, style) {
        var start = i;
        // Ensure there's a token end at the current position, and that i points at it
        while (at < end) {
          var i_end = st[i];
          if (i_end > end)
            st.splice(i, 1, end, st[i+1], i_end);
          i += 2;
          at = Math.min(end, i_end);
        }
        if (!style) return;
        if (overlay.opaque) {
          st.splice(start, i - start, end, "cm-overlay " + style);
          i = start + 2;
        } else {
          for (; start < i; start += 2) {
            var cur = st[start+1];
            st[start+1] = (cur ? cur + " " : "") + "cm-overlay " + style;
          }
        }
      }, lineClasses);
    }

    return {styles: st, classes: lineClasses.bgClass || lineClasses.textClass ? lineClasses : null};
  }

  function getLineStyles(cm, line, updateFrontier) {
    if (!line.styles || line.styles[0] != cm.state.modeGen) {
      var state = getStateBefore(cm, lineNo(line));
      var result = highlightLine(cm, line, line.text.length > cm.options.maxHighlightLength ? copyState(cm.doc.mode, state) : state);
      line.stateAfter = state;
      line.styles = result.styles;
      if (result.classes) line.styleClasses = result.classes;
      else if (line.styleClasses) line.styleClasses = null;
      if (updateFrontier === cm.doc.frontier) cm.doc.frontier++;
    }
    return line.styles;
  }

  // Lightweight form of highlight -- proceed over this line and
  // update state, but don't save a style array. Used for lines that
  // aren't currently visible.
  function processLine(cm, text, state, startAt) {
    var mode = cm.doc.mode;
    var stream = new StringStream(text, cm.options.tabSize);
    stream.start = stream.pos = startAt || 0;
    if (text == "") callBlankLine(mode, state);
    while (!stream.eol()) {
      readToken(mode, stream, state);
      stream.start = stream.pos;
    }
  }

  // Convert a style as returned by a mode (either null, or a string
  // containing one or more styles) to a CSS style. This is cached,
  // and also looks for line-wide styles.
  var styleToClassCache = {}, styleToClassCacheWithMode = {};
  function interpretTokenStyle(style, options) {
    if (!style || /^\s*$/.test(style)) return null;
    var cache = options.addModeClass ? styleToClassCacheWithMode : styleToClassCache;
    return cache[style] ||
      (cache[style] = style.replace(/\S+/g, "cm-$&"));
  }

  // Render the DOM representation of the text of a line. Also builds
  // up a 'line map', which points at the DOM nodes that represent
  // specific stretches of text, and is used by the measuring code.
  // The returned object contains the DOM node, this map, and
  // information about line-wide styles that were set by the mode.
  function buildLineContent(cm, lineView) {
    // The padding-right forces the element to have a 'border', which
    // is needed on Webkit to be able to get line-level bounding
    // rectangles for it (in measureChar).
    var content = elt("span", null, null, webkit ? "padding-right: .1px" : null);
    var builder = {pre: elt("pre", [content], "CodeMirror-line"), content: content,
                   col: 0, pos: 0, cm: cm,
                   splitSpaces: (ie || webkit) && cm.getOption("lineWrapping")};
    lineView.measure = {};

    // Iterate over the logical lines that make up this visual line.
    for (var i = 0; i <= (lineView.rest ? lineView.rest.length : 0); i++) {
      var line = i ? lineView.rest[i - 1] : lineView.line, order;
      builder.pos = 0;
      builder.addToken = buildToken;
      // Optionally wire in some hacks into the token-rendering
      // algorithm, to deal with browser quirks.
      if (hasBadBidiRects(cm.display.measure) && (order = getOrder(line)))
        builder.addToken = buildTokenBadBidi(builder.addToken, order);
      builder.map = [];
      var allowFrontierUpdate = lineView != cm.display.externalMeasured && lineNo(line);
      insertLineContent(line, builder, getLineStyles(cm, line, allowFrontierUpdate));
      if (line.styleClasses) {
        if (line.styleClasses.bgClass)
          builder.bgClass = joinClasses(line.styleClasses.bgClass, builder.bgClass || "");
        if (line.styleClasses.textClass)
          builder.textClass = joinClasses(line.styleClasses.textClass, builder.textClass || "");
      }

      // Ensure at least a single node is present, for measuring.
      if (builder.map.length == 0)
        builder.map.push(0, 0, builder.content.appendChild(zeroWidthElement(cm.display.measure)));

      // Store the map and a cache object for the current logical line
      if (i == 0) {
        lineView.measure.map = builder.map;
        lineView.measure.cache = {};
      } else {
        (lineView.measure.maps || (lineView.measure.maps = [])).push(builder.map);
        (lineView.measure.caches || (lineView.measure.caches = [])).push({});
      }
    }

    // See issue #2901
    if (webkit && /\bcm-tab\b/.test(builder.content.lastChild.className))
      builder.content.className = "cm-tab-wrap-hack";

    signal(cm, "renderLine", cm, lineView.line, builder.pre);
    if (builder.pre.className)
      builder.textClass = joinClasses(builder.pre.className, builder.textClass || "");

    return builder;
  }

  function defaultSpecialCharPlaceholder(ch) {
    var token = elt("span", "\u2022", "cm-invalidchar");
    token.title = "\\u" + ch.charCodeAt(0).toString(16);
    token.setAttribute("aria-label", token.title);
    return token;
  }

  // Build up the DOM representation for a single token, and add it to
  // the line map. Takes care to render special characters separately.
  function buildToken(builder, text, style, startStyle, endStyle, title, css) {
    if (!text) return;
    var displayText = builder.splitSpaces ? text.replace(/ {3,}/g, splitSpaces) : text;
    var special = builder.cm.state.specialChars, mustWrap = false;
    if (!special.test(text)) {
      builder.col += text.length;
      var content = document.createTextNode(displayText);
      builder.map.push(builder.pos, builder.pos + text.length, content);
      if (ie && ie_version < 9) mustWrap = true;
      builder.pos += text.length;
    } else {
      var content = document.createDocumentFragment(), pos = 0;
      while (true) {
        special.lastIndex = pos;
        var m = special.exec(text);
        var skipped = m ? m.index - pos : text.length - pos;
        if (skipped) {
          var txt = document.createTextNode(displayText.slice(pos, pos + skipped));
          if (ie && ie_version < 9) content.appendChild(elt("span", [txt]));
          else content.appendChild(txt);
          builder.map.push(builder.pos, builder.pos + skipped, txt);
          builder.col += skipped;
          builder.pos += skipped;
        }
        if (!m) break;
        pos += skipped + 1;
        if (m[0] == "\t") {
          var tabSize = builder.cm.options.tabSize, tabWidth = tabSize - builder.col % tabSize;
          var txt = content.appendChild(elt("span", spaceStr(tabWidth), "cm-tab"));
          txt.setAttribute("role", "presentation");
          txt.setAttribute("cm-text", "\t");
          builder.col += tabWidth;
        } else if (m[0] == "\r" || m[0] == "\n") {
          var txt = content.appendChild(elt("span", m[0] == "\r" ? "\u240d" : "\u2424", "cm-invalidchar"));
          txt.setAttribute("cm-text", m[0]);
          builder.col += 1;
        } else {
          var txt = builder.cm.options.specialCharPlaceholder(m[0]);
          txt.setAttribute("cm-text", m[0]);
          if (ie && ie_version < 9) content.appendChild(elt("span", [txt]));
          else content.appendChild(txt);
          builder.col += 1;
        }
        builder.map.push(builder.pos, builder.pos + 1, txt);
        builder.pos++;
      }
    }
    if (style || startStyle || endStyle || mustWrap || css) {
      var fullStyle = style || "";
      if (startStyle) fullStyle += startStyle;
      if (endStyle) fullStyle += endStyle;
      var token = elt("span", [content], fullStyle, css);
      if (title) token.title = title;
      return builder.content.appendChild(token);
    }
    builder.content.appendChild(content);
  }

  function splitSpaces(old) {
    var out = " ";
    for (var i = 0; i < old.length - 2; ++i) out += i % 2 ? " " : "\u00a0";
    out += " ";
    return out;
  }

  // Work around nonsense dimensions being reported for stretches of
  // right-to-left text.
  function buildTokenBadBidi(inner, order) {
    return function(builder, text, style, startStyle, endStyle, title, css) {
      style = style ? style + " cm-force-border" : "cm-force-border";
      var start = builder.pos, end = start + text.length;
      for (;;) {
        // Find the part that overlaps with the start of this text
        for (var i = 0; i < order.length; i++) {
          var part = order[i];
          if (part.to > start && part.from <= start) break;
        }
        if (part.to >= end) return inner(builder, text, style, startStyle, endStyle, title, css);
        inner(builder, text.slice(0, part.to - start), style, startStyle, null, title, css);
        startStyle = null;
        text = text.slice(part.to - start);
        start = part.to;
      }
    };
  }

  function buildCollapsedSpan(builder, size, marker, ignoreWidget) {
    var widget = !ignoreWidget && marker.widgetNode;
    if (widget) builder.map.push(builder.pos, builder.pos + size, widget);
    if (!ignoreWidget && builder.cm.display.input.needsContentAttribute) {
      if (!widget)
        widget = builder.content.appendChild(document.createElement("span"));
      widget.setAttribute("cm-marker", marker.id);
    }
    if (widget) {
      builder.cm.display.input.setUneditable(widget);
      builder.content.appendChild(widget);
    }
    builder.pos += size;
  }

  // Outputs a number of spans to make up a line, taking highlighting
  // and marked text into account.
  function insertLineContent(line, builder, styles) {
    var spans = line.markedSpans, allText = line.text, at = 0;
    if (!spans) {
      for (var i = 1; i < styles.length; i+=2)
        builder.addToken(builder, allText.slice(at, at = styles[i]), interpretTokenStyle(styles[i+1], builder.cm.options));
      return;
    }

    var len = allText.length, pos = 0, i = 1, text = "", style, css;
    var nextChange = 0, spanStyle, spanEndStyle, spanStartStyle, title, collapsed;
    for (;;) {
      if (nextChange == pos) { // Update current marker set
        spanStyle = spanEndStyle = spanStartStyle = title = css = "";
        collapsed = null; nextChange = Infinity;
        var foundBookmarks = [];
        for (var j = 0; j < spans.length; ++j) {
          var sp = spans[j], m = sp.marker;
          if (m.type == "bookmark" && sp.from == pos && m.widgetNode) {
            foundBookmarks.push(m);
          } else if (sp.from <= pos && (sp.to == null || sp.to > pos || m.collapsed && sp.to == pos && sp.from == pos)) {
            if (sp.to != null && sp.to != pos && nextChange > sp.to) {
              nextChange = sp.to;
              spanEndStyle = "";
            }
            if (m.className) spanStyle += " " + m.className;
            if (m.css) css = m.css;
            if (m.startStyle && sp.from == pos) spanStartStyle += " " + m.startStyle;
            if (m.endStyle && sp.to == nextChange) spanEndStyle += " " + m.endStyle;
            if (m.title && !title) title = m.title;
            if (m.collapsed && (!collapsed || compareCollapsedMarkers(collapsed.marker, m) < 0))
              collapsed = sp;
          } else if (sp.from > pos && nextChange > sp.from) {
            nextChange = sp.from;
          }
        }
        if (collapsed && (collapsed.from || 0) == pos) {
          buildCollapsedSpan(builder, (collapsed.to == null ? len + 1 : collapsed.to) - pos,
                             collapsed.marker, collapsed.from == null);
          if (collapsed.to == null) return;
          if (collapsed.to == pos) collapsed = false;
        }
        if (!collapsed && foundBookmarks.length) for (var j = 0; j < foundBookmarks.length; ++j)
          buildCollapsedSpan(builder, 0, foundBookmarks[j]);
      }
      if (pos >= len) break;

      var upto = Math.min(len, nextChange);
      while (true) {
        if (text) {
          var end = pos + text.length;
          if (!collapsed) {
            var tokenText = end > upto ? text.slice(0, upto - pos) : text;
            builder.addToken(builder, tokenText, style ? style + spanStyle : spanStyle,
                             spanStartStyle, pos + tokenText.length == nextChange ? spanEndStyle : "", title, css);
          }
          if (end >= upto) {text = text.slice(upto - pos); pos = upto; break;}
          pos = end;
          spanStartStyle = "";
        }
        text = allText.slice(at, at = styles[i++]);
        style = interpretTokenStyle(styles[i++], builder.cm.options);
      }
    }
  }

  // DOCUMENT DATA STRUCTURE

  // By default, updates that start and end at the beginning of a line
  // are treated specially, in order to make the association of line
  // widgets and marker elements with the text behave more intuitive.
  function isWholeLineUpdate(doc, change) {
    return change.from.ch == 0 && change.to.ch == 0 && lst(change.text) == "" &&
      (!doc.cm || doc.cm.options.wholeLineUpdateBefore);
  }

  // Perform a change on the document data structure.
  function updateDoc(doc, change, markedSpans, estimateHeight) {
    function spansFor(n) {return markedSpans ? markedSpans[n] : null;}
    function update(line, text, spans) {
      updateLine(line, text, spans, estimateHeight);
      signalLater(line, "change", line, change);
    }
    function linesFor(start, end) {
      for (var i = start, result = []; i < end; ++i)
        result.push(new Line(text[i], spansFor(i), estimateHeight));
      return result;
    }

    var from = change.from, to = change.to, text = change.text;
    var firstLine = getLine(doc, from.line), lastLine = getLine(doc, to.line);
    var lastText = lst(text), lastSpans = spansFor(text.length - 1), nlines = to.line - from.line;

    // Adjust the line structure
    if (change.full) {
      doc.insert(0, linesFor(0, text.length));
      doc.remove(text.length, doc.size - text.length);
    } else if (isWholeLineUpdate(doc, change)) {
      // This is a whole-line replace. Treated specially to make
      // sure line objects move the way they are supposed to.
      var added = linesFor(0, text.length - 1);
      update(lastLine, lastLine.text, lastSpans);
      if (nlines) doc.remove(from.line, nlines);
      if (added.length) doc.insert(from.line, added);
    } else if (firstLine == lastLine) {
      if (text.length == 1) {
        update(firstLine, firstLine.text.slice(0, from.ch) + lastText + firstLine.text.slice(to.ch), lastSpans);
      } else {
        var added = linesFor(1, text.length - 1);
        added.push(new Line(lastText + firstLine.text.slice(to.ch), lastSpans, estimateHeight));
        update(firstLine, firstLine.text.slice(0, from.ch) + text[0], spansFor(0));
        doc.insert(from.line + 1, added);
      }
    } else if (text.length == 1) {
      update(firstLine, firstLine.text.slice(0, from.ch) + text[0] + lastLine.text.slice(to.ch), spansFor(0));
      doc.remove(from.line + 1, nlines);
    } else {
      update(firstLine, firstLine.text.slice(0, from.ch) + text[0], spansFor(0));
      update(lastLine, lastText + lastLine.text.slice(to.ch), lastSpans);
      var added = linesFor(1, text.length - 1);
      if (nlines > 1) doc.remove(from.line + 1, nlines - 1);
      doc.insert(from.line + 1, added);
    }

    signalLater(doc, "change", doc, change);
  }

  // The document is represented as a BTree consisting of leaves, with
  // chunk of lines in them, and branches, with up to ten leaves or
  // other branch nodes below them. The top node is always a branch
  // node, and is the document object itself (meaning it has
  // additional methods and properties).
  //
  // All nodes have parent links. The tree is used both to go from
  // line numbers to line objects, and to go from objects to numbers.
  // It also indexes by height, and is used to convert between height
  // and line object, and to find the total height of the document.
  //
  // See also http://marijnhaverbeke.nl/blog/codemirror-line-tree.html

  function LeafChunk(lines) {
    this.lines = lines;
    this.parent = null;
    for (var i = 0, height = 0; i < lines.length; ++i) {
      lines[i].parent = this;
      height += lines[i].height;
    }
    this.height = height;
  }

  LeafChunk.prototype = {
    chunkSize: function() { return this.lines.length; },
    // Remove the n lines at offset 'at'.
    removeInner: function(at, n) {
      for (var i = at, e = at + n; i < e; ++i) {
        var line = this.lines[i];
        this.height -= line.height;
        cleanUpLine(line);
        signalLater(line, "delete");
      }
      this.lines.splice(at, n);
    },
    // Helper used to collapse a small branch into a single leaf.
    collapse: function(lines) {
      lines.push.apply(lines, this.lines);
    },
    // Insert the given array of lines at offset 'at', count them as
    // having the given height.
    insertInner: function(at, lines, height) {
      this.height += height;
      this.lines = this.lines.slice(0, at).concat(lines).concat(this.lines.slice(at));
      for (var i = 0; i < lines.length; ++i) lines[i].parent = this;
    },
    // Used to iterate over a part of the tree.
    iterN: function(at, n, op) {
      for (var e = at + n; at < e; ++at)
        if (op(this.lines[at])) return true;
    }
  };

  function BranchChunk(children) {
    this.children = children;
    var size = 0, height = 0;
    for (var i = 0; i < children.length; ++i) {
      var ch = children[i];
      size += ch.chunkSize(); height += ch.height;
      ch.parent = this;
    }
    this.size = size;
    this.height = height;
    this.parent = null;
  }

  BranchChunk.prototype = {
    chunkSize: function() { return this.size; },
    removeInner: function(at, n) {
      this.size -= n;
      for (var i = 0; i < this.children.length; ++i) {
        var child = this.children[i], sz = child.chunkSize();
        if (at < sz) {
          var rm = Math.min(n, sz - at), oldHeight = child.height;
          child.removeInner(at, rm);
          this.height -= oldHeight - child.height;
          if (sz == rm) { this.children.splice(i--, 1); child.parent = null; }
          if ((n -= rm) == 0) break;
          at = 0;
        } else at -= sz;
      }
      // If the result is smaller than 25 lines, ensure that it is a
      // single leaf node.
      if (this.size - n < 25 &&
          (this.children.length > 1 || !(this.children[0] instanceof LeafChunk))) {
        var lines = [];
        this.collapse(lines);
        this.children = [new LeafChunk(lines)];
        this.children[0].parent = this;
      }
    },
    collapse: function(lines) {
      for (var i = 0; i < this.children.length; ++i) this.children[i].collapse(lines);
    },
    insertInner: function(at, lines, height) {
      this.size += lines.length;
      this.height += height;
      for (var i = 0; i < this.children.length; ++i) {
        var child = this.children[i], sz = child.chunkSize();
        if (at <= sz) {
          child.insertInner(at, lines, height);
          if (child.lines && child.lines.length > 50) {
            while (child.lines.length > 50) {
              var spilled = child.lines.splice(child.lines.length - 25, 25);
              var newleaf = new LeafChunk(spilled);
              child.height -= newleaf.height;
              this.children.splice(i + 1, 0, newleaf);
              newleaf.parent = this;
            }
            this.maybeSpill();
          }
          break;
        }
        at -= sz;
      }
    },
    // When a node has grown, check whether it should be split.
    maybeSpill: function() {
      if (this.children.length <= 10) return;
      var me = this;
      do {
        var spilled = me.children.splice(me.children.length - 5, 5);
        var sibling = new BranchChunk(spilled);
        if (!me.parent) { // Become the parent node
          var copy = new BranchChunk(me.children);
          copy.parent = me;
          me.children = [copy, sibling];
          me = copy;
        } else {
          me.size -= sibling.size;
          me.height -= sibling.height;
          var myIndex = indexOf(me.parent.children, me);
          me.parent.children.splice(myIndex + 1, 0, sibling);
        }
        sibling.parent = me.parent;
      } while (me.children.length > 10);
      me.parent.maybeSpill();
    },
    iterN: function(at, n, op) {
      for (var i = 0; i < this.children.length; ++i) {
        var child = this.children[i], sz = child.chunkSize();
        if (at < sz) {
          var used = Math.min(n, sz - at);
          if (child.iterN(at, used, op)) return true;
          if ((n -= used) == 0) break;
          at = 0;
        } else at -= sz;
      }
    }
  };

  var nextDocId = 0;
  var Doc = CodeMirror.Doc = function(text, mode, firstLine, lineSep) {
    if (!(this instanceof Doc)) return new Doc(text, mode, firstLine, lineSep);
    if (firstLine == null) firstLine = 0;

    BranchChunk.call(this, [new LeafChunk([new Line("", null)])]);
    this.first = firstLine;
    this.scrollTop = this.scrollLeft = 0;
    this.cantEdit = false;
    this.cleanGeneration = 1;
    this.frontier = firstLine;
    var start = Pos(firstLine, 0);
    this.sel = simpleSelection(start);
    this.history = new History(null);
    this.id = ++nextDocId;
    this.modeOption = mode;
    this.lineSep = lineSep;

    if (typeof text == "string") text = this.splitLines(text);
    updateDoc(this, {from: start, to: start, text: text});
    setSelection(this, simpleSelection(start), sel_dontScroll);
  };

  Doc.prototype = createObj(BranchChunk.prototype, {
    constructor: Doc,
    // Iterate over the document. Supports two forms -- with only one
    // argument, it calls that for each line in the document. With
    // three, it iterates over the range given by the first two (with
    // the second being non-inclusive).
    iter: function(from, to, op) {
      if (op) this.iterN(from - this.first, to - from, op);
      else this.iterN(this.first, this.first + this.size, from);
    },

    // Non-public interface for adding and removing lines.
    insert: function(at, lines) {
      var height = 0;
      for (var i = 0; i < lines.length; ++i) height += lines[i].height;
      this.insertInner(at - this.first, lines, height);
    },
    remove: function(at, n) { this.removeInner(at - this.first, n); },

    // From here, the methods are part of the public interface. Most
    // are also available from CodeMirror (editor) instances.

    getValue: function(lineSep) {
      var lines = getLines(this, this.first, this.first + this.size);
      if (lineSep === false) return lines;
      return lines.join(lineSep || this.lineSeparator());
    },
    setValue: docMethodOp(function(code) {
      var top = Pos(this.first, 0), last = this.first + this.size - 1;
      makeChange(this, {from: top, to: Pos(last, getLine(this, last).text.length),
                        text: this.splitLines(code), origin: "setValue", full: true}, true);
      setSelection(this, simpleSelection(top));
    }),
    replaceRange: function(code, from, to, origin) {
      from = clipPos(this, from);
      to = to ? clipPos(this, to) : from;
      replaceRange(this, code, from, to, origin);
    },
    getRange: function(from, to, lineSep) {
      var lines = getBetween(this, clipPos(this, from), clipPos(this, to));
      if (lineSep === false) return lines;
      return lines.join(lineSep || this.lineSeparator());
    },

    getLine: function(line) {var l = this.getLineHandle(line); return l && l.text;},

    getLineHandle: function(line) {if (isLine(this, line)) return getLine(this, line);},
    getLineNumber: function(line) {return lineNo(line);},

    getLineHandleVisualStart: function(line) {
      if (typeof line == "number") line = getLine(this, line);
      return visualLine(line);
    },

    lineCount: function() {return this.size;},
    firstLine: function() {return this.first;},
    lastLine: function() {return this.first + this.size - 1;},

    clipPos: function(pos) {return clipPos(this, pos);},

    getCursor: function(start) {
      var range = this.sel.primary(), pos;
      if (start == null || start == "head") pos = range.head;
      else if (start == "anchor") pos = range.anchor;
      else if (start == "end" || start == "to" || start === false) pos = range.to();
      else pos = range.from();
      return pos;
    },
    listSelections: function() { return this.sel.ranges; },
    somethingSelected: function() {return this.sel.somethingSelected();},

    setCursor: docMethodOp(function(line, ch, options) {
      setSimpleSelection(this, clipPos(this, typeof line == "number" ? Pos(line, ch || 0) : line), null, options);
    }),
    setSelection: docMethodOp(function(anchor, head, options) {
      setSimpleSelection(this, clipPos(this, anchor), clipPos(this, head || anchor), options);
    }),
    extendSelection: docMethodOp(function(head, other, options) {
      extendSelection(this, clipPos(this, head), other && clipPos(this, other), options);
    }),
    extendSelections: docMethodOp(function(heads, options) {
      extendSelections(this, clipPosArray(this, heads, options));
    }),
    extendSelectionsBy: docMethodOp(function(f, options) {
      extendSelections(this, map(this.sel.ranges, f), options);
    }),
    setSelections: docMethodOp(function(ranges, primary, options) {
      if (!ranges.length) return;
      for (var i = 0, out = []; i < ranges.length; i++)
        out[i] = new Range(clipPos(this, ranges[i].anchor),
                           clipPos(this, ranges[i].head));
      if (primary == null) primary = Math.min(ranges.length - 1, this.sel.primIndex);
      setSelection(this, normalizeSelection(out, primary), options);
    }),
    addSelection: docMethodOp(function(anchor, head, options) {
      var ranges = this.sel.ranges.slice(0);
      ranges.push(new Range(clipPos(this, anchor), clipPos(this, head || anchor)));
      setSelection(this, normalizeSelection(ranges, ranges.length - 1), options);
    }),

    getSelection: function(lineSep) {
      var ranges = this.sel.ranges, lines;
      for (var i = 0; i < ranges.length; i++) {
        var sel = getBetween(this, ranges[i].from(), ranges[i].to());
        lines = lines ? lines.concat(sel) : sel;
      }
      if (lineSep === false) return lines;
      else return lines.join(lineSep || this.lineSeparator());
    },
    getSelections: function(lineSep) {
      var parts = [], ranges = this.sel.ranges;
      for (var i = 0; i < ranges.length; i++) {
        var sel = getBetween(this, ranges[i].from(), ranges[i].to());
        if (lineSep !== false) sel = sel.join(lineSep || this.lineSeparator());
        parts[i] = sel;
      }
      return parts;
    },
    replaceSelection: function(code, collapse, origin) {
      var dup = [];
      for (var i = 0; i < this.sel.ranges.length; i++)
        dup[i] = code;
      this.replaceSelections(dup, collapse, origin || "+input");
    },
    replaceSelections: docMethodOp(function(code, collapse, origin) {
      var changes = [], sel = this.sel;
      for (var i = 0; i < sel.ranges.length; i++) {
        var range = sel.ranges[i];
        changes[i] = {from: range.from(), to: range.to(), text: this.splitLines(code[i]), origin: origin};
      }
      var newSel = collapse && collapse != "end" && computeReplacedSel(this, changes, collapse);
      for (var i = changes.length - 1; i >= 0; i--)
        makeChange(this, changes[i]);
      if (newSel) setSelectionReplaceHistory(this, newSel);
      else if (this.cm) ensureCursorVisible(this.cm);
    }),
    undo: docMethodOp(function() {makeChangeFromHistory(this, "undo");}),
    redo: docMethodOp(function() {makeChangeFromHistory(this, "redo");}),
    undoSelection: docMethodOp(function() {makeChangeFromHistory(this, "undo", true);}),
    redoSelection: docMethodOp(function() {makeChangeFromHistory(this, "redo", true);}),

    setExtending: function(val) {this.extend = val;},
    getExtending: function() {return this.extend;},

    historySize: function() {
      var hist = this.history, done = 0, undone = 0;
      for (var i = 0; i < hist.done.length; i++) if (!hist.done[i].ranges) ++done;
      for (var i = 0; i < hist.undone.length; i++) if (!hist.undone[i].ranges) ++undone;
      return {undo: done, redo: undone};
    },
    clearHistory: function() {this.history = new History(this.history.maxGeneration);},

    markClean: function() {
      this.cleanGeneration = this.changeGeneration(true);
    },
    changeGeneration: function(forceSplit) {
      if (forceSplit)
        this.history.lastOp = this.history.lastSelOp = this.history.lastOrigin = null;
      return this.history.generation;
    },
    isClean: function (gen) {
      return this.history.generation == (gen || this.cleanGeneration);
    },

    getHistory: function() {
      return {done: copyHistoryArray(this.history.done),
              undone: copyHistoryArray(this.history.undone)};
    },
    setHistory: function(histData) {
      var hist = this.history = new History(this.history.maxGeneration);
      hist.done = copyHistoryArray(histData.done.slice(0), null, true);
      hist.undone = copyHistoryArray(histData.undone.slice(0), null, true);
    },

    addLineClass: docMethodOp(function(handle, where, cls) {
      return changeLine(this, handle, where == "gutter" ? "gutter" : "class", function(line) {
        var prop = where == "text" ? "textClass"
                 : where == "background" ? "bgClass"
                 : where == "gutter" ? "gutterClass" : "wrapClass";
        if (!line[prop]) line[prop] = cls;
        else if (classTest(cls).test(line[prop])) return false;
        else line[prop] += " " + cls;
        return true;
      });
    }),
    removeLineClass: docMethodOp(function(handle, where, cls) {
      return changeLine(this, handle, where == "gutter" ? "gutter" : "class", function(line) {
        var prop = where == "text" ? "textClass"
                 : where == "background" ? "bgClass"
                 : where == "gutter" ? "gutterClass" : "wrapClass";
        var cur = line[prop];
        if (!cur) return false;
        else if (cls == null) line[prop] = null;
        else {
          var found = cur.match(classTest(cls));
          if (!found) return false;
          var end = found.index + found[0].length;
          line[prop] = cur.slice(0, found.index) + (!found.index || end == cur.length ? "" : " ") + cur.slice(end) || null;
        }
        return true;
      });
    }),

    addLineWidget: docMethodOp(function(handle, node, options) {
      return addLineWidget(this, handle, node, options);
    }),
    removeLineWidget: function(widget) { widget.clear(); },

    markText: function(from, to, options) {
      return markText(this, clipPos(this, from), clipPos(this, to), options, options && options.type || "range");
    },
    setBookmark: function(pos, options) {
      var realOpts = {replacedWith: options && (options.nodeType == null ? options.widget : options),
                      insertLeft: options && options.insertLeft,
                      clearWhenEmpty: false, shared: options && options.shared,
                      handleMouseEvents: options && options.handleMouseEvents};
      pos = clipPos(this, pos);
      return markText(this, pos, pos, realOpts, "bookmark");
    },
    findMarksAt: function(pos) {
      pos = clipPos(this, pos);
      var markers = [], spans = getLine(this, pos.line).markedSpans;
      if (spans) for (var i = 0; i < spans.length; ++i) {
        var span = spans[i];
        if ((span.from == null || span.from <= pos.ch) &&
            (span.to == null || span.to >= pos.ch))
          markers.push(span.marker.parent || span.marker);
      }
      return markers;
    },
    findMarks: function(from, to, filter) {
      from = clipPos(this, from); to = clipPos(this, to);
      var found = [], lineNo = from.line;
      this.iter(from.line, to.line + 1, function(line) {
        var spans = line.markedSpans;
        if (spans) for (var i = 0; i < spans.length; i++) {
          var span = spans[i];
          if (!(lineNo == from.line && from.ch > span.to ||
                span.from == null && lineNo != from.line||
                lineNo == to.line && span.from > to.ch) &&
              (!filter || filter(span.marker)))
            found.push(span.marker.parent || span.marker);
        }
        ++lineNo;
      });
      return found;
    },
    getAllMarks: function() {
      var markers = [];
      this.iter(function(line) {
        var sps = line.markedSpans;
        if (sps) for (var i = 0; i < sps.length; ++i)
          if (sps[i].from != null) markers.push(sps[i].marker);
      });
      return markers;
    },

    posFromIndex: function(off) {
      var ch, lineNo = this.first;
      this.iter(function(line) {
        var sz = line.text.length + 1;
        if (sz > off) { ch = off; return true; }
        off -= sz;
        ++lineNo;
      });
      return clipPos(this, Pos(lineNo, ch));
    },
    indexFromPos: function (coords) {
      coords = clipPos(this, coords);
      var index = coords.ch;
      if (coords.line < this.first || coords.ch < 0) return 0;
      this.iter(this.first, coords.line, function (line) {
        index += line.text.length + 1;
      });
      return index;
    },

    copy: function(copyHistory) {
      var doc = new Doc(getLines(this, this.first, this.first + this.size),
                        this.modeOption, this.first, this.lineSep);
      doc.scrollTop = this.scrollTop; doc.scrollLeft = this.scrollLeft;
      doc.sel = this.sel;
      doc.extend = false;
      if (copyHistory) {
        doc.history.undoDepth = this.history.undoDepth;
        doc.setHistory(this.getHistory());
      }
      return doc;
    },

    linkedDoc: function(options) {
      if (!options) options = {};
      var from = this.first, to = this.first + this.size;
      if (options.from != null && options.from > from) from = options.from;
      if (options.to != null && options.to < to) to = options.to;
      var copy = new Doc(getLines(this, from, to), options.mode || this.modeOption, from, this.lineSep);
      if (options.sharedHist) copy.history = this.history;
      (this.linked || (this.linked = [])).push({doc: copy, sharedHist: options.sharedHist});
      copy.linked = [{doc: this, isParent: true, sharedHist: options.sharedHist}];
      copySharedMarkers(copy, findSharedMarkers(this));
      return copy;
    },
    unlinkDoc: function(other) {
      if (other instanceof CodeMirror) other = other.doc;
      if (this.linked) for (var i = 0; i < this.linked.length; ++i) {
        var link = this.linked[i];
        if (link.doc != other) continue;
        this.linked.splice(i, 1);
        other.unlinkDoc(this);
        detachSharedMarkers(findSharedMarkers(this));
        break;
      }
      // If the histories were shared, split them again
      if (other.history == this.history) {
        var splitIds = [other.id];
        linkedDocs(other, function(doc) {splitIds.push(doc.id);}, true);
        other.history = new History(null);
        other.history.done = copyHistoryArray(this.history.done, splitIds);
        other.history.undone = copyHistoryArray(this.history.undone, splitIds);
      }
    },
    iterLinkedDocs: function(f) {linkedDocs(this, f);},

    getMode: function() {return this.mode;},
    getEditor: function() {return this.cm;},

    splitLines: function(str) {
      if (this.lineSep) return str.split(this.lineSep);
      return splitLinesAuto(str);
    },
    lineSeparator: function() { return this.lineSep || "\n"; }
  });

  // Public alias.
  Doc.prototype.eachLine = Doc.prototype.iter;

  // Set up methods on CodeMirror's prototype to redirect to the editor's document.
  var dontDelegate = "iter insert remove copy getEditor constructor".split(" ");
  for (var prop in Doc.prototype) if (Doc.prototype.hasOwnProperty(prop) && indexOf(dontDelegate, prop) < 0)
    CodeMirror.prototype[prop] = (function(method) {
      return function() {return method.apply(this.doc, arguments);};
    })(Doc.prototype[prop]);

  eventMixin(Doc);

  // Call f for all linked documents.
  function linkedDocs(doc, f, sharedHistOnly) {
    function propagate(doc, skip, sharedHist) {
      if (doc.linked) for (var i = 0; i < doc.linked.length; ++i) {
        var rel = doc.linked[i];
        if (rel.doc == skip) continue;
        var shared = sharedHist && rel.sharedHist;
        if (sharedHistOnly && !shared) continue;
        f(rel.doc, shared);
        propagate(rel.doc, doc, shared);
      }
    }
    propagate(doc, null, true);
  }

  // Attach a document to an editor.
  function attachDoc(cm, doc) {
    if (doc.cm) throw new Error("This document is already in use.");
    cm.doc = doc;
    doc.cm = cm;
    estimateLineHeights(cm);
    loadMode(cm);
    if (!cm.options.lineWrapping) findMaxLine(cm);
    cm.options.mode = doc.modeOption;
    regChange(cm);
  }

  // LINE UTILITIES

  // Find the line object corresponding to the given line number.
  function getLine(doc, n) {
    n -= doc.first;
    if (n < 0 || n >= doc.size) throw new Error("There is no line " + (n + doc.first) + " in the document.");
    for (var chunk = doc; !chunk.lines;) {
      for (var i = 0;; ++i) {
        var child = chunk.children[i], sz = child.chunkSize();
        if (n < sz) { chunk = child; break; }
        n -= sz;
      }
    }
    return chunk.lines[n];
  }

  // Get the part of a document between two positions, as an array of
  // strings.
  function getBetween(doc, start, end) {
    var out = [], n = start.line;
    doc.iter(start.line, end.line + 1, function(line) {
      var text = line.text;
      if (n == end.line) text = text.slice(0, end.ch);
      if (n == start.line) text = text.slice(start.ch);
      out.push(text);
      ++n;
    });
    return out;
  }
  // Get the lines between from and to, as array of strings.
  function getLines(doc, from, to) {
    var out = [];
    doc.iter(from, to, function(line) { out.push(line.text); });
    return out;
  }

  // Update the height of a line, propagating the height change
  // upwards to parent nodes.
  function updateLineHeight(line, height) {
    var diff = height - line.height;
    if (diff) for (var n = line; n; n = n.parent) n.height += diff;
  }

  // Given a line object, find its line number by walking up through
  // its parent links.
  function lineNo(line) {
    if (line.parent == null) return null;
    var cur = line.parent, no = indexOf(cur.lines, line);
    for (var chunk = cur.parent; chunk; cur = chunk, chunk = chunk.parent) {
      for (var i = 0;; ++i) {
        if (chunk.children[i] == cur) break;
        no += chunk.children[i].chunkSize();
      }
    }
    return no + cur.first;
  }

  // Find the line at the given vertical position, using the height
  // information in the document tree.
  function lineAtHeight(chunk, h) {
    var n = chunk.first;
    outer: do {
      for (var i = 0; i < chunk.children.length; ++i) {
        var child = chunk.children[i], ch = child.height;
        if (h < ch) { chunk = child; continue outer; }
        h -= ch;
        n += child.chunkSize();
      }
      return n;
    } while (!chunk.lines);
    for (var i = 0; i < chunk.lines.length; ++i) {
      var line = chunk.lines[i], lh = line.height;
      if (h < lh) break;
      h -= lh;
    }
    return n + i;
  }


  // Find the height above the given line.
  function heightAtLine(lineObj) {
    lineObj = visualLine(lineObj);

    var h = 0, chunk = lineObj.parent;
    for (var i = 0; i < chunk.lines.length; ++i) {
      var line = chunk.lines[i];
      if (line == lineObj) break;
      else h += line.height;
    }
    for (var p = chunk.parent; p; chunk = p, p = chunk.parent) {
      for (var i = 0; i < p.children.length; ++i) {
        var cur = p.children[i];
        if (cur == chunk) break;
        else h += cur.height;
      }
    }
    return h;
  }

  // Get the bidi ordering for the given line (and cache it). Returns
  // false for lines that are fully left-to-right, and an array of
  // BidiSpan objects otherwise.
  function getOrder(line) {
    var order = line.order;
    if (order == null) order = line.order = bidiOrdering(line.text);
    return order;
  }

  // HISTORY

  function History(startGen) {
    // Arrays of change events and selections. Doing something adds an
    // event to done and clears undo. Undoing moves events from done
    // to undone, redoing moves them in the other direction.
    this.done = []; this.undone = [];
    this.undoDepth = Infinity;
    // Used to track when changes can be merged into a single undo
    // event
    this.lastModTime = this.lastSelTime = 0;
    this.lastOp = this.lastSelOp = null;
    this.lastOrigin = this.lastSelOrigin = null;
    // Used by the isClean() method
    this.generation = this.maxGeneration = startGen || 1;
  }

  // Create a history change event from an updateDoc-style change
  // object.
  function historyChangeFromChange(doc, change) {
    var histChange = {from: copyPos(change.from), to: changeEnd(change), text: getBetween(doc, change.from, change.to)};
    attachLocalSpans(doc, histChange, change.from.line, change.to.line + 1);
    linkedDocs(doc, function(doc) {attachLocalSpans(doc, histChange, change.from.line, change.to.line + 1);}, true);
    return histChange;
  }

  // Pop all selection events off the end of a history array. Stop at
  // a change event.
  function clearSelectionEvents(array) {
    while (array.length) {
      var last = lst(array);
      if (last.ranges) array.pop();
      else break;
    }
  }

  // Find the top change event in the history. Pop off selection
  // events that are in the way.
  function lastChangeEvent(hist, force) {
    if (force) {
      clearSelectionEvents(hist.done);
      return lst(hist.done);
    } else if (hist.done.length && !lst(hist.done).ranges) {
      return lst(hist.done);
    } else if (hist.done.length > 1 && !hist.done[hist.done.length - 2].ranges) {
      hist.done.pop();
      return lst(hist.done);
    }
  }

  // Register a change in the history. Merges changes that are within
  // a single operation, ore are close together with an origin that
  // allows merging (starting with "+") into a single event.
  function addChangeToHistory(doc, change, selAfter, opId) {
    var hist = doc.history;
    hist.undone.length = 0;
    var time = +new Date, cur;

    if ((hist.lastOp == opId ||
         hist.lastOrigin == change.origin && change.origin &&
         ((change.origin.charAt(0) == "+" && doc.cm && hist.lastModTime > time - doc.cm.options.historyEventDelay) ||
          change.origin.charAt(0) == "*")) &&
        (cur = lastChangeEvent(hist, hist.lastOp == opId))) {
      // Merge this change into the last event
      var last = lst(cur.changes);
      if (cmp(change.from, change.to) == 0 && cmp(change.from, last.to) == 0) {
        // Optimized case for simple insertion -- don't want to add
        // new changesets for every character typed
        last.to = changeEnd(change);
      } else {
        // Add new sub-event
        cur.changes.push(historyChangeFromChange(doc, change));
      }
    } else {
      // Can not be merged, start a new event.
      var before = lst(hist.done);
      if (!before || !before.ranges)
        pushSelectionToHistory(doc.sel, hist.done);
      cur = {changes: [historyChangeFromChange(doc, change)],
             generation: hist.generation};
      hist.done.push(cur);
      while (hist.done.length > hist.undoDepth) {
        hist.done.shift();
        if (!hist.done[0].ranges) hist.done.shift();
      }
    }
    hist.done.push(selAfter);
    hist.generation = ++hist.maxGeneration;
    hist.lastModTime = hist.lastSelTime = time;
    hist.lastOp = hist.lastSelOp = opId;
    hist.lastOrigin = hist.lastSelOrigin = change.origin;

    if (!last) signal(doc, "historyAdded");
  }

  function selectionEventCanBeMerged(doc, origin, prev, sel) {
    var ch = origin.charAt(0);
    return ch == "*" ||
      ch == "+" &&
      prev.ranges.length == sel.ranges.length &&
      prev.somethingSelected() == sel.somethingSelected() &&
      new Date - doc.history.lastSelTime <= (doc.cm ? doc.cm.options.historyEventDelay : 500);
  }

  // Called whenever the selection changes, sets the new selection as
  // the pending selection in the history, and pushes the old pending
  // selection into the 'done' array when it was significantly
  // different (in number of selected ranges, emptiness, or time).
  function addSelectionToHistory(doc, sel, opId, options) {
    var hist = doc.history, origin = options && options.origin;

    // A new event is started when the previous origin does not match
    // the current, or the origins don't allow matching. Origins
    // starting with * are always merged, those starting with + are
    // merged when similar and close together in time.
    if (opId == hist.lastSelOp ||
        (origin && hist.lastSelOrigin == origin &&
         (hist.lastModTime == hist.lastSelTime && hist.lastOrigin == origin ||
          selectionEventCanBeMerged(doc, origin, lst(hist.done), sel))))
      hist.done[hist.done.length - 1] = sel;
    else
      pushSelectionToHistory(sel, hist.done);

    hist.lastSelTime = +new Date;
    hist.lastSelOrigin = origin;
    hist.lastSelOp = opId;
    if (options && options.clearRedo !== false)
      clearSelectionEvents(hist.undone);
  }

  function pushSelectionToHistory(sel, dest) {
    var top = lst(dest);
    if (!(top && top.ranges && top.equals(sel)))
      dest.push(sel);
  }

  // Used to store marked span information in the history.
  function attachLocalSpans(doc, change, from, to) {
    var existing = change["spans_" + doc.id], n = 0;
    doc.iter(Math.max(doc.first, from), Math.min(doc.first + doc.size, to), function(line) {
      if (line.markedSpans)
        (existing || (existing = change["spans_" + doc.id] = {}))[n] = line.markedSpans;
      ++n;
    });
  }

  // When un/re-doing restores text containing marked spans, those
  // that have been explicitly cleared should not be restored.
  function removeClearedSpans(spans) {
    if (!spans) return null;
    for (var i = 0, out; i < spans.length; ++i) {
      if (spans[i].marker.explicitlyCleared) { if (!out) out = spans.slice(0, i); }
      else if (out) out.push(spans[i]);
    }
    return !out ? spans : out.length ? out : null;
  }

  // Retrieve and filter the old marked spans stored in a change event.
  function getOldSpans(doc, change) {
    var found = change["spans_" + doc.id];
    if (!found) return null;
    for (var i = 0, nw = []; i < change.text.length; ++i)
      nw.push(removeClearedSpans(found[i]));
    return nw;
  }

  // Used both to provide a JSON-safe object in .getHistory, and, when
  // detaching a document, to split the history in two
  function copyHistoryArray(events, newGroup, instantiateSel) {
    for (var i = 0, copy = []; i < events.length; ++i) {
      var event = events[i];
      if (event.ranges) {
        copy.push(instantiateSel ? Selection.prototype.deepCopy.call(event) : event);
        continue;
      }
      var changes = event.changes, newChanges = [];
      copy.push({changes: newChanges});
      for (var j = 0; j < changes.length; ++j) {
        var change = changes[j], m;
        newChanges.push({from: change.from, to: change.to, text: change.text});
        if (newGroup) for (var prop in change) if (m = prop.match(/^spans_(\d+)$/)) {
          if (indexOf(newGroup, Number(m[1])) > -1) {
            lst(newChanges)[prop] = change[prop];
            delete change[prop];
          }
        }
      }
    }
    return copy;
  }

  // Rebasing/resetting history to deal with externally-sourced changes

  function rebaseHistSelSingle(pos, from, to, diff) {
    if (to < pos.line) {
      pos.line += diff;
    } else if (from < pos.line) {
      pos.line = from;
      pos.ch = 0;
    }
  }

  // Tries to rebase an array of history events given a change in the
  // document. If the change touches the same lines as the event, the
  // event, and everything 'behind' it, is discarded. If the change is
  // before the event, the event's positions are updated. Uses a
  // copy-on-write scheme for the positions, to avoid having to
  // reallocate them all on every rebase, but also avoid problems with
  // shared position objects being unsafely updated.
  function rebaseHistArray(array, from, to, diff) {
    for (var i = 0; i < array.length; ++i) {
      var sub = array[i], ok = true;
      if (sub.ranges) {
        if (!sub.copied) { sub = array[i] = sub.deepCopy(); sub.copied = true; }
        for (var j = 0; j < sub.ranges.length; j++) {
          rebaseHistSelSingle(sub.ranges[j].anchor, from, to, diff);
          rebaseHistSelSingle(sub.ranges[j].head, from, to, diff);
        }
        continue;
      }
      for (var j = 0; j < sub.changes.length; ++j) {
        var cur = sub.changes[j];
        if (to < cur.from.line) {
          cur.from = Pos(cur.from.line + diff, cur.from.ch);
          cur.to = Pos(cur.to.line + diff, cur.to.ch);
        } else if (from <= cur.to.line) {
          ok = false;
          break;
        }
      }
      if (!ok) {
        array.splice(0, i + 1);
        i = 0;
      }
    }
  }

  function rebaseHist(hist, change) {
    var from = change.from.line, to = change.to.line, diff = change.text.length - (to - from) - 1;
    rebaseHistArray(hist.done, from, to, diff);
    rebaseHistArray(hist.undone, from, to, diff);
  }

  // EVENT UTILITIES

  // Due to the fact that we still support jurassic IE versions, some
  // compatibility wrappers are needed.

  var e_preventDefault = CodeMirror.e_preventDefault = function(e) {
    if (e.preventDefault) e.preventDefault();
    else e.returnValue = false;
  };
  var e_stopPropagation = CodeMirror.e_stopPropagation = function(e) {
    if (e.stopPropagation) e.stopPropagation();
    else e.cancelBubble = true;
  };
  function e_defaultPrevented(e) {
    return e.defaultPrevented != null ? e.defaultPrevented : e.returnValue == false;
  }
  var e_stop = CodeMirror.e_stop = function(e) {e_preventDefault(e); e_stopPropagation(e);};

  function e_target(e) {return e.target || e.srcElement;}
  function e_button(e) {
    var b = e.which;
    if (b == null) {
      if (e.button & 1) b = 1;
      else if (e.button & 2) b = 3;
      else if (e.button & 4) b = 2;
    }
    if (mac && e.ctrlKey && b == 1) b = 3;
    return b;
  }

  // EVENT HANDLING

  // Lightweight event framework. on/off also work on DOM nodes,
  // registering native DOM handlers.

  var on = CodeMirror.on = function(emitter, type, f) {
    if (emitter.addEventListener)
      emitter.addEventListener(type, f, false);
    else if (emitter.attachEvent)
      emitter.attachEvent("on" + type, f);
    else {
      var map = emitter._handlers || (emitter._handlers = {});
      var arr = map[type] || (map[type] = []);
      arr.push(f);
    }
  };

  var noHandlers = []
  function getHandlers(emitter, type, copy) {
    var arr = emitter._handlers && emitter._handlers[type]
    if (copy) return arr && arr.length > 0 ? arr.slice() : noHandlers
    else return arr || noHandlers
  }

  var off = CodeMirror.off = function(emitter, type, f) {
    if (emitter.removeEventListener)
      emitter.removeEventListener(type, f, false);
    else if (emitter.detachEvent)
      emitter.detachEvent("on" + type, f);
    else {
      var handlers = getHandlers(emitter, type, false)
      for (var i = 0; i < handlers.length; ++i)
        if (handlers[i] == f) { handlers.splice(i, 1); break; }
    }
  };

  var signal = CodeMirror.signal = function(emitter, type /*, values...*/) {
    var handlers = getHandlers(emitter, type, true)
    if (!handlers.length) return;
    var args = Array.prototype.slice.call(arguments, 2);
    for (var i = 0; i < handlers.length; ++i) handlers[i].apply(null, args);
  };

  var orphanDelayedCallbacks = null;

  // Often, we want to signal events at a point where we are in the
  // middle of some work, but don't want the handler to start calling
  // other methods on the editor, which might be in an inconsistent
  // state or simply not expect any other events to happen.
  // signalLater looks whether there are any handlers, and schedules
  // them to be executed when the last operation ends, or, if no
  // operation is active, when a timeout fires.
  function signalLater(emitter, type /*, values...*/) {
    var arr = getHandlers(emitter, type, false)
    if (!arr.length) return;
    var args = Array.prototype.slice.call(arguments, 2), list;
    if (operationGroup) {
      list = operationGroup.delayedCallbacks;
    } else if (orphanDelayedCallbacks) {
      list = orphanDelayedCallbacks;
    } else {
      list = orphanDelayedCallbacks = [];
      setTimeout(fireOrphanDelayed, 0);
    }
    function bnd(f) {return function(){f.apply(null, args);};};
    for (var i = 0; i < arr.length; ++i)
      list.push(bnd(arr[i]));
  }

  function fireOrphanDelayed() {
    var delayed = orphanDelayedCallbacks;
    orphanDelayedCallbacks = null;
    for (var i = 0; i < delayed.length; ++i) delayed[i]();
  }

  // The DOM events that CodeMirror handles can be overridden by
  // registering a (non-DOM) handler on the editor for the event name,
  // and preventDefault-ing the event in that handler.
  function signalDOMEvent(cm, e, override) {
    if (typeof e == "string")
      e = {type: e, preventDefault: function() { this.defaultPrevented = true; }};
    signal(cm, override || e.type, cm, e);
    return e_defaultPrevented(e) || e.codemirrorIgnore;
  }

  function signalCursorActivity(cm) {
    var arr = cm._handlers && cm._handlers.cursorActivity;
    if (!arr) return;
    var set = cm.curOp.cursorActivityHandlers || (cm.curOp.cursorActivityHandlers = []);
    for (var i = 0; i < arr.length; ++i) if (indexOf(set, arr[i]) == -1)
      set.push(arr[i]);
  }

  function hasHandler(emitter, type) {
    return getHandlers(emitter, type).length > 0
  }

  // Add on and off methods to a constructor's prototype, to make
  // registering events on such objects more convenient.
  function eventMixin(ctor) {
    ctor.prototype.on = function(type, f) {on(this, type, f);};
    ctor.prototype.off = function(type, f) {off(this, type, f);};
  }

  // MISC UTILITIES

  // Number of pixels added to scroller and sizer to hide scrollbar
  var scrollerGap = 30;

  // Returned or thrown by various protocols to signal 'I'm not
  // handling this'.
  var Pass = CodeMirror.Pass = {toString: function(){return "CodeMirror.Pass";}};

  // Reused option objects for setSelection & friends
  var sel_dontScroll = {scroll: false}, sel_mouse = {origin: "*mouse"}, sel_move = {origin: "+move"};

  function Delayed() {this.id = null;}
  Delayed.prototype.set = function(ms, f) {
    clearTimeout(this.id);
    this.id = setTimeout(f, ms);
  };

  // Counts the column offset in a string, taking tabs into account.
  // Used mostly to find indentation.
  var countColumn = CodeMirror.countColumn = function(string, end, tabSize, startIndex, startValue) {
    if (end == null) {
      end = string.search(/[^\s\u00a0]/);
      if (end == -1) end = string.length;
    }
    for (var i = startIndex || 0, n = startValue || 0;;) {
      var nextTab = string.indexOf("\t", i);
      if (nextTab < 0 || nextTab >= end)
        return n + (end - i);
      n += nextTab - i;
      n += tabSize - (n % tabSize);
      i = nextTab + 1;
    }
  };

  // The inverse of countColumn -- find the offset that corresponds to
  // a particular column.
  var findColumn = CodeMirror.findColumn = function(string, goal, tabSize) {
    for (var pos = 0, col = 0;;) {
      var nextTab = string.indexOf("\t", pos);
      if (nextTab == -1) nextTab = string.length;
      var skipped = nextTab - pos;
      if (nextTab == string.length || col + skipped >= goal)
        return pos + Math.min(skipped, goal - col);
      col += nextTab - pos;
      col += tabSize - (col % tabSize);
      pos = nextTab + 1;
      if (col >= goal) return pos;
    }
  }

  var spaceStrs = [""];
  function spaceStr(n) {
    while (spaceStrs.length <= n)
      spaceStrs.push(lst(spaceStrs) + " ");
    return spaceStrs[n];
  }

  function lst(arr) { return arr[arr.length-1]; }

  var selectInput = function(node) { node.select(); };
  if (ios) // Mobile Safari apparently has a bug where select() is broken.
    selectInput = function(node) { node.selectionStart = 0; node.selectionEnd = node.value.length; };
  else if (ie) // Suppress mysterious IE10 errors
    selectInput = function(node) { try { node.select(); } catch(_e) {} };

  function indexOf(array, elt) {
    for (var i = 0; i < array.length; ++i)
      if (array[i] == elt) return i;
    return -1;
  }
  function map(array, f) {
    var out = [];
    for (var i = 0; i < array.length; i++) out[i] = f(array[i], i);
    return out;
  }

  function nothing() {}

  function createObj(base, props) {
    var inst;
    if (Object.create) {
      inst = Object.create(base);
    } else {
      nothing.prototype = base;
      inst = new nothing();
    }
    if (props) copyObj(props, inst);
    return inst;
  };

  function copyObj(obj, target, overwrite) {
    if (!target) target = {};
    for (var prop in obj)
      if (obj.hasOwnProperty(prop) && (overwrite !== false || !target.hasOwnProperty(prop)))
        target[prop] = obj[prop];
    return target;
  }

  function bind(f) {
    var args = Array.prototype.slice.call(arguments, 1);
    return function(){return f.apply(null, args);};
  }

  var nonASCIISingleCaseWordChar = /[\u00df\u0587\u0590-\u05f4\u0600-\u06ff\u3040-\u309f\u30a0-\u30ff\u3400-\u4db5\u4e00-\u9fcc\uac00-\ud7af]/;
  var isWordCharBasic = CodeMirror.isWordChar = function(ch) {
    return /\w/.test(ch) || ch > "\x80" &&
      (ch.toUpperCase() != ch.toLowerCase() || nonASCIISingleCaseWordChar.test(ch));
  };
  function isWordChar(ch, helper) {
    if (!helper) return isWordCharBasic(ch);
    if (helper.source.indexOf("\\w") > -1 && isWordCharBasic(ch)) return true;
    return helper.test(ch);
  }

  function isEmpty(obj) {
    for (var n in obj) if (obj.hasOwnProperty(n) && obj[n]) return false;
    return true;
  }

  // Extending unicode characters. A series of a non-extending char +
  // any number of extending chars is treated as a single unit as far
  // as editing and measuring is concerned. This is not fully correct,
  // since some scripts/fonts/browsers also treat other configurations
  // of code points as a group.
  var extendingChars = /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u064b-\u065e\u0670\u06d6-\u06dc\u06de-\u06e4\u06e7\u06e8\u06ea-\u06ed\u0711\u0730-\u074a\u07a6-\u07b0\u07eb-\u07f3\u0816-\u0819\u081b-\u0823\u0825-\u0827\u0829-\u082d\u0900-\u0902\u093c\u0941-\u0948\u094d\u0951-\u0955\u0962\u0963\u0981\u09bc\u09be\u09c1-\u09c4\u09cd\u09d7\u09e2\u09e3\u0a01\u0a02\u0a3c\u0a41\u0a42\u0a47\u0a48\u0a4b-\u0a4d\u0a51\u0a70\u0a71\u0a75\u0a81\u0a82\u0abc\u0ac1-\u0ac5\u0ac7\u0ac8\u0acd\u0ae2\u0ae3\u0b01\u0b3c\u0b3e\u0b3f\u0b41-\u0b44\u0b4d\u0b56\u0b57\u0b62\u0b63\u0b82\u0bbe\u0bc0\u0bcd\u0bd7\u0c3e-\u0c40\u0c46-\u0c48\u0c4a-\u0c4d\u0c55\u0c56\u0c62\u0c63\u0cbc\u0cbf\u0cc2\u0cc6\u0ccc\u0ccd\u0cd5\u0cd6\u0ce2\u0ce3\u0d3e\u0d41-\u0d44\u0d4d\u0d57\u0d62\u0d63\u0dca\u0dcf\u0dd2-\u0dd4\u0dd6\u0ddf\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0eb1\u0eb4-\u0eb9\u0ebb\u0ebc\u0ec8-\u0ecd\u0f18\u0f19\u0f35\u0f37\u0f39\u0f71-\u0f7e\u0f80-\u0f84\u0f86\u0f87\u0f90-\u0f97\u0f99-\u0fbc\u0fc6\u102d-\u1030\u1032-\u1037\u1039\u103a\u103d\u103e\u1058\u1059\u105e-\u1060\u1071-\u1074\u1082\u1085\u1086\u108d\u109d\u135f\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17b7-\u17bd\u17c6\u17c9-\u17d3\u17dd\u180b-\u180d\u18a9\u1920-\u1922\u1927\u1928\u1932\u1939-\u193b\u1a17\u1a18\u1a56\u1a58-\u1a5e\u1a60\u1a62\u1a65-\u1a6c\u1a73-\u1a7c\u1a7f\u1b00-\u1b03\u1b34\u1b36-\u1b3a\u1b3c\u1b42\u1b6b-\u1b73\u1b80\u1b81\u1ba2-\u1ba5\u1ba8\u1ba9\u1c2c-\u1c33\u1c36\u1c37\u1cd0-\u1cd2\u1cd4-\u1ce0\u1ce2-\u1ce8\u1ced\u1dc0-\u1de6\u1dfd-\u1dff\u200c\u200d\u20d0-\u20f0\u2cef-\u2cf1\u2de0-\u2dff\u302a-\u302f\u3099\u309a\ua66f-\ua672\ua67c\ua67d\ua6f0\ua6f1\ua802\ua806\ua80b\ua825\ua826\ua8c4\ua8e0-\ua8f1\ua926-\ua92d\ua947-\ua951\ua980-\ua982\ua9b3\ua9b6-\ua9b9\ua9bc\uaa29-\uaa2e\uaa31\uaa32\uaa35\uaa36\uaa43\uaa4c\uaab0\uaab2-\uaab4\uaab7\uaab8\uaabe\uaabf\uaac1\uabe5\uabe8\uabed\udc00-\udfff\ufb1e\ufe00-\ufe0f\ufe20-\ufe26\uff9e\uff9f]/;
  function isExtendingChar(ch) { return ch.charCodeAt(0) >= 768 && extendingChars.test(ch); }

  // DOM UTILITIES

  function elt(tag, content, className, style) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (style) e.style.cssText = style;
    if (typeof content == "string") e.appendChild(document.createTextNode(content));
    else if (content) for (var i = 0; i < content.length; ++i) e.appendChild(content[i]);
    return e;
  }

  var range;
  if (document.createRange) range = function(node, start, end, endNode) {
    var r = document.createRange();
    r.setEnd(endNode || node, end);
    r.setStart(node, start);
    return r;
  };
  else range = function(node, start, end) {
    var r = document.body.createTextRange();
    try { r.moveToElementText(node.parentNode); }
    catch(e) { return r; }
    r.collapse(true);
    r.moveEnd("character", end);
    r.moveStart("character", start);
    return r;
  };

  function removeChildren(e) {
    for (var count = e.childNodes.length; count > 0; --count)
      e.removeChild(e.firstChild);
    return e;
  }

  function removeChildrenAndAdd(parent, e) {
    return removeChildren(parent).appendChild(e);
  }

  var contains = CodeMirror.contains = function(parent, child) {
    if (child.nodeType == 3) // Android browser always returns false when child is a textnode
      child = child.parentNode;
    if (parent.contains)
      return parent.contains(child);
    do {
      if (child.nodeType == 11) child = child.host;
      if (child == parent) return true;
    } while (child = child.parentNode);
  };

  function activeElt() {
    var activeElement = document.activeElement;
    while (activeElement && activeElement.root && activeElement.root.activeElement)
      activeElement = activeElement.root.activeElement;
    return activeElement;
  }
  // Older versions of IE throws unspecified error when touching
  // document.activeElement in some cases (during loading, in iframe)
  if (ie && ie_version < 11) activeElt = function() {
    try { return document.activeElement; }
    catch(e) { return document.body; }
  };

  function classTest(cls) { return new RegExp("(^|\\s)" + cls + "(?:$|\\s)\\s*"); }
  var rmClass = CodeMirror.rmClass = function(node, cls) {
    var current = node.className;
    var match = classTest(cls).exec(current);
    if (match) {
      var after = current.slice(match.index + match[0].length);
      node.className = current.slice(0, match.index) + (after ? match[1] + after : "");
    }
  };
  var addClass = CodeMirror.addClass = function(node, cls) {
    var current = node.className;
    if (!classTest(cls).test(current)) node.className += (current ? " " : "") + cls;
  };
  function joinClasses(a, b) {
    var as = a.split(" ");
    for (var i = 0; i < as.length; i++)
      if (as[i] && !classTest(as[i]).test(b)) b += " " + as[i];
    return b;
  }

  // WINDOW-WIDE EVENTS

  // These must be handled carefully, because naively registering a
  // handler for each editor will cause the editors to never be
  // garbage collected.

  function forEachCodeMirror(f) {
    if (!document.body.getElementsByClassName) return;
    var byClass = document.body.getElementsByClassName("CodeMirror");
    for (var i = 0; i < byClass.length; i++) {
      var cm = byClass[i].CodeMirror;
      if (cm) f(cm);
    }
  }

  var globalsRegistered = false;
  function ensureGlobalHandlers() {
    if (globalsRegistered) return;
    registerGlobalHandlers();
    globalsRegistered = true;
  }
  function registerGlobalHandlers() {
    // When the window resizes, we need to refresh active editors.
    var resizeTimer;
    on(window, "resize", function() {
      if (resizeTimer == null) resizeTimer = setTimeout(function() {
        resizeTimer = null;
        forEachCodeMirror(onResize);
      }, 100);
    });
    // When the window loses focus, we want to show the editor as blurred
    on(window, "blur", function() {
      forEachCodeMirror(onBlur);
    });
  }

  // FEATURE DETECTION

  // Detect drag-and-drop
  var dragAndDrop = function() {
    // There is *some* kind of drag-and-drop support in IE6-8, but I
    // couldn't get it to work yet.
    if (ie && ie_version < 9) return false;
    var div = elt('div');
    return "draggable" in div || "dragDrop" in div;
  }();

  var zwspSupported;
  function zeroWidthElement(measure) {
    if (zwspSupported == null) {
      var test = elt("span", "\u200b");
      removeChildrenAndAdd(measure, elt("span", [test, document.createTextNode("x")]));
      if (measure.firstChild.offsetHeight != 0)
        zwspSupported = test.offsetWidth <= 1 && test.offsetHeight > 2 && !(ie && ie_version < 8);
    }
    var node = zwspSupported ? elt("span", "\u200b") :
      elt("span", "\u00a0", null, "display: inline-block; width: 1px; margin-right: -1px");
    node.setAttribute("cm-text", "");
    return node;
  }

  // Feature-detect IE's crummy client rect reporting for bidi text
  var badBidiRects;
  function hasBadBidiRects(measure) {
    if (badBidiRects != null) return badBidiRects;
    var txt = removeChildrenAndAdd(measure, document.createTextNode("A\u062eA"));
    var r0 = range(txt, 0, 1).getBoundingClientRect();
    if (!r0 || r0.left == r0.right) return false; // Safari returns null in some cases (#2780)
    var r1 = range(txt, 1, 2).getBoundingClientRect();
    return badBidiRects = (r1.right - r0.right < 3);
  }

  // See if "".split is the broken IE version, if so, provide an
  // alternative way to split lines.
  var splitLinesAuto = CodeMirror.splitLines = "\n\nb".split(/\n/).length != 3 ? function(string) {
    var pos = 0, result = [], l = string.length;
    while (pos <= l) {
      var nl = string.indexOf("\n", pos);
      if (nl == -1) nl = string.length;
      var line = string.slice(pos, string.charAt(nl - 1) == "\r" ? nl - 1 : nl);
      var rt = line.indexOf("\r");
      if (rt != -1) {
        result.push(line.slice(0, rt));
        pos += rt + 1;
      } else {
        result.push(line);
        pos = nl + 1;
      }
    }
    return result;
  } : function(string){return string.split(/\r\n?|\n/);};

  var hasSelection = window.getSelection ? function(te) {
    try { return te.selectionStart != te.selectionEnd; }
    catch(e) { return false; }
  } : function(te) {
    try {var range = te.ownerDocument.selection.createRange();}
    catch(e) {}
    if (!range || range.parentElement() != te) return false;
    return range.compareEndPoints("StartToEnd", range) != 0;
  };

  var hasCopyEvent = (function() {
    var e = elt("div");
    if ("oncopy" in e) return true;
    e.setAttribute("oncopy", "return;");
    return typeof e.oncopy == "function";
  })();

  var badZoomedRects = null;
  function hasBadZoomedRects(measure) {
    if (badZoomedRects != null) return badZoomedRects;
    var node = removeChildrenAndAdd(measure, elt("span", "x"));
    var normal = node.getBoundingClientRect();
    var fromRange = range(node, 0, 1).getBoundingClientRect();
    return badZoomedRects = Math.abs(normal.left - fromRange.left) > 1;
  }

  // KEY NAMES

  var keyNames = CodeMirror.keyNames = {
    3: "Enter", 8: "Backspace", 9: "Tab", 13: "Enter", 16: "Shift", 17: "Ctrl", 18: "Alt",
    19: "Pause", 20: "CapsLock", 27: "Esc", 32: "Space", 33: "PageUp", 34: "PageDown", 35: "End",
    36: "Home", 37: "Left", 38: "Up", 39: "Right", 40: "Down", 44: "PrintScrn", 45: "Insert",
    46: "Delete", 59: ";", 61: "=", 91: "Mod", 92: "Mod", 93: "Mod",
    106: "*", 107: "=", 109: "-", 110: ".", 111: "/", 127: "Delete",
    173: "-", 186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/", 192: "`", 219: "[", 220: "\\",
    221: "]", 222: "'", 63232: "Up", 63233: "Down", 63234: "Left", 63235: "Right", 63272: "Delete",
    63273: "Home", 63275: "End", 63276: "PageUp", 63277: "PageDown", 63302: "Insert"
  };
  (function() {
    // Number keys
    for (var i = 0; i < 10; i++) keyNames[i + 48] = keyNames[i + 96] = String(i);
    // Alphabetic keys
    for (var i = 65; i <= 90; i++) keyNames[i] = String.fromCharCode(i);
    // Function keys
    for (var i = 1; i <= 12; i++) keyNames[i + 111] = keyNames[i + 63235] = "F" + i;
  })();

  // BIDI HELPERS

  function iterateBidiSections(order, from, to, f) {
    if (!order) return f(from, to, "ltr");
    var found = false;
    for (var i = 0; i < order.length; ++i) {
      var part = order[i];
      if (part.from < to && part.to > from || from == to && part.to == from) {
        f(Math.max(part.from, from), Math.min(part.to, to), part.level == 1 ? "rtl" : "ltr");
        found = true;
      }
    }
    if (!found) f(from, to, "ltr");
  }

  function bidiLeft(part) { return part.level % 2 ? part.to : part.from; }
  function bidiRight(part) { return part.level % 2 ? part.from : part.to; }

  function lineLeft(line) { var order = getOrder(line); return order ? bidiLeft(order[0]) : 0; }
  function lineRight(line) {
    var order = getOrder(line);
    if (!order) return line.text.length;
    return bidiRight(lst(order));
  }

  function lineStart(cm, lineN) {
    var line = getLine(cm.doc, lineN);
    var visual = visualLine(line);
    if (visual != line) lineN = lineNo(visual);
    var order = getOrder(visual);
    var ch = !order ? 0 : order[0].level % 2 ? lineRight(visual) : lineLeft(visual);
    return Pos(lineN, ch);
  }
  function lineEnd(cm, lineN) {
    var merged, line = getLine(cm.doc, lineN);
    while (merged = collapsedSpanAtEnd(line)) {
      line = merged.find(1, true).line;
      lineN = null;
    }
    var order = getOrder(line);
    var ch = !order ? line.text.length : order[0].level % 2 ? lineLeft(line) : lineRight(line);
    return Pos(lineN == null ? lineNo(line) : lineN, ch);
  }
  function lineStartSmart(cm, pos) {
    var start = lineStart(cm, pos.line);
    var line = getLine(cm.doc, start.line);
    var order = getOrder(line);
    if (!order || order[0].level == 0) {
      var firstNonWS = Math.max(0, line.text.search(/\S/));
      var inWS = pos.line == start.line && pos.ch <= firstNonWS && pos.ch;
      return Pos(start.line, inWS ? 0 : firstNonWS);
    }
    return start;
  }

  function compareBidiLevel(order, a, b) {
    var linedir = order[0].level;
    if (a == linedir) return true;
    if (b == linedir) return false;
    return a < b;
  }
  var bidiOther;
  function getBidiPartAt(order, pos) {
    bidiOther = null;
    for (var i = 0, found; i < order.length; ++i) {
      var cur = order[i];
      if (cur.from < pos && cur.to > pos) return i;
      if ((cur.from == pos || cur.to == pos)) {
        if (found == null) {
          found = i;
        } else if (compareBidiLevel(order, cur.level, order[found].level)) {
          if (cur.from != cur.to) bidiOther = found;
          return i;
        } else {
          if (cur.from != cur.to) bidiOther = i;
          return found;
        }
      }
    }
    return found;
  }

  function moveInLine(line, pos, dir, byUnit) {
    if (!byUnit) return pos + dir;
    do pos += dir;
    while (pos > 0 && isExtendingChar(line.text.charAt(pos)));
    return pos;
  }

  // This is needed in order to move 'visually' through bi-directional
  // text -- i.e., pressing left should make the cursor go left, even
  // when in RTL text. The tricky part is the 'jumps', where RTL and
  // LTR text touch each other. This often requires the cursor offset
  // to move more than one unit, in order to visually move one unit.
  function moveVisually(line, start, dir, byUnit) {
    var bidi = getOrder(line);
    if (!bidi) return moveLogically(line, start, dir, byUnit);
    var pos = getBidiPartAt(bidi, start), part = bidi[pos];
    var target = moveInLine(line, start, part.level % 2 ? -dir : dir, byUnit);

    for (;;) {
      if (target > part.from && target < part.to) return target;
      if (target == part.from || target == part.to) {
        if (getBidiPartAt(bidi, target) == pos) return target;
        part = bidi[pos += dir];
        return (dir > 0) == part.level % 2 ? part.to : part.from;
      } else {
        part = bidi[pos += dir];
        if (!part) return null;
        if ((dir > 0) == part.level % 2)
          target = moveInLine(line, part.to, -1, byUnit);
        else
          target = moveInLine(line, part.from, 1, byUnit);
      }
    }
  }

  function moveLogically(line, start, dir, byUnit) {
    var target = start + dir;
    if (byUnit) while (target > 0 && isExtendingChar(line.text.charAt(target))) target += dir;
    return target < 0 || target > line.text.length ? null : target;
  }

  // Bidirectional ordering algorithm
  // See http://unicode.org/reports/tr9/tr9-13.html for the algorithm
  // that this (partially) implements.

  // One-char codes used for character types:
  // L (L):   Left-to-Right
  // R (R):   Right-to-Left
  // r (AL):  Right-to-Left Arabic
  // 1 (EN):  European Number
  // + (ES):  European Number Separator
  // % (ET):  European Number Terminator
  // n (AN):  Arabic Number
  // , (CS):  Common Number Separator
  // m (NSM): Non-Spacing Mark
  // b (BN):  Boundary Neutral
  // s (B):   Paragraph Separator
  // t (S):   Segment Separator
  // w (WS):  Whitespace
  // N (ON):  Other Neutrals

  // Returns null if characters are ordered as they appear
  // (left-to-right), or an array of sections ({from, to, level}
  // objects) in the order in which they occur visually.
  var bidiOrdering = (function() {
    // Character types for codepoints 0 to 0xff
    var lowTypes = "bbbbbbbbbtstwsbbbbbbbbbbbbbbssstwNN%%%NNNNNN,N,N1111111111NNNNNNNLLLLLLLLLLLLLLLLLLLLLLLLLLNNNNNNLLLLLLLLLLLLLLLLLLLLLLLLLLNNNNbbbbbbsbbbbbbbbbbbbbbbbbbbbbbbbbb,N%%%%NNNNLNNNNN%%11NLNNN1LNNNNNLLLLLLLLLLLLLLLLLLLLLLLNLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLN";
    // Character types for codepoints 0x600 to 0x6ff
    var arabicTypes = "rrrrrrrrrrrr,rNNmmmmmmrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrmmmmmmmmmmmmmmrrrrrrrnnnnnnnnnn%nnrrrmrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrmmmmmmmmmmmmmmmmmmmNmmmm";
    function charType(code) {
      if (code <= 0xf7) return lowTypes.charAt(code);
      else if (0x590 <= code && code <= 0x5f4) return "R";
      else if (0x600 <= code && code <= 0x6ed) return arabicTypes.charAt(code - 0x600);
      else if (0x6ee <= code && code <= 0x8ac) return "r";
      else if (0x2000 <= code && code <= 0x200b) return "w";
      else if (code == 0x200c) return "b";
      else return "L";
    }

    var bidiRE = /[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac]/;
    var isNeutral = /[stwN]/, isStrong = /[LRr]/, countsAsLeft = /[Lb1n]/, countsAsNum = /[1n]/;
    // Browsers seem to always treat the boundaries of block elements as being L.
    var outerType = "L";

    function BidiSpan(level, from, to) {
      this.level = level;
      this.from = from; this.to = to;
    }

    return function(str) {
      if (!bidiRE.test(str)) return false;
      var len = str.length, types = [];
      for (var i = 0, type; i < len; ++i)
        types.push(type = charType(str.charCodeAt(i)));

      // W1. Examine each non-spacing mark (NSM) in the level run, and
      // change the type of the NSM to the type of the previous
      // character. If the NSM is at the start of the level run, it will
      // get the type of sor.
      for (var i = 0, prev = outerType; i < len; ++i) {
        var type = types[i];
        if (type == "m") types[i] = prev;
        else prev = type;
      }

      // W2. Search backwards from each instance of a European number
      // until the first strong type (R, L, AL, or sor) is found. If an
      // AL is found, change the type of the European number to Arabic
      // number.
      // W3. Change all ALs to R.
      for (var i = 0, cur = outerType; i < len; ++i) {
        var type = types[i];
        if (type == "1" && cur == "r") types[i] = "n";
        else if (isStrong.test(type)) { cur = type; if (type == "r") types[i] = "R"; }
      }

      // W4. A single European separator between two European numbers
      // changes to a European number. A single common separator between
      // two numbers of the same type changes to that type.
      for (var i = 1, prev = types[0]; i < len - 1; ++i) {
        var type = types[i];
        if (type == "+" && prev == "1" && types[i+1] == "1") types[i] = "1";
        else if (type == "," && prev == types[i+1] &&
                 (prev == "1" || prev == "n")) types[i] = prev;
        prev = type;
      }

      // W5. A sequence of European terminators adjacent to European
      // numbers changes to all European numbers.
      // W6. Otherwise, separators and terminators change to Other
      // Neutral.
      for (var i = 0; i < len; ++i) {
        var type = types[i];
        if (type == ",") types[i] = "N";
        else if (type == "%") {
          for (var end = i + 1; end < len && types[end] == "%"; ++end) {}
          var replace = (i && types[i-1] == "!") || (end < len && types[end] == "1") ? "1" : "N";
          for (var j = i; j < end; ++j) types[j] = replace;
          i = end - 1;
        }
      }

      // W7. Search backwards from each instance of a European number
      // until the first strong type (R, L, or sor) is found. If an L is
      // found, then change the type of the European number to L.
      for (var i = 0, cur = outerType; i < len; ++i) {
        var type = types[i];
        if (cur == "L" && type == "1") types[i] = "L";
        else if (isStrong.test(type)) cur = type;
      }

      // N1. A sequence of neutrals takes the direction of the
      // surrounding strong text if the text on both sides has the same
      // direction. European and Arabic numbers act as if they were R in
      // terms of their influence on neutrals. Start-of-level-run (sor)
      // and end-of-level-run (eor) are used at level run boundaries.
      // N2. Any remaining neutrals take the embedding direction.
      for (var i = 0; i < len; ++i) {
        if (isNeutral.test(types[i])) {
          for (var end = i + 1; end < len && isNeutral.test(types[end]); ++end) {}
          var before = (i ? types[i-1] : outerType) == "L";
          var after = (end < len ? types[end] : outerType) == "L";
          var replace = before || after ? "L" : "R";
          for (var j = i; j < end; ++j) types[j] = replace;
          i = end - 1;
        }
      }

      // Here we depart from the documented algorithm, in order to avoid
      // building up an actual levels array. Since there are only three
      // levels (0, 1, 2) in an implementation that doesn't take
      // explicit embedding into account, we can build up the order on
      // the fly, without following the level-based algorithm.
      var order = [], m;
      for (var i = 0; i < len;) {
        if (countsAsLeft.test(types[i])) {
          var start = i;
          for (++i; i < len && countsAsLeft.test(types[i]); ++i) {}
          order.push(new BidiSpan(0, start, i));
        } else {
          var pos = i, at = order.length;
          for (++i; i < len && types[i] != "L"; ++i) {}
          for (var j = pos; j < i;) {
            if (countsAsNum.test(types[j])) {
              if (pos < j) order.splice(at, 0, new BidiSpan(1, pos, j));
              var nstart = j;
              for (++j; j < i && countsAsNum.test(types[j]); ++j) {}
              order.splice(at, 0, new BidiSpan(2, nstart, j));
              pos = j;
            } else ++j;
          }
          if (pos < i) order.splice(at, 0, new BidiSpan(1, pos, i));
        }
      }
      if (order[0].level == 1 && (m = str.match(/^\s+/))) {
        order[0].from = m[0].length;
        order.unshift(new BidiSpan(0, 0, m[0].length));
      }
      if (lst(order).level == 1 && (m = str.match(/\s+$/))) {
        lst(order).to -= m[0].length;
        order.push(new BidiSpan(0, len - m[0].length, len));
      }
      if (order[0].level == 2)
        order.unshift(new BidiSpan(1, order[0].to, order[0].to));
      if (order[0].level != lst(order).level)
        order.push(new BidiSpan(order[0].level, len, len));

      return order;
    };
  })();

  // THE END

  CodeMirror.version = "5.8.0";

  return CodeMirror;
});

// TinyColor v1.2.1
// https://github.com/bgrins/TinyColor
// Brian Grinstead, MIT License

(function() {

var trimLeft = /^[\s,#]+/,
    trimRight = /\s+$/,
    tinyCounter = 0,
    math = Math,
    mathRound = math.round,
    mathMin = math.min,
    mathMax = math.max,
    mathRandom = math.random;

function tinycolor (color, opts) {

    color = (color) ? color : '';
    opts = opts || { };

    // If input is already a tinycolor, return itself
    if (color instanceof tinycolor) {
       return color;
    }
    // If we are called as a function, call using new instead
    if (!(this instanceof tinycolor)) {
        return new tinycolor(color, opts);
    }

    var rgb = inputToRGB(color);
    this._originalInput = color,
    this._r = rgb.r,
    this._g = rgb.g,
    this._b = rgb.b,
    this._a = rgb.a,
    this._roundA = mathRound(100*this._a) / 100,
    this._format = opts.format || rgb.format;
    this._gradientType = opts.gradientType;

    // Don't let the range of [0,255] come back in [0,1].
    // Potentially lose a little bit of precision here, but will fix issues where
    // .5 gets interpreted as half of the total, instead of half of 1
    // If it was supposed to be 128, this was already taken care of by `inputToRgb`
    if (this._r < 1) { this._r = mathRound(this._r); }
    if (this._g < 1) { this._g = mathRound(this._g); }
    if (this._b < 1) { this._b = mathRound(this._b); }

    this._ok = rgb.ok;
    this._tc_id = tinyCounter++;
}

tinycolor.prototype = {
    isDark: function() {
        return this.getBrightness() < 128;
    },
    isLight: function() {
        return !this.isDark();
    },
    isValid: function() {
        return this._ok;
    },
    getOriginalInput: function() {
      return this._originalInput;
    },
    getFormat: function() {
        return this._format;
    },
    getAlpha: function() {
        return this._a;
    },
    getBrightness: function() {
        //http://www.w3.org/TR/AERT#color-contrast
        var rgb = this.toRgb();
        return (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
    },
    getLuminance: function() {
        //http://www.w3.org/TR/2008/REC-WCAG20-20081211/#relativeluminancedef
        var rgb = this.toRgb();
        var RsRGB, GsRGB, BsRGB, R, G, B;
        RsRGB = rgb.r/255;
        GsRGB = rgb.g/255;
        BsRGB = rgb.b/255;

        if (RsRGB <= 0.03928) {R = RsRGB / 12.92;} else {R = Math.pow(((RsRGB + 0.055) / 1.055), 2.4);}
        if (GsRGB <= 0.03928) {G = GsRGB / 12.92;} else {G = Math.pow(((GsRGB + 0.055) / 1.055), 2.4);}
        if (BsRGB <= 0.03928) {B = BsRGB / 12.92;} else {B = Math.pow(((BsRGB + 0.055) / 1.055), 2.4);}
        return (0.2126 * R) + (0.7152 * G) + (0.0722 * B);
    },
    setAlpha: function(value) {
        this._a = boundAlpha(value);
        this._roundA = mathRound(100*this._a) / 100;
        return this;
    },
    toHsv: function() {
        var hsv = rgbToHsv(this._r, this._g, this._b);
        return { h: hsv.h * 360, s: hsv.s, v: hsv.v, a: this._a };
    },
    toHsvString: function() {
        var hsv = rgbToHsv(this._r, this._g, this._b);
        var h = mathRound(hsv.h * 360), s = mathRound(hsv.s * 100), v = mathRound(hsv.v * 100);
        return (this._a == 1) ?
          "hsv("  + h + ", " + s + "%, " + v + "%)" :
          "hsva(" + h + ", " + s + "%, " + v + "%, "+ this._roundA + ")";
    },
    toHsl: function() {
        var hsl = rgbToHsl(this._r, this._g, this._b);
        return { h: hsl.h * 360, s: hsl.s, l: hsl.l, a: this._a };
    },
    toHslString: function() {
        var hsl = rgbToHsl(this._r, this._g, this._b);
        var h = mathRound(hsl.h * 360), s = mathRound(hsl.s * 100), l = mathRound(hsl.l * 100);
        return (this._a == 1) ?
          "hsl("  + h + ", " + s + "%, " + l + "%)" :
          "hsla(" + h + ", " + s + "%, " + l + "%, "+ this._roundA + ")";
    },
    toHex: function(allow3Char) {
        return rgbToHex(this._r, this._g, this._b, allow3Char);
    },
    toHexString: function(allow3Char) {
        return '#' + this.toHex(allow3Char);
    },
    toHex8: function() {
        return rgbaToHex(this._r, this._g, this._b, this._a);
    },
    toHex8String: function() {
        return '#' + this.toHex8();
    },
    toRgb: function() {
        return { r: mathRound(this._r), g: mathRound(this._g), b: mathRound(this._b), a: this._a };
    },
    toRgbString: function() {
        return (this._a == 1) ?
          "rgb("  + mathRound(this._r) + ", " + mathRound(this._g) + ", " + mathRound(this._b) + ")" :
          "rgba(" + mathRound(this._r) + ", " + mathRound(this._g) + ", " + mathRound(this._b) + ", " + this._roundA + ")";
    },
    toPercentageRgb: function() {
        return { r: mathRound(bound01(this._r, 255) * 100) + "%", g: mathRound(bound01(this._g, 255) * 100) + "%", b: mathRound(bound01(this._b, 255) * 100) + "%", a: this._a };
    },
    toPercentageRgbString: function() {
        return (this._a == 1) ?
          "rgb("  + mathRound(bound01(this._r, 255) * 100) + "%, " + mathRound(bound01(this._g, 255) * 100) + "%, " + mathRound(bound01(this._b, 255) * 100) + "%)" :
          "rgba(" + mathRound(bound01(this._r, 255) * 100) + "%, " + mathRound(bound01(this._g, 255) * 100) + "%, " + mathRound(bound01(this._b, 255) * 100) + "%, " + this._roundA + ")";
    },
    toName: function() {
        if (this._a === 0) {
            return "transparent";
        }

        if (this._a < 1) {
            return false;
        }

        return hexNames[rgbToHex(this._r, this._g, this._b, true)] || false;
    },
    toFilter: function(secondColor) {
        var hex8String = '#' + rgbaToHex(this._r, this._g, this._b, this._a);
        var secondHex8String = hex8String;
        var gradientType = this._gradientType ? "GradientType = 1, " : "";

        if (secondColor) {
            var s = tinycolor(secondColor);
            secondHex8String = s.toHex8String();
        }

        return "progid:DXImageTransform.Microsoft.gradient("+gradientType+"startColorstr="+hex8String+",endColorstr="+secondHex8String+")";
    },
    toString: function(format) {
        var formatSet = !!format;
        format = format || this._format;

        var formattedString = false;
        var hasAlpha = this._a < 1 && this._a >= 0;
        var needsAlphaFormat = !formatSet && hasAlpha && (format === "hex" || format === "hex6" || format === "hex3" || format === "name");

        if (needsAlphaFormat) {
            // Special case for "transparent", all other non-alpha formats
            // will return rgba when there is transparency.
            if (format === "name" && this._a === 0) {
                return this.toName();
            }
            return this.toRgbString();
        }
        if (format === "rgb") {
            formattedString = this.toRgbString();
        }
        if (format === "prgb") {
            formattedString = this.toPercentageRgbString();
        }
        if (format === "hex" || format === "hex6") {
            formattedString = this.toHexString();
        }
        if (format === "hex3") {
            formattedString = this.toHexString(true);
        }
        if (format === "hex8") {
            formattedString = this.toHex8String();
        }
        if (format === "name") {
            formattedString = this.toName();
        }
        if (format === "hsl") {
            formattedString = this.toHslString();
        }
        if (format === "hsv") {
            formattedString = this.toHsvString();
        }

        return formattedString || this.toHexString();
    },

    _applyModification: function(fn, args) {
        var color = fn.apply(null, [this].concat([].slice.call(args)));
        this._r = color._r;
        this._g = color._g;
        this._b = color._b;
        this.setAlpha(color._a);
        return this;
    },
    lighten: function() {
        return this._applyModification(lighten, arguments);
    },
    brighten: function() {
        return this._applyModification(brighten, arguments);
    },
    darken: function() {
        return this._applyModification(darken, arguments);
    },
    desaturate: function() {
        return this._applyModification(desaturate, arguments);
    },
    saturate: function() {
        return this._applyModification(saturate, arguments);
    },
    greyscale: function() {
        return this._applyModification(greyscale, arguments);
    },
    spin: function() {
        return this._applyModification(spin, arguments);
    },

    _applyCombination: function(fn, args) {
        return fn.apply(null, [this].concat([].slice.call(args)));
    },
    analogous: function() {
        return this._applyCombination(analogous, arguments);
    },
    complement: function() {
        return this._applyCombination(complement, arguments);
    },
    monochromatic: function() {
        return this._applyCombination(monochromatic, arguments);
    },
    splitcomplement: function() {
        return this._applyCombination(splitcomplement, arguments);
    },
    triad: function() {
        return this._applyCombination(triad, arguments);
    },
    tetrad: function() {
        return this._applyCombination(tetrad, arguments);
    }
};

// If input is an object, force 1 into "1.0" to handle ratios properly
// String input requires "1.0" as input, so 1 will be treated as 1
tinycolor.fromRatio = function(color, opts) {
    if (typeof color == "object") {
        var newColor = {};
        for (var i in color) {
            if (color.hasOwnProperty(i)) {
                if (i === "a") {
                    newColor[i] = color[i];
                }
                else {
                    newColor[i] = convertToPercentage(color[i]);
                }
            }
        }
        color = newColor;
    }

    return tinycolor(color, opts);
};

// Given a string or object, convert that input to RGB
// Possible string inputs:
//
//     "red"
//     "#f00" or "f00"
//     "#ff0000" or "ff0000"
//     "#ff000000" or "ff000000"
//     "rgb 255 0 0" or "rgb (255, 0, 0)"
//     "rgb 1.0 0 0" or "rgb (1, 0, 0)"
//     "rgba (255, 0, 0, 1)" or "rgba 255, 0, 0, 1"
//     "rgba (1.0, 0, 0, 1)" or "rgba 1.0, 0, 0, 1"
//     "hsl(0, 100%, 50%)" or "hsl 0 100% 50%"
//     "hsla(0, 100%, 50%, 1)" or "hsla 0 100% 50%, 1"
//     "hsv(0, 100%, 100%)" or "hsv 0 100% 100%"
//
function inputToRGB(color) {

    var rgb = { r: 0, g: 0, b: 0 };
    var a = 1;
    var ok = false;
    var format = false;

    if (typeof color == "string") {
        color = stringInputToObject(color);
    }

    if (typeof color == "object") {
        if (color.hasOwnProperty("r") && color.hasOwnProperty("g") && color.hasOwnProperty("b")) {
            rgb = rgbToRgb(color.r, color.g, color.b);
            ok = true;
            format = String(color.r).substr(-1) === "%" ? "prgb" : "rgb";
        }
        else if (color.hasOwnProperty("h") && color.hasOwnProperty("s") && color.hasOwnProperty("v")) {
            color.s = convertToPercentage(color.s);
            color.v = convertToPercentage(color.v);
            rgb = hsvToRgb(color.h, color.s, color.v);
            ok = true;
            format = "hsv";
        }
        else if (color.hasOwnProperty("h") && color.hasOwnProperty("s") && color.hasOwnProperty("l")) {
            color.s = convertToPercentage(color.s);
            color.l = convertToPercentage(color.l);
            rgb = hslToRgb(color.h, color.s, color.l);
            ok = true;
            format = "hsl";
        }

        if (color.hasOwnProperty("a")) {
            a = color.a;
        }
    }

    a = boundAlpha(a);

    return {
        ok: ok,
        format: color.format || format,
        r: mathMin(255, mathMax(rgb.r, 0)),
        g: mathMin(255, mathMax(rgb.g, 0)),
        b: mathMin(255, mathMax(rgb.b, 0)),
        a: a
    };
}


// Conversion Functions
// --------------------

// `rgbToHsl`, `rgbToHsv`, `hslToRgb`, `hsvToRgb` modified from:
// <http://mjijackson.com/2008/02/rgb-to-hsl-and-rgb-to-hsv-color-model-conversion-algorithms-in-javascript>

// `rgbToRgb`
// Handle bounds / percentage checking to conform to CSS color spec
// <http://www.w3.org/TR/css3-color/>
// *Assumes:* r, g, b in [0, 255] or [0, 1]
// *Returns:* { r, g, b } in [0, 255]
function rgbToRgb(r, g, b){
    return {
        r: bound01(r, 255) * 255,
        g: bound01(g, 255) * 255,
        b: bound01(b, 255) * 255
    };
}

// `rgbToHsl`
// Converts an RGB color value to HSL.
// *Assumes:* r, g, and b are contained in [0, 255] or [0, 1]
// *Returns:* { h, s, l } in [0,1]
function rgbToHsl(r, g, b) {

    r = bound01(r, 255);
    g = bound01(g, 255);
    b = bound01(b, 255);

    var max = mathMax(r, g, b), min = mathMin(r, g, b);
    var h, s, l = (max + min) / 2;

    if(max == min) {
        h = s = 0; // achromatic
    }
    else {
        var d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch(max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }

        h /= 6;
    }

    return { h: h, s: s, l: l };
}

// `hslToRgb`
// Converts an HSL color value to RGB.
// *Assumes:* h is contained in [0, 1] or [0, 360] and s and l are contained [0, 1] or [0, 100]
// *Returns:* { r, g, b } in the set [0, 255]
function hslToRgb(h, s, l) {
    var r, g, b;

    h = bound01(h, 360);
    s = bound01(s, 100);
    l = bound01(l, 100);

    function hue2rgb(p, q, t) {
        if(t < 0) t += 1;
        if(t > 1) t -= 1;
        if(t < 1/6) return p + (q - p) * 6 * t;
        if(t < 1/2) return q;
        if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
    }

    if(s === 0) {
        r = g = b = l; // achromatic
    }
    else {
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        var p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }

    return { r: r * 255, g: g * 255, b: b * 255 };
}

// `rgbToHsv`
// Converts an RGB color value to HSV
// *Assumes:* r, g, and b are contained in the set [0, 255] or [0, 1]
// *Returns:* { h, s, v } in [0,1]
function rgbToHsv(r, g, b) {

    r = bound01(r, 255);
    g = bound01(g, 255);
    b = bound01(b, 255);

    var max = mathMax(r, g, b), min = mathMin(r, g, b);
    var h, s, v = max;

    var d = max - min;
    s = max === 0 ? 0 : d / max;

    if(max == min) {
        h = 0; // achromatic
    }
    else {
        switch(max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return { h: h, s: s, v: v };
}

// `hsvToRgb`
// Converts an HSV color value to RGB.
// *Assumes:* h is contained in [0, 1] or [0, 360] and s and v are contained in [0, 1] or [0, 100]
// *Returns:* { r, g, b } in the set [0, 255]
 function hsvToRgb(h, s, v) {

    h = bound01(h, 360) * 6;
    s = bound01(s, 100);
    v = bound01(v, 100);

    var i = math.floor(h),
        f = h - i,
        p = v * (1 - s),
        q = v * (1 - f * s),
        t = v * (1 - (1 - f) * s),
        mod = i % 6,
        r = [v, q, p, p, t, v][mod],
        g = [t, v, v, q, p, p][mod],
        b = [p, p, t, v, v, q][mod];

    return { r: r * 255, g: g * 255, b: b * 255 };
}

// `rgbToHex`
// Converts an RGB color to hex
// Assumes r, g, and b are contained in the set [0, 255]
// Returns a 3 or 6 character hex
function rgbToHex(r, g, b, allow3Char) {

    var hex = [
        pad2(mathRound(r).toString(16)),
        pad2(mathRound(g).toString(16)),
        pad2(mathRound(b).toString(16))
    ];

    // Return a 3 character hex if possible
    if (allow3Char && hex[0].charAt(0) == hex[0].charAt(1) && hex[1].charAt(0) == hex[1].charAt(1) && hex[2].charAt(0) == hex[2].charAt(1)) {
        return hex[0].charAt(0) + hex[1].charAt(0) + hex[2].charAt(0);
    }

    return hex.join("");
}

// `rgbaToHex`
// Converts an RGBA color plus alpha transparency to hex
// Assumes r, g, b and a are contained in the set [0, 255]
// Returns an 8 character hex
function rgbaToHex(r, g, b, a) {

    var hex = [
        pad2(convertDecimalToHex(a)),
        pad2(mathRound(r).toString(16)),
        pad2(mathRound(g).toString(16)),
        pad2(mathRound(b).toString(16))
    ];

    return hex.join("");
}

// `equals`
// Can be called with any tinycolor input
tinycolor.equals = function (color1, color2) {
    if (!color1 || !color2) { return false; }
    return tinycolor(color1).toRgbString() == tinycolor(color2).toRgbString();
};

tinycolor.random = function() {
    return tinycolor.fromRatio({
        r: mathRandom(),
        g: mathRandom(),
        b: mathRandom()
    });
};


// Modification Functions
// ----------------------
// Thanks to less.js for some of the basics here
// <https://github.com/cloudhead/less.js/blob/master/lib/less/functions.js>

function desaturate(color, amount) {
    amount = (amount === 0) ? 0 : (amount || 10);
    var hsl = tinycolor(color).toHsl();
    hsl.s -= amount / 100;
    hsl.s = clamp01(hsl.s);
    return tinycolor(hsl);
}

function saturate(color, amount) {
    amount = (amount === 0) ? 0 : (amount || 10);
    var hsl = tinycolor(color).toHsl();
    hsl.s += amount / 100;
    hsl.s = clamp01(hsl.s);
    return tinycolor(hsl);
}

function greyscale(color) {
    return tinycolor(color).desaturate(100);
}

function lighten (color, amount) {
    amount = (amount === 0) ? 0 : (amount || 10);
    var hsl = tinycolor(color).toHsl();
    hsl.l += amount / 100;
    hsl.l = clamp01(hsl.l);
    return tinycolor(hsl);
}

function brighten(color, amount) {
    amount = (amount === 0) ? 0 : (amount || 10);
    var rgb = tinycolor(color).toRgb();
    rgb.r = mathMax(0, mathMin(255, rgb.r - mathRound(255 * - (amount / 100))));
    rgb.g = mathMax(0, mathMin(255, rgb.g - mathRound(255 * - (amount / 100))));
    rgb.b = mathMax(0, mathMin(255, rgb.b - mathRound(255 * - (amount / 100))));
    return tinycolor(rgb);
}

function darken (color, amount) {
    amount = (amount === 0) ? 0 : (amount || 10);
    var hsl = tinycolor(color).toHsl();
    hsl.l -= amount / 100;
    hsl.l = clamp01(hsl.l);
    return tinycolor(hsl);
}

// Spin takes a positive or negative amount within [-360, 360] indicating the change of hue.
// Values outside of this range will be wrapped into this range.
function spin(color, amount) {
    var hsl = tinycolor(color).toHsl();
    var hue = (mathRound(hsl.h) + amount) % 360;
    hsl.h = hue < 0 ? 360 + hue : hue;
    return tinycolor(hsl);
}

// Combination Functions
// ---------------------
// Thanks to jQuery xColor for some of the ideas behind these
// <https://github.com/infusion/jQuery-xcolor/blob/master/jquery.xcolor.js>

function complement(color) {
    var hsl = tinycolor(color).toHsl();
    hsl.h = (hsl.h + 180) % 360;
    return tinycolor(hsl);
}

function triad(color) {
    var hsl = tinycolor(color).toHsl();
    var h = hsl.h;
    return [
        tinycolor(color),
        tinycolor({ h: (h + 120) % 360, s: hsl.s, l: hsl.l }),
        tinycolor({ h: (h + 240) % 360, s: hsl.s, l: hsl.l })
    ];
}

function tetrad(color) {
    var hsl = tinycolor(color).toHsl();
    var h = hsl.h;
    return [
        tinycolor(color),
        tinycolor({ h: (h + 90) % 360, s: hsl.s, l: hsl.l }),
        tinycolor({ h: (h + 180) % 360, s: hsl.s, l: hsl.l }),
        tinycolor({ h: (h + 270) % 360, s: hsl.s, l: hsl.l })
    ];
}

function splitcomplement(color) {
    var hsl = tinycolor(color).toHsl();
    var h = hsl.h;
    return [
        tinycolor(color),
        tinycolor({ h: (h + 72) % 360, s: hsl.s, l: hsl.l}),
        tinycolor({ h: (h + 216) % 360, s: hsl.s, l: hsl.l})
    ];
}

function analogous(color, results, slices) {
    results = results || 6;
    slices = slices || 30;

    var hsl = tinycolor(color).toHsl();
    var part = 360 / slices;
    var ret = [tinycolor(color)];

    for (hsl.h = ((hsl.h - (part * results >> 1)) + 720) % 360; --results; ) {
        hsl.h = (hsl.h + part) % 360;
        ret.push(tinycolor(hsl));
    }
    return ret;
}

function monochromatic(color, results) {
    results = results || 6;
    var hsv = tinycolor(color).toHsv();
    var h = hsv.h, s = hsv.s, v = hsv.v;
    var ret = [];
    var modification = 1 / results;

    while (results--) {
        ret.push(tinycolor({ h: h, s: s, v: v}));
        v = (v + modification) % 1;
    }

    return ret;
}

// Utility Functions
// ---------------------

tinycolor.mix = function(color1, color2, amount) {
    amount = (amount === 0) ? 0 : (amount || 50);

    var rgb1 = tinycolor(color1).toRgb();
    var rgb2 = tinycolor(color2).toRgb();

    var p = amount / 100;
    var w = p * 2 - 1;
    var a = rgb2.a - rgb1.a;

    var w1;

    if (w * a == -1) {
        w1 = w;
    } else {
        w1 = (w + a) / (1 + w * a);
    }

    w1 = (w1 + 1) / 2;

    var w2 = 1 - w1;

    var rgba = {
        r: rgb2.r * w1 + rgb1.r * w2,
        g: rgb2.g * w1 + rgb1.g * w2,
        b: rgb2.b * w1 + rgb1.b * w2,
        a: rgb2.a * p  + rgb1.a * (1 - p)
    };

    return tinycolor(rgba);
};


// Readability Functions
// ---------------------
// <http://www.w3.org/TR/2008/REC-WCAG20-20081211/#contrast-ratiodef (WCAG Version 2)

// `contrast`
// Analyze the 2 colors and returns the color contrast defined by (WCAG Version 2)
tinycolor.readability = function(color1, color2) {
    var c1 = tinycolor(color1);
    var c2 = tinycolor(color2);
    return (Math.max(c1.getLuminance(),c2.getLuminance())+0.05) / (Math.min(c1.getLuminance(),c2.getLuminance())+0.05);
};

// `isReadable`
// Ensure that foreground and background color combinations meet WCAG2 guidelines.
// The third argument is an optional Object.
//      the 'level' property states 'AA' or 'AAA' - if missing or invalid, it defaults to 'AA';
//      the 'size' property states 'large' or 'small' - if missing or invalid, it defaults to 'small'.
// If the entire object is absent, isReadable defaults to {level:"AA",size:"small"}.

// *Example*
//    tinycolor.isReadable("#000", "#111") => false
//    tinycolor.isReadable("#000", "#111",{level:"AA",size:"large"}) => false
tinycolor.isReadable = function(color1, color2, wcag2) {
    var readability = tinycolor.readability(color1, color2);
    var wcag2Parms, out;

    out = false;

    wcag2Parms = validateWCAG2Parms(wcag2);
    switch (wcag2Parms.level + wcag2Parms.size) {
        case "AAsmall":
        case "AAAlarge":
            out = readability >= 4.5;
            break;
        case "AAlarge":
            out = readability >= 3;
            break;
        case "AAAsmall":
            out = readability >= 7;
            break;
    }
    return out;

};

// `mostReadable`
// Given a base color and a list of possible foreground or background
// colors for that base, returns the most readable color.
// Optionally returns Black or White if the most readable color is unreadable.
// *Example*
//    tinycolor.mostReadable(tinycolor.mostReadable("#123", ["#124", "#125"],{includeFallbackColors:false}).toHexString(); // "#112255"
//    tinycolor.mostReadable(tinycolor.mostReadable("#123", ["#124", "#125"],{includeFallbackColors:true}).toHexString();  // "#ffffff"
//    tinycolor.mostReadable("#a8015a", ["#faf3f3"],{includeFallbackColors:true,level:"AAA",size:"large"}).toHexString(); // "#faf3f3"
//    tinycolor.mostReadable("#a8015a", ["#faf3f3"],{includeFallbackColors:true,level:"AAA",size:"small"}).toHexString(); // "#ffffff"
tinycolor.mostReadable = function(baseColor, colorList, args) {
    var bestColor = null;
    var bestScore = 0;
    var readability;
    var includeFallbackColors, level, size ;
    args = args || {};
    includeFallbackColors = args.includeFallbackColors ;
    level = args.level;
    size = args.size;

    for (var i= 0; i < colorList.length ; i++) {
        readability = tinycolor.readability(baseColor, colorList[i]);
        if (readability > bestScore) {
            bestScore = readability;
            bestColor = tinycolor(colorList[i]);
        }
    }

    if (tinycolor.isReadable(baseColor, bestColor, {"level":level,"size":size}) || !includeFallbackColors) {
        return bestColor;
    }
    else {
        args.includeFallbackColors=false;
        return tinycolor.mostReadable(baseColor,["#fff", "#000"],args);
    }
};


// Big List of Colors
// ------------------
// <http://www.w3.org/TR/css3-color/#svg-color>
var names = tinycolor.names = {
    aliceblue: "f0f8ff",
    antiquewhite: "faebd7",
    aqua: "0ff",
    aquamarine: "7fffd4",
    azure: "f0ffff",
    beige: "f5f5dc",
    bisque: "ffe4c4",
    black: "000",
    blanchedalmond: "ffebcd",
    blue: "00f",
    blueviolet: "8a2be2",
    brown: "a52a2a",
    burlywood: "deb887",
    burntsienna: "ea7e5d",
    cadetblue: "5f9ea0",
    chartreuse: "7fff00",
    chocolate: "d2691e",
    coral: "ff7f50",
    cornflowerblue: "6495ed",
    cornsilk: "fff8dc",
    crimson: "dc143c",
    cyan: "0ff",
    darkblue: "00008b",
    darkcyan: "008b8b",
    darkgoldenrod: "b8860b",
    darkgray: "a9a9a9",
    darkgreen: "006400",
    darkgrey: "a9a9a9",
    darkkhaki: "bdb76b",
    darkmagenta: "8b008b",
    darkolivegreen: "556b2f",
    darkorange: "ff8c00",
    darkorchid: "9932cc",
    darkred: "8b0000",
    darksalmon: "e9967a",
    darkseagreen: "8fbc8f",
    darkslateblue: "483d8b",
    darkslategray: "2f4f4f",
    darkslategrey: "2f4f4f",
    darkturquoise: "00ced1",
    darkviolet: "9400d3",
    deeppink: "ff1493",
    deepskyblue: "00bfff",
    dimgray: "696969",
    dimgrey: "696969",
    dodgerblue: "1e90ff",
    firebrick: "b22222",
    floralwhite: "fffaf0",
    forestgreen: "228b22",
    fuchsia: "f0f",
    gainsboro: "dcdcdc",
    ghostwhite: "f8f8ff",
    gold: "ffd700",
    goldenrod: "daa520",
    gray: "808080",
    green: "008000",
    greenyellow: "adff2f",
    grey: "808080",
    honeydew: "f0fff0",
    hotpink: "ff69b4",
    indianred: "cd5c5c",
    indigo: "4b0082",
    ivory: "fffff0",
    khaki: "f0e68c",
    lavender: "e6e6fa",
    lavenderblush: "fff0f5",
    lawngreen: "7cfc00",
    lemonchiffon: "fffacd",
    lightblue: "add8e6",
    lightcoral: "f08080",
    lightcyan: "e0ffff",
    lightgoldenrodyellow: "fafad2",
    lightgray: "d3d3d3",
    lightgreen: "90ee90",
    lightgrey: "d3d3d3",
    lightpink: "ffb6c1",
    lightsalmon: "ffa07a",
    lightseagreen: "20b2aa",
    lightskyblue: "87cefa",
    lightslategray: "789",
    lightslategrey: "789",
    lightsteelblue: "b0c4de",
    lightyellow: "ffffe0",
    lime: "0f0",
    limegreen: "32cd32",
    linen: "faf0e6",
    magenta: "f0f",
    maroon: "800000",
    mediumaquamarine: "66cdaa",
    mediumblue: "0000cd",
    mediumorchid: "ba55d3",
    mediumpurple: "9370db",
    mediumseagreen: "3cb371",
    mediumslateblue: "7b68ee",
    mediumspringgreen: "00fa9a",
    mediumturquoise: "48d1cc",
    mediumvioletred: "c71585",
    midnightblue: "191970",
    mintcream: "f5fffa",
    mistyrose: "ffe4e1",
    moccasin: "ffe4b5",
    navajowhite: "ffdead",
    navy: "000080",
    oldlace: "fdf5e6",
    olive: "808000",
    olivedrab: "6b8e23",
    orange: "ffa500",
    orangered: "ff4500",
    orchid: "da70d6",
    palegoldenrod: "eee8aa",
    palegreen: "98fb98",
    paleturquoise: "afeeee",
    palevioletred: "db7093",
    papayawhip: "ffefd5",
    peachpuff: "ffdab9",
    peru: "cd853f",
    pink: "ffc0cb",
    plum: "dda0dd",
    powderblue: "b0e0e6",
    purple: "800080",
    rebeccapurple: "663399",
    red: "f00",
    rosybrown: "bc8f8f",
    royalblue: "4169e1",
    saddlebrown: "8b4513",
    salmon: "fa8072",
    sandybrown: "f4a460",
    seagreen: "2e8b57",
    seashell: "fff5ee",
    sienna: "a0522d",
    silver: "c0c0c0",
    skyblue: "87ceeb",
    slateblue: "6a5acd",
    slategray: "708090",
    slategrey: "708090",
    snow: "fffafa",
    springgreen: "00ff7f",
    steelblue: "4682b4",
    tan: "d2b48c",
    teal: "008080",
    thistle: "d8bfd8",
    tomato: "ff6347",
    turquoise: "40e0d0",
    violet: "ee82ee",
    wheat: "f5deb3",
    white: "fff",
    whitesmoke: "f5f5f5",
    yellow: "ff0",
    yellowgreen: "9acd32"
};

// Make it easy to access colors via `hexNames[hex]`
var hexNames = tinycolor.hexNames = flip(names);


// Utilities
// ---------

// `{ 'name1': 'val1' }` becomes `{ 'val1': 'name1' }`
function flip(o) {
    var flipped = { };
    for (var i in o) {
        if (o.hasOwnProperty(i)) {
            flipped[o[i]] = i;
        }
    }
    return flipped;
}

// Return a valid alpha value [0,1] with all invalid values being set to 1
function boundAlpha(a) {
    a = parseFloat(a);

    if (isNaN(a) || a < 0 || a > 1) {
        a = 1;
    }

    return a;
}

// Take input from [0, n] and return it as [0, 1]
function bound01(n, max) {
    if (isOnePointZero(n)) { n = "100%"; }

    var processPercent = isPercentage(n);
    n = mathMin(max, mathMax(0, parseFloat(n)));

    // Automatically convert percentage into number
    if (processPercent) {
        n = parseInt(n * max, 10) / 100;
    }

    // Handle floating point rounding errors
    if ((math.abs(n - max) < 0.000001)) {
        return 1;
    }

    // Convert into [0, 1] range if it isn't already
    return (n % max) / parseFloat(max);
}

// Force a number between 0 and 1
function clamp01(val) {
    return mathMin(1, mathMax(0, val));
}

// Parse a base-16 hex value into a base-10 integer
function parseIntFromHex(val) {
    return parseInt(val, 16);
}

// Need to handle 1.0 as 100%, since once it is a number, there is no difference between it and 1
// <http://stackoverflow.com/questions/7422072/javascript-how-to-detect-number-as-a-decimal-including-1-0>
function isOnePointZero(n) {
    return typeof n == "string" && n.indexOf('.') != -1 && parseFloat(n) === 1;
}

// Check to see if string passed in is a percentage
function isPercentage(n) {
    return typeof n === "string" && n.indexOf('%') != -1;
}

// Force a hex value to have 2 characters
function pad2(c) {
    return c.length == 1 ? '0' + c : '' + c;
}

// Replace a decimal with it's percentage value
function convertToPercentage(n) {
    if (n <= 1) {
        n = (n * 100) + "%";
    }

    return n;
}

// Converts a decimal to a hex value
function convertDecimalToHex(d) {
    return Math.round(parseFloat(d) * 255).toString(16);
}
// Converts a hex value to a decimal
function convertHexToDecimal(h) {
    return (parseIntFromHex(h) / 255);
}

var matchers = (function() {

    // <http://www.w3.org/TR/css3-values/#integers>
    var CSS_INTEGER = "[-\\+]?\\d+%?";

    // <http://www.w3.org/TR/css3-values/#number-value>
    var CSS_NUMBER = "[-\\+]?\\d*\\.\\d+%?";

    // Allow positive/negative integer/number.  Don't capture the either/or, just the entire outcome.
    var CSS_UNIT = "(?:" + CSS_NUMBER + ")|(?:" + CSS_INTEGER + ")";

    // Actual matching.
    // Parentheses and commas are optional, but not required.
    // Whitespace can take the place of commas or opening paren
    var PERMISSIVE_MATCH3 = "[\\s|\\(]+(" + CSS_UNIT + ")[,|\\s]+(" + CSS_UNIT + ")[,|\\s]+(" + CSS_UNIT + ")\\s*\\)?";
    var PERMISSIVE_MATCH4 = "[\\s|\\(]+(" + CSS_UNIT + ")[,|\\s]+(" + CSS_UNIT + ")[,|\\s]+(" + CSS_UNIT + ")[,|\\s]+(" + CSS_UNIT + ")\\s*\\)?";

    return {
        rgb: new RegExp("rgb" + PERMISSIVE_MATCH3),
        rgba: new RegExp("rgba" + PERMISSIVE_MATCH4),
        hsl: new RegExp("hsl" + PERMISSIVE_MATCH3),
        hsla: new RegExp("hsla" + PERMISSIVE_MATCH4),
        hsv: new RegExp("hsv" + PERMISSIVE_MATCH3),
        hsva: new RegExp("hsva" + PERMISSIVE_MATCH4),
        hex3: /^([0-9a-fA-F]{1})([0-9a-fA-F]{1})([0-9a-fA-F]{1})$/,
        hex6: /^([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/,
        hex8: /^([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/
    };
})();

// `stringInputToObject`
// Permissive string parsing.  Take in a number of formats, and output an object
// based on detected format.  Returns `{ r, g, b }` or `{ h, s, l }` or `{ h, s, v}`
function stringInputToObject(color) {

    color = color.replace(trimLeft,'').replace(trimRight, '').toLowerCase();
    var named = false;
    if (names[color]) {
        color = names[color];
        named = true;
    }
    else if (color == 'transparent') {
        return { r: 0, g: 0, b: 0, a: 0, format: "name" };
    }

    // Try to match string input using regular expressions.
    // Keep most of the number bounding out of this function - don't worry about [0,1] or [0,100] or [0,360]
    // Just return an object and let the conversion functions handle that.
    // This way the result will be the same whether the tinycolor is initialized with string or object.
    var match;
    if ((match = matchers.rgb.exec(color))) {
        return { r: match[1], g: match[2], b: match[3] };
    }
    if ((match = matchers.rgba.exec(color))) {
        return { r: match[1], g: match[2], b: match[3], a: match[4] };
    }
    if ((match = matchers.hsl.exec(color))) {
        return { h: match[1], s: match[2], l: match[3] };
    }
    if ((match = matchers.hsla.exec(color))) {
        return { h: match[1], s: match[2], l: match[3], a: match[4] };
    }
    if ((match = matchers.hsv.exec(color))) {
        return { h: match[1], s: match[2], v: match[3] };
    }
    if ((match = matchers.hsva.exec(color))) {
        return { h: match[1], s: match[2], v: match[3], a: match[4] };
    }
    if ((match = matchers.hex8.exec(color))) {
        return {
            a: convertHexToDecimal(match[1]),
            r: parseIntFromHex(match[2]),
            g: parseIntFromHex(match[3]),
            b: parseIntFromHex(match[4]),
            format: named ? "name" : "hex8"
        };
    }
    if ((match = matchers.hex6.exec(color))) {
        return {
            r: parseIntFromHex(match[1]),
            g: parseIntFromHex(match[2]),
            b: parseIntFromHex(match[3]),
            format: named ? "name" : "hex"
        };
    }
    if ((match = matchers.hex3.exec(color))) {
        return {
            r: parseIntFromHex(match[1] + '' + match[1]),
            g: parseIntFromHex(match[2] + '' + match[2]),
            b: parseIntFromHex(match[3] + '' + match[3]),
            format: named ? "name" : "hex"
        };
    }

    return false;
}

function validateWCAG2Parms(parms) {
    // return valid WCAG2 parms for isReadable.
    // If input parms are invalid, return {"level":"AA", "size":"small"}
    var level, size;
    parms = parms || {"level":"AA", "size":"small"};
    level = (parms.level || "AA").toUpperCase();
    size = (parms.size || "small").toLowerCase();
    if (level !== "AA" && level !== "AAA") {
        level = "AA";
    }
    if (size !== "small" && size !== "large") {
        size = "small";
    }
    return {"level":level, "size":size};
}

// Node: Export function
if (typeof module !== "undefined" && module.exports) {
    module.exports = tinycolor;
}
// AMD/requirejs: Define the module
else if (typeof define === 'function' && define.amd) {
    define(function () {return tinycolor;});
}
// Browser: Expose to window
else {
    window.tinycolor = tinycolor;
}

})();

/*

 Running the following code before any other code will create if it's not natively available.
 https://developer.mozilla.org/

*/

if(!Array.prototype.forEach){
    Array.prototype.forEach = function(fn, scope){
        for(var i = 0, len = this.length; i < len; ++i){
            fn.call(scope || this, this[i], i, this);
        }
    }
}

if(!Array.prototype.filter){
    Array.prototype.filter = function(fun /*, thisp */){
        "use strict";

        if(this == null){
            throw new TypeError();
        }
        var t = Object(this);
        var len = t.length >>> 0;
        if(typeof fun != "function"){
            throw new TypeError();
        }
        var res = [];
        var thisp = arguments[1];
        for(var i = 0; i < len; i++){
            if(i in t){
                var val = t[i]; // in case fun mutates this
                if(fun.call(thisp, val, i, t)){
                    res.push(val);
                }
            }
        }
        return res;
    };
}


if (!Array.prototype.map) {
    Array.prototype.map = function(callback, thisArg) {
        var T, A, k;
        if (this == null) {
            throw new TypeError(' this is null or not defined');
        }
        var O = Object(this);
        var len = O.length >>> 0;
        if (typeof callback !== 'function') {
            throw new TypeError(callback + ' is not a function');
        }
        if (arguments.length > 1) {
            T = thisArg;
        }
        A = new Array(len);
        k = 0;
        while (k < len) {
            var kValue, mappedValue;
            if (k in O) {
                kValue = O[k];
                mappedValue = callback.call(T, kValue, k, O);
                A[k] = mappedValue;
            }
            k++;
        }
        return A;
    };
}

if(!Array.prototype.indexOf){
    Array.prototype.indexOf = function(searchElement /*, fromIndex */){
        "use strict";
        if(this == null){
            throw new TypeError();
        }
        var t = Object(this);
        var len = t.length >>> 0;
        if(len === 0){
            return -1;
        }
        var n = 0;
        if(arguments.length > 1){
            n = Number(arguments[1]);
            if(n != n){
                n = 0;
            }else if(n != 0 && n != Infinity && n != -Infinity){
                n = (n > 0 || -1) * Math.floor(Math.abs(n));
            }
        }
        if(n >= len){
            return -1;
        }
        var k = n >= 0 ? n : Math.max(len - Math.abs(n), 0);
        for(; k < len; k++){
            if(k in t && t[k] === searchElement){
                return k;
            }
        }
        return -1;
    };
}

if (!Array.prototype.find) {
    Array.prototype.find = function(predicate) {
        if (this == null) {
            throw new TypeError('Array.prototype.find called on null or undefined');
        }
        if (typeof predicate !== 'function') {
            throw new TypeError('predicate must be a function');
        }
        var list = Object(this);
        var length = list.length >>> 0;
        var thisArg = arguments[1];
        var value;

        for (var i = 0; i < length; i++) {
            value = list[i];
            if (predicate.call(thisArg, value, i, list)) {
                return value;
            }
        }
        return undefined;
    };
}

if ( 'function' !== typeof Array.prototype.reduce ) {
    Array.prototype.reduce = function( callback /*, initialValue*/ ) {
        'use strict';
        if ( null === this || 'undefined' === typeof this ) {
            throw new TypeError('Array.prototype.reduce called on null or undefined' );
        }
        if ( 'function' !== typeof callback ) {
            throw new TypeError( callback + ' is not a function' );
        }
        var t = Object( this ), len = t.length >>> 0, k = 0, value;
        if ( arguments.length >= 2 ) {
            value = arguments[1];
        } else {
            while ( k < len && ! k in t ) k++;
            if ( k >= len )
                throw new TypeError('Reduce of empty array with no initial value');
            value = t[ k++ ];
        }
        for ( ; k < len ; k++ ) {
            if ( k in t ) {
                value = callback( value, t[k], k, t );
            }
        }
        return value;
    };
}

if ( 'function' !== typeof Array.prototype.reduceRight ) {
    Array.prototype.reduceRight = function( callback /*, initialValue*/ ) {
        'use strict';
        if ( null === this || 'undefined' === typeof this ) {
            throw new TypeError(
                'Array.prototype.reduce called on null or undefined' );
        }
        if ( 'function' !== typeof callback ) {
            throw new TypeError( callback + ' is not a function' );
        }
        var t = Object( this ), len = t.length >>> 0, k = len - 1, value;
        if ( arguments.length >= 2 ) {
            value = arguments[1];
        } else {
            while ( k >= 0 && ! k in t ) k--;
            if ( k < 0 )
                throw new TypeError('Reduce of empty array with no initial value');
            value = t[ k-- ];
        }
        for ( ; k >= 0 ; k-- ) {
            if ( k in t ) {
                value = callback( value, t[k], k, t );
            }
        }
        return value;
    };
}

if (!Function.prototype.bind) {
    Function.prototype.bind = function(oThis) {
        if (typeof this !== 'function') {
            throw new TypeError('Function.prototype.bind - what is trying to be bound is not callable');
        }
        var aArgs = Array.prototype.slice.call(arguments, 1),
            fToBind = this,
            fNOP    = function() {},
            fBound  = function() {
                return fToBind.apply(this instanceof fNOP && oThis
                        ? this
                        : oThis,
                    aArgs.concat(Array.prototype.slice.call(arguments)));
            };
        fNOP.prototype = this.prototype;
        fBound.prototype = new fNOP();
        return fBound;
    };
}

if(!String.prototype.trim) {
    String.prototype.trim = function(){
        return this.replace(/^\s+|\s+$/g, '');
    };
}

if(!Date.now){
    Date.now = function now(){
        return new Date().getTime();
    };
}

(function(){
    if('undefined' == typeof JSON){
        window.JSON = {};
    }
    if(!JSON.parse || !JSON.stringify){
        JSON.parse = function(str){
            return eval('(' + str + ')');
        };
        JSON.stringify = function(){
            throw new Error('JSON.stringify is not supported by this browser.');
        };
    }
})();
/* ******* INFO ******* */

/* *******

    Objects and Arrays:             56
    Events:                         339
    Nodes:                          703
    Forms:                          1006
    Strings:                        1282
    Date and Time:                  1379
    Styles:                         1506
    Animation:                      2168
    Cookie and Local Storage:       2372
    Ajax:                           2439
    Hash (?):                       2717
    Graphics:                       2737
    Class Fabric                    2747

    -------

    Custom Events:
       scrollSizeChange

 ******* */

var cm = {
        '_version' : '3.9.0',
        '_loadTime' : Date.now(),
        '_debug' : true,
        '_debugAlert' : false,
        '_deviceType' : 'desktop',
        '_deviceOrientation' : 'landscape',
        '_scrollSize' : 0,
        '_clientPosition' : {'x' : 0, 'y' : 0},
        '_config' : {
            'animDuration' : 300,
            'animDurationQuick' : 150,
            'adaptiveFrom' : 768,
            'screenTablet' : 1024,
            'screenTabletPortrait' : 768,
            'screenMobile' : 640,
            'screenMobilePortrait' : 480,
            'dateFormat' : '%Y-%m-%d',
            'dateTimeFormat' : '%Y-%m-%d %H:%i:%s',
            'timeFormat' : '%H:%i:%s',
            'displayDateFormat' : '%F %j, %Y',
            'displayDateTimeFormat' : '%F %j, %Y, %H:%i',
            'tooltipTop' : 'targetHeight + 4'
        }
    },
    Mod = {},
    Part = {},
    Com = {
        'Elements' : {}
    };

/* ******* CHECK SUPPORT ******* */

cm.isFileReader = (function(){return 'FileReader' in window;})();
cm.isHistoryAPI = !!(window.history && history.pushState);
cm.isLocalStorage = (function(){try{return 'localStorage' in window && window['localStorage'] !== null;}catch(e){return false;}})();
cm.isCanvas = !!document.createElement("canvas").getContext;
cm.isTouch = 'ontouchstart' in document.documentElement || !!window.navigator.msMaxTouchPoints;

/* ******* OBJECTS AND ARRAYS ******* */

cm.isArray = Array.isArray || function(a){
    return (a) ? a.constructor == Array : false;
};
cm.isObject = function(o){
    return (o) ? o.constructor == Object : false;
};

cm.forEach = function(o, callback){
    if(!o){
        return null;
    }
    if(!callback){
        return o;
    }
    var i, l;
    switch(o.constructor){
        case Object:
            for(var key in o){
                if(o.hasOwnProperty(key)){
                    callback(o[key], key, o);
                }
            }
            break;
        case Array:
            o.forEach(callback);
            break;
        case Number:
            for(i = 0; i < o; i++){
                callback(i);
            }
            break;
        default:
            try{
                Array.prototype.forEach.call(o, callback);
            }catch(e){
                try{
                    for(i = 0, l = o.length; i < l; i++){
                        callback(o[i], i, o);
                    }
                }catch(e){}
            }
            break;
    }
    return o;
};

cm.forEachReverse = function(o, callback){
    if(!o){
        return null;
    }
    if(!callback){
        return o;
    }
    o.reverse();
    cm.forEach(o, callback);
    o.reverse();
    return o;
};

cm.merge = function(o1, o2){
    if(!o2){
        o2 = {};
    }
    if(!o1){
        o1 = {}
    }else if(cm.isObject(o1) || cm.isArray(o1)){
        o1 = cm.clone(o1);
    }else{
        return cm.clone(o2);
    }
    cm.forEach(o2, function(item, key){
        if(item != null){
            try{
                if(Object.prototype.toString.call(item) == '[object Object]' && item.constructor != Object){
                    o1[key] = item;
                }else if(cm.isObject(item)){
                    o1[key] = cm.merge(o1[key], item);
                }else{
                    o1[key] = item;
                }
            }catch(e){
                o1[key] = item;
            }
        }
    });
    return o1;
};

cm.extend = function(o1, o2){
    if(!o1){
        return o2;
    }
    if(!o2){
        return o1;
    }
    var o;
    switch(o1.constructor){
        case Array:
            o = o1.concat(o2);
            break;
        case Object:
            o = {};
            cm.forEach(o1, function(item, key){
                o[key] = item;
            });
            cm.forEach(o2, function(item, key){
                o[key] = item;
            });
            break;
    }
    return o;
};

cm.clone = function(o, cloneNode){
    var newO;
    if(!o){
        return o;
    }
    switch(o.constructor){
        case Function:
        case String:
        case Number:
        case RegExp:
        case Boolean:
        case XMLHttpRequest:
            newO = o;
            break;
        case Array:
            newO = [];
            cm.forEach(o, function(item){
                newO.push(cm.clone(item, cloneNode));
            });
            break;
        case Object:
            newO = {};
            cm.forEach(o, function(item, key){
                newO[key] = cm.clone(item, cloneNode);
            });
            break;
        default:
            // Exceptions
            if(cm.isNode(o)){
                if(cloneNode){
                    newO = o.cloneNode(true);
                }else{
                    newO = o;
                }
            }else if(XMLHttpRequest && o instanceof XMLHttpRequest){
                newO = o;
            }else if(Object.prototype.toString.call(o) == '[object Object]' && o.constructor != Object){
                newO = o;
            }else if(o == window){
                newO = o;
            }else if(o instanceof CSSStyleDeclaration){
                newO = o;
            }else{
                newO = [];
                cm.forEach(o, function(item){
                    newO.push(cm.clone(item, cloneNode));
                });
            }
            break;
    }
    return newO;
};

cm.getLength = function(o){
    var i = 0;
    cm.forEach(o, function(){
        i++;
    });
    return i;
};

cm.inArray = function(a, str){
    if(typeof a == 'string'){
        return a === str;
    }else{
        var inArray = false;
        a.forEach(function(item){
            if(item === str){
                inArray = true;
            }
        });
        return inArray;
    }
};

cm.objectToArray = function(o){
    if(typeof(o) != 'object'){
        return [o];
    }
    var a = [];
    cm.forEach(o, function(item){
        a.push(item);
    });
    return a;
};

cm.arrayToObject = function(a){
    var o = {};
    a.forEach(function(item, i){
        if(typeof item == 'object'){
            o[i] = item;
        }else{
            o[item] = item;
        }
    });
    return o;
};

cm.objectReplace = function(o, vars){
    var newO = cm.clone(o);
    cm.forEach(newO, function(value, key){
        if(typeof value == 'object'){
            newO[key] = cm.objectReplace(value, vars);
        }else{
            newO[key] = cm.strReplace(value, vars);
        }
    });
    return newO;
};

cm.isEmpty = function(el){
    if(!el){
        return true;
    }else if(typeof el == 'string' || el.constructor == Array){
        return el.length == 0;
    }else if(el.constructor == Object){
        return cm.getLength(el) === 0;
    }else if(typeof el == 'number'){
        return el == 0;
    }else{
        return false;
    }
};

cm.objectSelector = function(name, obj, apply){
    obj = typeof obj == 'undefined'? window : obj;
    name = name.split('.');
    var findObj = obj,
        length = name.length;
    cm.forEach(name, function(item, key){
        if(!findObj[item]){
            findObj[item] = {};
        }
        if(apply && key == length -1){
            findObj[item] = apply;
        }
        findObj = findObj[item];
    });
    return findObj;
};

cm.sort = function(o){
    var a = [];
    cm.forEach(o, function(item, key){
        a.push({'key' : key, 'value' : item});
    });
    a.sort(function(a, b){
        return (a['key'] < b['key']) ? -1 : ((a['key'] > b['key']) ? 1 : 0);
    });
    o = {};
    a.forEach(function(item){
        o[item['key']] = item['value'];
    });
    return o;
};

cm.replaceDeep = function(o, from, to){
    var newO = cm.clone(o);
    cm.forEach(newO, function(value, key){
        if(typeof value == 'object'){
            newO[key] = cm.replaceDeep(value, from, to);
        }else{
            newO[key] = value.replace(from, to);
        }
    });
    return newO;
};

/* ******* EVENTS ******* */

cm.log = (function(){
    var results = [],
        log;
    if(cm._debug && Function.prototype.bind && window.console){
        log = Function.prototype.bind.call(console.log, console);
        return function(){
            log.apply(console, arguments);
        };
    }else if(cm._debug && cm._debugAlert){
        return function(){
            cm.forEach(arguments, function(arg){
                results.push(arg);
            });
            alert(results.join(', '));
        };
    }else{
        return function(){}
    }
})();

cm.errorLog = function(o){
    var config = cm.merge({
            'type' : 'error',
            'name' : '',
            'message' : '',
            'langs' : {
                'error' : 'Error!',
                'success' : 'Success!',
                'attention' : 'Attention!',
                'common' : 'Common'
            }
        }, o),
        str = [
            config['langs'][config['type']],
            config['name'],
            config['message']
        ];
    cm.log(str.join(' > '));
};

cm.getEvent = function(e){
    return e || window.event;
};

cm.stopPropagation = function(e){
    return e.stopPropagation ? e.stopPropagation() : e.cancelBubble = true;
};

cm.preventDefault = function(e){
    return e.preventDefault ? e.preventDefault() : e.returnValue = false;
};

cm.getObjFromEvent = cm.getEventObject = cm.getEventTarget = function(e){
    return  e.target || e.srcElement;
};

cm.getObjToEvent = cm.getRelatedTarget = function(e){
    return e.relatedTarget || e.srcElement;
};

cm.getEventClientPosition = function(e){
    var o = {
        'x' : 0,
        'y' : 0
    };
    if(e){
        try{
            o['x'] = e.clientX;
            o['y'] = e.clientY;
            if(cm.isTouch && e.touches){
                o['x'] = e.touches[0].clientX;
                o['y'] = e.touches[0].clientY;
            }
        }catch(e){}
    }
    return o;
};

cm.crossEvents = function(key){
    var events = {
        'mousedown' : 'touchstart',
        'mouseup' : 'touchend',
        'mousemove' : 'touchmove'
    };
    return events[key];
};

cm.addEvent = function(el, type, handler, useCapture){
    useCapture = typeof useCapture == 'undefined' ? false : useCapture;
    // Process touch events
    if(cm.isTouch && cm.crossEvents(type)){
        el.addEventListener(cm.crossEvents(type), handler, useCapture);
        return el;
    }
    try{
        el.addEventListener(type, handler, useCapture);
    }catch(e){
        el.attachEvent('on' + type, handler);
    }
    return el;
};

cm.removeEvent = function(el, type, handler, useCapture){
    useCapture = typeof useCapture == 'undefined' ? false : useCapture;
    // Process touch events
    if(cm.isTouch && cm.crossEvents(type)){
        el.removeEventListener(cm.crossEvents(type), handler, useCapture);
        return el;
    }
    try{
        el.removeEventListener(type, handler, useCapture);
    }catch(e){
        el.detachEvent('on' + type, handler);
    }
    return el;
};

cm.triggerEvent = function(el, type, params){
    var event;
    if(cm.isTouch && cm.crossEvents(type)){
        type = cm.crossEvents(type);
    }
    if(document.createEvent){
        event = document.createEvent('Event');
        event.initEvent(type, true, true);
    }else if(document.createEventObject){
        event = document.createEventObject();
        event.eventType = type;
    }
    event.eventName = type;
    if(el.dispatchEvent){
        el.dispatchEvent(event);
    }else if(el.fireEvent){
        el.fireEvent('on' + event.eventType, event);
    }
    return el;
};

cm.customEventsStack = [
    /* {'el' : node, 'type' : 'customEventType', 'handler' : function, 'misc' : {'eventType' : [function]}} */
];

cm.addCustomEvent = function(el, type, handler, useCapture, preventDefault){
    useCapture = typeof(useCapture) == 'undefined' ? true : useCapture;
    preventDefault = typeof(preventDefault) == 'undefined' ? false : preventDefault;

    var events = {
        'tap' : function(){
            var x = 0,
                fault = 4,
                y = 0;
            // Generate events
            return {
                'click' : [
                    function(e){
                        if(preventDefault){
                            e.preventDefault();
                        }
                    }
                ],
                'touchstart' : [
                    function(e){
                        x = e.changedTouches[0].screenX;
                        y = e.changedTouches[0].screenY;
                        if(preventDefault){
                            e.preventDefault();
                        }
                    }
                ],
                'touchend' : [
                    function(e){
                        if(
                            Math.abs(e.changedTouches[0].screenX - x) > fault ||
                            Math.abs(e.changedTouches[0].screenY - y) > fault
                        ){
                            return;
                        }
                        if(preventDefault){
                            e.preventDefault();
                        }
                        handler(e);
                    }
                ]
            };
        }
    };
    // Process custom event
    if(events[type]){
        var miscEvents = events[type]();
        // Push generated events to stack
        cm.customEventsStack.push({
            'el' : el,
            'type' : type,
            'handler' : handler,
            'misc' : miscEvents
        });
        // Bind generated events
        cm.forEach(miscEvents, function(miscFunctions, eventType){
            cm.forEach(miscFunctions, function(miscFunction){
                el.addEventListener(eventType, miscFunction, useCapture);
            });
        });
    }
    return el;
};

cm.removeCustomEvent = function(el, type, handler, useCapture){
    cm.customEventsStack = cm.customEventsStack.filter(function(item){
        if(item['el'] === el && item['type'] == type && item['handler'] === handler){
            cm.forEach(item['misc'], function(miscFunctions, eventType){
                cm.forEach(miscFunctions, function(miscFunction){
                    el.removeEventListener(eventType, miscFunction, useCapture);
                });
            });
            return false;
        }
        return true;
    });
    return el;
};

cm.customEvent = (function(){
    var _stack = {};

    return {
        'add' : function(node, type, handler){
            if(!_stack[type]){
                _stack[type] = [];
            }
            _stack[type].push({
                'node' : node,
                'type' : type,
                'handler' : typeof handler == 'function' ? handler : function(){}
            });
            return node;
        },
        'remove' : function(node, type, handler){
            if(!_stack[type]){
                _stack[type] = [];
            }
            _stack[type] = _stack[type].filter(function(item){
                return item['node'] != node && item['handler'] != handler;
            });
            return node;
        },
        'trigger' : function(node, type, params){
            var stopPropagation = false;
            params = cm.merge({
                'target' : node,
                'type' : 'both',            // child | parent | both | all
                'self' : true,
                'stopPropagation' : function(){
                    stopPropagation = true;
                }
            }, params);
            cm.forEach(_stack[type], function(item){
                if(!stopPropagation){
                    if(params['self'] && node === item['node']){
                        item['handler'](params);
                    }
                    switch(params['type']){
                        case 'child':
                            if(cm.isParent(node, item['node'], false)){
                                item['handler'](params);
                            }
                            break;
                        case 'parent':
                            if(cm.isParent(item['node'], node, false)){
                                item['handler'](params);
                            }
                            break;
                        case 'both':
                            if(cm.isParent(node, item['node'], false)){
                                item['handler'](params);
                            }
                            if(cm.isParent(item['node'], node, false)){
                                item['handler'](params);
                            }
                            break;
                        case 'all':
                        default:
                            if(!params['self'] && node !== item['node']){
                                item['handler'](params);
                            }
                            break;
                    }
                }
            });
            return node;
        }
    };
})();

cm.onLoad = function(handler, isMessage){
    isMessage = typeof isMessage == 'undefined'? true : isMessage;
    var called = false;
    var execute = function(){
        if(called){
            return;
        }
        called = true;
        if(isMessage){
            cm.errorLog({
                'type' : 'common',
                'name' : 'cm.onLoad',
                'message' : ['Load time', (Date.now() - cm._loadTime), 'ms.'].join(' ')
            });
        }
        handler();
    };
    try{
        cm.addEvent(window, 'load', execute);
    }catch(e){}
};

cm.onReady = function(handler, isMessage){
    isMessage = typeof isMessage == 'undefined'? true : isMessage;
    var called = false;
    var execute = function(){
        if(called){
            return;
        }
        called = true;
        if(isMessage){
            cm.errorLog({
                'type' : 'common',
                'name' : 'cm.onReady',
                'message' : ['Ready time', (Date.now() - cm._loadTime), 'ms.'].join(' ')
            });
        }
        handler();
    };
    cm.addEvent(document, 'DOMContentLoaded', execute);
    try{
        cm.addEvent(window, 'load', execute);
    }catch(e){}
};

cm.addScrollEvent = function(node, callback, useCapture){
    useCapture = typeof useCapture == 'undefined' ? false : useCapture;
    if(cm.isWindow(node)){
        cm.addEvent(window, 'scroll', callback, useCapture);
    }else if(cm.isNode(node)){
        if(/body|html/gi.test(node.tagName)){
            cm.addEvent(window, 'scroll', callback, useCapture);
        }else{
            cm.addEvent(node, 'scroll', callback, useCapture);
        }
    }
    return node;
};

cm.removeScrollEvent = function(node, callback, useCapture){
    useCapture = typeof useCapture == 'undefined' ? false : useCapture;
    if(cm.isWindow(node)){
        cm.removeEvent(window, 'scroll', callback, useCapture);
    }if(cm.isNode(node)){
        if(/body|html/gi.test(node.tagName)){
            cm.removeEvent(window, 'scroll', callback, useCapture);
        }else{
            cm.removeEvent(node, 'scroll', callback, useCapture);
        }
    }
    return node;
};

cm.isCenterButton = function(e){
    return e.button == ((cm.is('IE') && cm.isVersion() < 9) ? 4 : 1);
};

cm.debounce = function(func, wait, immediate){
    var timeout, result;
    return function(){
        var context = this, args = arguments;
        var later = function(){
            timeout = null;
            if(!immediate){
                result = func.apply(context, args);
            }
        };
        var callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if(callNow){
            result = func.apply(context, args);
        }
        return result;
    };
};

cm.onScrollStart = function(node, handler){
    var worked = false,
        scrollEnd = function(){
            worked = false;
        },
        helper = cm.debounce(scrollEnd, 300),
        scrollEvent = function(){
            !worked && handler();
            worked = true;
            helper();
        };
    cm.addEvent(node, 'scroll', scrollEvent);
    return {
        'remove' : function(){
            cm.removeEvent(node, 'scroll', scrollEvent);
        }
    };
};

cm.onScrollEnd = function(node, handler){
    var helper = cm.debounce(handler, 300);
    cm.addEvent(node, 'scroll', helper);
    return {
        'remove' : function(){
            cm.removeEvent(node, 'scroll', helper);
        }
    };
};

cm.onImageLoad = function(src, handler, delay){
    delay = delay || 0;
    var nodes = [],
        isMany = cm.isArray(src),
        images = isMany ? src : [src],
        imagesLength = images.length,
        isLoad = 0,
        timeStart = Date.now(),
        timePassed = 0;

    images.forEach(function(item, i){
        nodes[i] = cm.Node('img', {'alt' : ''});
        nodes[i].onload = function(){
            isLoad++;
            if(isLoad == imagesLength){
                timePassed = Date.now() - timeStart;
                delay = timePassed < delay ? delay - timePassed : 0;

                if(delay){
                    setTimeout(function(){
                        handler(isMany ? nodes : nodes[0]);
                    }, delay);
                }else{
                    handler(isMany ? nodes : nodes[0]);
                }
            }
        };
        nodes[i].src = item;
    });

    return isMany ? nodes : nodes[0];
};

/* ******* NODES ******* */

cm.isNode = function(node){
    return !!(node && node.nodeType);
};

cm.isTextNode = function(node){
    return !!(node && node.nodeType && node.nodeType == 3);
};

cm.isElementNode = function(node){
    return !!(node && node.nodeType && node.nodeType == 1);
};

cm.isWindow = function(o) {
    if(typeof(window.constructor) === 'undefined') {
        return o instanceof window.constructor;
    }else{
        return window === o;
    }
};

cm.getEl = function(str){
    return document.getElementById(str);
};

cm.getByClass = function(str, node){
    node = node || document;
    if(node.getElementsByClassName){
        return node.getElementsByClassName(str);
    }
    var els = node.getElementsByTagName('*'), arr = [];
    for(var i = 0, l = els.length; i < l; i++){
        cm.isClass(els[i], str) && arr.push(els[i]);
    }
    return arr;
};

cm.getByAttr = function(attr, value, element){
    var p = element || document;
    if(p.querySelectorAll){
        return p.querySelectorAll("[" + attr + "='" + value + "']");
    }
    var elements = p.getElementsByTagName('*');
    var stack = [];
    for(var i = 0, ln = elements.length; i < ln; i++){
        if(elements[i].getAttribute(attr) == value){
            stack.push(elements[i]);
        }
    }
    return stack;
};

cm.getByName = function(name, node){
    if(node){
        var arr = [],
            els = node.getElementsByTagName('*');
        for(var i = 0, l = els.length; i < l; i++){
            if(els[i].name == name){
                arr.push(els[i]);
            }
        }
        return arr;
    }else{
        return document.getElementsByName(name);
    }
};

cm.getParentByTagName = function(tagName, node){
    if(!tagName || !node || !node.parentNode){
        return null;
    }
    var el = node.parentNode;
    do{
        if(el.tagName && el.tagName.toLowerCase() == tagName.toLowerCase()){
            return el;
        }
    }while(el = el.parentNode);
    return null;
};

cm.getIFrameDOM = function(o){
    return o.contentDocument || o.document;
};

cm.getDocumentHead = function(){
    return document.getElementsByTagName('head')[0];
};

cm.getDocumentHtml = function(){
    return document.documentElement;
};

cm.node = cm.Node = function(){
    var args = arguments,
        value,
        el = document.createElement(args[0]);
    if(typeof args[1] == "object" && !args[1].nodeType){
        for(var i in args[1]){
            value = args[1][i];
            if(typeof value == 'object'){
                value = JSON.stringify(value);
            }
            if(i == 'style'){
                el.style.cssText = value;
            }else if(i == 'class'){
                el.className = value;
            }else if(i == 'innerHTML'){
                el.innerHTML = value;
            }else{
                el.setAttribute(i, value);
            }
        }
        i = 2;
    }else{
        i = 1;
    }
    for(var ln = args.length; i < ln; i++){
        if(typeof arguments[i] != 'undefined'){
            if(typeof arguments[i] == 'string' || typeof args[i] == 'number'){
                el.appendChild(document.createTextNode(args[i]));
            }else{
                el.appendChild(args[i]);
            }
        }
    }
    return el;
};

cm.wrap = function(target, node){
    if(!target || !node){
        return null;
    }
    if(node.parentNode){
        cm.insertBefore(target, node);
    }
    target.appendChild(node);
    return target;
};

cm.inDOM = function(o){
    if(o){
        var el = o.parentNode;
        while(el){
            if(el == document){
                return true;
            }
            el = el.parentNode
        }
    }
    return false;
};

cm.isParent = function(p, o, flag){
    if(cm.isNode(o) && o.parentNode){
        if(cm.isWindow(p) && cm.inDOM(o)){
            return true;
        }

        var el = o.parentNode;
        do{
            if(el == p){
                return true;
            }
        }while(el = el.parentNode);
    }
    return (flag) ? p === o : false;
};

cm.isParentByClass = function(parentClass, o){
    if(o && o.parentNode){
        var el = o.parentNode;
        do{
            if(cm.isClass(el, parentClass)){
                return true;
            }
        }while(el = el.parentNode);
    }
    return false;
};

cm.getData = function(node, name){
    if(!node){
        return null;
    }
    if(node.dataset){
        return node.dataset[name];
    }else{
        return node.getAttribute(['data', name].join('-'));
    }
};

cm.getTextValue = cm.getTxtVal = function(o){
    return o.nodeType == 1 && o.firstChild ? o.firstChild.nodeValue : '';
};

cm.getTextNodesStr = function(node){
    var str = '',
        childs;
    if(node){
        if(cm.isArray(node)){
            cm.forEach(node, function(child){
                str += cm.getTextNodesStr(child);
            });
        }else if(cm.isNode(node)){
            childs = node.childNodes;
            cm.forEach(childs, function(child){
                if(child.nodeType == 1){
                    str += cm.getTextNodesStr(child);
                }else{
                    str += child.nodeValue;
                }
            });
        }
    }
    return str;
};

cm.remove = function(node){
    if(node && node.parentNode){
        node.parentNode.removeChild(node);
    }
};

cm.clearNode = function(node){
    while(node.childNodes.length != 0){
        node.removeChild(node.firstChild);
    }
    return node;
};

cm.prevEl = function(node){
    node = node.previousSibling;
    if(node && node.nodeType && node.nodeType != 1){
        node = cm.prevEl(node);
    }
    return node;
};

cm.nextEl = function(node){
    node = node.nextSibling;
    if(node && node.nodeType && node.nodeType != 1){
        node = cm.nextEl(node);
    }
    return node;
};

cm.firstEl = function(node){
    if(!node || !node.firstChild){
        return null;
    }
    node = node.firstChild;
    if(node.nodeType != 1){
        node = cm.nextEl(node);
    }
    return node;
};

cm.insertFirst = function(node, target){
    if(cm.isNode(node) && cm.isNode(target)){
        if(target.firstChild){
            cm.insertBefore(node, target.firstChild);
        }else{
            cm.appendChild(node, target);
        }
    }
    return node;
};

cm.insertLast = cm.appendChild = function(node, target){
    if(cm.isNode(node) && cm.isNode(target)){
        target.appendChild(node);
    }
    return node;
};

cm.insertBefore = function(node, target){
    if(cm.isNode(node) && cm.isNode(target)){
        target.parentNode.insertBefore(node, target);
    }
    return node;
};

cm.insertAfter = function(node, target){
    if(cm.isNode(node) && cm.isNode(target)){
        var before = target.nextSibling;
        if(before != null){
            cm.insertBefore(node, before);
        }else{
            target.parentNode.appendChild(node);
        }
    }
    return node;
};

cm.replaceNode = function(node, target){
    cm.insertBefore(node, target);
    cm.remove(target);
    return node;
};

cm.hideSpecialTags = function(){
    var els;
    if(document.querySelectorAll){
        els = document.querySelectorAll('iframe,object,embed');
        cm.forEach(els, function(item){
            item.style.visibility = 'hidden';
        });
    }else{
        els = document.getElementsByTagName('*');
        cm.forEach(els, function(item){
            if(item.tagName && /iframe|object|embed/.test(item.tagName)){
                item.style.visibility = 'hidden';
            }
        });
    }
};

cm.showSpecialTags = function(){
    var els;
    if(document.querySelectorAll){
        els = document.querySelectorAll('iframe,object,embed');
        cm.forEach(els, function(item){
            item.style.visibility = 'visible';
        });
    }else{
        els = document.getElementsByTagName('*');
        cm.forEach(els, function(item){
            if(item.tagName && /iframe|object|embed/.test(item.tagName)){
                item.style.visibility = 'visible';
            }
        });
    }
};

cm.strToHTML = function(str){
    if(!str){
        return null;
    }
    var node = cm.Node('div');
    node.insertAdjacentHTML('beforeend', str);
    return node.childNodes.length == 1? node.firstChild : node.childNodes;
};

cm.getNodes = function(container, marker){
    container = container || document.body;
    marker = marker || 'data-node';
    var nodes = {},
        processedNodes = [];

    var separation = function(node, obj, processedObj){
        var attrData = node.getAttribute(marker),
            separators = attrData? attrData.split('|') : [],
            altProcessedObj;

        cm.forEach(separators, function(separator){
            altProcessedObj = [];
            if(separator.indexOf('.') == -1){
                process(node, separator, obj, altProcessedObj);
            }else{
                pathway(node, separator, altProcessedObj);
            }
            cm.forEach(altProcessedObj, function(node){
                processedObj.push(node);
            });
        });
    };

    var pathway = function(node, attr, processedObj){
        var separators = attr? attr.split('.') : [],
            obj = nodes;
        cm.forEach(separators, function(separator, i){
            if(i == 0 && cm.isEmpty(separator)){
                obj = nodes;
            }else if((i + 1) == separators.length){
                process(node, separator, obj, processedObj);
            }else{
                if(!obj[separator]){
                    obj[separator] = {};
                }
                obj = obj[separator];
            }
        });
    };

    var process = function(node, attr, obj, processedObj){
        var separators = attr? attr.split(':') : [],
            arr;
        if(separators.length == 1){
            obj[separators[0]] = node;
        }else if(separators.length == 2 || separators.length == 3){
            if(separators[1] == '[]'){
                if(!obj[separators[0]]){
                    obj[separators[0]] = [];
                }
                arr = {};
                if(separators[2]){
                    arr[separators[2]] = node;
                }
                find(node, arr, processedObj);
                obj[separators[0]].push(arr);
            }else if(separators[1] == '{}'){
                if(!obj[separators[0]]){
                    obj[separators[0]] = {};
                }
                if(separators[2]){
                    obj[separators[0]][separators[2]] = node;
                }
                find(node, obj[separators[0]], processedObj);
            }
        }
        processedObj.push(node);
    };

    var find = function(container, obj, processedObj){
        var sourceNodes = container.querySelectorAll('[' + marker +']');
        cm.forEach(sourceNodes, function(node){
            if(!cm.inArray(processedObj, node)){
                separation(node, obj, processedObj);
            }
        });
    };

    separation(container, nodes, processedNodes);
    find(container, nodes, processedNodes);

    return nodes;
};

cm.processDataAttributes = function(node, name, vars){
    vars = typeof vars != 'undefined' ? vars : {};
    var marker = ['data-attributes', name].join('-'),
        nodes = node.querySelectorAll('[' + marker + ']'),
        value;

    var process = function(node){
        if(value = node.getAttribute(marker)){
            node.setAttribute(name, cm.strReplace(value, vars));
        }
    };

    process(node);
    cm.forEach(nodes, process);
};

/* ******* FORM ******* */

cm.setFDO = function(o, form){
    cm.forEach(o, function(item, name){
        var el = cm.getByAttr('name', name, form);

        for(var i = 0, ln = el.length; i < ln; i++){
            var type = (el[i].type || '').toLowerCase();
            switch(type){
                case 'radio':
                    if(o[name] == el[i].value){
                        el[i].checked = true;
                    }
                    break;

                case 'checkbox':
                    el[i].checked = !!+o[name];
                    break;

                default:
                    if(el[i].tagName.toLowerCase() == 'select'){
                        cm.setSelect(el[i], o[name]);
                    }else{
                        el[i].value = o[name];
                    }
                    break;
            }
        }
    });
    return form;
};

cm.getFDO = function(o, chbx){
    var data = {},
        elements = [
            o.getElementsByTagName('input'),
            o.getElementsByTagName('textarea'),
            o.getElementsByTagName('select')
        ];

    var setValue = function(name, value){
        if(/\[.*\]$/.test(name)){
            var indexes = [];
            var re = /\[(.*?)\]/g;
            var results = null;
            while(results = re.exec(name)){
                indexes.push(results[1]);
            }
            name = name.replace(/\[.*\]$/, '');
            data[name] = (function(i, obj){
                var index = indexes[i];
                var next = typeof(indexes[i + 1]) != 'undefined';
                if(index == ''){
                    if(obj && obj instanceof Array){
                        obj.push(next ? arguments.callee(i + 1, obj) : value);
                    }else{
                        obj = [next? arguments.callee(i+1, obj) : value];
                    }
                }else{
                    if(!obj || !(obj instanceof Object)){
                        obj = {};
                    }
                    obj[index] = next ? arguments.callee(i + 1, obj[index]) : value;
                }
                return obj;
            })(0, data[name]);
        }else{
            data[name] = value;
        }
        return 1;
    };

    for(var d = 0, lnd = elements.length; d < lnd; d++){
        for(var i = 0, ln = elements[d].length; i < ln; i++){
            if(!elements[d][i].name.length){
                continue;
            }
            switch(elements[d][i].tagName.toLowerCase()){
                case 'input':
                    switch(elements[d][i].type.toLowerCase()){
                        case 'radio':
                            if(elements[d][i].checked){
                                setValue(elements[d][i].name, elements[d][i].value || 1);
                            }
                            break;

                        case 'checkbox':
                            if(elements[d][i].checked){
                                setValue(elements[d][i].name, elements[d][i].value || 1);
                            }else if(typeof(chbx) != 'undefined' && chbx !== false){
                                setValue(elements[d][i].name, chbx);
                            }
                            break;

                        case 'password':
                        case 'hidden':
                        case 'text':
                        default:
                            setValue(elements[d][i].name, elements[d][i].value);
                            break;
                    }
                    break;

                case 'textarea':
                case 'select':
                    if(elements[d][i].multiple){
                        var opts = elements[d][i].getElementsByTagName('option');
                        for(var j in opts){
                            if(opts[j].selected){
                                setValue(elements[d][i].name, opts[j].value);
                            }
                        }
                    }else{
                        setValue(elements[d][i].name, elements[d][i].value);
                    }
                    break;
            }
        }
    }
    return data;
};

cm.clearForm = function(o){
    var formEls = cm.getByClass('formData', o);
    for(var i = 0, ln = formEls.length; i < ln; i++){
        if(formEls[i].tagName.toLowerCase() == 'input'){
            if(formEls[i].type.toLowerCase() == 'checkbox' || formEls[i].type.toLowerCase() == 'radio'){
                formEls[i].checked = false;
            }else{
                formEls[i].value = '';
            }
        }else if(formEls[i].tagName.toLowerCase() == 'textarea'){
            formEls[i].value = '';
        }else if(formEls[i].tagName.toLowerCase() == 'select'){
            var opts = formEls[i].getElementsByTagName('option');
            for(var d = 0, lnd = opts.length; d < lnd; d++){
                opts[d].selected = false;
            }
        }
    }
    return o;
};

cm.setSelect = function(o, value){
    if(!o || !cm.isNode(o)){
        return null;
    }
    var options = o.getElementsByTagName('option');
    cm.forEach(options, function(node){
        node.selected = (typeof value == 'object'? cm.inArray(node.value, value) : node.value == value);
    });
    return o;
};

cm.toggleRadio = function(name, value, node){
    node = node || document.body;
    var els = cm.getByName(name, node);
    for(var i = 0; i < els.length; i++){
        if(els[i].value == value){
            els[i].checked = true;
        }
    }
};

cm.getValue = function(name, node){
    node = node || document.body;
    var nodes = cm.getByName(name, node),
        value;
    for(var i = 0, l = nodes.length; i < l; i++){
        if(nodes[i].checked){
            value = nodes[i].value;
        }
    }
    return value;
};

/* ******* STRINGS ******* */

cm.isRegExp = function(obj){
    return obj.constructor == RegExp;
};
cm.toFixed = function(n, x){
    return parseFloat(n).toFixed(x);
};
cm.toNumber = function(str){
    return parseInt(str.replace(/\s+/, ''));
};

cm.is = function(str){
    if(typeof Com.UA == 'undefined'){
        cm.log('Error. UA.js is not exists or not loaded. Method "cm.is()" returns false.');
        return false;
    }
    return Com.UA.is(str);
};

cm.isVersion = function(){
    if(typeof Com.UA == 'undefined'){
        cm.log('Error. UA.js is not exists or not loaded. Method "cm.isVersion()" returns null.');
        return null;
    }
    return Com.UA.isVersion();
};

cm.isMobile = function(){
    if(typeof Com.UA == 'undefined'){
        cm.log('Error. UA.js is not exists or not loaded. Method "cm.isMobile()" returns false.');
        return false;
    }
    return Com.UA.isMobile();
};

cm.decode = (function(){
    var node = document.createElement('textarea');
    return function(str){
        if(str){
            node.innerHTML = str;
            return node.value;
        }else{
            return '';
        }

    };
})();

cm.strWrap = function(str, symbol){
    str = str.toString();
    return ['', str, ''].join(symbol);
};

cm.strReplace = function(str, vars){
    if(vars && cm.isObject(vars)){
        str = str.toString();
        cm.forEach(vars, function(item, key){
            str = str.replace(new RegExp(key, 'g'), item);
        });
    }
    return str;
};

cm.reduceText = function(str, length, points){
    if(str.length > length){
        return str.slice(0, length) + ((points) ? '...' : '');
    }else{
        return str;
    }
};

cm.removeDanger = function(str){
    return str.replace(/(\<|\>|&lt;|&gt;)/gim, '');
};

cm.cutHTML = function(str){
    return str.replace(/<[^>]*>/g, '');
};

cm.splitNumber = function(str){
    return str.toString().replace(/(\d)(?=(\d\d\d)+([^\d]|$))/g, '$1 ');
};

cm.rand = function(min, max){
    return Math.floor(Math.random() * (max - min + 1)) + min;
};

cm.isEven = function(num){
    return /^(.*)(0|2|4|6|8)$/.test(num);
};

cm.addLeadZero = function(x){
    x = parseInt(x, 10);
    return x < 10 ? '0' + x : x;
};

cm.getNumberDeclension = function(number, titles){
    var cases = [2, 0, 1, 1, 1, 2];
    return titles[
        (number % 100 > 4 && number % 100 < 20)
            ?
            2
            :
            cases[(number % 10 < 5) ? number % 10 : 5]
        ];
};

cm.toRadians = function(degrees) {
    return degrees * Math.PI / 180;
};

cm.toDegrees = function(radians) {
    return radians * 180 / Math.PI;
};

/* ******* DATE AND TIME ******* */

cm.getCurrentDate = function(format){
    format = format || cm._config['dateTimeFormat'];
    return cm.dateFormat(new Date(), format);
};

cm.dateFormat = function(date, format, langs){
    var str = format,
        formats = function(date){
            return {
                '%Y' : function(){
                    return date ? date.getFullYear() : '0000';
                },
                '%m' : function(){
                    return date ? cm.addLeadZero(date.getMonth() + 1) : '00';
                },
                '%n' : function(){
                    return date ? (date.getMonth() + 1) : '00';
                },
                '%F' : function(){
                    return date ? langs['months'][date.getMonth()] : '00';
                },
                '%d' : function(){
                    return date ? cm.addLeadZero(date.getDate()) : '00';
                },
                '%j' : function(){
                    return date ? date.getDate() : '00';
                },
                '%l' : function(){
                    return date ? langs['days'][date.getDay()] : '00';
                },
                '%a' : function(){
                    return date ? (date.getHours() >= 12? 'pm' : 'am') : '';
                },
                '%A' : function(){
                    return date ? (date.getHours() >= 12? 'PM' : 'AM') : '';
                },
                '%g' : function(){
                    return date ? (date.getHours() % 12 || 12) : '00';
                },
                '%G' : function(){
                    return date ? date.getHours() : '00';
                },
                '%h' : function(){
                    return date ? cm.addLeadZero(date.getHours() % 12 || 12) : '00';
                },
                '%H' : function(){
                    return date ? cm.addLeadZero(date.getHours()) : '00';
                },
                '%i' : function(){
                    return date ? cm.addLeadZero(date.getMinutes()) : '00';
                },
                '%s' : function(){
                    return date ? cm.addLeadZero(date.getSeconds()) : '00';
                }
            }
        };

    langs = cm.merge({
        'months' : [
            'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'
        ],
        'days' : [
            'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
        ]
    }, langs);

    cm.forEach(formats(date), function(item, key){
        str = str.replace(key, item);
    });
    return str;
};

cm.parseDate = function(str, format){
    if(!str){
        return null;
    }

    var date = new Date(),
        convertFormats = {
            '%Y' : 'YYYY',
            '%m' : 'mm',
            '%d' : 'dd',
            '%H' : 'HH',
            '%i' : 'ii',
            '%s' : 'ss'
        },
        formats = {
            'YYYY' : function(value){
                date.setFullYear(value);
            },
            'mm' : function(value){
                date.setMonth(value - 1);
            },
            'dd' : function(value){
                date.setDate(value);
            },
            'HH' : function(value){
                date.setHours(value);
            },
            'ii' : function(value){
                date.setMinutes(value);
            },
            'ss' : function(value){
                date.setSeconds(value);
            }
        },
        fromIndex = 0;

    format = format || cm._config['dateTimeFormat'];

    cm.forEach(convertFormats, function(item, key){
        format = format.replace(key, item);
    });

    cm.forEach(formats, function(item, key){
        fromIndex = format.indexOf(key);
        while(fromIndex != -1){
            item(str.substr(fromIndex, key.length));
            fromIndex = format.indexOf(key, fromIndex + 1);
        }
    });

    return date;
};

/* ******* STYLES ******* */

cm.addClass = function(node, str, useHack){
    if(!node || cm.isEmpty(str)){
        return null;
    }
    if(useHack){
        useHack = node.clientHeight;
    }
    if(node.classList){
        cm.forEach(str.split(/\s+/), function(item){
            if(!cm.isEmpty(item)){
                node.classList.add(item);
            }
        });
    }else{
        var add = cm.arrayToObject(typeof(str) == 'object' ? str : str.split(/\s+/)),
            current = cm.arrayToObject(node && node.className ? node.className.split(/\s+/) : []);
        current = cm.merge(current, add);
        node.className = cm.objectToArray(current).join(' ');
    }
    return node;
};

cm.removeClass = function(node, str, useHack){
    if(!node || cm.isEmpty(str)){
        return null;
    }
    if(useHack){
        useHack = node.clientHeight;
    }
    if(node.classList){
        cm.forEach(str.split(/\s+/), function(item){
            if(!cm.isEmpty(item)){
                node.classList.remove(item);
            }
        });
    }else{
        var remove = cm.arrayToObject(typeof(str) == 'object' ? str : str.split(/\s+/)),
            current = node && node.className ? node.className.split(/\s+/) : [],
            ready = [];
        current.forEach(function(item){
            if(!remove[item]){
                ready.push(item);
            }
        });
        node.className = ready.join(' ');
    }
    return node;
};

cm.replaceClass = function(node, oldClass, newClass, useHack){
    if(!node){
        return null;
    }
    return cm.addClass(cm.removeClass(node, oldClass, useHack), newClass, useHack);
};

cm.hasClass = cm.isClass = function(node, cssClass){
    var hasClass, classes;
    if(!node){
        return false;
    }
    if(node.classList){
        return node.classList.contains(cssClass);
    }else{
        classes = node.className ? node.className.split(/\s+/) : [];
        hasClass = false;
        cm.forEach(classes, function(item){
            if(item == cssClass){
                hasClass = true;
            }
        });
        return hasClass;
    }
};

cm.getPageSize = function(key){
    var d = document,
        de = d.documentElement,
        o = {
            'height' : Math.max(
                Math.max(d.body.scrollHeight, de.scrollHeight),
                Math.max(d.body.offsetHeight, de.offsetHeight),
                Math.max(d.body.clientHeight, de.clientHeight)
            ),
            'width' : Math.max(
                Math.max(d.body.scrollWidth, de.scrollWidth),
                Math.max(d.body.offsetWidth, de.offsetWidth),
                Math.max(d.body.clientWidth, de.clientWidth)
            ),
            'winHeight' : de.clientHeight,
            'winWidth' : de.clientWidth
        };
    return o[key] || o;
};

cm.getScrollBarSize = function(){
    var node = cm.Node('div'),
        styles = node.style,
        size = 0;
    styles.width = '100px';
    styles.height = '100px';
    styles.overflow = 'scroll';
    styles.position = 'position';
    styles.top = '-9000px';
    cm.insertFirst(node, document.body);
    size = Math.max(node.offsetWidth - node.clientWidth, 0);
    cm.remove(node);
    return size;
};

cm.setOpacity = function(node, value){
    if(node){
        if(cm.is('ie') && cm.isVersion() < 9){
            node.style.filter = "alpha(opacity=" + (Math.floor(value * 100)) + ")";
        }else{
            node.style.opacity = value;
        }
    }
    return node;
};

cm.getX = function(o){
    var x = 0, p = o;
    try{
        while(p){
            x += p.offsetLeft;
            if(p != o){
                x += cm.getStyle(p, 'borderLeftWidth', true) || 0;
            }
            p = p.offsetParent;
        }
    }catch(e){
        return x;
    }
    return x;
};

cm.getY = function(o){
    var y = 0, p = o;
    try{
        while(p){
            y += p.offsetTop;
            if(p != o){
                y += cm.getStyle(p, 'borderTopWidth', true) || 0;
            }
            p = p.offsetParent;
        }
    }catch(e){
        return y;
    }
    return y;
};

cm.getRealX = function(node){
    if(cm.isNode(node)){
        return node.getBoundingClientRect()['left'];
    }
    return 0;
};

cm.getRealY = function(node){
    if(cm.isNode(node)){
        return node.getBoundingClientRect()['top'];
    }
    return 0;
};

cm.getRect = function(node){
    var docEl = document.documentElement,
        o,
        rect;
    if(cm.isWindow(node)){
        docEl = document.documentElement;
        return {
            'top' : 0,
            'right' : docEl.clientWidth,
            'bottom' : docEl.clientHeight,
            'left' : 0,
            'width' : docEl.clientWidth,
            'height' : docEl.clientHeight
        };
    }
    if(cm.isNode(node)){
        o = node.getBoundingClientRect();
        rect = {
            'top' : Math.round(o['top']),
            'right' : Math.round(o['right']),
            'bottom' : Math.round(o['bottom']),
            'left' : Math.round(o['left'])
        };
        rect['width'] = typeof o['width'] != 'undefined' ? Math.round(o['width']) : o['right'] - o['left'];
        rect['height'] = typeof o['height'] != 'undefined' ? Math.round(o['height']) : o['bottom'] - o['top'];
        return rect;
    }
    return {
        'top' : 0,
        'right' : 0,
        'bottom' : 0,
        'left' : 0,
        'width' : 0,
        'height' : 0
    };
};

cm.getFullRect = function(node, styleObject){
    if(!node || !cm.isNode(node)){
        return null;
    }
    var dimensions = {};
    styleObject = typeof styleObject == 'undefined' ? cm.getStyleObject(node) : styleObject;
    // Get size and position
    dimensions['width'] = node.offsetWidth;
    dimensions['height'] = node.offsetHeight;
    dimensions['x1'] = cm.getRealX(node);
    dimensions['y1'] = cm.getRealY(node);
    dimensions['x2'] = dimensions['x1'] + dimensions['width'];
    dimensions['y2'] = dimensions['y1'] + dimensions['height'];
    // Calculate Padding and Inner Dimensions
    dimensions['padding'] = {
        'top' :     cm.getCSSStyle(styleObject, 'paddingTop', true),
        'right' :   cm.getCSSStyle(styleObject, 'paddingRight', true),
        'bottom' :  cm.getCSSStyle(styleObject, 'paddingBottom', true),
        'left' :    cm.getCSSStyle(styleObject, 'paddingLeft', true)
    };
    dimensions['innerWidth'] = dimensions['width'] - dimensions['padding']['left'] - dimensions['padding']['right'];
    dimensions['innerHeight'] = dimensions['height'] - dimensions['padding']['top'] - dimensions['padding']['bottom'];
    dimensions['innerX1'] = dimensions['x1'] + dimensions['padding']['left'];
    dimensions['innerY1'] = dimensions['y1'] + dimensions['padding']['top'];
    dimensions['innerX2'] = dimensions['innerX1'] + dimensions['innerWidth'];
    dimensions['innerY2'] = dimensions['innerY1'] + dimensions['innerHeight'];
    // Calculate Margin and Absolute Dimensions
    dimensions['margin'] = {
        'top' :     cm.getCSSStyle(styleObject, 'marginTop', true),
        'right' :   cm.getCSSStyle(styleObject, 'marginRight', true),
        'bottom' :  cm.getCSSStyle(styleObject, 'marginBottom', true),
        'left' :    cm.getCSSStyle(styleObject, 'marginLeft', true)
    };
    dimensions['absoluteWidth'] = dimensions['width'] + dimensions['margin']['left'] + dimensions['margin']['right'];
    dimensions['absoluteHeight'] = dimensions['height'] + dimensions['margin']['top'] + dimensions['margin']['bottom'];
    dimensions['absoluteX1'] = dimensions['x1'] - dimensions['margin']['left'];
    dimensions['absoluteY1'] = dimensions['y1'] - dimensions['margin']['top'];
    dimensions['absoluteX2'] = dimensions['x2'] + dimensions['margin']['right'];
    dimensions['absoluteY2'] = dimensions['y2'] + dimensions['margin']['bottom'];
    return dimensions;
};

cm.getRealWidth = function(node, applyWidth){
    var nodeWidth = 0,
        width = 0;
    nodeWidth = node.offsetWidth;
    node.style.width = 'auto';
    width = node.offsetWidth;
    node.style.width = typeof applyWidth == 'undefined' ? [nodeWidth, 'px'].join('') : applyWidth;
    return width;
};

cm.getRealHeight = function(node, type, applyType){
    var types = ['self', 'current', 'offset', 'offsetRelative'],
        height = {},
        styles,
        styleObject;
    // Check parameters
    if(!node || !cm.isNode(node)){
        return 0;
    }
    styleObject = cm.getStyleObject(node);
    type = typeof type == 'undefined' || !cm.inArray(types, type)? 'offset' : type;
    applyType = typeof applyType == 'undefined' || !cm.inArray(types, applyType) ? false : applyType;
    cm.forEach(types, function(type){
        height[type] = 0;
    });
    // Get inline styles
    styles = {
        'display': node.style.display,
        'height': node.style.height,
        'position' : node.style.position
    };
    node.style.display = 'block';
    height['current'] = node.offsetHeight;
    node.style.height = 'auto';

    height['offset'] = node.offsetHeight;
    height['self'] = height['offset']
                     - cm.getStyle(styleObject, 'borderTopWidth', true)
                     - cm.getStyle(styleObject, 'borderBottomWidth', true)
                     - cm.getStyle(styleObject, 'paddingTop', true)
                     - cm.getStyle(styleObject, 'paddingBottom', true);

    node.style.position = 'relative';
    height['offsetRelative'] = node.offsetHeight;
    // Set default styles
    node.style.display = styles['display'];
    node.style.height = styles['height'];
    node.style.position = styles['position'];
    if(applyType){
        node.style.height = [height[applyType], 'px'].join('');
    }
    return height[type];
};

cm.getIndentX = function(node){
    if(!node){
        return null;
    }
    return cm.getStyle(node, 'paddingLeft', true)
         + cm.getStyle(node, 'paddingRight', true)
         + cm.getStyle(node, 'borderLeftWidth', true)
         + cm.getStyle(node, 'borderRightWidth', true);
};

cm.getIndentY = function(node){
    if(!node){
        return null;
    }
    return cm.getStyle(node, 'paddingTop', true)
         + cm.getStyle(node, 'paddingBottom', true)
         + cm.getStyle(node, 'borderTopWidth', true)
         + cm.getStyle(node, 'borderBottomWidth', true);
};

cm.addStyles = function(node, str){
    var arr = str.replace(/\s/g, '').split(';'),
        style;

    arr.forEach(function(item){
        if(item.length > 0){
            style = item.split(':');
            // Add style to element
            style[2] = cm.styleStrToKey(style[0]);
            if(style[0] == 'float'){
                node.style[style[2][0]] = style[1];
                node.style[style[2][1]] = style[1];
            }else{
                node.style[style[2]] = style[1];
            }
        }
    });
    return node;
};

cm.getStyleObject = (function(){
    if(window.getComputedStyle){
        return function(node){
            return document.defaultView.getComputedStyle(node, null);
        };
    }else{
        return function(node){
            return node.currentStyle;
        };
    }
})();

cm.getCSSStyle = cm.getStyle = function(node, name, number){
    var obj, raw, data;
    if(cm.isNode(node)){
        obj = cm.getStyleObject(node);
    }else{
        obj = node;
    }
    if(!obj){
        return 0;
    }
    raw = obj[name];
    // Parse
    if(number){
        data = cm.styleToNumber(raw);
    }else{
        data = raw;
    }
    return data;
};

cm.getCurrentStyle = function(obj, name, dimension){
    switch(name){
        case 'width':
        case 'height':
        case 'top':
        case 'left':
            var Name = name.charAt(0).toUpperCase() + name.substr(1, name.length - 1);
            if(dimension == '%' && !obj.style[name].match(/%/)){
                var el = (/body/i.test(obj.parentNode.tagName) || /top|left/i.test(Name)) ? 'client' : 'offset';
                var pv = (/width|left/i.test(Name)) ? obj.parentNode[el + 'Width'] : obj.parentNode[el + 'Height'];
                return 100 * ( obj['offset' + Name] / pv );
            }else if(dimension == '%' && /%/.test(obj.style[name])){
                var display = obj.style.display;
                obj.style.display = 'none';
                var style = cm.getCSSStyle(obj, name, true) || 0;
                obj.style.display = display;
                return style;
            }else if(dimension == 'px' && /px/.test(obj.style[name])){
                return cm.getCSSStyle(obj, name, true) || 0;
            }
            return obj['offset' + Name];
            break;
        case 'opacity':
            if(cm.is('ie') && cm.isVersion() < 9){
                var reg = /alpha\(opacity=(.*)\)/;
                var res = reg.exec(obj.style.filter || cm.getCSSStyle(obj, 'filter'));
                return (res) ? res[1] / 100 : 1;
            }else{
                var val = parseFloat(obj.style.opacity || cm.getCSSStyle(obj, 'opacity'));
                return (!isNaN(val)) ? val : 1;
            }
            break;
        case 'color':
        case 'backgroundColor':
        case 'borderColor':
            var val = cm.getCSSStyle(obj, name);
            if(val.match(/rgb/i)){
                return val = val.match(/\d+/g), [parseInt(val[0]), parseInt(val[1]), parseInt(val[2])];
            }
            return cm.hex2rgb(val.match(/[\w\d]+/)[0]);
            break;
        case 'docScrollTop':
            return cm.getBodyScrollTop();
            break;
        case 'scrollLeft':
        case 'scrollTop':
            return obj[name];
            break;
        case 'x1':
        case 'x2':
        case 'y1':
        case 'y2':
            return parseInt(obj.getAttribute(name));
            break;
        default:
            return cm.getCSSStyle(obj, name, true) || 0;
    }
};

cm.getStyleDimension = function(value){
    var pure = value.toString().match(/\d+(\D*)/);
    return pure ? pure[1] : '';
};

cm.styleToNumber = function(data){
    data = parseFloat(data.toString().replace(/(pt|px|%)/g, ''));
    data = isNaN(data)? 0 : data;
    return data;
};

cm.hex2rgb = function(hex){
    return(function(v){
        return [v >> 16 & 255, v >> 8 & 255, v & 255];
    })(parseInt(hex, 16));
};

cm.rgb2hex = function(r, g, b){
    var rgb = [r, g, b];
    for(var i in rgb){
        rgb[i] = Number(rgb[i]).toString(16);
        if(rgb[i] == '0'){
            rgb[i] = '00';
        }else if(rgb[i].length == 1){
            rgb[i] = '0' + rgb[i];
        }
    }
    return '#' + rgb.join('');
};

cm.styleStrToKey = function(line){
    line = line.replace(/\s/g, '');
    if(line == 'float'){
        line = ['cssFloat', 'styleFloat'];
    }else if(line.match('-')){
        var st = line.split('-');
        line = st[0] + st[1].replace(st[1].charAt(0), st[1].charAt(0).toUpperCase());
    }
    return line;
};

cm.getScrollTop = function(node){
    if(cm.isWindow(node)){
        return cm.getBodyScrollTop();
    }
    if(cm.isNode(node)){
        if(/body|html/gi.test(node.tagName)){
            return cm.getBodyScrollTop();
        }
        return node.scrollTop;
    }
    return 0;
};

cm.getScrollLeft = function(node){
    if(cm.isWindow(node)){
        return cm.getBodyScrollLeft();
    }
    if(cm.isNode(node)){
        if(/body|html/gi.test(node.tagName)){
            return cm.getBodyScrollLeft();
        }
        return node.scrollLeft;
    }
    return 0;
};

cm.setScrollTop = function(node, num){
    if(cm.isWindow(node)){
        cm.setBodyScrollTop(num);
    }else if(cm.isNode(node)){
        if(/body|html/gi.test(node.tagName)){
            cm.setBodyScrollTop(num);
        }else{
            node.scrollTop = num;
        }
    }
    return node;
};

cm.setScrollLeft = function(node, num){
    if(cm.isWindow(node)){
        cm.setBodyScrollLeft(num);
    }else if(cm.isNode(node)){
        if(/body|html/gi.test(node.tagName)){
            cm.setBodyScrollLeft(num);
        }else{
            node.scrollLeft = num;
        }
    }
    return node;
};

cm.getScrollHeight = function(node){
    if(cm.isWindow(node)){
        return cm.getBodyScrollHeight();
    }
    if(cm.isNode(node)){
        if(/body|html/gi.test(node.tagName)){
            return cm.getBodyScrollHeight();
        }
        return node.scrollHeight;
    }
    return 0;
};

cm.setBodyScrollTop = function(num){
    document.documentElement.scrollTop = num;
    document.body.scrollTop = num;
};

cm.setBodyScrollLeft = function(num){
    document.documentElement.scrollLeft = num;
    document.body.scrollLeft = num;
};

cm.getBodyScrollTop = function(){
    return Math.max(
        document.documentElement.scrollTop,
        document.body.scrollTop,
        0
    );
};

cm.getBodyScrollLeft = function(){
    return Math.max(
        document.documentElement.scrollLeft,
        document.body.scrollLeft,
        0
    );
};

cm.getBodyScrollHeight = function(){
    return Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
        0
    );
};

cm.getSupportedStyle = function(style){
    var upper = cm.styleStrToKey(style).replace(style.charAt(0), style.charAt(0).toUpperCase()),
        styles = [
            cm.styleStrToKey(style),
            ['Webkit', upper].join(''),
            ['Moz', upper].join(''),
            ['O', upper].join(''),
            ['ms', upper].join('')
        ];
    style = false;
    cm.forEach(styles, function(item){
        if(typeof document.createElement('div').style[item] != 'undefined' && !style){
            style = item;
        }
    });
    return style;
};

cm.getTransitionDurationFromRule = function(rule){
    var openDurationRule = cm.getCSSRule(rule)[0],
        openDurationProperty;
    if(openDurationRule){
        if(openDurationProperty = openDurationRule.style[cm.getSupportedStyle('transitionDuration')]){
            if(openDurationProperty.match('ms')){
                return parseFloat(openDurationProperty);
            }else if(openDurationProperty.match('s')){
                return (openDurationProperty) / 1000;
            }else{
                return parseFloat(openDurationProperty);
            }
        }
    }
    return 0;
};

cm.createStyleSheet = function(){
    var style = document.createElement('style');
    // Fix for WebKit
    style.appendChild(document.createTextNode(''));
    document.head.appendChild(style);
    return style.sheet;
};

cm.getCSSRule = function(ruleName){
    var matchedRules = [],
        cssRules;
    if(document.styleSheets){
        cm.forEach(document.styleSheets, function(styleSheet){
            if(styleSheet.cssRules){
                cssRules = styleSheet.cssRules;
            }else{
                cssRules = styleSheet.rules;
            }
            cm.forEach(cssRules, function(cssRule){
                if(cssRule.selectorText == ruleName){
                    matchedRules.push(cssRule);
                }
            });
        });
    }
    return matchedRules;
};

cm.addCSSRule = function(sheet, selector, rules, index){
    if(document.styleSheets){
        sheet = typeof sheet == 'undefined' || !sheet ? document.styleSheets[0] : sheet;
        rules = typeof rules == 'undefined' || !rules ? '' : rules;
        index = typeof index == 'undefined' || !index ? -1 : index;
        if('insertRule' in sheet){
            sheet.insertRule(selector + '{' + rules + '}', index);
        }else if('addRule' in sheet){
            sheet.addRule(selector, rules, index);
        }
    }
};

cm.removeCSSRule = function(ruleName){
    var cssRules;
    if(document.styleSheets){
        cm.forEach(document.styleSheets, function(styleSheet){
            if(styleSheet.cssRules){
                cssRules = styleSheet.cssRules;
            }else{
                cssRules = styleSheet.rules;
            }
            cm.forEachReverse(cssRules, function(cssRule, i){
                if(cssRule.selectorText == ruleName){
                    if(styleSheet.cssRules){
                        styleSheet.deleteRule(i);
                    }else{
                        styleSheet.removeRule(i);
                    }
                }
            });
        });
    }
};

cm.setCSSTranslate = (function(){
    var transform = cm.getSupportedStyle('transform');
    if(transform){
        return function(node, x, y, z, additional){
            x = typeof x != 'undefined' && x != 'auto' ? x : 0;
            y = typeof y != 'undefined' && y != 'auto' ? y : 0;
            z = typeof z != 'undefined' && z != 'auto' ? z : 0;
            additional = typeof additional != 'undefined' ? additional : '';
            node.style[transform] = ['translate3d(', x, ',', y, ',', z,')', additional].join(' ');
            return node;
        };
    }else{
        return function(node, x, y, z, additional){
            x = typeof x != 'undefined' ? x : 0;
            y = typeof y != 'undefined' ? y : 0;
            node.style.left = x;
            node.style.top = y;
            return node;
        };
    }
})();

cm.inRange = function(a1, b1, a2, b2){
    return a1 >= a2 && a1 <= b2 || b1 >= a2 && b1 <= b2 || a2 >= a1 && a2 <= b1
};

/* ******* ANIMATION ******* */

var animFrame = (function(){
    return  window.requestAnimationFrame ||
            window.webkitRequestAnimationFrame ||
            window.mozRequestAnimationFrame ||
            window.oRequestAnimationFrame ||
            window.msRequestAnimationFrame ||
            function(callback, element){
                return window.setTimeout(callback, 1000 / 60);
            };
})();

cm.Animation = function(o){
    var that = this,
        obj = o,
        processes = [],
        animationMethod = {
            'random' : function(progress){
                return (function(min, max){
                    return Math.random() * (max - min) + min;
                })(progress, 1);
            },
            'simple' : function(progress){
                return progress;
            },
            'acceleration' : function(progress){
                return Math.pow(progress, 3);
            },
            'inhibition' : function(progress){
                return 1 - animationMethod.acceleration(1 - progress);
            },
            'smooth' : function(progress){
                return (progress < 0.5) ? animationMethod.acceleration(2 * progress) / 2 : 1 - animationMethod.acceleration(2 * (1 - progress)) / 2;
            }
        };

    that.getTarget = function(){
        return obj;
    };

    that.go = function(){
        var args = cm.merge({
                'style' : '',
                'duration' : '',
                'anim' : 'simple',
                'onStop' : function(){}
            }, arguments[0]),
            pId = 'animation_process_' + Math.random(),
            delta = animationMethod[args.anim] || animationMethod['simple'],
            properties = [];

        for(var name in args.style){
            var value = args.style[name].toString();
            var dimension = cm.getStyleDimension(value);
            properties.push({
                'name' : name,
                'new' : prepareEndPosition(name, value),
                'dimension' : dimension,
                'old' : cm.getCurrentStyle(obj, name, dimension)
            });
        }

        var start = Date.now();
        for(var i in processes){
            processes[i] = false;
        }
        processes[pId] = true;
        // Run process
        (function process(){
            var processId = pId;
            if(!processes[processId]){
                delete processes[processId];
                return false;
            }
            var now = Date.now() - start;
            var progress = now / args.duration;
            if(setProperties(progress, delta, properties, args['duration'])){
                delete processes[processId];
                args.onStop && args.onStop();
            }else{
                animFrame(process);
            }
        })();
    };

    that.stop = function(){
        for(var i in processes){
            processes[i] = false;
        }
    };

    var setProperties = function(progress, delta, properties, duration){
        if(progress <= 1){
            properties.forEach(function(item){
                var val = item['old'] + (item['new'] - item['old']) * delta(progress);

                if(item['name'] == 'opacity'){
                    cm.setOpacity(obj, val);
                }else if(/color/i.test(item['name'])){
                    var r = parseInt((item['new'][0] - item['old'][0]) * delta(progress) + item['old'][0]);
                    var g = parseInt((item['new'][1] - item['old'][1]) * delta(progress) + item['old'][1]);
                    var b = parseInt((item['new'][2] - item['old'][2]) * delta(progress) + item['old'][2]);
                    obj.style[properties[i]['name']] = cm.rgb2hex(r, g, b);
                }else if(/scrollLeft|scrollTop/.test(item['name'])){
                    obj[item['name']] = val;
                }else if(/x1|x2|y1|y2/.test(item['name'])){
                    obj.setAttribute(item['name'], Math.round(val));
                }else if(item['name'] == 'docScrollTop'){
                    cm.setBodyScrollTop(val);
                }else{
                    obj.style[item['name']] = Math.round(val) + item['dimension'];
                }
            });
            return false;
        }
        properties.forEach(function(item){
            if(item['name'] == 'opacity'){
                cm.setOpacity(obj, item['new']);
            }else if(/color/i.test(item['name'])){
                obj.style[item['name']] = cm.rgb2hex(item['new'][0], item['new'][1], item['new'][2]);
            }else if(/scrollLeft|scrollTop/.test(item['name'])){
                obj[item['name']] = item['new'];
            }else if(/x1|x2|y1|y2/.test(item['name'])){
                obj.setAttribute(item['name'], item['new']);
            }else if(item['name'] == 'docScrollTop'){
                cm.setBodyScrollTop(item['new']);
            }else{
                obj.style[item['name']] = item['new'] + item['dimension'];
            }
        });
        return true;
    };

    var prepareEndPosition = function(name, value){
        if(name.match(/color/i)){
            if(/rgb/i.test(value)){
                var rgb = value.match(/\d+/g);
                return [parseInt(rgb[0]), parseInt(rgb[1]), parseInt(rgb[2])];
            }else{
                return cm.hex2rgb(value.match(/[\w\d]+/)[0]);
            }
        }
        return value.replace(/[^\-0-9\.]/g, '');
    };
};

cm.transition = function(node, params){
    var rule = cm.getSupportedStyle('transition'),
        transitions = [],
        dimension;

    var init = function(){
        // Merge params
        params = cm.merge({
            'properties' : {},
            'duration' : 0,
            'easing' : 'ease-in-out',
            'delayIn' : 30,
            'delayOut' : 30,
            'clear' : false,
            'onStop' : function(){}
        }, params);
        // Prepare styles
        cm.forEach(params['properties'], function(value, key){
            key = cm.styleStrToKey(key);
            transitions.push([key, params['duration'] + 'ms', params['easing']].join(' '));
        });
        transitions = transitions.join(', ');
        start();
    };

    var start = function(){
        // Prepare
        cm.forEach(params['properties'], function(value, key){
            key = cm.styleStrToKey(key);
            dimension = cm.getStyleDimension(value);
            node.style[key] = cm.getCurrentStyle(node, key, dimension) + dimension;
        });
        // Set
        setTimeout(function(){
            node.style[rule] = transitions;
            // Set new styles
            cm.forEach(params['properties'], function(value, key){
                key = cm.styleStrToKey(key);
                node.style[key] = value;
            });
        }, params['delayIn']);
        // End
        setTimeout(function(){
            node.style[rule]  = '';
            if(params['clear']){
                cm.forEach(params['properties'], function(value, key){
                    key = cm.styleStrToKey(key);
                    node.style[key] = '';
                });
            }
            params['onStop'](node);
        }, params['duration'] + params['delayIn'] + params['delayOut']);
    };

    init();
};

/* ******* COOKIE & LOCAL STORAGE ******* */

cm.storageSet = function(key, value, cookie){
    cookie = cookie !== false;
    if(cm.isLocalStorage){
        try{
            window.localStorage.setItem(key, value);
        }catch(e){
        }
    }else if(cookie){
        cm.cookieSet(key, value);
    }
};

cm.storageGet = function(key, cookie){
    cookie = cookie !== false;
    if(cm.isLocalStorage){
        return window.localStorage.getItem(key);
    }else if(cookie){
        return cm.cookieGet(key);
    }
    return null;
};

cm.storageRemove = function(key, cookie){
    cookie = cookie !== false;
    if(cm.isLocalStorage){
        localStorage.removeItem(key);
    }else if(cookie){
        cm.cookieRemove(key);
    }
};

cm.cookieSet = function(name, value, expires){
    document.cookie = encodeURI(name) + "=" + encodeURI(value) + ';' + (expires ? cm.cookieDate(expires) : '');
};

cm.cookieGet = function(name){
    var cookie = " " + document.cookie;
    var search = " " + encodeURI(name) + "=";
    var setStr = null;
    var offset = 0;
    var end = 0;
    if(cookie.length > 0){
        offset = cookie.indexOf(search);
        if(offset != -1){
            offset += search.length;
            end = cookie.indexOf(";", offset);
            if(end == -1){
                end = cookie.length;
            }
            setStr = encodeURI(cookie.substring(offset, end));
        }
    }
    return setStr;
};

cm.cookieRemove = function(name){
    var date = new Date();
    date.setDate(date.getDate() - 1);
    document.cookie = encodeURI(name) + '=;expires=' + date;
};

cm.cookieDate = function(num){
    return 'expires=' + (new Date(new Date().getTime() + 1000 * 60 * 60 * 24 * num)).toUTCString() + ';';
};

/* ******* AJAX ******* */

cm.ajax = function(o){
    var config = cm.merge({
            'debug' : true,
            'type' : 'xml',                                         // text | xml | json | jsonp
            'method' : 'post',                                      // post | get
            'params' : '',
            'url' : '',
            'httpRequestObject' : cm.createXmlHttpRequestObject(),
            'headers' : {
                'Content-Type' : 'application/x-www-form-urlencoded',
                'X-Requested-With' : 'XMLHttpRequest'
            },
            'withCredentials' : false,
            'onStart' : function(){},
            'onEnd' : function(){},
            'onSuccess' : function(){},
            'onError' : function(){},
            'onAbort' : function(){},
            'handler' : false
        }, o),
        responseType,
        response,
        callbackName,
        callbackSuccessName,
        callbackErrorName,
        scriptNode,
        returnObject;

    var init = function(){
        validate();
        if(config['type'] == 'jsonp'){
            returnObject = {
                'abort' : abortJSONP
            };
            sendJSONP();
        }else{
            returnObject = config['httpRequestObject'];
            send();
        }
    };

    var validate = function(){
        config['type'] = config['type'].toLocaleLowerCase();
        responseType =  /text|json/.test(config['type']) ? 'responseText' : 'responseXML';
        config['method'] = config['method'].toLocaleLowerCase();
        // Convert params object to URI string
        if(cm.isObject(config['params'])){
            config['params'] = cm.obj2URI(config['params']);
        }
        // Build request link
        if(config['method'] != 'post'){
            if(!cm.isEmpty(config['params'])){
                config['url'] = [config['url'], config['params']].join('?');
            }
        }
    };

    var send = function(){
        config['httpRequestObject'].open(config['method'], config['url'], true);
        // Set Headers
        if('withCredentials' in config['httpRequestObject']){
            config['httpRequestObject'].withCredentials = config['withCredentials'];
        }
        cm.forEach(config['headers'], function(value, name){
            config['httpRequestObject'].setRequestHeader(name, value);
        });
        // Add response events
        cm.addEvent(config['httpRequestObject'], 'load', loadHandler);
        cm.addEvent(config['httpRequestObject'], 'error', errorHandler);
        cm.addEvent(config['httpRequestObject'], 'abort', abortHandler);
        // Send
        config['onStart']();
        if(config['method'] == 'post'){
            config['httpRequestObject'].send(config['params']);
        }else{
            config['httpRequestObject'].send(null);
        }
    };

    var loadHandler = function(e){
        if(config['httpRequestObject'].readyState == 4){
            response = config['httpRequestObject'][responseType];
            if(config['type'] == 'json'){
                response = cm.parseJSON(response);
            }
            if(config['httpRequestObject'].status == 200){
                config['onSuccess'](response, e);
            }else{
                config['onError'](e);
            }
            deprecatedHandler(response);
            config['onEnd'](e);
        }
    };

    var successHandler = function(){
        config['onSuccess'].apply(config['onSuccess'], arguments);
        deprecatedHandler.apply(deprecatedHandler, arguments);
        config['onEnd'].apply(config['onEnd'], arguments);
    };

    var errorHandler = function(){
        config['onError'].apply(config['onError'], arguments);
        deprecatedHandler.apply(deprecatedHandler, arguments);
        config['onEnd'].apply(config['onEnd'], arguments);
    };

    var abortHandler = function(){
        config['onAbort'].apply(config['onAbort'], arguments);
        deprecatedHandler.apply(deprecatedHandler, arguments);
        config['onEnd'].apply(config['onEnd'], arguments);
    };

    var deprecatedHandler = function(){
        if(typeof config['handler'] == 'function'){
            cm.errorLog({'type' : 'attention', 'name' : 'cm.ajax', 'message' : 'Parameter "handler" is deprecated. Use "onSuccess", "onError" or "onAbort" callbacks instead.'});
            config['handler'].apply(config['handler'], arguments);
        }
    };

    var sendJSONP = function(){
        // Generate unique callback name
        callbackName = ['cmAjaxJSONP', Date.now()].join('__');
        callbackSuccessName = [callbackName, 'Success'].join('__');
        callbackErrorName = [callbackName, 'Error'].join('__');
        // Generate events
        window[callbackSuccessName] = function(){
            successHandler.apply(successHandler, arguments);
            removeJSONP();
        };
        window[callbackErrorName] = function(){
            errorHandler.apply(errorHandler, arguments);
            removeJSONP();
        };
        // Prepare url and attach events
        scriptNode = cm.Node('script', {'type' : 'application/javascript'});
        if(/%callback%|%25callback%25/.test(config['url'])){
            config['url'] = cm.strReplace(config['url'], {'%callback%' : callbackSuccessName, '%25callback%25' : callbackSuccessName});
        }else{
            cm.addEvent(scriptNode, 'load', window[callbackSuccessName]);
        }
        cm.addEvent(scriptNode, 'error', window[callbackErrorName]);
        // Embed
        config['onStart']();
        scriptNode.setAttribute('src', config['url']);
        document.getElementsByTagName('head')[0].appendChild(scriptNode);
    };

    var removeJSONP = function(){
        cm.removeEvent(scriptNode, 'load', window[callbackSuccessName]);
        cm.removeEvent(scriptNode, 'error', window[callbackErrorName]);
        cm.remove(scriptNode);
        delete window[callbackSuccessName];
        delete window[callbackErrorName];
    };

    var abortJSONP = function(){
        window[callbackSuccessName] = function(){
            abortHandler();
            removeJSONP();
        };
    };

    init();
    return returnObject;
};

cm.parseJSON = function(str){
    var o;
    if(str){
        try{
            o = JSON.parse(str);
        }catch(e){
            cm.errorLog({
                'type' : 'common',
                'name' : 'cm.parseJSON',
                'message' : ['Error while parsing JSON. Input string:', str].join(' ')
            });
        }
    }
    return o;
};

cm.obj2URI = function(obj, prefix){
    var str = [];
    cm.forEach(obj, function(item, key){
        var k = prefix ? prefix + "[" + key + "]" : key,
            v = item;
        str.push(typeof v == "object" ? cm.obj2URI(v, k) : k + "=" + encodeURIComponent(v));
    });
    return str.join("&");
};

cm.xml2arr = function(o){
    o = o.nodeType == 9 ? cm.firstEl(o) : o;
    if(o.nodeType == 3 || o.nodeType == 4){
        //Need to be change
        var n = cm.nextEl(o);
        if(!n){
            return o.nodeValue;
        }
        o = n;
    }
    if(o.nodeType == 1){
        var res = {};
        res[o.tagName] = {};
        var els = o.childNodes;
        for(var i = 0, ln = els.length; i < ln; i++){
            var childs = arguments.callee(els[i]);
            if(typeof(childs) == 'object'){
                for(var key in childs){
                    if(!res[o.tagName][key]){
                        res[o.tagName][key] = childs[key];
                    }else if(res[o.tagName][key]){
                        if(!res[o.tagName][key].push){
                            res[o.tagName][key] = [res[o.tagName][key], childs[key]];
                        }else{
                            res[o.tagName][key].push(childs[key]);
                        }
                    }
                }
            }else{
                res[o.tagName] = childs;
            }
        }
        res[o.tagName] = ln ? res[o.tagName] : '';
        return res;
    }
    return null;
};

cm.responseInArray = function(xmldoc){
    var response = xmldoc.getElementsByTagName('response')[0];
    var data = [];
    var els = response.childNodes;
    for(var i = 0; els.length > i; i++){
        if(els[i].nodeType != 1){
            continue;
        }
        var kids = els[i].childNodes;
        var tmp = [];
        for(var k = 0; kids.length > k; k++){
            if(kids[k].nodeType == 1){
                tmp[kids[k].tagName] = kids[k].firstChild ? kids[k].firstChild.nodeValue : '';
            }
        }
        data.push(tmp);
    }
    return data;
};

cm.createXmlHttpRequestObject = function(){
    var xmlHttp;
    try{
        xmlHttp = new XMLHttpRequest();
    }catch(e){
        var XmlHttpVersions = [
            "MSXML2.XMLHTTP.6.0",
            "MSXML2.XMLHTTP.5.0",
            "MSXML2.XMLHTTP.4.0",
            "MSXML2.XMLHTTP.3.0",
            "MSXML2.XMLHTTP",
            "Microsoft.XMLHTTP"
        ];
        cm.forEach(XmlHttpVersions, function(item){
            try{
                xmlHttp = new ActiveXObject(item);
            }catch(e){}
        });
    }
    if(!xmlHttp){
        return null;
    }
    return xmlHttp;
};

/* ******* HASH ******* */

cm.loadHashData = function(){
    var hash = document.location.hash.replace('#', '').split('&');
    window.userRequest = {};
    hash.forEach(function(item){
        window.userRequest[item.split('=')[0]] = item.split('=')[1];
    });
    return true;
};

cm.reloadHashData = function(){
    var hash = '#';
    cm.forEach(window.userRequest, function(item, key){
        hash += key + '=' + item;
    });
    document.location.hash = hash;
    return true;
};

/* ******* GRAPHICS ******* */

cm.createSvg = function(){
    var node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    node.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    node.setAttribute('version', '1.1');
    return node;
};

/* ******* CLASS FABRIC ******* */

cm.defineStack = {};

cm.defineHelper = function(name, data, handler){
    var that = this;
    // Process config
    data = cm.merge({
        'modules' : [],
        'require' : [],
        'params' : {},
        'events' : []
    }, data);
    // Create class extend object
    that.build = {
        '_raw' : data,
        '_name' : {
            'full' : name,
            'short' : name.replace('.', ''),
            'split' : name.split('.')
        },
        '_modules' : {},
        'params' : data['params']
    };
    // Extend class by predefine module
    cm.forEach(Mod, function(module, name){
        if(module._config && module._config['predefine']){
            Mod['Extend']._extend.call(that, name, module);
        }
    });
    // Extend class by class specific modules
    cm.forEach(that.build._raw['modules'], function(module){
        if(Mod[module]){
            Mod['Extend']._extend.call(that, module, Mod[module]);
        }
    });
    // Prototype class
    handler.prototype = that.build;
    // Extend Window object
    cm.objectSelector(that.build._name['full'], window, handler);
    // Add to defined stack
    cm.defineStack[name] = handler;
};

cm.define = (function(){
    var definer = Function.prototype.call.bind(cm.defineHelper, arguments);
    return function(){
        definer.apply(cm.defineHelper, arguments);
    };
})();

cm.getConstructor = function(className, callback){
    var classConstructor;
    callback = typeof callback != 'undefined' ? callback : function(){}
    if(!className || className == '*'){
        cm.forEach(cm.defineStack, function(classConstructor){
            callback(classConstructor);
        });
        return cm.defineStack;
    }else{
        classConstructor = cm.defineStack[className];
        if(!classConstructor){
            if(cm._debug){
                cm.errorLog({
                    'type' : 'attention',
                    'name' : 'cm.getConstructor',
                    'message' : ['Class', cm.strWrap(className, '"'), 'does not exists or define.'].join(' ')
                });
            }
            return false;
        }else{
            callback(classConstructor);
            return classConstructor;
        }
    }
};

cm.find = function(className, name, parentNode, callback){
    if(!className || className == '*'){
        var classes = [];
        cm.forEach(cm.defineStack, function(classConstructor){
            if(classConstructor.prototype.findInStack){
                classes = cm.extend(classes, classConstructor.prototype.findInStack(name, parentNode, callback));
            }
        });
        return classes;
    }else{
        var classConstructor = cm.defineStack[className];
        if(!classConstructor){
            cm.errorLog({
                'type' : 'error',
                'name' : 'cm.find',
                'message' : ['Class', cm.strWrap(className, '"'), 'does not exist.'].join(' ')
            });
        }else if(!classConstructor.prototype.findInStack){
            cm.errorLog({
                'type' : 'error',
                'name' : 'cm.find',
                'message' : ['Class', cm.strWrap(className, '"'), 'does not support Module Stack.'].join(' ')
            });
        }else{
            return classConstructor.prototype.findInStack(name, parentNode, callback);
        }
    }
    return null;
};

cm.Finder = function(className, name, parentNode, callback, params){
    var that = this,
        isEventBind = false;

    var init = function(){
        var finder;
        // Merge params
        parentNode = parentNode || document.body;
        callback = typeof callback == 'function' ? callback : function(){};
        params = cm.merge({
            'event' : 'onRender',
            'multiple' : false
        }, params);
        // Search in constructed classes
        finder = cm.find(className, name, parentNode, callback);
        // Bind event when no one constructed class found
        if(!finder || !finder.length || params['multiple']){
            isEventBind = true;
            cm.getConstructor(className, function(classConstructor){
                classConstructor.prototype.addEvent(params['event'], watcher);
            });
        }
    };

    var watcher = function(classObject){
        classObject.removeEvent(params['event'], watcher);
        var isSame = classObject.isAppropriateToStack(name, parentNode, callback);
        if(isSame && !params['multiple'] && isEventBind){
            that.remove();
        }
    };

    that.remove = function(){
        cm.getConstructor(className, function(classConstructor){
            classConstructor.prototype.removeEvent(params['event'], watcher);
        });
        return that;
    };

    init();
};

/* ******* PARAMS ******* */

Mod['Params'] = {
    '_config' : {
        'extend' : true,
        'predefine' : false,
        'require' : ['Extend']
    },
    '_construct' : function(){
        var that = this;
        if(!that.build['params']){
            that.build['params'] = {};
        }
    },
    'setParams' : function(params){
        var that = this;
        that.params = cm.merge(that.params, params);
        // Validate params
        cm.forEach(that.params, function(item, key){
            switch(item){
                case 'document.window':
                    that.params[key] = window;
                    break;

                case 'document.html':
                    that.params[key] = cm.getDocumentHtml();
                    break;

                case 'document.body':
                    that.params[key] = document.body;
                    break;

                case 'top.document.body':
                    that.params[key] = window.top.document.body;
                    break;

                case 'document.head':
                    that.params[key] = cm.getDocumentHead();
                    break;

                default:
                    if(/cm._config./i.test(item)){
                        that.params[key] = cm._config[item.replace('cm._config.', '')];
                    }
                    break
            }
        });
        return that;
    }
};

/* ******* EVENTS ******* */

Mod['Events'] = {
    '_config' : {
        'extend' : true,
        'predefine' : false,
        'require' : ['Extend']
    },
    '_construct' : function(){
        var that = this;
        if(!that.build['params']['events']){
            that.build['params']['events'] = {};
        }
        that.build['events'] = {};
        cm.forEach(that.build._raw['events'], function(item){
            that.build['events'][item] = [];
            that.build[item] = function(handler){
                var that = this;
                that.addEvent(item, handler);
                return that;
            };
        });
    },
    'addEvent' : function(event, handler){
        var that = this;
        that.events = cm.clone(that.events);
        if(that.events[event]){
            if(typeof handler == 'function'){
                that.events[event].push(handler);
            }else{
                cm.errorLog({
                    'name' : that._name['full'],
                    'message' : ['Handler of event', cm.strWrap(event, '"'), 'must be a function.'].join(' ')
                });
            }
        }else{
            cm.errorLog({
                'name' : that._name['full'],
                'message' : [cm.strWrap(event, '"'), 'does not exists.'].join(' ')
            });
        }
        return that;
    },
    'addEvents' : function(o){
        var that = this;
        if(o){
            that.convertEvents(o);
        }
        return that;
    },
    'removeEvent' : function(event, handler){
        var that = this;
        that.events = cm.clone(that.events);
        if(that.events[event]){
            if(typeof handler == 'function'){
                that.events[event] = that.events[event].filter(function(item){
                    return item != handler;
                });
            }else{
                cm.errorLog({
                    'name' : that._name['full'],
                    'message' : ['Handler of event', cm.strWrap(event, '"'), 'must be a function.'].join(' ')
                });
            }
        }else{
            cm.errorLog({
                'name' : that._name['full'],
                'message' : [cm.strWrap(event, '"'), 'does not exists.'].join(' ')
            });
        }
        return that;
    },
    'triggerEvent' : function(event, params){
        var that = this;
        if(that.events[event]){
            cm.forEach(that.events[event], function(item){
                item(that, params || {});
            });
        }else{
            cm.errorLog({
                'name' : that._name['full'],
                'message' : [cm.strWrap(event, '"'), 'does not exists.'].join(' ')
            });
        }
        return that;
    },
    'convertEvents' : function(o){
        var that = this;
        cm.forEach(o, function(item, key){
            that.addEvent(key, item);
        });
        return that;
    }
};

/* ******* LANGS ******* */

Mod['Langs'] = {
    '_config' : {
        'extend' : true,
        'predefine' : false,
        'require' : ['Extend']
    },
    '_construct' : function(){
        var that = this;
        if(!that.build['params']['langs']){
            that.build['params']['langs'] = {};
        }
    },
    'lang' : function(str, vars){
        var that = this,
            langStr;
        if(typeof str == 'undefined'){
            return that.params['langs'];
        }
        if(!str || cm.isEmpty(str)){
            return '';
        }
        if(typeof that.params['langs'][str] == 'undefined'){
            that.params['langs'][str] = str;
        }
        langStr = that.params['langs'][str];
        // Process variables
        langStr = cm.strReplace(langStr, vars);
        return langStr;
    },
    'setLangs' : function(o){
        var that = this;
        if(cm.isObject(o)){
            that.params['langs'] = cm.merge(that.params['langs'], o);
        }
        return that;
    }
};

/* ******* DATA CONFIG ******* */

Mod['DataConfig'] = {
    '_config' : {
        'extend' : true,
        'predefine' : false,
        'require' : ['Extend']
    },
    '_construct' : function(){
        var that = this;
        if(typeof that.build['params']['configDataMarker'] == 'undefined'){
            that.build['params']['configDataMarker'] = 'data-config';
        }
    },
    'getDataConfig' : function(container, dataMarker){
        var that = this,
            sourceConfig;
        if(cm.isNode(container)){
            dataMarker = dataMarker || that.params['configDataMarker'];
            sourceConfig = container.getAttribute(dataMarker);
            if(sourceConfig && (sourceConfig = cm.parseJSON(sourceConfig))){
                that.setParams(sourceConfig);
            }
        }
        return that;
    },
    'getNodeDataConfig' : function(node, dataMarker){
        var that = this,
            sourceConfig;
        if(cm.isNode(node)){
            dataMarker = dataMarker || that.params['configDataMarker'];
            sourceConfig = node.getAttribute(dataMarker);
            if(sourceConfig && (sourceConfig = cm.parseJSON(sourceConfig))){
                return sourceConfig;
            }
        }
        return {};
    }
};

/* ******* DATA NODES ******* */

Mod['DataNodes'] = {
    '_config' : {
        'extend' : true,
        'predefine' : false,
        'require' : ['Extend']
    },
    '_construct' : function(){
        var that = this;
        if(!that.build['params']['nodes']){
            that.build['params']['nodes'] = {};
        }
        if(typeof that.build['params']['nodesDataMarker'] == 'undefined'){
            that.build['params']['nodesDataMarker'] = 'data-node';
        }
        if(typeof that.build['params']['nodesMarker'] == 'undefined'){
            that.build['params']['nodesMarker'] = that.build._name['short'];
        }
        if(!that.build['nodes']){
            that.build['nodes'] = {};
        }
    },
    'getDataNodes' : function(container, dataMarker, className){
        var that = this,
            sourceNodes = {};
        container = typeof container == 'undefined'? document.body : container;
        if(container){
            dataMarker = typeof dataMarker == 'undefined'? that.params['nodesDataMarker'] : dataMarker;
            className = typeof className == 'undefined'? that.params['nodesMarker'] : className;
            if(className){
                sourceNodes = cm.getNodes(container, dataMarker)[className] || {};
            }else{
                sourceNodes = cm.getNodes(container, dataMarker);
            }
            that.nodes = cm.merge(that.nodes, sourceNodes);
        }
        that.nodes = cm.merge(that.nodes, that.params['nodes']);
        return that;
    }
};

/* ******* LOCAL STORAGE ******* */

Mod['Storage'] = {
    '_config' : {
        'extend' : true,
        'predefine' : false,
        'require' : ['Extend']
    },
    '_construct' : function(){
        var that = this;
        if(!that.build['params']['name']){
            that.build['params']['name'] = '';
        }
    },
    'storageRead' : function(key){
        var that = this,
            storage = JSON.parse(cm.storageGet(that._name['full'])) || {};
        if(cm.isEmpty(that.params['name'])){
            cm.errorLog({
                'type' : 'error',
                'name' : that._name['full'],
                'message' : 'Storage cannot be read because "name" parameter not provided.'
            });
            return null;
        }
        if(!storage[that.params['name']] || typeof storage[that.params['name']][key] == 'undefined'){
            cm.errorLog({
                'type' : 'attention',
                'name' : that._name['full'],
                'message' : ['Parameter', cm.strWrap(key, '"'), 'does not exist or is not set.'].join(' ')
            });
            return null;
        }
        return storage[that.params['name']][key];
    },
    'storageReadAll' : function(){
        var that = this,
            storage = JSON.parse(cm.storageGet(that._name['full'])) || {};
        if(cm.isEmpty(that.params['name'])){
            cm.errorLog({
                'type' : 'error',
                'name' : that._name['full'],
                'message' : 'Storage cannot be read because "name" parameter not provided.'
            });
            return {};
        }
        if(!storage[that.params['name']]){
            cm.errorLog({
                'type' : 'attention',
                'name' : that._name['full'],
                'message' : 'Storage is empty.'
            });
            return {};
        }
        return storage[that.params['name']];
    },
    'storageWrite' : function(key, value){
        var that = this,
            storage = JSON.parse(cm.storageGet(that._name['full'])) || {};
        if(cm.isEmpty(that.params['name'])){
            cm.errorLog({
                'type' : 'error',
                'name' : that._name['full'],
                'message' : 'Storage cannot be written because "name" parameter not provided.'
            });
            return {};
        }
        if(!storage[that.params['name']]){
            storage[that.params['name']] = {};
        }
        storage[that.params['name']][key] = value;
        cm.storageSet(that._name['full'], JSON.stringify(storage));
        return storage[that.params['name']];
    },
    'storageWriteAll' : function(data){
        var that = this,
            storage = JSON.parse(cm.storageGet(that._name['full'])) || {};
        if(cm.isEmpty(that.params['name'])){
            cm.errorLog({
                'type' : 'error',
                'name' : that._name['full'],
                'message' : 'Storage cannot be written because "name" parameter not provided.'
            });
            return {};
        }
        storage[that.params['name']] = data;
        cm.storageSet(that._name['full'], JSON.stringify(storage));
        return storage[that.params['name']];
    }
};

/* ******* CALLBACKS ******* */

Mod['Callbacks'] = {
    '_config' : {
        'extend' : true,
        'predefine' : false,
        'require' : ['Extend']
    },
    '_construct' : function(){
        var that = this;
        if(!that.build['params']['callbacks']){
            that.build['params']['callbacks'] = {};
        }
        that.build['callbacks'] = {};
        that.build['_callbacks'] = {};
    },
    'callbacksProcess' : function(){
        var that = this;
        that.callbacks = cm.clone(that.callbacks);
        // Save default callbacks
        cm.forEach(that.callbacks, function(callback, name){
            that._callbacks[name] = callback;
        });
        // Replace callbacks
        cm.forEach(that.params['callbacks'], function(callback, name){
            that.callbacks[name] = callback;
        });
        return that;
    },
    'callbacksRestore' : function(){
        var that = this;
        that.callbacks = cm.clone(that.callbacks);
        cm.forEach(that._callbacks, function(callback, name){
            that.callbacks[name] = callback;
        });
        return that;
    }
};

/* ******* STACK ******* */

Mod['Stack'] = {
    '_config' : {
        'extend' : true,
        'predefine' : false,
        'require' : ['Extend']
    },
    '_construct' : function(){
        var that = this;
        if(!that.build['params']['name']){
            that.build['params']['name'] = '';
        }
        that.build['_stack'] = [];
    },
    'addToStack' : function(node){
        var that = this;
        that._stackItem = {
            'name' : that.params['name'],
            'node' : node,
            'class' : that,
            'className' : that._name['full']
        };
        that._stack.push(that._stackItem);
        return that;
    },
    'isAppropriateToStack' : function(name, parent, callback){
        var that = this,
            item = that._stackItem;
        if((cm.isEmpty(name) || item['name'] == name) && cm.isParent(parent, item['node'], true)){
            callback(item['class'], item);
            return true;
        }
        return false;
    },
    'findInStack' : function(name, parent, callback){
        var that = this,
            items = [];
        parent = parent || document.body;
        callback = typeof callback == 'function' ? callback : function(){};
        cm.forEach(that._stack, function(item){
            if((cm.isEmpty(name) || item['name'] == name) && cm.isParent(parent, item['node'], true)){
                items.push(item);
                callback(item['class'], item);
            }
        });
        return items;
    }
};

/* ******* EXTEND ******* */

Mod['Extend'] = {
    '_config' : {
        'extend' : true,
        'predefine' : true
    },
    '_construct' : function(){
        var that = this;
    },
    '_extend' : function(name, o){
        var that = this;
        if(!that.build._modules[name]){
            // Merge Config
            o._config = cm.merge({
                'extend' : false,
                'predefine' : false,
                'require' : []
            }, o._config);
            // Check Requires
            cm.forEach(o._config['require'], function(module){
                if(Mod[module]){
                    Mod['Extend']._extend.call(that, module, Mod[module]);
                }
            });
            // Extend class by module's methods
            if(o._config['extend']){
                cm.forEach(o, function(item, key){
                    if(!/^(_)/.test(key)){
                        that.build[key] = item;
                    }
                });
            }
            // Construct module
            if(typeof o._construct == 'function'){
                // Construct
                o._construct.call(that);
            }else{
                cm.errorLog({
                    'type' : 'error',
                    'name' : that.build._name['full'],
                    'message' : ['Module', cm.strWrap(name, '"'), 'does not have "_construct" method.'].join(' ')
                });
            }
            // Add into stack of class's modules
            that.build._modules[name] = o;
        }
    },
    'extend' : function(name, o){
        var that = this;
        if(!o){
            cm.errorLog({
                'type' : 'error',
                'name' : that._name['full'],
                'message' : 'Trying to extend the class by non-existing module.'
            });
        }else if(!name){
            cm.errorLog({
                'type' : 'error',
                'name' : that._name['full'],
                'message' : 'Module should have a name.'
            });
        }else if(that._modules[name]){
            cm.errorLog({
                'type' : 'error',
                'name' : that._name['full'],
                'message' : ['Module with name', cm.strWrap(name, '"'), 'already constructed.'].join(' ')
            });
        }else{
            // Merge Config
            o._config = cm.merge({
                'extend' : false,
                'predefine' : false,
                'require' : []
            }, o._config);
            // Check Requires
            cm.forEach(o._config['require'], function(module){
                if(Mod[module]){
                    Mod['Extend']._extend.call(that, module, Mod[module]);
                }
            });
            // Extend class by module's methods
            if(o._config['extend']){
                cm.forEach(o, function(item, key){
                    if(!/^(_)/.test(key)){
                        cm.defineStack[that._name['full']].prototype[key] = item;
                    }
                });
            }
            // Construct module
            if(typeof o._construct == 'function'){
                // Construct
                o._construct.call(that);
            }else{
                cm.errorLog({
                    'type' : 'error',
                    'name' : that._name['full'],
                    'message' : ['Module', cm.strWrap(name, '"'), 'does not have "_construct" method.'].join(' ')
                });
            }
            // Add into stack of class's modules
            that._modules[name] = o;
        }
    }
};

/* ****** STRUCTURE ******* */

Mod['Structure'] = {
    '_config' : {
        'extend' : true,
        'predefine' : false,
        'require' : ['Extend']
    },
    '_construct' : function(){
        var that = this;
        if(typeof that.build['params']['renderStructure'] == 'undefined'){
            that.build['params']['renderStructure'] = true;
        }
    },
    'appendStructure' : function(node){
        var that = this;
        if(that.params['container']){
            if(that.params['container'] === that.params['node']){
                cm.insertBefore(node, that.params['node']);
            }else{
                that.params['container'].appendChild(node);
            }
        }else if(that.params['node'].parentNode){
            cm.insertBefore(node, that.params['node']);
        }
        return that;
    }
};
Part['Menu'] = (function(){
    var processedNodes = [],
        pageSize;

    var checkPosition = function(item){
        pageSize = cm.getPageSize();
        var dropWidth = item['drop'].offsetWidth,
            parentLeft = cm.getX(item['node']),
            parentWidth = item['node'].parentNode && cm.isClass(item['node'].parentNode, 'pt__menu-dropdown') ? item['node'].parentNode.offsetWidth : 0;
        if(dropWidth + parentWidth + parentLeft >= pageSize['winWidth']){
            cm.replaceClass(item['drop'], 'pull-left', 'pull-right');
        }else{
            cm.replaceClass(item['drop'], 'pull-right', 'pull-left');
        }
    };

    var setEvents = function(item){
        var target;
        cm.addEvent(item['node'], 'mouseover', function(e){
            e = cm.getEvent(e);
            target = cm.getObjFromEvent(e);
            if(!cm.isParent(item['drop'], target, true)){
                checkPosition(item);
            }
        });
        cm.addEvent(item['node'], 'mousedown', function(e){
            e = cm.getEvent(e);
            target = cm.getObjFromEvent(e);
            if(cm.getStyle(item['drop'], 'visibility') == 'hidden' && !cm.isClass(item['node'], 'is-show')){
                if(!cm.isParent(item['drop'], target, true)){
                    if(cm.isClass(item['node'], 'is-show')){
                        cm.removeClass(item['node'], 'is-show');
                    }else{
                        cm.preventDefault(e);
                        cm.addClass(item['node'], 'is-show');
                    }
                }
            }
        });
        cm.addEvent(document.body, 'mousedown', function(e){
            e = cm.getEvent(e);
            target = cm.getRelatedTarget(e);
            if(!cm.isParent(item['node'], target, true)){
                cm.removeClass(item['node'], 'is-show');
            }
        });
        checkPosition(item);
    };

    return function(container){
        container = typeof container == 'undefined'? document.body : container;
        var menus = cm.getByClass('pt__menu', container),
            items = [],
            item;
        cm.forEach(menus, function(node){
            if(!cm.inArray(processedNodes, node)){
                item = {
                    'node' : node,
                    'drop' : cm.getByClass('pt__menu-dropdown', node)[0]
                };
                if(item['drop']){
                    setEvents(item);
                }
                items.push(item);
                processedNodes.push(node);
            }
        });
        cm.addEvent(window, 'resize', function(){
            cm.forEach(items, function(item){
                checkPosition(item);
            });
        });
    };
})();

Part['Autoresize'] = (function(){
    var processedNodes = [],
        nodes;

    var process = function(node){
        if(!cm.inArray(processedNodes, node)){
            if(cm.isNode(node) && node.tagName.toLowerCase() == 'textarea'){
                var resizeInt,
                    rows,
                    oldRows,
                    matches,
                    lineHeight = cm.getStyle(node, 'lineHeight', true),
                    padding = cm.getStyle(node, 'paddingTop', true)
                        + cm.getStyle(node, 'paddingBottom', true)
                        + cm.getStyle(node, 'borderTopWidth', true)
                        + cm.getStyle(node, 'borderBottomWidth', true);
                cm.addEvent(node, 'scroll', function(){
                    node.scrollTop = 0;
                });
                resizeInt = setInterval(function(){
                    if(!node || !cm.inDOM(node)){
                        clearInterval(resizeInt);
                    }
                    oldRows = rows;
                    matches = node.value.match(/\n/g);
                    rows = matches? matches.length : 0;
                    if(rows !== oldRows){
                        node.style.height = [(rows + 1) * lineHeight + padding, 'px'].join('');
                    }
                }, 5);
            }
            processedNodes.push(node);
        }
    };

    return function(container){
        container = typeof container == 'undefined'? document.body : container;
        nodes = cm.getByClass('cm-autoresize', container);
        cm.forEach(nodes, process);
    };
})();
cm.init = function(){
    var init = function(){
        checkBrowser();
        checkType();
        checkScrollSize();
        cm.addEvent(window, 'resize', checkType);
        cm.addEvent(window, 'resize', checkScrollSize);
        cm.addEvent(window, 'mousemove', getClientPosition);
        //cm.addEvent(window, 'scroll', disableHover);
    };

    // Set browser class
    var checkBrowser = function(){
        if(typeof Com.UA != 'undefined'){
            Com.UA.setBrowserClass();
        }
    };

    // Get device type

    var checkType = (function(){
        var html = cm.getDocumentHtml(),
            sizes,
            width,
            height;

        return function(){
            sizes = cm.getPageSize();
            width = sizes['winWidth'];
            height = sizes['winHeight'];

            cm.removeClass(html, ['is', cm._deviceType].join('-'));
            cm.removeClass(html, ['is', cm._deviceOrientation].join('-'));

            cm._deviceOrientation = width < height? 'portrait' : 'landscape';
            if(width > cm._config['screenTablet']){
                cm._deviceType = 'desktop';
            }
            if(width <= cm._config['screenTablet'] && width > cm._config['screenMobile']){
                cm._deviceType = 'tablet';
            }
            if(width <= cm._config['screenMobile']){
                cm._deviceType = 'mobile';
            }

            cm.addClass(html, ['is', cm._deviceType].join('-'));
            cm.addClass(html, ['is', cm._deviceOrientation].join('-'));
        };
    })();

    // Get device scroll bar size

    var checkScrollSize = (function(){
        var oldSize = 0;

        return function(){
            oldSize = cm._scrollSize;
            cm._scrollSize = cm.getScrollBarSize();
            if(oldSize != cm._scrollSize){
                cm.customEvent.trigger(window, 'scrollSizeChange', {
                    'type' : 'all',
                    'self' : true,
                    'scrollSize' : cm._scrollSize
                })
            }
        };
    })();

    // Disable hover on scroll

    var disableHover = (function(){
        var body = document.body,
            timer;

        return function(){
            timer && clearTimeout(timer);
            if(!cm.hasClass(body, 'disable-hover')){
                cm.addClass(body, 'disable-hover');
            }
            timer = setTimeout(function(){
                cm.removeClass(body, 'disable-hover');
            }, 100);
        };
    })();

    // Get client cursor position

    var getClientPosition = function(e){
        cm._clientPosition = cm.getEventClientPosition(e);
    };

    init();
};

cm.onReady(cm.init, false);
cm.define('Com.Form', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig',
        'DataNodes',
        'Storage',
        'Callbacks',
        'Stack',
        'Structure'
    ],
    'events' : [
        'onRender'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'name' : '',
        'renderStructure' : true
    }
},
function(params){
    var that = this;

    that.fields = {};

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);
        that.callbacksProcess();
        render();
        that.addToStack(that.nodes['container']);
        that.triggerEvent('onRender');
    };

    var render = function(){
        if(that.params['renderStructure']){
            that.nodes['container'] = cm.node('div', {'class' : 'com__form'},
                that.nodes['form'] = cm.node('form', {'class' : 'form'})
            );
            that.appendStructure(that.nodes['container']);
            cm.remove(that.params['node']);
        }
    };

    var renderField = function(params){
        var field;
        // Merge params
        params = cm.merge({
            'type' : null,
            'name' : '',
            'label' : '',
            'fields' : [],
            'container' : that.nodes['form']
        }, params);
        // Render
        if(field = Com.FormFields.get(params['type'])){
            cm.getConstructor('Com.FormField', function(classConstructor){
                params = cm.merge(field, params);
                that.fields[params['name']] = new classConstructor(params);
            });
        }
    };

    /* ******* PUBLIC ******* */

    that.clear = function(){
        cm.clearNode(that.nodes['form']);
        return that;
    };

    that.add = function(item){
        renderField(item);
        return that;
    };

    init();
});

/* ******* COMPONENT: FORM FIELD ******* */

Com.FormFields = (function(){
    var stack = {};

    return {
        'add' : function(type, item){
            stack[type] = cm.merge({
                'node' : cm.node('div'),
                'type' : type
            }, item);
        },
        'get' : function(type){
            return stack[type]? cm.clone(stack[type], true) : null;
        }
    };
})();

cm.define('Com.FormField', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'Stack',
        'Callbacks'
    ],
    'events' : [
        'onRender'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'container' : cm.node('div'),
        'name' : '',
        'type' : false,
        'label' : '',
        'options' : [],
        'isComponent' : false
    }
},
function(params){
    var that = this;

    that.nodes = {};
    that.component = null;
    that.value = null;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['node']);
        that.callbacksProcess();
        validateParams();
        render();
        that.addToStack(that.params['node']);
        that.triggerEvent('onRender');
    };

    var validateParams = function(){
        if(that.params['isComponent']){
            cm.getConstructor(that.params['type'], function(classConstructor){
                that.params['constructor'] = classConstructor;
            });
        }
    };

    var render = function(){
        // Render structure
        that.nodes = that.callbacks.render.apply(that) || {};
        // Append
        that.params['container'].appendChild(that.nodes['container']);
        // Construct
        that.callbacks.construct.apply(that);
    };

    /* ******* CALLBACKS ******* */

    that.callbacks.construct = function(){
        if(that.params['isComponent'] && that.params['constructor']){
            that.component = that.callbacks.component.apply(that, that.params[that.params['type']]);
        }else{
            that.callbacks.component.apply(that);
        }
    };

    that.callbacks.component = function(params){
        return new that.params['constructor'](
            cm.merge(params, {
                'node' : that.params['node'],
                'name' : that.params['name']
            })
        );
    };

    that.callbacks.render = function(){
        var nodes = {};
        nodes['container'] = cm.node('dl',
            nodes['label'] = cm.node('dt', that.params['label']),
            nodes['value'] = cm.node('dd', that.params['node'])
        );
        return nodes;
    };

    that.callbacks.set = function(value){
        return value;
    };

    that.callbacks.get = function(){
        return that.value;
    };

    /* ******* PUBLIC ******* */

    that.set = function(value){
        that.value = that.callbacks.set.apply(that, value);
        return that;
    };

    that.get = function(){
        that.value = that.callbacks.get.apply(that);
        return that.value;
    };

    init();
});

/* ******* COMPONENT: FORM FIELDS ******* */

Com.FormFields.add('input', {
    'node' : cm.node('input', {'type' : 'text'}),
    'callbacks' : {
        'set' : function(value){
            var that = this;
            that.params['node'].value = value;
            return value;
        },
        'get' : function(){
            var that = this;
            return that.params['node'];
        }
    }
});

Com.FormFields.add('text', {
    'node' : cm.node('textarea'),
    'callbacks' : {
        'set' : function(value){
            var that = this;
            that.params['node'].value = value;
            return value;
        },
        'get' : function(){
            var that = this;
            return that.params['node'];
        }
    }
});

Com.FormFields.add('radio', {
    'node' : cm.node('div', {'class' : 'form__check-line'}),
    'callbacks' : {
        'construct' : function(){
            var that = this;
            cm.forEach(that.params['options'], function(item){
                that.params['node'].appendChild(
                    cm.node('label',
                        cm.node('input', {'type' : 'radio', 'name' : that.params['name'], 'value' : item['value']}),
                        cm.node('span', {'class' : 'label'}, item['text'])
                    )
                );
            });
        },
        'set' : function(value){
            var that = this;
            that.params['node'].value = value;
            return value;
        },
        'get' : function(){
            var that = this;
            return that.params['node'];
        }
    }
});

Com.FormFields.add('check', {
    'node' : cm.node('div', {'class' : 'form__check-line'}),
    'callbacks' : {
        'construct' : function(){
            var that = this;
            cm.forEach(that.params['options'], function(item){
                that.params['node'].appendChild(
                    cm.node('label',
                        cm.node('input', {'type' : 'checkbox', 'name' : that.params['name'], 'value' : item['value']}),
                        cm.node('span', {'class' : 'label'}, item['text'])
                    )
                );
            });
        },
        'set' : function(value){
            var that = this;
            that.params['node'].value = value;
            return value;
        },
        'get' : function(){
            var that = this;
            return that.params['node'];
        }
    }
});
cm.define('Com.Autocomplete', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig',
        'Storage',
        'Callbacks'
    ],
    'require' : [
        'Com.Tooltip'
    ],
    'events' : [
        'onRender',
        'onClear',
        'onSelect',
        'onChange',
        'onClickSelect',
        'onAbort',
        'onError'
    ],
    'params' : {
        'input' : cm.Node('input', {'type' : 'text'}),              // HTML input node.
        'target' : false,                                           // HTML node.
        'container' : 'document.body',
        'minLength' : 3,
        'delay' : 300,
        'clearOnEmpty' : true,                                      // Clear input and value if item didn't selected from tooltip
        'showLoader' : true,                                        // Show ajax spinner in tooltip, for ajax mode only.
        'data' : [],                                                // Examples: [{'value' : 'foo', 'text' : 'Bar'}] or ['Foo', 'Bar'].
        'responseKey' : 'data',                                     // Instead of using filter callback, you can provide response array key
        'ajax' : {
            'type' : 'json',
            'method' : 'get',
            'url' : '',                                             // Request URL. Variables: %query%, %callback%.
            'params' : ''                                           // Params object. Variables: %query%, %callback%.
        },
        'langs' : {
            'loader' : 'Searching for: %query%.'                    // Variable: %query%.
        },
        'Com.Tooltip' : {
            'hideOnOut' : true,
            'targetEvent' : 'none',
            'className' : 'com__ac-tooltip',
            'width' : 'targetWidth',
            'top' : 'targetHeight + 4'
        }
    }
},
function(params){
    var that = this,
        requestDelay,
        ajaxHandler;

    that.isOpen = false;
    that.isAjax = false;
    that.components = {};
    that.registeredItems = [];
    that.selectedItemIndex = null;
    that.value = null;
    that.previousValue = null;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['input']);
        that.callbacksProcess();
        validateParams();
        render();
    };

    var validateParams = function(){
        if(!that.params['target']){
            that.params['target'] = that.params['input'];
        }
        // If URL parameter exists, use ajax data
        that.isAjax = !cm.isEmpty(that.params['ajax']['url']);
        // Convert params object to URI string
        if(cm.isObject(that.params['ajax']['params'])){
            that.params['ajax']['params'] = cm.obj2URI(that.params['ajax']['params']);
        }
        // Prepare data
        that.params['data'] = that.convertData(that.params['data']);
    };

    var render = function(){
        // Init tooltip
        that.components['tooltip'] = new Com.Tooltip(
            cm.merge(that.params['Com.Tooltip'], {
                'container' : that.params['container'],
                'target' : that.params['target'],
                'events' : {
                    'onShowStart' : function(){
                        that.isOpen = true;
                        cm.addEvent(document, 'mousedown', bodyEvent);
                    },
                    'onHideStart' : function(){
                        that.isOpen = false;
                        cm.removeEvent(document, 'mousedown', bodyEvent);
                    }
                }
            })
        );
        // Set input
        that.setInput(that.params['input']);
        that.triggerEvent('onRender');
    };

    var inputHandler = function(e){
        var listLength,
            listIndex;
        e = cm.getEvent(e);

        switch(e.keyCode){
            // Enter
            case 13:
                clear();
                that.hide();
                break;
            // Arrow Up
            case 38:
                listLength = that.registeredItems.length;
                if(listLength){
                    if(that.selectedItemIndex == null){
                        that.selectedItemIndex = listLength - 1;
                    }else if(that.selectedItemIndex - 1 >= 0){
                        listIndex = that.selectedItemIndex - 1;
                    }else{
                        listIndex = listLength - 1;
                    }
                    setListItem(listIndex);
                }
                break;
            // Arrow Down
            case 40:
                listLength = that.registeredItems.length;
                if(listLength){
                    if(that.selectedItemIndex == null){
                        listIndex = 0;
                    }else if(that.selectedItemIndex + 1 < listLength){
                        listIndex = that.selectedItemIndex + 1;
                    }else{
                        listIndex = 0;
                    }
                    setListItem(listIndex);
                }
                break;
        }
    };

    var blurHandler = function(){
        if(!that.isOpen){
            clear();
        }
    };

    var requestHandler = function(){
        var query = that.params['input'].value,
            config = cm.clone(that.params['ajax']);
        // Clear tooltip ajax/static delay and filtered items list
        requestDelay && clearTimeout(requestDelay);
        that.selectedItemIndex = null;
        that.registeredItems = [];
        that.abort();

        if(query.length >= that.params['minLength']){
            requestDelay = setTimeout(function(){
                if(that.isAjax){
                    if(that.params['showLoader']){
                        that.callbacks.loader(that, config, query);
                    }
                    that.ajaxHandler = that.callbacks.request(that, config, query);
                }else{
                    that.callbacks.data(that, query, that.params['data']);
                }
            }, that.params['delay']);
        }else{
            that.hide();
        }
    };

    var setListItem = function(index){
        var previousItem = that.registeredItems[that.selectedItemIndex],
            item = that.registeredItems[index];
        if(previousItem){
            cm.removeClass(previousItem['node'], 'active');
        }
        if(item){
            cm.addClass(item['node'], 'active');
            that.components['tooltip'].scrollToNode(item['node']);
        }
        that.selectedItemIndex = index;
        // Set input data
        set(that.selectedItemIndex);
    };

    var set = function(index){
        var item = that.registeredItems[index];
        if(item){
            that.setRegistered(item, true);
        }
    };

    var clear = function(){
        var item;
        // Kill timeout interval and ajax request
        requestDelay && clearTimeout(requestDelay);
        that.abort();
        // Clear input
        if(that.params['clearOnEmpty']){
            item = that.getRegisteredItem(that.value);
            if(!item || item['data']['text'] != that.params['input'].value){
                that.clear();
            }
        }
    };

    var onChange = function(){
        if(that.value != that.previousValue){
            that.triggerEvent('onChange', that.value);
        }
    };

    var bodyEvent = function(e){
        e = cm.getEvent(e);
        var target = cm.getEventTarget(e);
        if(!that.isOwnNode(target)){
            clear();
            that.hide();
        }
    };

    /* ******* CALLBACKS ******* */

    /* *** AJAX *** */

    that.callbacks.prepare = function(that, config, query){
        config['url'] = cm.strReplace(config['url'], {
            '%query%' : query
        });
        config['params'] = cm.strReplace(config['params'], {
            '%query%' : query
        });
        return config;
    };

    that.callbacks.request = function(that, config, query){
        config = that.callbacks.prepare(that, config, query);
        // Return ajax handler (XMLHttpRequest) to providing abort method.
        return cm.ajax(
            cm.merge(config, {
                'onSuccess' : function(response){
                    that.callbacks.response(that, config, query, response);
                },
                'onError' : function(){
                    that.callbacks.error(that, config, query);
                }
            })
        );
    };

    that.callbacks.filter = function(that, config, query, response){
        var data = [],
            dataItem = cm.objectSelector(that.params['responseKey'], response);
        if(dataItem && !cm.isEmpty(dataItem)){
            data = dataItem;
        }
        return data;
    };

    that.callbacks.response = function(that, config, query, response){
        if(response){
            response = that.callbacks.filter(that, config, query, response);
        }
        if(!cm.isEmpty(response)){
            that.callbacks.render(that, that.convertData(response));
        }else{
            that.callbacks.render(that, []);
        }
    };

    that.callbacks.error = function(that, config, query){
        that.hide();
        that.triggerEvent('onError');
    };

    that.callbacks.loader = function(that, config, query){
        var nodes = {};
        // Render Structure
        nodes['container'] = cm.Node('div', {'class' : 'pt__listing-items disabled'},
            cm.Node('ul',
                cm.Node('li',
                    cm.Node('a',
                        cm.Node('span', {'class' : 'icon small loader-circle'}),
                        cm.Node('span', that.lang('loader', {'%query%' : query}))
                    )
                )
            )
        );
        // Embed nodes to Tooltip
        that.callbacks.embed(that, nodes['container']);
        // Show Tooltip
        that.show();
    };

    /* *** STATIC DATA *** */

    that.callbacks.data = function(that, query, items){
        // Filter data
        items = that.callbacks.query(that, query, items);
        that.callbacks.render(that, items);
    };

    /* *** HELPERS *** */

    that.callbacks.query = function(that, query, items){
        var filteredItems = [];
        cm.forEach(items, function(item){
            if(item['text'].toLowerCase().indexOf(query.toLowerCase()) > -1){
                filteredItems.push(item);
            }
        });
        return filteredItems;
    };

    that.callbacks.render = function(that, items){
        if(items.length){
            // Render List Nodes
            that.callbacks.renderList(that, items);
            // Show menu
            that.show();
        }else{
            that.hide();
        }
    };

    that.callbacks.renderList = function(that, items){
        var nodes = {};
        // Render structure
        nodes['container'] = cm.Node('div', {'class' : 'pt__listing-items'},
            nodes['items'] = cm.Node('ul')
        );
        // Render List Items
        cm.forEach(items, function(item, i){
            that.callbacks.renderItem(that, nodes['items'], item, i);
        });
        // Embed nodes to Tooltip
        that.callbacks.embed(that, nodes['container']);
    };

    that.callbacks.renderItem = function(that, container, item, i){
        var nodes = {};
        // Render Structure of List Item
        nodes['container'] = cm.Node('li',
            cm.Node('a', {'innerHTML' : item['text']})
        );
        // Highlight selected option
        if(that.value == item['value']){
            cm.addClass(nodes['container'], 'active');
            that.selectedItemIndex = i;
        }
        // Register item
        that.callbacks.registerItem(that, nodes['container'], item, i);
        // Embed Item to List
        cm.appendChild(nodes['container'], container);
    };

    that.callbacks.registerItem = function(that, node, item, i){
        var regItem = {
            'data' : item,
            'node' : node,
            'i' : i
        };
        cm.addEvent(regItem['node'], 'click', function(){
            that.setRegistered(regItem, true);
            that.triggerEvent('onClickSelect', that.value);
            that.hide();
        });
        that.registeredItems.push(regItem);
    };

    that.callbacks.embed = function(that, container){
        that.components['tooltip'].setContent(container);
    };

    /* ******* MAIN ******* */

    that.set = function(item, triggerEvents){
        triggerEvents = typeof triggerEvents == 'undefined'? true : triggerEvents;
        that.previousValue = that.value;
        that.value = typeof item['value'] != 'undefined'? item['value'] : item['text'];
        that.params['input'].value = item['text'];
        // Trigger events
        if(triggerEvents){
            that.triggerEvent('onSelect', that.value);
            onChange();
        }
        return that;
    };

    that.setRegistered = function(item, triggerEvents){
        triggerEvents = typeof triggerEvents == 'undefined'? true : triggerEvents;
        that.set(item['data'], triggerEvents);
        return that;
    };

    that.setInput = function(node){
        if(cm.isNode(node)){
            that.params['input'] = node;
            cm.addEvent(that.params['input'], 'input', requestHandler);
            cm.addEvent(that.params['input'], 'keydown', inputHandler);
            cm.addEvent(that.params['input'], 'blur', blurHandler);
        }
        return that;
    };

    that.setTarget = function(node){
        if(cm.isNode(node)){
            that.params['target'] = node;
            that.components['tooltip'].setTarget(node);
        }
        return that;
    };

    that.get = function(){
        return that.value;
    };

    that.getItem = function(value){
        var item;
        if(value){
            cm.forEach(that.params['data'], function(dataItem){
                if(dataItem['value'] == value){
                    item = dataItem;
                }
            });
        }
        return item;
    };

    that.getRegisteredItem = function(value){
        var item;
        if(value){
            cm.forEach(that.registeredItems, function(regItem){
                if(regItem['data']['value'] == value){
                    item = regItem;
                }
            });
        }
        return item;
    };

    that.convertData = function(data){
        var newData = data.map(function(item){
            if(!cm.isObject(item)){
                return {'text' : item, 'value' : item};
            }else{
                return item;
            }
        });
        return newData;
    };

    that.clear = function(triggerEvents){
        triggerEvents = typeof triggerEvents == 'undefined'? true : triggerEvents;
        that.previousValue = that.value;
        that.value = null;
        if(that.params['clearOnEmpty']){
            that.params['input'].value = '';
        }
        // Trigger events
        if(triggerEvents){
            that.triggerEvent('onClear', that.value);
            onChange();
        }
        return that;
    };

    that.show = function(){
        that.components['tooltip'].show();
        return that;
    };

    that.hide = function(){
        that.components['tooltip'].hide();
        return that;
    };

    that.abort = function(){
        if(that.ajaxHandler && that.ajaxHandler.abort){
            that.ajaxHandler.abort();
        }
        return that;
    };

    that.isOwnNode = function(node){
        return that.components['tooltip'].isOwnNode(node);
    };

    init();
});
cm.define('Com.Calendar', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig',
        'Stack'
    ],
    'events' : [
        'onRender',
        'onDayOver',
        'onDayOut',
        'onDayClick',
        'onMonthRender'
    ],
    'params' : {
        'name' : '',
        'container' : cm.Node('div'),
        'className' : '',
        'startYear' : 1950,                                                 // number | current
        'endYear' : 'current + 10',                                         // number | current
        'renderMonthOnInit' : true,
        'startWeekDay' : 0,
        'renderSelectsInBody' : true,
        'langs' : {
            'daysAbbr' : ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
            'days' : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
            'months' : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
        }
    }
},
function(params){
    var that = this,
        nodes = {
            'selects' : {}
        },
        selects = {},
        today = new Date(),
        current = {
            'year' : today.getFullYear(),
            'month' : today.getMonth()
        },
        previous = {},
        next = {};

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['container']);
        validateParams();
        render();
        setMiscEvents();
        that.params['renderMonthOnInit'] && renderView();
        that.addToStack(nodes['container']);
        that.triggerEvent('onRender');
    };

    var validateParams = function(){
        if(/current/.test(that.params['startYear'])){
            that.params['startYear'] = eval(cm.strReplace(that.params['startYear'], {'current' : new Date().getFullYear()}));
        }
        if(/current/.test(that.params['endYear'])){
            that.params['endYear'] = eval(cm.strReplace(that.params['endYear'], {'current' : new Date().getFullYear()}));
        }
    };

    var render = function(){
        var weekday;
        // Structure
        nodes['container'] = cm.Node('div', {'class' : 'com__calendar'},
            cm.Node('div', {'class' : 'selects'},
                nodes['months'] = cm.Node('select', {'class' : 'select months'}),
                nodes['years'] = cm.Node('select', {'class' : 'select years'})
            ),
            cm.Node('table',
                cm.Node('thead',
                    nodes['days'] = cm.Node('tr')
                ),
                nodes['dates'] = cm.Node('tbody')
            )
        );
        // Add css class
        !cm.isEmpty(that.params['className']) && cm.addClass(nodes['container'], that.params['className']);
        // Render days
        cm.forEach(7, function(i){
            weekday = i + that.params['startWeekDay'];
            weekday = weekday > 6? Math.abs(6 - (weekday - 1)) : weekday;
            nodes['days'].appendChild(
                cm.Node('th', that.lang('daysAbbr')[weekday])
            );
        });
        // Render selects options
        that.lang('months').forEach(function(item, i){
            nodes['months'].appendChild(
                cm.Node('option', {'value' : i}, item)
            );
        });
        for(var i = that.params['endYear']; i >= that.params['startYear']; i--){
            nodes['years'].appendChild(
                cm.Node('option', {'value' : i}, i)
            );
        }
        // Insert into DOM
        that.params['container'].appendChild(nodes['container']);
    };

    var setMiscEvents = function(){
        // Init custom selects
        selects['years'] = new Com.Select({
                'select' : nodes['years'],
                'renderInBody' : that.params['renderSelectsInBody']
            })
            .set(current['year'])
            .addEvent('onChange', renderView);

        selects['months'] = new Com.Select({
                'select' : nodes['months'],
                'renderInBody' : that.params['renderSelectsInBody']
            })
            .set(current['month'])
            .addEvent('onChange', renderView);
    };

    var renderView = function(triggerEvents){
        triggerEvents = typeof triggerEvents != 'undefined'? triggerEvents : true;
        var date;
        // Get new today date
        today = new Date();
        // Get current month data
        date = new Date(selects['years'].get(), selects['months'].get(), 1);
        current = getMonthData(date);
        // Get previous month data
        date = new Date(current['year'], current['month'], 1);
        date.setMonth(current['month'] - 1);
        previous = getMonthData(date);
        // Get next month data
        date = new Date(current['year'], current['month'], 1);
        date.setMonth(current['month'] + 1);
        next = getMonthData(date);
        // Clear current table
        cm.clearNode(nodes['dates']);
        // Render rows
        cm.forEach(6, renderRow);
        // Trigger events
        if(triggerEvents){
            that.triggerEvent('onMonthRender', current);
        }
    };

    var renderRow = function(i){
        var startWeekDay = current['startWeekDay'] - that.params['startWeekDay'],
            day = ((i - 1) * 7) + 1 - (startWeekDay > 0? startWeekDay - 7 : startWeekDay),
            tr = nodes['dates'].appendChild(
                cm.Node('tr')
            );
        cm.forEach(7, function(){
            renderCell(tr, day);
            day++;
        });
    };

    var renderCell = function(tr, day){
        var td, div, params;
        tr.appendChild(
            td = cm.Node('td')
        );
        // Render day
        if(day <= 0){
            td.appendChild(
                div = cm.Node('div', (previous['dayCount'] + day))
            );
            cm.addClass(td, 'out');
            cm.addEvent(div, 'click', that.prevMonth);
        }else if(day > current['dayCount']){
            td.appendChild(
                div = cm.Node('div', (day - current['dayCount']))
            );
            cm.addClass(td, 'out');
            cm.addEvent(div, 'click', that.nextMonth);
        }else{
            td.appendChild(
                div = cm.Node('div', day)
            );
            cm.addClass(td, 'in');
            params = {
                'container' : td,
                'node' : div,
                'day' : day,
                'month' : current['month'],
                'year' : current['year'],
                'date' : new Date(current['year'], current['month'], day),
                'isWeekend' : false,
                'isToday' : false
            };
            if(today.getFullYear() == current['year'] && today.getMonth() == current['month'] && day == today.getDate()){
                params['isToday'] = true;
                cm.addClass(td, 'today');
            }
            if(/0|6/.test(new Date(current['year'], current['month'], day).getDay())){
                params['isWeekend'] = true;
                cm.addClass(td, 'weekend');
            }
            // Add events
            cm.addEvent(div, 'mouseover', function(){
                that.triggerEvent('onDayOver', params);
            });
            cm.addEvent(div, 'mouseout', function(){
                that.triggerEvent('onDayOut', params);
            });
            cm.addEvent(div, 'click', function(){
                that.triggerEvent('onDayClick', params);
            });
            // Add to array
            current['days'][day] = params;
        }
    };

    var getMonthData = function(date){
        var o = {
            'year' : date.getFullYear(),
            'month' : date.getMonth(),
            'days' : {},
            'startWeekDay' : date.getDay()
        };
        o['dayCount'] = 32 - new Date(o['year'], o['month'], 32).getDate();
        return o;
    };

    /* ******* PUBLIC ******* */

    that.getFullYear = function(){
        return current['year'];
    };

    that.getMonth = function(){
        return current['month'];
    };

    that.set = function(year, month, triggerEvents){
        triggerEvents = typeof triggerEvents != 'undefined'? triggerEvents : true;
        if(
            year >= that.params['startYear'] && year <= that.params['endYear']
            && month >= 0 && month <= 11
        ){
            selects['years'].set(year, false);
            selects['months'].set(month, false);
            renderView(triggerEvents);
        }
        return that;
    };

    that.clear = function(triggerEvents){
        triggerEvents = typeof triggerEvents != 'undefined'? triggerEvents : true;
        var date = new Date();
        selects['years'].set(date.getFullYear(), false);
        selects['months'].set(date.getMonth(), false);
        renderView(triggerEvents);
        return that;
    };

    that.renderMonth = function(){
        renderView();
        return that;
    };

    that.getCurrentMonth = function(){
        return current;
    };

    that.nextMonth = function(){
        if(next['year'] <= that.params['endYear']){
            selects['years'].set(next['year'], false);
            selects['months'].set(next['month'], false);
            renderView();
        }
        return that;
    };

    that.prevMonth = function(){
        if(previous['year'] >= that.params['startYear']){
            selects['years'].set(previous['year'], false);
            selects['months'].set(previous['month'], false);
            renderView();
        }
        return that;
    };

    that.selectDay = function(date){
        if(date && current['year'] == date.getFullYear() && current['month'] == date.getMonth()){
            cm.addClass(current['days'][date.getDate()]['container'], 'selected');
        }
    };

    that.unSelectDay = function(date){
        if(date && current['year'] == date.getFullYear() && current['month'] == date.getMonth()){
            cm.removeClass(current['days'][date.getDate()]['container'], 'selected');
        }
    };

    that.getNodes = function(key){
        return nodes[key] || nodes;
    };

    init();
});
cm.define('Com.CalendarEvents', {
    'modules' : [
        'Params',
        'DataConfig',
        'Langs'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'data' : {},
        'format' : cm._config['displayDateFormat'],
        'startYear' : 1950,
        'endYear' : new Date().getFullYear() + 10,
        'startWeekDay' : 0,
        'target' : '_blank',
        'langs' : {
            'daysAbbr' : ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
            'days' : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
            'months' : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
        },
        'Com.Tooltip' : {
            'className' : 'com__calendar-events__tooltip'
        }
    }
},
function(params){
    var that = this;

    that.nodes = {};
    that.components = {};

    var init = function(){
        that.setParams(params);
        that.getDataConfig(that.params['node']);
        // Render
        render();
        setMiscEvents();
    };

    var render = function(){
        // Structure
        that.nodes['container'] = cm.Node('div', {'class' : 'com__calendar-events'});
        // Render calendar
        that.components['calendar'] = new Com.Calendar({
            'container' : that.nodes['container'],
            'renderMonthOnInit' : false,
            'startYear' : that.params['startYear'],
            'endYear' : that.params['endYear'],
            'startWeekDay' : that.params['startWeekDay'],
            'langs' : that.params['langs']
        });
        // Render tooltip
        that.components['tooltip'] = new Com.Tooltip(that.params['Com.Tooltip']);
        // Insert into DOM
        that.params['node'].appendChild(that.nodes['container']);
    };

    var setMiscEvents = function(){
        // Add events on calendars day
        that.components['calendar']
            .addEvent('onDayOver', renderTooltip)
            .addEvent('onMonthRender', markMonthDays)
            .renderMonth();
    };

    var markMonthDays = function(calendar, params){
        var data, day;
        if((data = that.params['data'][params['year']]) && (data = data[(params['month'] + 1)])){
            cm.forEach(data, function(value, key){
                if(day = params['days'][key]){
                    cm.addClass(day['container'], 'active');
                }
            })
        }
    };

    var renderTooltip = function(calendar, params){
        var data,
            myNodes = {};

        if((data = that.params['data'][params['year']]) && (data = data[(params['month'] + 1)]) && (data = data[params['day']])){
            // Structure
            myNodes['content'] = cm.Node('div', {'class' : 'pt__listing com__calendar-events-listing'},
                myNodes['list'] = cm.Node('ul', {'class' : 'list'})
            );
            // Foreach events
            cm.forEach(data, function(value){
                myNodes['list'].appendChild(
                    cm.Node('li',
                        cm.Node('a', {'href' : value['url'], 'target' : that.params['target']}, value['title'])
                    )
                );
            });
            // Show tooltip
            that.components['tooltip']
                .setTarget(params['node'])
                .setTitle(cm.dateFormat(params['date'], that.params['format'], that.lang()))
                .setContent(myNodes['content'])
                .show();
        }
    };

    /* ******* MAIN ******* */

    that.addData = function(data){
        that.params['data'] = cm.merge(that.params['data'], data);
        that.components['calendar'].renderMonth();
        return that;
    };

    that.replaceData = function(data){
        that.params['data'] = data;
        that.components['calendar'].renderMonth();
        return that;
    };

    init();
});
cm.define('Com.CodeHighlight', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'Stack'
    ],
    'events' : [
        'onRender'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'name' : '',
        'language' : 'javascript',
        'lineNumbers' : true
    }
},
function(params){
    var that = this;

    that.components = {};

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['node']);
        render();
        that.addToStack(that.params['node']);
        that.triggerEvent('onRender');
    };

    var render = function(){
        if(typeof CodeMirror != 'undefined'){
            that.components['codemirror'] = CodeMirror.fromTextArea(that.params['node'], {
                'lineNumbers': that.params['lineNumbers'],
                'viewportMargin': Infinity,
                'mode': that.params['language']
            });
            that.components['codemirror'].on('change', function(cm){
                that.params['node'].value = cm.getValue();
            });
        }
    };

    /* ******* PUBLIC ******* */

    init();
});
cm.define('Com.CollapsibleLayout', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'DataNodes',
        'Storage'
    ],
    'events' : [
        'onRender',
        'onCollapseLeft',
        'onExpandLeft',
        'onCollapseRight',
        'onExpandRight'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'remember' : false
    }
},
function(params){
    var that = this;

    that.nodes = {
        'leftButton' : cm.Node('div'),
        'leftContainer' : cm.Node('div'),
        'rightButton': cm.Node('div'),
        'rightContainer' : cm.Node('div')
    };

    that.isLeftCollapsed = false;
    that.isRightCollapsed = false;

    /* *** CLASS FUNCTIONS *** */

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);
        render();
    };

    var render = function(){
        // Left Sidebar
        cm.addEvent(that.nodes['leftButton'], 'click', toggleLeft);
        // Right sidebar
        cm.addEvent(that.nodes['rightButton'], 'click', toggleRight);
        // Check toggle class
        that.isLeftCollapsed = cm.isClass(that.params['node'], 'is-sidebar-left-collapsed');
        that.isRightCollapsed = cm.isClass(that.params['node'], 'is-sidebar-right-collapsed');
        // Check storage
        if(that.params['remember']){
            that.isLeftCollapsed = that.storageRead('isLeftCollapsed');
            that.isRightCollapsed = that.storageRead('isRightCollapsed');
        }
        // Check sidebars visibility
        if(!cm.inDOM(that.nodes['leftContainer']) || cm.getStyle(that.nodes['leftContainer'], 'display') == 'none'){
            that.isLeftCollapsed = true;
        }
        if(!cm.inDOM(that.nodes['rightContainer']) || cm.getStyle(that.nodes['rightContainer'], 'display') == 'none'){
            that.isRightCollapsed = true;
        }
        // Trigger events
        if(that.isLeftCollapsed){
            that.collapseLeft(true);
        }else{
            that.expandLeft(true);
        }
        if(that.isRightCollapsed){
            that.collapseRight(true);
        }else{
            that.expandRight(true);
        }
        that.triggerEvent('onRender');
    };

   var toggleRight = function(){
        if(that.isRightCollapsed){
            that.expandRight();
        }else{
            that.collapseRight();
        }
    };

    var toggleLeft = function(){
        if(that.isLeftCollapsed){
            that.expandLeft();
        }else{
            that.collapseLeft();
        }
    };

    /* ******* MAIN ******* */

    that.collapseLeft = function(isImmediately){
        that.isLeftCollapsed = true;
        isImmediately && cm.addClass(that.params['node'], 'is-immediately');
        cm.replaceClass(that.params['node'], 'is-sidebar-left-expanded', 'is-sidebar-left-collapsed', true);
        isImmediately && cm.removeClass(that.params['node'], 'is-immediately');
        // Write storage
        if(that.params['remember']){
            that.storageWrite('isLeftCollapsed', true);
        }
        that.triggerEvent('onCollapseLeft');
        return that;
    };

    that.expandLeft = function(isImmediately){
        that.isLeftCollapsed = false;
        isImmediately && cm.addClass(that.params['node'], 'is-immediately');
        cm.replaceClass(that.params['node'], 'is-sidebar-left-collapsed', 'is-sidebar-left-expanded', true);
        setTimeout(function(){
            isImmediately && cm.removeClass(that.params['node'], 'is-immediately');
        }, 5);
        // Write storage
        if(that.params['remember']){
            that.storageWrite('isLeftCollapsed', false);
        }
        that.triggerEvent('onExpandLeft');
        return that;
    };

    that.collapseRight = function(isImmediately){
        that.isRightCollapsed = true;
        isImmediately && cm.addClass(that.params['node'], 'is-immediately');
        cm.replaceClass(that.params['node'], 'is-sidebar-right-expanded', 'is-sidebar-right-collapsed', true);
        setTimeout(function(){
            isImmediately && cm.removeClass(that.params['node'], 'is-immediately');
        }, 5);
        // Write storage
        if(that.params['remember']){
            that.storageWrite('isRightCollapsed', true);
        }
        that.triggerEvent('onCollapseRight');
        return that;
    };

    that.expandRight = function(isImmediately){
        that.isRightCollapsed = false;
        isImmediately && cm.addClass(that.params['node'], 'is-immediately');
        cm.replaceClass(that.params['node'], 'is-sidebar-right-collapsed', 'is-sidebar-right-expanded', true);
        isImmediately && cm.removeClass(that.params['node'], 'is-immediately');
        // Write storage
        if(that.params['remember']){
            that.storageWrite('isRightCollapsed', false);
        }
        that.triggerEvent('onExpandRight');
        return that;
    };

    init();
});
Com['Collector'] = function(o){
    var that = this,
        config = cm.merge({
            'attribute' : 'data-element',
            'events' : {}
        }, o),
        API = {
            'onConstructStart' : [],
            'onConstruct' : [],
            'onDestructStart' : [],
            'onDestruct' : []
        },
        stuck = {};

    var init = function(){
        convertEvents(config['events']);
    };

    var constructItem = function(item, name, parentNode){
        var nodes = [];
        // Find element in specified node
        if(parentNode.getAttribute(config['attribute']) == name){
            nodes.push(parentNode)
        }
        // Search for nodes in specified node
        nodes = nodes.concat(
            cm.clone(
                cm.getByAttr(config['attribute'], name, parentNode)
            )
        );
        // Filter off existing nodes
        nodes = nodes.filter(function(node){
            return !cm.inArray(item['nodes'], node);
        });
        // Push new nodes in constructed nodes array
        item['nodes'] = item['nodes'].concat(nodes);
        // Construct
        cm.forEach(nodes, function(node){
            cm.forEach(item['construct'], function(handler){
                handler(node);
            });
        });
    };

    var destructItem = function(item, name, parentNode){
        var nodes = [],
            inArray;
        if(parentNode){
            // Find element in specified node
            if(parentNode.getAttribute(config['attribute']) == name){
                nodes.push(parentNode)
            }
            // Search for nodes in specified node
            nodes = nodes.concat(
                cm.clone(
                    cm.getByAttr(config['attribute'], name, parentNode)
                )
            );
            // Filter off not existing nodes and remove existing from global array
            nodes = nodes.filter(function(node){
                if(inArray = cm.inArray(item['nodes'], node)){
                    item['nodes'].splice(item['nodes'].indexOf(node), 1);
                }
                return inArray;
            });
            // Destruct
            cm.forEach(nodes, function(node){
                cm.forEach(item['destruct'], function(handler){
                    handler(node);
                });
            });
        }else{
            cm.forEach(item['nodes'], function(node){
                cm.forEach(item['destruct'], function(handler){
                    handler(node);
                });
            });
            delete stuck[name];
        }
    };

    /* *** MISC FUNCTIONS *** */

    var convertEvents = function(o){
        cm.forEach(o, function(item, key){
            if(API[key] && typeof item == 'function'){
                API[key].push(item);
            }
        });
    };

    var executeEvent = function(event, params){
        API[event].forEach(function(item){
            item(that, params || {});
        });
    };

    /* *** MAIN *** */

    that.add = function(name, construct, destruct){
        if(name){
            if(!stuck[name]){
                stuck[name] = {
                    'construct' : [],
                    'destruct' : [],
                    'nodes' : []
                };
            }
            if(typeof construct == 'function'){
                stuck[name]['construct'].push(construct);
            }
            if(typeof destruct == 'function'){
                stuck[name]['destruct'].push(destruct);
            }
        }
        return that;
    };

    that.remove = function(name, construct, destruct){
        if(name && stuck[name]){
            if(construct || destruct){
                // Remove item's handlers
                if(typeof construct == 'function'){
                    stuck[name]['construct'] = stuck[name]['construct'].filter(function(handler){
                        return handler != construct;
                    });
                }
                if(typeof destruct == 'function'){
                    stuck[name]['destruct'] = stuck[name]['destruct'].filter(function(handler){
                        return handler != destruct;
                    });
                }
            }else{
                // Remove item from global array
                delete stuck[name];
            }
        }
        return that;
    };

    that.construct = function(node, name){
        node = node || document.body;
        executeEvent('onConstructStart', {
            'node' : node,
            'name' : name
        });
        if(name && stuck[name]){
            constructItem(stuck[name], name, node);
        }else{
            cm.forEach(stuck, function(item, name){
                constructItem(item, name, node);
            });
        }
        executeEvent('onConstruct', {
            'node' : node,
            'name' : name
        });
        return that;
    };

    that.destruct = function(node, name){
        node = node || null;
        executeEvent('onDestructStart', {
            'node' : node,
            'name' : name
        });
        if(name && stuck[name]){
            destructItem(stuck[name], name, node);
        }else{
            cm.forEach(stuck, function(item, name){
                destructItem(item, name, node);
            });
        }
        executeEvent('onDestruct', {
            'node' : node,
            'name' : name
        });
        return that;
    };

    that.addEvent = function(event, handler){
        if(API[event] && typeof handler == 'function'){
            API[event].push(handler);
        }
        return that;
    };

    that.removeEvent = function(event, handler){
        if(API[event] && typeof handler == 'function'){
            API[event] = API[event].filter(function(item){
                return item != handler;
            });
        }
        return that;
    };

    init();
};
cm.define('Com.ColorPicker', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig',
        'Storage',
        'Stack'
    ],
    'require' : [
        'Com.Tooltip',
        'Com.Palette'
    ],
    'events' : [
        'onRender',
        'onSelect',
        'onChange',
        'onClear'
    ],
    'params' : {
        'container' : false,
        'input' : cm.Node('div'),
        'name' : '',
        'value' : null,                        // Color string: transparent | hex | rgba.
        'defaultValue' : 'transparent',
        'title' : '',
        'showInputValue' : true,
        'showClearButton' : false,
        'showTitleTooltip' : true,
        'renderInBody' : true,
        'disabled' : false,
        'icons' : {
            'picker' : 'icon default linked',
            'clear' : 'icon default linked'
        },
        'langs' : {
            'Transparent' : 'Transparent',
            'Clear' : 'Clear'
        },
        'Com.Tooltip' : {
            'targetEvent' : 'click',
            'hideOnReClick' : true,
            'className' : 'com__colorpicker__tooltip',
            'top' : 'cm._config.tooltipTop'
        },
        'Com.Palette' : {
            'setOnInit' : false
        }
    }
},
function(params){
    var that = this;

    that.nodes = {};
    that.components = {};
    that.value = null;
    that.previousValue = null;
    that.disabled = false;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['input']);
        validateParams();
        render();
        setLogic();
        // Add to stack
        that.addToStack(that.nodes['container']);
        // Set
        that.set(that.value, false);
        // Trigger render event
        that.triggerEvent('onRender', that.value);
    };

    var validateParams = function(){
        if(cm.isNode(that.params['input'])){
            that.params['title'] = that.params['input'].getAttribute('title') || that.params['title'];
            that.params['disabled'] = that.params['input'].disabled || that.params['disabled'];
            that.value = that.params['input'].value;
            that.params['name'] = that.params['input'].getAttribute('name') || that.params['name'];
        }
        that.value = that.params['value'] || that.value || that.params['defaultValue'];
        that.disabled = that.params['disabled'];
        that.params['Com.Palette']['name'] = [that.params['name'], 'palette'].join('-');
    };

    var render = function(){
        /* *** RENDER STRUCTURE *** */
        that.nodes['container'] = cm.Node('div', {'class' : 'com__colorpicker'},
            that.nodes['hidden'] = cm.Node('input', {'type' : 'hidden'}),
            that.nodes['target'] = cm.Node('div', {'class' : 'form-field has-icon-right'},
                that.nodes['input'] = cm.Node('input', {'type' : 'text', 'readOnly' : 'true'}),
                that.nodes['icon'] = cm.Node('div', {'class' : that.params['icons']['picker']})
            ),
            that.nodes['menuContainer'] = cm.Node('div', {'class' : 'form'},
                that.nodes['paletteContainer'] = cm.Node('div')
            )
        );
        /* *** ATTRIBUTES *** */
        // Title
        if(that.params['showTitleTooltip'] && !cm.isEmpty(that.params['title'])){
            that.nodes['container'].title = that.params['title'];
        }
        // ID
        if(that.params['input'].id){
            that.nodes['container'].id = that.params['input'].id;
        }
        // Set hidden input attributes
        if(that.params['input'].getAttribute('name')){
            that.nodes['hidden'].setAttribute('name', that.params['input'].getAttribute('name'));
        }
        // Clear Button
        if(that.params['showClearButton']){
            cm.addClass(that.nodes['container'], 'has-clear-button');
            that.nodes['container'].appendChild(
                that.nodes['clearButton'] = cm.Node('div', {'class' : that.params['icons']['clear'], 'title' : that.lang('Clear')})
            );
        }
        /* *** INSERT INTO DOM *** */
        if(that.params['container']){
            that.params['container'].appendChild(that.nodes['container']);
        }else if(that.params['input'].parentNode){
            cm.insertBefore(that.nodes['container'], that.params['input']);
        }
        cm.remove(that.params['input']);
    };

    var setLogic = function(){
        // Add events on input to makes him clear himself when user wants that
        cm.addEvent(that.nodes['input'], 'keydown', function(e){
            e = cm.getEvent(e);
            cm.preventDefault(e);
            if(e.keyCode == 8){
                that.clear();
                that.components['tooltip'].hide();
            }
        });
        // Clear Button
        if(that.params['showClearButton']){
            cm.addEvent(that.nodes['clearButton'], 'click', function(){
                that.clear();
                that.components['tooltip'].hide();
            });
        }
        // Render tooltip
        that.components['tooltip'] = new Com.Tooltip(
            cm.merge(that.params['Com.Tooltip'], {
                'container' : that.params['renderInBody'] ? document.body : that.nodes['container'],
                'content' : that.nodes['menuContainer'],
                'target' : that.nodes['target'],
                'events' : {
                    'onShowStart' : show,
                    'onHideStart' : hide
                }
            })
        );
        // Render palette
        that.components['palette'] = new Com.Palette(
            cm.merge(that.params['Com.Palette'], {
                'container' : that.nodes['menuContainer'],
                'events' : {
                    'onChange' : function(my, value){
                        set(my.get('rgb'), true);
                        that.components['tooltip'].hide();
                    }
                }
            })
        );
        // Enable / Disable
        if(that.disabled){
            that.disable();
        }else{
            that.enable();
        }
    };

    var set = function(color, triggerEvents){
        that.previousValue = that.value;
        if(cm.isEmpty(color)){
            color = that.params['defaultValue'];
        }
        that.value = color;
        that.components['palette'].set(that.value, false);
        that.nodes['hidden'].value = that.components['palette'].get('rgb');
        if(that.value == 'transparent'){
            if(that.params['showInputValue']){
                that.nodes['input'].value = that.lang('Transparent');
            }
            cm.replaceClass(that.nodes['input'], 'input-dark input-light', 'input-transparent');
        }else{
            if(that.params['showInputValue']){
                that.nodes['input'].value = that.components['palette'].get('hex');
            }
            that.nodes['input'].style.backgroundColor = that.components['palette'].get('hex');
            if(that.components['palette'].isDark()){
                cm.replaceClass(that.nodes['input'], 'input-transparent input-light', 'input-dark');
            }else{
                cm.replaceClass(that.nodes['input'], 'input-transparent input-dark', 'input-light');
            }
        }
        if(triggerEvents){
            that.triggerEvent('onSelect', that.value);
            eventOnChange();
        }
    };

    var hide = function(){
        that.nodes['input'].blur();
        cm.removeClass(that.nodes['container'], 'active');
        that.components['palette'].set(that.value, false);
    };

    var show = function(){
        cm.addClass(that.nodes['container'], 'active');
        that.components['palette'].redraw();
    };

    var eventOnChange = function(){
        if(that.value != that.previousValue){
            that.triggerEvent('onChange', that.value);
        }
    };

    /* ******* MAIN ******* */

    that.set = function(color, triggerEvents){
        triggerEvents = typeof triggerEvents != 'undefined'? triggerEvents : true;
        set(color, triggerEvents);
        return that;
    };

    that.get = function(){
        return that.value;
    };

    that.clear = function(triggerEvents){
        triggerEvents = typeof triggerEvents != 'undefined'? triggerEvents : true;
        // Set default color value
        set(that.params['defaultValue'], false);
        // Trigger events
        if(triggerEvents){
            that.triggerEvent('onClear', that.value);
            eventOnChange();
        }
        return that;
    };

    that.disable = function(){
        that.disabled = true;
        cm.addClass(that.nodes['container'], 'disabled');
        that.nodes['input'].disabled = true;
        that.components['tooltip'].disable();
        return that;
    };

    that.enable = function(){
        that.disabled = false;
        cm.removeClass(that.nodes['container'], 'disabled');
        that.nodes['input'].disabled = false;
        that.components['tooltip'].enable();
        return that;
    };

    init();
});
Com.Elements['Columns'] = {};

Com['GetColumns'] = function(id){
    return Com.Elements.Columns[id] || null;
};

cm.define('Com.Columns', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'Stack'
    ],
    'required' : [
        'Com.Draggable'
    ],
    'events' : [
        'onRender',
        'onAdd',
        'onRemove',
        'onChange',
        'onResize'
    ],
    'params' : {
        'container' : cm.Node('div'),
        'name' : '',
        'renderStructure' : false,
        'columns' : false,
        'minColumnWidth' : 48,              // in px
        'data' : []
    }
},
function(params){
    var that = this,
        nodes = {},
        current;

    that.items = [];
    that.chassis = [];

    /* *** INIT *** */

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['container']);
        validateParams();
        render();
        renderChassis();
        that.addToStack(nodes['container']);
        that.triggerEvent('onRender');
    };

    var validateParams = function(){
        if(cm.isNode(that.params['container'])){
            that.params['name'] = that.params['container'].getAttribute('name') || that.params['name'];
        }
    };

    /* *** STRUCTURE *** */

    var render = function(){
        if(that.params['renderStructure']){
            renderStructure();
        }else if(that.params['columns']){
            collect();
        }
        // Add custom event
        cm.customEvent.add(nodes['container'], 'redraw', function(){
            that.redraw();
        });
    };

    var collect = function(){
        var columns;
        // Collect nodes
        nodes['container'] = that.params['columns'];
        nodes['inner'] = cm.getByAttr('data-com__columns', 'inner', nodes['container'])[0];
        nodes['holder'] = cm.getByAttr('data-com__columns', 'holder', nodes['container'])[0];
        // Set editable class
        //cm.addClass(nodes['container'], 'is-editable');
        // Collect only first child columns
        columns = cm.clone(cm.getByAttr('data-com__columns', 'column', nodes['holder']) || []);
        columns = columns.filter(function(item){
            var past = true;
            cm.forEach(columns, function(testItem){
                if(cm.isParent(testItem, item)){
                    past = false;
                }
            });
            return past;
        });
        cm.forEach(columns, collectColumn);
    };

    var renderStructure = function(){
        // Structure
        nodes['container'] = cm.Node('div', {'class' : 'com__columns'},
            nodes['inner'] = cm.Node('div', {'class' : 'inner'},
                nodes['holder'] = cm.Node('div', {'class' : 'container'})
            )
        );
        // Render Columns
        cm.forEach(that.params['data'], renderColumn);
        // Embed
        that.params['container'].appendChild(nodes['container']);
    };

    /* *** COLUMNS *** */

    var collectColumn = function(container){
        var item = {
            'container' : container,
            'inner' : cm.getByAttr('data-com__columns', 'column-inner', container)[0] || cm.Node('div'),
            'width' : container.style.width
        };
        // Render ruler
        renderRuler(item);
        // Push to items array
        that.items.push(item);
    };

    var renderColumn = function(item, execute){
        item = cm.merge({
            'width' : '0%'
        }, item);
        // Structure
        item['container'] = cm.Node('div', {'class' : 'com__column'},
            item['inner'] = cm.Node('div', {'class' : 'inner'})
        );
        // Render ruler
        renderRuler(item);
        // Push to items array
        that.items.push(item);
        // Embed
        nodes['holder'].appendChild(item['container']);
        if(execute){
            // API onAdd event
            that.triggerEvent('onAdd', item);
        }
        return item;
    };

    var removeColumn = function(item, execute){
        var index = that.items.indexOf(item);
        cm.remove(item['container']);
        that.items.splice(index, 1);
        if(execute){
            // API onRemove event
            that.triggerEvent('onRemove', item);
        }
        return item;
    };

    var removeLastColumn = function(execute){
        var item = that.items.pop();
        cm.remove(item['container']);
        if(execute){
            // API onRemove event
            that.triggerEvent('onRemove', item);
        }
        return item;
    };

    var setEqualDimensions = function(){
        var itemsLength = that.items.length,
            width = (100 / itemsLength).toFixed(2);

        cm.forEach(that.items, function(item){
            item['width'] = [width, '%'].join('');
            item['container'].style.width = item['width'];
            item['rulerCounter'].innerHTML = item['width'];
        });
        // API onResize event
        that.triggerEvent('onResize', that.items);
        that.triggerEvent('onChange', that.items);
    };

    /* *** RULERS METHODS *** */

    var renderRuler = function(item){
        // Structure
        item['rulerContainer'] = cm.Node('div', {'class' : 'com__columns__ruler'},
            item['ruler'] = cm.Node('div', {'class' : 'pt__ruler is-horizontal is-small'},
                cm.Node('div', {'class' : 'line line-top'}),
                item['rulerCounter'] = cm.Node('div', {'class' : 'counter'}, item['width']),
                cm.Node('div', {'class' : 'line line-bottom'})
            )
        );
        // Embed
        cm.insertFirst(item['rulerContainer'], item['inner']);
    };

    /* *** CHASSIS METHODS *** */

    var renderChassis = function(){
        that.chassis = [];
        var count = that.items.length - 1;
        cm.forEach(count, renderChassisItem);
    };

    var removeChassis = function(){
        cm.forEach(that.chassis, function(chassis){
            cm.remove(chassis['container']);
        });
        that.chassis = [];
    };

    var updateChassis = function(){
        removeChassis();
        renderChassis();
    };

    var redrawChassis = function(){
        cm.forEach(that.chassis, function(item){
            redrawChassisItem(item);
        });
    };

    var renderChassisItem = function(i){
        var chassis = {
            'index' : i
        };
        // Structure
        chassis['container'] = cm.Node('div', {'class' : 'com__columns__chassis'},
            chassis['drag'] = cm.Node('div', {'class' : 'pt__drag is-horizontal'},
                cm.Node('div', {'class' : 'line'}),
                cm.Node('div', {'class' : 'drag'},
                    cm.Node('div', {'class' : 'icon draggable'})
                )
            )
        );
        // Styles
        redrawChassisItem(chassis);
        // Push to chassis array
        that.chassis.push(chassis);
        // Add events
        cm.addEvent(chassis['container'], 'mousedown', function(e){
            start(e, chassis);
        });
        // Embed
        nodes['inner'].appendChild(chassis['container']);
    };

    var redrawChassisItem = function(chassis){
        var ratio = nodes['holder'].offsetWidth / 100,
            i = chassis['index'],
            left = ((cm.getRealX(that.items[i]['container']) - cm.getRealX(nodes['holder']) + that.items[i]['container'].offsetWidth) / ratio).toFixed(2);
        // Structure
        chassis['container'].style.left = [left, '%'].join('');
    };

    /* *** DRAG FUNCTIONS *** */

    var start = function(e, chassis){
        // If current exists, we don't need to start another drag event until previous will not stop
        if(current){
            return false;
        }
        cm.preventDefault(e);
        // Current
        if(e.ctrlKey){
            blockContextMenu();
            setEqualDimensions();
            redrawChassis();
        }else if(e.button === 0){
            // Hide IFRAMES and EMBED tags
            cm.hideSpecialTags();
            // Get columns
            var index = that.chassis.indexOf(chassis),
                leftColumn = that.items[index],
                rightColumn = that.items[index + 1];

            current = {
                'index' : index,
                'offset' : cm.getRealX(nodes['holder']),
                'ratio' : nodes['holder'].offsetWidth / 100,
                'chassis' : chassis,
                'left' : {
                    'column' : leftColumn,
                    'offset' : cm.getRealX(leftColumn['container'])
                },
                'right' : {
                    'column' : rightColumn,
                    'offset' : cm.getRealX(rightColumn['container']) + rightColumn['container'].offsetWidth
                }
            };
            // Add move event on document
            cm.addClass(nodes['container'], 'is-active');
            cm.addClass(current['chassis']['drag'], 'is-active');
            cm.addClass(current['left']['column']['ruler'], 'is-active');
            cm.addClass(current['right']['column']['ruler'], 'is-active');
            cm.addClass(document.body, 'pt__drag__body--horizontal');
            cm.addEvent(window, 'mousemove', move);
            cm.addEvent(window, 'mouseup', stop);
        }else{
            return false;
        }
        return true;
    };

    var move = function(e){
        cm.preventDefault(e);
        // Calculate sizes and positions
        var x = cm._clientPosition['x'],
            toFixed = e.shiftKey ? 0 : 2,
            leftWidth = x - current['left']['offset'],
            rightWidth = current['right']['offset'] - x;
        // Apply sizes and positions
        if(leftWidth > that.params['minColumnWidth'] && rightWidth > that.params['minColumnWidth']){
            current['left']['column']['width'] = [(leftWidth / current['ratio']).toFixed(toFixed), '%'].join('');
            current['right']['column']['width'] = [(rightWidth / current['ratio']).toFixed(toFixed), '%'].join('');

            current['left']['column']['container'].style.width = current['left']['column']['width'];
            current['right']['column']['container'].style.width = current['right']['column']['width'];
            current['chassis']['container'].style.left = [((x - current['offset']) / current['ratio']).toFixed(toFixed), '%'].join('');

            current['left']['column']['rulerCounter'].innerHTML = current['left']['column']['width'];
            current['right']['column']['rulerCounter'].innerHTML = current['right']['column']['width'];
        }
        // API onResize event
        that.triggerEvent('onChange', that.items);
    };

    var stop = function(){
        // Remove move event from document
        cm.removeClass(nodes['container'], 'is-active');
        cm.removeClass(current['chassis']['drag'], 'is-active');
        cm.removeClass(current['left']['column']['ruler'], 'is-active');
        cm.removeClass(current['right']['column']['ruler'], 'is-active');
        cm.removeClass(document.body, 'pt__drag__body--horizontal');
        cm.removeEvent(window, 'mousemove', move);
        cm.removeEvent(window, 'mouseup', stop);
        current = null;
        // Show IFRAMES and EMBED tags
        cm.showSpecialTags();
        // API onResize event
        that.triggerEvent('onResize', that.items);
    };

    /* *** HELPERS *** */

    var blockContextMenu = function(){
        cm.addEvent(window, 'contextmenu', contextMenuHandler);
        cm.addEvent(window, 'mouseup', restoreContextMenu);
    };

    var restoreContextMenu = function(){
        cm.removeEvent(window, 'contextmenu', contextMenuHandler);
        cm.removeEvent(window, 'mouseup', restoreContextMenu);
    };

    var contextMenuHandler = function(e){
        cm.preventDefault(e);
    };

    /* ******* PUBLIC ******* */

    that.redraw = function(){
        redrawChassis();
        return that;
    };

    that.setColumnsCount = function(count){
        var itemsLength = that.items.length;
        if(!count || itemsLength == count){
            return that;
        }
        if(itemsLength < count){
            // Add new columns
            cm.forEach(count - itemsLength, function(){
                renderColumn({}, true);
            });
        }else{
            // Remove columns from last
            while(that.items.length > count){
                removeLastColumn(true);
            }
        }
        setEqualDimensions();
        updateChassis();
        return that;
    };

    that.get = function(){
        return that.items;
    };

    init();
});
cm.define('Com.ColumnsHelper', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig',
        'DataNodes',
        'Callbacks',
        'Stack'
    ],
    'events' : [
        'onRender',
        'onChange',
        'onResize',
        'onDragStart',
        'onDragMove',
        'onDragStop'
    ],
    'params' : {
        'node' : cm.node('div'),
        'name' : '',
        'isEditMode' : true,
        'items' : [],
        'showDrag' : true,
        'minColumnWidth' : 48,              // in px
        'ajax' : {
            'type' : 'json',
            'method' : 'post',
            'url' : '',                                             // Request URL. Variables: %items%, %callback% for JSONP.
            'params' : ''                                           // Params object. %items%, %callback% for JSONP.
        }
    }
},
function(params){
    var that = this;

    that.items = [];
    that.chassis = [];
    that.current = null;
    that.isEditMode = false;
    that.isRendered = false;
    that.isAjax = false;
    that.isProcess = false;
    that.ajaxHandler = null;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);
        that.callbacksProcess();
        validateParams();
        render();
        that.addToStack(that.params['node']);
        that.triggerEvent('onRender');
    };

    var validateParams = function(){
        if(!cm.isEmpty(that.params['ajax']['url'])){
            that.isAjax = true;
        }
        that.isEditMode = that.params['isEditMode'];
    };

    var render = function(){
        renderChassis();
        // Add window event
        cm.addEvent(window, 'resize', function(){
            that.redraw();
        });
        // Add custom event
        cm.customEvent.add(that.params['node'], 'redraw', function(){
            that.redraw();
        });
    };

    var renderChassis = function(){
        if(that.isEditMode && !that.isRendered){
            that.items = [];
            that.chassis = [];
            cm.forEach(that.params['items'], function(item, i){
                that.items.push({
                    'container' : item
                });
                if(i < that.params['items'].length - 1){
                    renderChassisItem(i);
                }
            });
            that.isRendered = true;
        }
    };

    var renderChassisItem = function(i){
        var chassis = {
            'index' : i
        };
        // Structure
        chassis['container'] = cm.node('div', {'class' : 'com__columns__chassis'},
            chassis['inner'] = cm.node('div', {'class' : 'pt__drag is-horizontal'},
                cm.node('div', {'class' : 'line'})
            )
        );
        if(that.params['showDrag']){
            chassis['inner'].appendChild(
                cm.node('div', {'class' : 'drag'},
                    cm.node('div', {'class' : 'icon draggable'})
                )
            );
        }else{
            chassis['inner'].appendChild(
                cm.node('div', {'class' : 'helper'})
            );
        }
        // Styles
        redrawChassisItem(chassis);
        // Push to chassis array
        that.chassis.push(chassis);
        // Add events
        cm.addEvent(chassis['container'], 'mousedown', function(e){
            start(e, chassis);
        });
        // Embed
        that.params['node'].appendChild(chassis['container']);
    };

    var redrawChassisItem = function(chassis){
        var ratio = that.params['node'].offsetWidth / 100,
            i = chassis['index'],
            left = ((cm.getRealX(that.items[i]['container']) - cm.getRealX(that.params['node']) + that.items[i]['container'].offsetWidth) / ratio).toFixed(2);
        chassis['container'].style.left = [left, '%'].join('');
    };

    var redrawChassis = function(){
        cm.forEach(that.chassis, function(item){
            redrawChassisItem(item);
        });
    };

    var removeChassis = function(){
        cm.forEach(that.chassis, function(item){
            cm.remove(item['container']);
        });
        that.items = [];
        that.chassis = [];
        that.isRendered = false;
    };

    /* *** DRAG FUNCTIONS *** */

    var start = function(e, chassis){
        // If current exists, we don't need to start another drag event until previous will not stop
        if(that.current){
            return false;
        }
        // Abort ajax handler
        if(that.isProcess){
            that.abort();
        }
        e = cm.getEvent(e);
        cm.preventDefault(e);
        // Hide IFRAMES and EMBED tags
        cm.hideSpecialTags();
        // If not left mouse button, don't duplicate drag event
        if((cm.is('IE') && cm.isVersion() < 9 && e.button != 1) || (!cm.is('IE') && e.button)){
            return false;
        }
        // Current
        var index = that.chassis.indexOf(chassis),
            leftColumn = that.items[index],
            rightColumn = that.items[index + 1];

        that.current = {
            'index' : index,
            'offset' : cm.getRealX(that.params['node']),
            'ratio' : that.params['node'].offsetWidth / 100,
            'chassis' : chassis,
            'left' : {
                'column' : leftColumn,
                'offset' : cm.getRealX(leftColumn['container'])
            },
            'right' : {
                'column' : rightColumn,
                'offset' : cm.getRealX(rightColumn['container']) + rightColumn['container'].offsetWidth
            }
        };
        // Add move event on document
        cm.addClass(that.params['node'], 'is-chassis-active');
        cm.addClass(that.current['chassis']['inner'], 'is-active');
        cm.addClass(document.body, 'pt__drag__body--horizontal');
        cm.addEvent(window, 'mousemove', move);
        cm.addEvent(window, 'mouseup', stop);
        that.triggerEvent('onDragStart', that.current);
        return true;
    };

    var move = function(e){
        var leftWidth,
            rightWidth;
        e = cm.getEvent(e);
        cm.preventDefault(e);
        var x = e.clientX;
        if(cm.isTouch && e.touches){
            x = e.touches[0].clientX;
        }
        // Calculate sizes and positions
        leftWidth = x - that.current['left']['offset'];
        rightWidth = that.current['right']['offset'] - x;
        // Apply sizes and positions
        if(leftWidth > that.params['minColumnWidth'] && rightWidth > that.params['minColumnWidth']){
            that.current['left']['column']['width'] = [(leftWidth / that.current['ratio']).toFixed(2), '%'].join('');
            that.current['right']['column']['width'] = [(rightWidth / that.current['ratio']).toFixed(2), '%'].join('');

            that.current['left']['column']['container'].style.width = that.current['left']['column']['width'];
            that.current['right']['column']['container'].style.width = that.current['right']['column']['width'];
            that.current['chassis']['container'].style.left = [((x - that.current['offset']) / that.current['ratio']).toFixed(2), '%'].join('');
        }
        // API onResize event
        that.triggerEvent('onChange', that.items);
        that.triggerEvent('onDragMove', that.current);
    };

    var stop = function(){
        var config;
        // Remove move event from document
        cm.removeClass(that.params['node'], 'is-chassis-active');
        cm.removeClass(that.current['chassis']['inner'], 'is-active');
        cm.removeClass(document.body, 'pt__drag__body--horizontal');
        cm.removeEvent((cm.is('IE') && cm.isVersion() < 9? document.body : window), 'mousemove', move);
        cm.removeEvent((cm.is('IE') && cm.isVersion() < 9? document.body : window), 'mouseup', stop);
        // Show IFRAMES and EMBED tags
        cm.showSpecialTags();
        // API onResize event
        that.triggerEvent('onResize', that.items);
        that.triggerEvent('onDragStop', that.current);
        that.current = null;
        // Ajax
        if(that.isAjax){
            config = cm.clone(that.params['ajax']);
            that.ajaxHandler = that.callbacks.request(that, config);
        }
    };

    /* ******* CALLBACKS ******* */

    that.callbacks.prepare = function(that, config){
        var items = [];
        cm.forEach(that.items, function(item){
            items.push(item['width']);
        });
        // Prepare
        config['url'] = cm.strReplace(config['url'], {
            '%items%' : items
        });
        config['params'] = cm.objectReplace(config['params'], {
            '%items%' : items
        });
        return config;
    };

    that.callbacks.request = function(that, config){
        config = that.callbacks.prepare(that, config);
        // Return ajax handler (XMLHttpRequest) to providing abort method.
        return cm.ajax(
            cm.merge(config, {
                'onStart' : function(){
                    that.callbacks.start(that);
                },
                'onEnd' : function(){
                    that.callbacks.end(that);
                }
            })
        );
    };

    that.callbacks.start = function(that){
        that.isProcess = true;
    };

    that.callbacks.end = function(that){
        that.isProcess = false;
    };

    /* ******* PUBLIC ******* */

    that.enableEditMode = function(){
        that.isEditMode = true;
        renderChassis();
        return that;
    };

    that.disableEditMode = function(){
        that.isEditMode = false;
        removeChassis();
        return that;
    };

    that.abort = function(){
        if(that.ajaxHandler && that.ajaxHandler.abort){
            that.ajaxHandler.abort();
        }
        return that;
    };

    that.redraw = function(){
        if(that.isEditMode){
            redrawChassis();
        }
        return that;
    };

    init();
});
cm.define('Com.Dashboard', {
    'modules' : [
        'Params',
        'Events'
    ],
    'events' : [
        'onRender',
        'onInit',
        'onDragStart',
        'onDrop',
        'onRemove',
        'onReplace'
    ],
    'params' : {
        'container' : cm.Node('div'),
        'chassisTag' : 'div',
        'draggableContainer' : 'document.body',      // HTML node | selfParent
        'scroll' : true,
        'scrollNode' : window,
        'scrollSpeed' : 1,                           // ms per 1px
        'renderTemporaryAria' : false,
        'useCSSAnimation' : true,
        'useGracefulDegradation' : true,
        'dropDuration' : 400,
        'moveDuration' : 200,
        'highlightAreas' : true,                     // highlight areas on drag start
        'highlightChassis' : false,
        'animateRemove' : true,
        'removeNode' : true,
        'classes' : {
            'area' : null
        }
    }
},
function(params){
    var that = this,
        nodes = {},
        anims = {},
        areas = [],
        areasList = [],
        draggableList = [],
        filteredAvailableAreas = [],


        checkInt,
        chassisInt,
        pageSize,
        isScrollProccess = false,
        isGracefulDegradation = false,
        isHighlightedAreas = false,

        current,
        currentAboveItem,
        currentPosition,
        currentArea,
        currentChassis,
        previousArea;

    that.currentAreas = [];
    that.currentPlaceholder = null;
    that.currentArea = null;
    that.currentWidget = null;

    /* *** INIT *** */

    var init = function(){
        var areasNodes;

        getCSSHelpers();
        that.setParams(params);
        that.convertEvents(that.params['events']);

        if(that.params['container']){
            // Check Graceful Degradation, and turn it to mobile and old ie.
            if(that.params['useGracefulDegradation'] && ((cm.is('IE') && cm.isVersion() < 9) || cm.isMobile())){
                isGracefulDegradation = true;
            }
            // Init misc
            anims['scroll'] = new cm.Animation(that.params['scrollNode']);
            // Render temporary area
            if(that.params['renderTemporaryAria']){
                nodes['temporaryArea'] = cm.Node('div');
                initArea(nodes['temporaryArea'], {
                    'isTemporary' : true
                });
            }
            // Find drop areas
            areasNodes = cm.getByAttr('data-com-draganddrop', 'area', that.params['container']);
            // Init areas
            cm.forEach(areasNodes, function(area){
                initArea(area, {});
            });
            /* *** EXECUTE API EVENTS *** */
            that.triggerEvent('onInit');
            that.triggerEvent('onRender');
        }
    };

    var getCSSHelpers = function(){
        that.params['dropDuration'] = cm.getTransitionDurationFromRule('.pt__dnd-helper__drop-duration');
        that.params['moveDuration'] = cm.getTransitionDurationFromRule('.pt__dnd-helper__move-duration');
    };

    var initArea = function(node, params){
        // Check, if area already exists
        if(cm.inArray(areasList, node)){
            return;
        }
        // Config
        var area = cm.merge({
                'node' : node,
                'styleObject' : cm.getStyleObject(node),
                'type' : 'area',
                'isLocked' : false,
                'isTemporary' : false,
                'isSystem' : false,
                'isRemoveZone' : false,
                'draggableInChildNodes' : true,
                'cloneDraggable' : false,
                'items' : [],
                'chassis' : [],
                'placeholders' : [],
                'dimensions' : {}
            }, params),
            childNodes;
        // Add mark classes
        cm.addClass(area['node'], 'com__dashboard__area');
        cm.addClass(area['node'], that.params['classes']['area']);
        if(area['isLocked']){
            cm.addClass(area['node'], 'is-locked');
        }else{
            cm.addClass(area['node'], 'is-available');
        }
        // Find draggable elements
        if(area['draggableInChildNodes']){
            childNodes = area['node'].childNodes;
            cm.forEach(childNodes, function(node){
                if(node.tagName && node.getAttribute('data-com-draganddrop') == 'draggable'){
                    area['items'].push(
                        initDraggable(node, area, {})
                    );
                }
            });
        }else{
            childNodes = cm.getByAttr('data-com-draganddrop', 'draggable', area['node']);
            cm.forEach(childNodes, function(node){
                area['items'].push(
                    initDraggable(node, area, {})
                );
            });
        }
        // Push to areas array
        areasList.push(area['node']);
        areas.push(area);
    };

    var initDraggable = function(node, area, params){
        // Config
        var draggable = cm.merge({
            'node' : node,
            'styleObject' : cm.getStyleObject(node),
            'type' : 'item',
            'chassis' : {
                'top' : null,
                'bottom' : null
            },
            'dimensions' : {
                'offsetX' : 0,
                'offsetY' : 0
            }
        }, params);
        draggable['area'] = area;
        draggable['anim'] = new cm.Animation(draggable['node']);
        // Set draggable event on element
        initDraggableDrag(draggable);
        // Return item to push in area array
        draggableList.push(draggable);
        return draggable;
    };

    var initDraggableDrag = function(draggable){
        var dragNode;
        draggable['drag'] = cm.getByAttr('data-com-draganddrop', 'drag', draggable['node'])[0];
        draggable['drag-bottom'] = cm.getByAttr('data-com-draganddrop', 'drag-bottom', draggable['node'])[0];
        // Set draggable event on element
        dragNode = draggable['drag'] || draggable['node'];
        cm.addEvent(dragNode, 'mousedown', function(e){
            start(e, draggable);
        });
        if(draggable['drag-bottom']){
            cm.addEvent(draggable['drag-bottom'], 'mousedown', function(e){
                start(e, draggable);
            });
        }
    };

    /* *** DRAG AND DROP PROCESS ** */

    var start = function(e, widget){
        cm.preventDefault(e);
        // Prevent multiple drag event
        if(that.currentWidget){
            return;
        }
        // Prevent drag event not on LMB
        if(!cm.isTouch && e.button){
            return;
        }
        // Hide IFRAMES and EMBED tags
        cm.hideSpecialTags();
        cm.addClass(document.body, 'com__dashboard__body');
        // Get pointer position
        var params = {
            'left' : cm._clientPosition['x'],
            'top' : cm._clientPosition['y']
        };
        // Filter areas
        that.currentAreas = getDroppableAreas(widget);
        // Drag start event
        that.triggerEvent('onDragStart', {
            'item' : widget,
            'node' : widget['node'],
            'from' : widget['area']
        });
        // Prepare widget, get offset, set start position, set widget as current
        prepareWidget(widget, params);
        // Render placeholders in filtered areas
        renderPlaceholders(that.currentAreas);
        // Find placeholder above widget
        checkPlaceholders(that.currentAreas, params);
        getCurrentPlaceholder(that.currentAreas, params);
        // Add events
        cm.addEvent(window, 'mousemove', move);
        cm.addEvent(window, 'mouseup', stop);
        cm.addScrollEvent(window, scroll);
    };

    var move  = function(e){
        cm.preventDefault(e);
        // Get pointer position
        var params = {
            'left' : cm._clientPosition['x'],
            'top' : cm._clientPosition['y']
        };
        // Move widget
        moveWidget(that.currentWidget, params, true);
        // Find placeholder above widget
        checkPlaceholders(that.currentAreas, params);
        getCurrentPlaceholder(that.currentAreas, params);
    };

    var stop = function(){
        // Unhighlight Placeholder
        unhighlightPlaceholder(that.currentPlaceholder);
        // Drop widget
        if(!that.currentArea || that.currentArea['isRemoveZone'] || that.currentArea['isTemporary']){
            cm.log(1);
            removeWidget(that.currentWidget, {
                'onStop' : clear
            });
        }else{
            dropWidget(that.currentWidget, that.currentArea, {
                'index' : that.currentPlaceholder['index'],
                'placeholder' : that.currentPlaceholder,
                'onStop' : clear
            });
        }
        // Show IFRAMES and EMBED tags
        cm.showSpecialTags();
        cm.removeClass(document.body, 'com__dashboard__body');
        // Remove move events attached on document
        cm.removeEvent(window, 'mousemove', move);
        cm.removeEvent(window, 'mouseup', stop);
        cm.removeScrollEvent(window, scroll);
    };

    var scroll = function(){
        // Get pointer position
        var params = {
            'left' : cm._clientPosition['x'],
            'top' : cm._clientPosition['y']
        };
        // Update placeholders position
        updatePlaceholdersDimensions(that.currentAreas, params);
        // Find placeholder above widget
        getCurrentPlaceholder(that.currentAreas, params);
    };

    var clear = function(){
        removePlaceholders(that.currentAreas);
        // Clear variables
        that.currentAreas = [];
        that.currentPlaceholder = null;
        that.currentArea = null;
        that.currentWidget = null;
    };

    var startold = function(e, draggable){
        // If current exists, we don't need to start another drag event until previous will not stop
        if(current){
            return;
        }
        cm.preventDefault(e);
        // Hide IFRAMES and EMBED tags
        cm.hideSpecialTags();
        // Check event type and get cursor / finger position
        var x = cm._clientPosition['x'],
            y = cm._clientPosition['y'],
            tempCurrentAboveItem,
            tempCurrentPosition;
        if(!cm.isTouch){
            // If not left mouse button, don't duplicate drag event
            if((cm.is('IE') && cm.isVersion() < 9 && e.button != 1) || (!cm.is('IE') && e.button)){
                return;
            }
        }
        pageSize = cm.getPageSize();
        // API onDragStart Event
        that.triggerEvent('onDragStart', {
            'item' : draggable,
            'node' : draggable['node'],
            'from' : draggable['area']
        });
        // Filter areas
        filteredAvailableAreas = areas.filter(function(area){
            // Filter out locked areas and inner areas
            if(cm.isParent(draggable['node'], area['node']) || area['isLocked']){
                return false;
            }
            // True - pass area
            return true;
        });
        // Highlight Areas
        if(that.params['highlightAreas']){
            toggleHighlightAreas();
        }
        // Get position and dimension of current draggable item
        getPosition(draggable);
        // Get offset position relative to touch point (cursor or finger position)
        draggable['dimensions']['offsetX'] = x - draggable['dimensions']['absoluteX1'];
        draggable['dimensions']['offsetY'] = y - draggable['dimensions']['absoluteY1'];
        // Set draggable item to current
        if(draggable['area']['cloneDraggable']){
            current = cloneDraggable(draggable);
        }else{
            current = draggable;
        }
        // Set position and dimension to current draggable node, before we insert it to draggableContainer
        current['node'].style.top = 0;
        current['node'].style.left = 0;
        current['node'].style.width = [current['dimensions']['width'], 'px'].join('');
        cm.setCSSTranslate(current['node'], [current['dimensions']['absoluteX1'], 'px'].join(''), [current['dimensions']['absoluteY1'], 'px'].join(''));
        // Unset area from draggable item
        unsetDraggableFromArea(current);
        // Insert draggable element to body
        if(that.params['draggableContainer'] && that.params['draggableContainer'] != 'selfParent'){
            that.params['draggableContainer'].appendChild(current['node']);
        }
        cm.addClass(current['node'], 'pt__dnd-helper');
        cm.addClass(current['node'], 'is-active', true);
        // Calculate elements position and dimension
        getPositionsAll();
        // Render Chassis Blocks
        renderChassisBlocks();
        // Find above draggable item
        cm.forEach(current['area']['items'], function(draggable){
            if(x >= draggable['dimensions']['absoluteX1'] && x < draggable['dimensions']['absoluteX2'] && y >= draggable['dimensions']['absoluteY1'] && y <= draggable['dimensions']['absoluteY2']){
                tempCurrentAboveItem = draggable;
                // Check above block position
                if((y - tempCurrentAboveItem['dimensions']['absoluteY1']) < (tempCurrentAboveItem['dimensions']['absoluteHeight'] / 2)){
                    tempCurrentPosition = 'top';
                }else{
                    tempCurrentPosition = 'bottom';
                }
            }
        });
        // If current current draggable not above other draggable items
        if(!tempCurrentAboveItem && current['area']['items'].length){
            if(y < current['area']['dimensions']['y1']){
                tempCurrentAboveItem = current['area']['items'][0];
                tempCurrentPosition = 'top';
            }else{
                tempCurrentAboveItem = current['area']['items'][current['area']['items'].length - 1];
                tempCurrentPosition = 'bottom';
            }
        }
        // Set chassis
        if(tempCurrentAboveItem){
            currentChassis = tempCurrentAboveItem['chassis'][tempCurrentPosition];
        }else{
            currentChassis = current['area']['chassis'][0];
        }
        if(currentChassis){
            cm.addClass(currentChassis['node'], 'is-active');
            if(that.params['highlightChassis']){
                cm.addClass(currentChassis['node'], 'is-highlight');
            }
            currentChassis['node'].style.height = [current['dimensions']['absoluteHeight'], 'px'].join('');
        }
        // Set current area and above
        currentArea = current['area'];
        currentAboveItem = tempCurrentAboveItem;
        currentPosition = tempCurrentPosition;
        cm.addClass(currentArea['node'], 'is-active');
        // Set check position event
        //checkInt = setInterval(checkPosition, 5);
        // Add move event on document
        cm.addClass(document.body, 'pt__dnd-body');
        cm.addEvent(window, 'mousemove', move);
        cm.addEvent(window, 'mouseup', stop);
    };

    var moveold = function(e){
        cm.preventDefault(e);
        // Check event type and get cursor / finger position
        var x = cm._clientPosition['x'],
            y = cm._clientPosition['y'],
            posY = y - current['dimensions']['offsetY'],
            posX = x - current['dimensions']['offsetX'],
            styleX,
            styleY,
            tempCurrentArea,
            tempCurrentAboveItem,
            tempCurrentPosition;
        // Calculate drag direction and set new position
        switch(that.params['direction']){
            case 'both':
                styleX = [posX, 'px'].join('');
                styleY = [posY, 'px'].join('');
                break;
            case 'vertical':
                styleX = [current['dimensions']['absoluteX1'], 'px'].join('');
                if(that.params['limit']){
                    if(posY < current['area']['dimensions']['y1']){
                        styleY = [current['area']['dimensions']['y1'], 'px'].join('');
                    }else if(posY > current['area']['dimensions']['y2']){
                        styleY = [current['area']['dimensions']['y2'], 'px'].join('');
                    }else{
                        styleY = [posY, 'px'].join('');
                    }
                }else{
                    styleY = [posY, 'px'].join('');
                }
                break;
            case 'horizontal':
                styleX = [posX, 'px'].join('');
                styleY = [current['dimensions']['absoluteY1'], 'px'].join('');
                break;
        }
        cm.setCSSTranslate(current['node'], styleX, styleY);
        // Scroll node
        if(that.params['scroll']){
        //if(false){
            if(y + 48 > pageSize['winHeight']){
                toggleScroll(1);
            }else if(y - 48 < 0){
                toggleScroll(-1);
            }else{
                toggleScroll(0);
            }
        }
        // Check and recalculate position
        checkPosition();
        // Find above area
        cm.forEach(filteredAvailableAreas, function(area){
            if(x >= area['dimensions']['x1'] && x < area['dimensions']['x2'] && y >= area['dimensions']['y1'] && y <= area['dimensions']['y2']){
                if(!tempCurrentArea){
                    tempCurrentArea = area;
                }else if(area['dimensions']['width'] < tempCurrentArea['dimensions']['width'] || area['dimensions']['height'] < tempCurrentArea['dimensions']['height']){
                    tempCurrentArea = area;
                }
            }
        });
        // Find above draggable item
        if(tempCurrentArea){
            cm.forEach(tempCurrentArea['items'], function(draggable){
                if(x >= draggable['dimensions']['absoluteX1'] && x < draggable['dimensions']['absoluteX2'] && y >= draggable['dimensions']['absoluteY1'] && y <= draggable['dimensions']['absoluteY2']){
                    tempCurrentAboveItem = draggable;
                    // Check above block position
                    if((y - tempCurrentAboveItem['dimensions']['absoluteY1']) < (tempCurrentAboveItem['dimensions']['absoluteHeight'] / 2)){
                        tempCurrentPosition = 'top';
                    }else{
                        tempCurrentPosition = 'bottom';
                    }
                }
            });
        }else{
            tempCurrentArea = currentArea;
        }
        // If current current draggable not above other draggable items
        if(!tempCurrentAboveItem && tempCurrentArea['items'].length){
            if(y < tempCurrentArea['dimensions']['innerY1']){
                tempCurrentAboveItem = tempCurrentArea['items'][0];
                tempCurrentPosition = 'top';
            }else{
                tempCurrentAboveItem = tempCurrentArea['items'][tempCurrentArea['items'].length - 1];
                tempCurrentPosition = 'bottom';
            }
        }
        // Animate previous chassis and get current
        if(currentChassis){
            cm.removeClass(currentChassis['node'], 'is-active is-highlight');
        }
        if(currentAboveItem && tempCurrentAboveItem && currentAboveItem['chassis'][currentPosition] != tempCurrentAboveItem['chassis'][tempCurrentPosition]){
            animateChassis(currentAboveItem['chassis'][currentPosition], 0, that.params['moveDuration']);
            currentChassis = tempCurrentAboveItem['chassis'][tempCurrentPosition];
        }else if(!currentAboveItem && tempCurrentAboveItem){
            animateChassis(currentArea['chassis'][0], 0, that.params['moveDuration']);
            currentChassis = tempCurrentAboveItem['chassis'][tempCurrentPosition];
        }else if(currentAboveItem && !tempCurrentAboveItem){
            animateChassis(currentAboveItem['chassis'][currentPosition], 0, that.params['moveDuration']);
            currentChassis = tempCurrentArea['chassis'][0];
        }else if(!currentAboveItem && !tempCurrentAboveItem && currentArea != tempCurrentArea){
            animateChassis(currentArea['chassis'][0], 0, that.params['moveDuration']);
            currentChassis = tempCurrentArea['chassis'][0];
        }
        // Animate current chassis
        if(currentChassis){
            cm.addClass(currentChassis['node'], 'is-active');
            if(that.params['highlightChassis']){
                cm.addClass(currentChassis['node'], 'is-highlight');
            }
            animateChassis(currentChassis, current['dimensions']['absoluteHeight'], that.params['moveDuration']);
        }
        // Unset classname from previous active area
        if(currentArea && currentArea != tempCurrentArea){
            cm.removeClass(currentArea['node'], 'is-active');
            previousArea = currentArea;
        }
        // Set current to global
        currentArea = tempCurrentArea;
        currentAboveItem = tempCurrentAboveItem;
        currentPosition = tempCurrentPosition;
        // Set active area class name
        if(!(previousArea && previousArea['isTemporary'] && currentArea['isRemoveZone'])){
            cm.addClass(currentArea['node'], 'is-active');
        }
    };

    var stopold = function(e){
        var currentHeight;
        // Remove check position event
        //checkInt && clearInterval(checkInt);
        // Remove move events attached on document
        cm.removeClass(document.body, 'pt__dnd-body');
        cm.removeEvent(window, 'mousemove', move);
        cm.removeEvent(window, 'mouseup', stop);
        // Calculate height of draggable block, like he already dropped in area, to animate height of fake empty space
        getPosition(current);
        current['node'].style.width = [(currentArea['dimensions']['innerWidth'] - current['dimensions']['margin']['left'] - current['dimensions']['margin']['right']), 'px'].join('');
        currentHeight = current['node'].offsetHeight + current['dimensions']['margin']['top'] + current['dimensions']['margin']['bottom'];
        current['node'].style.width = [current['dimensions']['width'], 'px'].join('');
        // If current draggable located above another draggable item, drops after/before it, or drops in area
        if(currentAboveItem){
            // Animate chassis blocks
            if(currentHeight != currentAboveItem['chassis'][currentPosition]['node'].offsetHeight){
                animateChassis(currentAboveItem['chassis'][currentPosition], currentHeight, that.params['dropDuration']);
            }
            // Drop Item to Area
            dropDraggableToArea(current, currentArea, {
                'target' : currentAboveItem['node'],
                'append' : currentPosition == 'top' ? 'before' : 'after',
                'index' : currentArea['items'].indexOf(currentAboveItem) + (currentPosition == 'top' ? 0 : 1),
                'top' : [currentPosition == 'top'? currentAboveItem['dimensions']['absoluteY1'] : currentAboveItem['dimensions']['absoluteY2'], 'px'].join(''),
                'onStop' : unsetCurrentDraggable
            });
        }else if(currentArea['isRemoveZone'] || currentArea['isTemporary']){
            removeDraggable(current, {
                'onStop' : unsetCurrentDraggable
            });
        }else{
            // Animate chassis blocks
            animateChassis(currentArea['chassis'][0], currentHeight, that.params['dropDuration']);
            // Drop Item to Area
            dropDraggableToArea(current, currentArea, {
                'onStop' : unsetCurrentDraggable
            });
        }
        // Unset chassis
        if(currentChassis){
            cm.removeClass(currentChassis['node'], 'is-active is-highlight');
        }
        // Unset active area classname
        if(currentArea){
            cm.removeClass(currentArea['node'], 'is-active');
        }
        // Un Highlight Areas
        if(that.params['highlightAreas']){
            toggleHighlightAreas();
        }
        // Show IFRAMES and EMBED tags
        cm.showSpecialTags();
    };

    /* *** DRAGGABLE MANIPULATION FUNCTIONS *** */

    var cloneDraggable = function(draggable){
        var clonedNode = draggable['node'].cloneNode(true),
            area = that.params['renderTemporaryAria']? areas[0] : draggable['area'],
            clonedDraggable = initDraggable(clonedNode, area, {});

        clonedDraggable['dimensions'] = cm.clone(draggable['dimensions']);
        area['items'].push(clonedDraggable);
        return clonedDraggable;
    };

    var dropDraggableToArea = function(draggable, area, params){
        params = cm.merge({
            'target' : area['node'],
            'append' : 'child',
            'index' : 0,
            'width' : [area['dimensions']['innerWidth'], 'px'].join(''),
            'top' : [area['dimensions']['innerY1'] - draggable['dimensions']['margin']['top'], 'px'].join(''),
            'left' : [area['dimensions']['innerX1'] - draggable['dimensions']['margin']['left'], 'px'].join(''),
            'onStart' : function(){},
            'onStop' : function(){}
        }, params);
        // System onStart event
        params['onStart']();
        // Animate draggable item, like it drops in area
        cm.addClass(draggable['node'], 'is-drop', true);
        draggable['node'].style.width = params['width'];
        cm.setCSSTranslate(draggable['node'], params['left'], params['top']);
        // On Dnimate Stop
        setTimeout(function(){
            // Append element in new position
            switch(params['append']){
                case 'child' :
                    cm.appendChild(draggable['node'], params['target']);
                    break;
                case 'before' :
                    cm.insertBefore(draggable['node'], params['target']);
                    break;
                case 'after' :
                    cm.insertAfter(draggable['node'], params['target']);
                    break;
                case 'first' :
                    cm.insertFirst(draggable['node'], params['target']);
                    break;
            }
            // Remove draggable helper classname
            cm.removeClass(draggable['node'], 'pt__dnd-helper is-drop is-active', true);
            // Reset styles
            draggable['node'].style.left = 'auto';
            draggable['node'].style.top = 'auto';
            draggable['node'].style.width = 'auto';
            cm.setCSSTranslate(current['node'], 'auto', 'auto');
            // Set index of draggable item in new area
            area['items'].splice(params['index'], 0, draggable);
            // API onDrop Event
            that.triggerEvent('onDrop', {
                'item' : draggable,
                'node' : draggable['node'],
                'to' : area,
                'from' : draggable['area'],
                'index' : params['index']
            });
            // Set draggable new area
            draggable['area'] = area;
            // System onStop event
            params['onStop']();
        }, that.params['dropDuration']);
    };

    var removeDraggable = function(draggable, params){
        var style, anim, node;
        // Remove handler
        var handler = function(){
            if(that.params['removeNode']){
                cm.remove(node);
            }
            // Remove from draggable list
            draggableList = draggableList.filter(function(item){
                return item != draggable;
            });
            unsetDraggableFromArea(draggable);
            // API onRemove Event
            if(!params['noEvent']){
                that.triggerEvent('onRemove', {
                    'item' : draggable,
                    'node' : draggable['node'],
                    'from' : draggable['area']
                });
            }
            // System onStop event
            params['onStop']();
        };
        // Config
        params = cm.merge({
            'isCurrent' : draggable === current,
            'isInDOM' : cm.inDOM(draggable['node']),
            'onStart' : function(){},
            'onStop' : function(){}
        }, params);
        // System onStart event
        params['onStart']();
        // If draggable not in DOM, we don't need to wrap and animate it
        if(params['isInDOM'] && that.params['animateRemove']){
            // If draggable is current - just animate pull out left, else - wrap to removable node
            if(params['isCurrent']){
                node = draggable['node'];
                anim = draggable['anim'];
                style = {
                    'left' : [-(draggable['dimensions']['absoluteWidth'] + 50), 'px'].join(''),
                    'opacity' : 0
                }
            }else{
                node = cm.wrap(cm.Node('div', {'class' : 'pt__dnd-removable'}), draggable['node']);
                anim = new cm.Animation(node);
                style = {
                    'height' : '0px',
                    'opacity' : 0
                }
            }
            // Animate draggable, like it disappear
            anim.go({
                'duration' : that.params['dropDuration'],
                'anim' : 'smooth',
                'style' : style,
                'onStop' : handler
            });
        }else{
            node = draggable['node'];
            handler();
        }
    };

    var unsetDraggableFromArea = function(draggable){
        draggable['area']['items'] = draggable['area']['items'].filter(function(item){
            return item != draggable;
        });
    };

    var unsetCurrentDraggable = function(){
        // Remove chassis blocks
        removeChassisBlocks();
        // Reset other
        current = false;
        currentAboveItem = false;
        currentArea = false;
        previousArea = false;
    };

    /* *** WIDGET *** */

    var prepareWidget = function(widget, params){
        updateDimensions(widget);
        // Get offset using pointer position (x and y)
        widget['dimensions']['offsetX'] = widget['dimensions']['absoluteX1'] - params['left'];
        widget['dimensions']['offsetY'] = widget['dimensions']['absoluteY1'] - params['top'];
        // Check clone statement and set widget as current
        if(widget['area']['cloneDraggable']){
            that.currentWidget = cloneDraggable(widget);
        }else{
            that.currentWidget = widget;
        }
        // Unset widget from his area
        unsetDraggableFromArea(that.currentWidget);
        // Set widget start position
        that.currentWidget['node'].style.top = 0;
        that.currentWidget['node'].style.left = 0;
        moveWidget(that.currentWidget, {
            'left' : that.currentWidget['dimensions']['absoluteX1'],
            'top' : that.currentWidget['dimensions']['absoluteY1'],
            'width' : that.currentWidget['dimensions']['width']
        });
        // Insert widget to body
        if(that.params['draggableContainer']){
            that.params['draggableContainer'].appendChild(that.currentWidget['node']);
        }
        // Set helper classes
        cm.addClass(that.currentWidget['node'], 'com__dashboard__helper');
        cm.addClass(that.currentWidget['node'], 'is-active', true);
    };

    var moveWidget = function(widget, params, offset){
        // Calculate
        var left = params['left'],
            top = params['top'],
            node = params['node'] || widget['node'];
        if(offset){
            left += widget['dimensions']['offsetX'];
            top += widget['dimensions']['offsetY'];
        }
        if(typeof params['width'] != 'undefined'){
            node.style.width = [params['width'], 'px'].join('');
        }
        if(typeof params['height'] != 'undefined'){
            node.style.height = [params['height'], 'px'].join('');
        }
        if(typeof params['opacity'] != 'undefined'){
            node.style.opacity = params['opacity'];
        }
        cm.setCSSTranslate(node, [left, 'px'].join(''), [top, 'px'].join(''));
    };

    var resetWidget = function(widget){
        // Remove helper classes
        cm.removeClass(widget['node'], 'com__dashboard__helper is-drop is-active', true);
        // Reset styles
        widget['node'].style.left = 'auto';
        widget['node'].style.top = 'auto';
        widget['node'].style.width = 'auto';
        cm.setCSSTranslate(widget['node'], 'auto', 'auto');
    };

    var dropWidget = function(widget, area, params){
        // Update area dimensions
        updateDimensions(area);
        // Merge params
        params = cm.merge({
            'index' : 0,
            'placeholder' : null,
            'onStart' : function(){},
            'onStop' : function(){}
        }, params);
        // System onStart event
        params['onStart']();
        // Init drop state
        cm.addClass(widget['node'], 'is-drop', true);
        // Update widget dimensions
        updateDimensions(widget);
        // Move widget
        if(params['placeholder']){
            moveWidget(widget, {
                'left' : params['placeholder']['dimensions']['left'] - widget['dimensions']['margin']['left'],
                'top' : params['placeholder']['dimensions']['top'] - widget['dimensions']['margin']['top'],
                'width' : area['dimensions']['innerWidth']
            });
            // Animate placeholder
            cm.transition(params['placeholder']['node'], {
                'properties' : {
                    'height' : [widget['dimensions']['absoluteHeight'], 'px'].join('')
                },
                'duration' : that.params['dropDuration']

            });
        }else{
            moveWidget(widget, {
                'left' : area['dimensions']['innerX1'] - widget['dimensions']['margin']['left'],
                'top' : area['dimensions']['innerY1'] - widget['dimensions']['margin']['top'],
                'width' : area['dimensions']['innerWidth']
            });
        }
        // Animation end event
        setTimeout(function(){
            // Append
            if(params['placeholder']){
                cm.insertBefore(widget['node'], params['placeholder']['node']);
            }else{
                cm.appendChild(widget['node'], area['node']);
            }
            // Reset styles
            resetWidget(widget);
            // Set index of draggable item in new area
            area['items'].splice(params['index'], 0, widget);
            // Drop event
            that.triggerEvent('onDrop', {
                'item' : widget,
                'node' : widget['node'],
                'from' : widget['area'],
                'to' : area,
                'index' : params['index']
            });
            // Set draggable new area
            widget['area'] = area;
            // System onStop event
            params['onStop']();
        }, that.params['dropDuration']);
    };

    var removeWidget = function(widget, params){
        var node;
        // Merge params
        params = cm.merge({
            'onStart' : function(){},
            'onStop' : function(){}
        }, params);
        // System onStart event
        params['onStart']();
        // Check if widget exists and placed in DOM
        if(cm.inDOM(widget['node'])){
            // Update widget dimensions
            updateDimensions(widget);
            // Init drop state
            cm.addClass(widget['node'], 'is-drop', true);
            // Move widget
            if(widget === that.currentWidget){
                node = widget['node'];
                moveWidget(widget, {
                    'left' : -widget['dimensions']['absoluteWidth'],
                    'top' : widget['dimensions']['absoluteY1'],
                    'opacity' : 0
                });
            }else{
                node = cm.wrap(cm.Node('div', {'class' : 'pt__dnd-removable'}), widget['node']);
                cm.transition(node, {
                    'properties' : {
                        'height' : '0px',
                        'opacity' : 0
                    },
                    'duration' : that.params['dropDuration'],
                    'easing' : 'linear'
                });
            }
        }else{
            node = widget['node'];
        }
        // Animation end event
        setTimeout(function(){
            if(that.params['removeNode']){
                cm.remove(node);
            }
            // Remove from draggable list
            draggableList = draggableList.filter(function(item){
                return item != widget;
            });
            unsetDraggableFromArea(widget);
            // API onRemove Event
            if(!params['noEvent']){
                that.triggerEvent('onRemove', {
                    'item' : widget,
                    'node' : widget['node'],
                    'from' : widget['area']
                });
            }
            // System onStop event
            params['onStop']();
        }, that.params['dropDuration']);
    };

    /* *** PLACEHOLDER *** */

    var renderPlaceholders = function(areas){
        var placeholder;
        cm.forEach(areas, function(area){
            if(area['isLocked']){
                return;
            }
            if(!area['items'].length){
                placeholder = renderPlaceholder(area['node'], {
                    'append' : 'appendChild',
                    'isArea' : true
                });
                placeholder['area'] = area;
                placeholder['index'] = 0;
                area['placeholders'].push(placeholder);
            }
            cm.log('start');
            cm.forEach(area['items'], function(widget, i){;
                cm.log(widget);
                if(i === 0){
                    placeholder = renderPlaceholder(widget['node'], {
                        'append' : 'insertBefore'
                    });
                    placeholder['area'] = area;
                    placeholder['index'] = i;
                    area['placeholders'].push(placeholder);
                }
                placeholder = renderPlaceholder(widget['node'], {
                    'append' : 'insertAfter'
                });
                placeholder['area'] = area;
                placeholder['index'] = i + 1;
                area['placeholders'].push(placeholder);
            });
        });
    };

    var renderPlaceholder = function(targetNode, params){
        params = cm.merge({
            'append' : 'appendChild',
            'isArea' : false
        }, params);
        // Placeholder object
        var placeholder = {
            'node' : cm.node(that.params['chassisTag'], {'class' : 'com__dashboard__placeholder'}),
            'isActive' : false,
            'isExpand' : false,
            'index' : 0,
            'area' : null
        };

        params['isArea'] && cm.addClass(placeholder['node'], 'is-area');
        cm[params['append']](placeholder['node'], targetNode);
        placeholder['dimensions'] = cm.getRect(placeholder['node']);
        cm.addClass(placeholder['node'], 'is-show', true);
        return placeholder;
    };

    var removePlaceholders = function(areas){
        cm.forEach(areas, function(area){
            cm.forEach(area['placeholders'], function(placeholder){
                cm.remove(placeholder['node']);
            });
            area['placeholders'] = [];
        });
    };

    var updatePlaceholdersDimensions = function(areas, params){
        cm.forEach(areas, function(area){
            cm.forEach(area['placeholders'], function(placeholder){
                placeholder['dimensions'] = cm.getRect(placeholder['node']);
            });
        });
    };

    var checkPlaceholders = function(areas, params){
        var additional = 96,
            top = params['top'] - additional,
            bottom = params['top'] + additional;
        cm.forEach(areas, function(area){
            cm.forEach(area['placeholders'], function(item){
                if(!cm.inRange(item['dimensions']['top'], item['dimensions']['bottom'], top, bottom)){
                    if(item['isExpand']){
                        collapsePlaceholder(item);
                        updatePlaceholdersDimensions(areas, params);
                        checkPlaceholders(areas, params);
                    }
                }else{
                    if(!item['isExpand']){
                        expandPlaceholder(item);
                        updatePlaceholdersDimensions(areas, params);
                        checkPlaceholders(areas, params);
                    }
                }
            });
        });
    };

    var getPlaceholder = function(areas, params){
        var placeholder;
        cm.forEach(areas, function(area){
            cm.forEach(area['placeholders'], function(item){
                if(
                    item['dimensions']['left'] <= params['left'] &&
                    item['dimensions']['right'] >= params['left'] &&
                    item['dimensions']['top']  <= params['top'] &&
                    item['dimensions']['bottom'] >= params['top']
                ){
                    placeholder = item;
                }
            });
        });
        return placeholder;
    };

    var getCurrentPlaceholder = function(areas, params){
        var placeholder = getPlaceholder(areas, params);
        if(!placeholder){
            placeholder = that.currentPlaceholder;
        }
        if(that.currentPlaceholder && placeholder != that.currentPlaceholder){
            unhighlightPlaceholder(that.currentPlaceholder);
        }
        if(placeholder && placeholder != that.currentPlaceholder){
            highlightPlaceholder(placeholder);
        }
        that.currentPlaceholder = placeholder;
        // Get current area
        if(that.currentPlaceholder){
            that.currentArea = that.currentPlaceholder['area'];
        }
        // Update placeholders position
        updatePlaceholdersDimensions(areas, params);
    };

    var expandPlaceholder = function(placeholder){
        if(placeholder && !placeholder['isExpand']){
            placeholder['isExpand'] = true;
            cm.addClass(placeholder['node'], 'is-expand', true);
        }
    };

    var collapsePlaceholder = function(placeholder){
        if(placeholder && placeholder['isExpand']){
            placeholder['isExpand'] = false;
            cm.removeClass(placeholder['node'], 'is-expand', true);
        }
    };

    var highlightPlaceholder = function(placeholder){
        if(placeholder && !placeholder['isActive']){
            highlightArea(placeholder['area']);
            placeholder['isActive'] = true;
            cm.addClass(placeholder['node'], 'is-active');
        }
    };

    var unhighlightPlaceholder = function(placeholder){
        if(placeholder && placeholder['isActive']){
            unhighlightArea(placeholder['area']);
            placeholder['isActive'] = false;
            cm.removeClass(placeholder['node'], 'is-active');
        }
    };

    /* *** CHASSIS FUNCTIONS *** */

    var renderChassisBlocks = function(){
        var chassis;
        cm.forEach(areas, function(area){
            if(area['isLocked']){
                return;
            }

            if(!area['items'].length){
                chassis = renderChassis();
                cm.appendChild(chassis['node'], area['node']);
                area['chassis'].push(chassis);
            }
            cm.forEach(area['items'], function(draggable, i){
                if(i === 0){
                    chassis = renderChassis();
                    cm.insertBefore(chassis['node'], draggable['node']);
                    area['chassis'].push(chassis);
                }
                chassis = renderChassis();
                cm.insertAfter(chassis['node'], draggable['node']);
                area['chassis'].push(chassis);
                // Associate with draggable
                draggable['chassis']['top'] = area['chassis'][i];
                draggable['chassis']['bottom'] = area['chassis'][i + 1];
            });
        });
    };

    var renderChassis = function(){
        var node = cm.Node(that.params['chassisTag'], {'class' : 'pt__dnd-chassis'});
        return {
            'node' : node,
            'anim' : new cm.Animation(node),
            'isShow' : false
        };
    };

    var removeChassisBlocks = function(){
        cm.forEach(areas, function(area){
            cm.forEach(area['chassis'], function(chassis){
                cm.remove(chassis['node']);
            });
            area['chassis'] = [];
        });
    };

    var animateChassis = function(chassis, height, duration) {
        var style;
        height = [height, 'px'].join('');
        if(that.params['useCSSAnimation'] || isGracefulDegradation){
            if(!isGracefulDegradation && (style = cm.getSupportedStyle('transition-duration'))){
                chassis['node'].style[style] = [duration, 'ms'].join('');
            }
            chassis['node'].style.height = height;
        }else{
            chassis['anim'].go({'style' : {'height' : height}, 'anim' : 'smooth', 'duration' : duration});
        }
    };

    /* *** POSITION CALCULATION FUNCTIONS *** */

    var updateDimensions = function(item){
        item['dimensions'] = cm.extend(item['dimensions'], cm.getFullRect(item['node'], item['styleObject']));
    };

    var getPosition = function(item){
        item['dimensions'] = cm.extend(item['dimensions'], cm.getFullRect(item['node'], item['styleObject']));
    };

    var getPositions = function(arr){
        cm.forEach(arr, getPosition);
    };

    var getPositionsAll = function(){
        getPositions(areas);
        cm.forEach(areas, function(area){
            getPositions(area['items']);
        });
    };

    var recalculatePosition = function(item){
        //item['dimensions']['x1'] = cm.getRealX(item['node']);
        item['dimensions']['y1'] = cm.getRealY(item['node']);
        //item['dimensions']['x2'] = item['dimensions']['x1'] + item['dimensions']['width'];
        item['dimensions']['y2'] = item['dimensions']['y1'] + item['dimensions']['height'];

        //item['dimensions']['innerX1'] = item['dimensions']['x1'] + item['dimensions']['padding']['left'];
        item['dimensions']['innerY1'] = item['dimensions']['y1'] + item['dimensions']['padding']['top'];
        //item['dimensions']['innerX2'] = item['dimensions']['innerX1'] + item['dimensions']['innerWidth'];
        item['dimensions']['innerY2'] = item['dimensions']['innerY1'] + item['dimensions']['innerHeight'];

        //item['dimensions']['absoluteX1'] = item['dimensions']['x1'] - item['dimensions']['margin']['left'];
        item['dimensions']['absoluteY1'] = item['dimensions']['y1'] - item['dimensions']['margin']['top'];
        //item['dimensions']['absoluteX2'] = item['dimensions']['x2'] + item['dimensions']['margin']['right'];
        item['dimensions']['absoluteY2'] = item['dimensions']['y2'] + item['dimensions']['margin']['bottom'];
    };

    var recalculatePositions = function(arr){
        cm.forEach(arr, recalculatePosition);
    };

    var recalculatePositionsAll = function(){
        var chassisHeight = 0;
        // Reset current active chassis height, cause we need to calculate clear positions
        if(currentChassis){
            cm.addClass(currentChassis['node'], 'is-immediately');
            chassisHeight = currentChassis['node'].offsetHeight;
            currentChassis['node'].style.height = 0;
        }
        recalculatePositions(areas);
        cm.forEach(areas, function(area){
            recalculatePositions(area['items']);
        });
        // Restoring chassis height after calculation
        if(currentChassis && chassisHeight){
            currentChassis['node'].style.height = [chassisHeight, 'px'].join('');
            (function(currentChassis){
                setTimeout(function(){
                    cm.removeClass(currentChassis['node'], 'is-immediately');
                }, 5);
            })(currentChassis);
        }
    };

    var checkPosition = function(){
        var filteredAreas = getFilteredAreas();
        if(filteredAreas[0]['dimensions']['y1'] != cm.getRealY(filteredAreas[0]['node'])){
            recalculatePositionsAll();
        }
    };

    /* *** AREA FUNCTIONS *** */

    var getFilteredAreas = function(){
        return areas.filter(function(area){
            // Filter out temporary and system areas
            if(area['isTemporary'] || area['isSystem']){
                return false;
            }
            // True - pass area
            return true;
        });
    };

    var getDroppableAreas = function(widget){
        return areas.filter(function(area){
            // Filter out locked areas and inner areas
            if(cm.isParent(widget['node'], area['node']) || area['isLocked']){
                return false;
            }
            // True - pass area
            return true;
        });
    };

    var getRemoveZones = function(){
        return areas.filter(function(area){
            return area['isRemoveZone'];
        });
    };

    var toggleHighlightAreas = function(){
        if(filteredAvailableAreas){
            if(isHighlightedAreas){
                isHighlightedAreas = false;
                cm.forEach(filteredAvailableAreas, function(area){
                    cm.removeClass(area['node'], 'is-highlight');
                });
            }else{
                isHighlightedAreas = true;
                cm.forEach(filteredAvailableAreas, function(area){
                    cm.addClass(area['node'], 'is-highlight');
                });
            }
        }
    };

    var highlightArea = function(area){
        if(area && !area['isActive']){
            area['isActive'] = true;
            cm.addClass(area['node'], 'is-active');
        }
    };

    var unhighlightArea = function(area){
        if(area && area['isActive']){
            area['isActive'] = false;
            cm.removeClass(area['node'], 'is-active');
        }
    };

    /* *** HELPERS *** */

    var toggleScroll = function(speed){
        var scrollRemaining,
            duration,
            styles = {};

        if(speed == 0){
            isScrollProccess = false;
            anims['scroll'].stop();
        }else if(speed < 0 && !isScrollProccess){
            isScrollProccess = true;
            duration = cm.getScrollTop(that.params['scrollNode']) * that.params['scrollSpeed'];
            if(cm.isWindow(that.params['scrollNode'])){
                styles['docScrollTop'] = 0;
            }else{
                styles['scrollTop'] = 0;
            }
            anims['scroll'].go({'style' : styles, 'duration' : duration, 'onStop' : function(){
                isScrollProccess = false;
                //getPositionsAll();
                //recalculatePositionsAll();
            }});
        }else if(speed > 0 && !isScrollProccess){
            isScrollProccess = true;
            scrollRemaining = cm.getScrollHeight(that.params['scrollNode']) - pageSize['winHeight'];
            if(cm.isWindow(that.params['scrollNode'])){
                styles['docScrollTop'] = scrollRemaining;
            }else{
                styles['scrollTop'] = scrollRemaining;
            }
            duration = scrollRemaining * that.params['scrollSpeed'];
            anims['scroll'].go({'style' : styles, 'duration' : duration, 'onStop' : function(){
                isScrollProccess = false;
                //getPositionsAll();
                //recalculatePositionsAll();
            }});
        }
    };

    /* ******* MAIN ******* */

    that.getArea = function(node){
        var area;
        cm.forEach(areas, function(item){
            if(item['node'] === node){
                area = item;
            }
        });
        return area;
    };

    that.registerArea = function(node, params){
        if(cm.isNode(node) && node.tagName){
            initArea(node, params || {});
        }
        return that;
    };

    that.removeArea = function(node, params){
        if(cm.isNode(node) && cm.inArray(areasList, node)){
            areasList = areasList.filter(function(area){
                return area != node;
            });
            areas = areas.filter(function(area){
                return area['node'] != node;
            });
        }
        return that;
    };

    that.getDraggable = function(node){
        var draggable;
        cm.forEach(draggableList, function(item){
            if(item['node'] === node){
                draggable = item;
            }
        });
        return draggable;
    };

    that.getDraggableList = function(){
        return draggableList;
    };

    that.registerDraggable = function(node, areaNode, params){
        var draggable, area, newDraggable, index, childNodes, draggableNodes = [];
        // Find draggable item by node
        draggable = that.getDraggable(node);
        // If draggable already exists - reinit it, else - init like new draggable item
        if(draggable){
            initDraggableDrag(draggable);
        }else if(cm.inArray(areasList, areaNode)){
            node.setAttribute('data-com-draganddrop', 'draggable');
            // Fins area item by node
            area = that.getArea(areaNode);
            // Find draggable index
            if(area['draggableInChildNodes']){
                childNodes = area['node'].childNodes;
                cm.forEach(childNodes, function(node){
                    if(node.tagName && node.getAttribute('data-com-draganddrop') == 'draggable'){
                        draggableNodes.push(node);
                    }
                });
            }else{
                draggableNodes = cm.getByAttr('data-com-draganddrop', 'draggable', area['node']);
            }
            index = draggableNodes.indexOf(node);
            // Register draggable
            newDraggable = initDraggable(node, area, params || {});
            area['items'].splice(index, 0, newDraggable);
        }
        return that;
    };

    that.replaceDraggable = function(oldDraggableNode, newDraggableNode, params){
        var oldDraggable,
            newDraggable;
        // Find draggable item
        cm.forEach(draggableList, function(item){
            if(item['node'] === oldDraggableNode){
                oldDraggable = item;
            }
        });
        if(oldDraggable){
            // Find old draggable area and index in area
            var area = oldDraggable['area'],
                index = area['items'].indexOf(oldDraggable),
                node = cm.wrap(cm.Node('div', {'class' : 'pt__dnd-removable', 'style' : 'height: 0px;'}), newDraggableNode);
            // Append new draggable into DOM
            cm.insertAfter(node, oldDraggableNode);
            // Remove old draggable
            removeDraggable(oldDraggable, params);
            // Animate new draggable
            cm.transition(node, {
                'properties' : {
                    'height' : [cm.getRealHeight(node, 'offset', 0), 'px'].join(''),
                    'opacity' : 1
                },
                'duration' : that.params['dropDuration'],
                'easing' : 'linear',
                'onStop' : function(){
                    cm.insertAfter(newDraggableNode, node);
                    cm.remove(node);
                    // Register new draggable
                    newDraggable = initDraggable(newDraggableNode, area);
                    area['items'].splice(index, 0, newDraggable);
                    // API onEmbed event
                    that.triggerEvent('onReplace', {
                        'item' : newDraggable,
                        'node' : newDraggable['node'],
                        'to' : newDraggable['to']
                    });
                }
            });

        }
        return that;
    };

    that.removeDraggable = function(node, params){
        var draggable;
        // Find draggable item
        cm.forEach(draggableList, function(item){
            if(item['node'] === node){
                draggable = item;
            }
        });
        if(draggable){
            // Remove
            removeDraggable(draggable, params || {});
        }
        return that;
    };

    that.getOrderingNodes = function(){
        var results = [],
            arr,
            filteredAreas = getFilteredAreas();
        // Build array
        cm.forEach(filteredAreas, function(area){
            arr = {
                'area' : area['node'],
                'items' : []
            };
            cm.forEach(area['items'], function(item){
                arr['items'].push(item['node']);
            });
            results.push(arr);
        });
        return filteredAreas.length == 1 ? arr['items'] : results;
    };

    that.getOrderingIDs = function(){
        var results = {},
            arr,
            filteredAreas = getFilteredAreas();
        // Build array
        cm.forEach(filteredAreas, function(area){
            arr = {};
            cm.forEach(area['items'], function(item, i){
                if(!item['id']){
                    throw new Error('Attribute "data-id" not specified on item node.');
                }
                arr[item['id']] = i;
            });
            results[area['id']] = arr;
        });
        return filteredAreas.length == 1 ? arr : results;
    };
    
    init();
});
cm.define('Com.DateSelect', {
    'modules' : [
        'Params',
        'DataConfig',
        'Langs',
        'Events'
    ],
    'events' : [
        'onSelect',
        'onChange'
    ],
    'params' : {
        'container' : false,
        'input' : cm.Node('input', {'type' : 'text'}),
        'format' : 'cm._config.dateFormat',
        'startYear' : 1950,
        'endYear' : new Date().getFullYear() + 10,
        'renderSelectsInBody' : true,
        'langs' : {
            'Day' : 'Day',
            'Month' : 'Month',
            'Year' : 'Year',
            'months' : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
        }
    }
},
function(params){
    var that = this,
        nodes = {},
        components = {},
        defaultDate = {
            'day' : '00',
            'month' : '00',
            'year' : '0000'
        };
    
    that.previous = cm.clone(defaultDate);
    that.selected = cm.clone(defaultDate);

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['node']);
        render();
        // Set selected date
        set(that.params['input'].value);
    };

    var render = function(){
        /* *** RENDER STRUCTURE *** */
        nodes['container'] = cm.Node('div', {'class' : 'com-dateselect'},
            nodes['hidden'] = cm.Node('input', {'type' : 'hidden'}),
            cm.Node('div', {'class' : 'pt__toolbar bottom'},
                cm.Node('div', {'class' : 'inner clear'},
                    cm.Node('ul', {'class' : 'group'},
                        nodes['year'] = cm.Node('li', {'class' : 'is-field small'}),
                        nodes['month'] = cm.Node('li', {'class' : 'is-field medium'}),
                        nodes['day'] = cm.Node('li', {'class' : 'is-field x-small'})
                    )
                )
            )
        );
        renderSelects();
        /* *** ATTRIBUTES *** */
        // Set hidden input attributes
        if(that.params['input'].getAttribute('name')){
            nodes['hidden'].setAttribute('name', that.params['input'].getAttribute('name'));
        }
        /* *** INSERT INTO DOM *** */
        if(that.params['container']){
            that.params['container'].appendChild(nodes['container']);
        }else if(that.params['input'].parentNode){
            cm.insertBefore(nodes['container'], that.params['input']);
        }
        cm.remove(that.params['input']);
    };

    var renderSelects = function(){
        var data, i;
        // Days
        data = [
            {'value' : '00', 'text' : that.lang('Day')}
        ];
        for(i = 1; i <= 31; i++){
            data.push({'value' : cm.addLeadZero(i), 'text' : i});
        }
        components['day'] = new Com.Select({
            'container' : nodes['day'],
            'options' : data,
            'renderInBody' : that.params['renderSelectsInBody'],
            'events' : {
                'onChange' :  function(select, item){
                    that.previous = cm.clone(that.selected);
                    that.selected['day'] = item;
                    setMisc(true);
                }
            }
        });
        // Months
        data = [
            {'value' : '00', 'text' : that.lang('Month')}
        ];
        cm.forEach(that.lang('months'), function(month, i){
            data.push({'value' : cm.addLeadZero(parseInt(i + 1)), 'text' : month});
        });
        components['month'] = new Com.Select({
            'container' : nodes['month'],
            'options' : data,
            'renderInBody' : that.params['renderSelectsInBody'],
            'events' : {
                'onChange' : function(select, item){
                    that.previous = cm.clone(that.selected);
                    that.selected['month'] = item;
                    setMisc(true);
                }
            }
        });
        // Years
        data = [
            {'value' : '0000', 'text' : that.lang('Year')}
        ];
        for(i = that.params['endYear']; i >= that.params['startYear']; i--){
            data.push({'value' : i, 'text' : i});
        }
        components['year'] = new Com.Select({
            'container' : nodes['year'],
            'options' : data,
            'renderInBody' : that.params['renderSelectsInBody'],
            'events' : {
                'onChange' : function(select, item){
                    that.previous = cm.clone(that.selected);
                    that.selected['year'] = item;
                    setMisc(true);
                }
            }
        });
    };

    var set = function(str, execute){
        that.previous = cm.clone(that.selected);
        if(!str || str == toStr(defaultDate)){
            that.selected = cm.clone(defaultDate);
        }else{
            if(str instanceof Date){
                that.selected = fromStr(cm.parseDate(str));
            }else{
                that.selected = fromStr(str);
            }
        }
        components['day'].set(that.selected['day'], false);
        components['month'].set(that.selected['month'], false);
        components['year'].set(that.selected['year'], false);
        setMisc(execute);
    };

    var setMisc = function(execute){
        nodes['hidden'].value = toStr(that.selected);
        if(execute){
            // API onSelect event
            that.triggerEvent('onSelect', toStr(that.selected));
            // API onChange event
            if(toStr(that.selected) != toStr(that.previous)){
                that.triggerEvent('onChange', toStr(that.selected));
            }
        }
    };

    var fromStr = function(str, format){
        var o = {},
            convertFormats = {
                '%Y' : 'YYYY',
                '%m' : 'mm',
                '%d' : 'dd'
            },
            formats = {
                'YYYY' : function(value){
                    o['year'] = value;
                },
                'mm' : function(value){
                    o['month'] = value;
                },
                'dd' : function(value){
                    o['day'] = value;
                }
            },
            fromIndex = 0;
        format = format || that.params['format'];
        // Parse
        cm.forEach(convertFormats, function(item, key){
            format = format.replace(key, item);
        });
        cm.forEach(formats, function(item, key){
            fromIndex = format.indexOf(key);
            while(fromIndex != -1){
                item(str.substr(fromIndex, key.length));
                fromIndex = format.indexOf(key, fromIndex + 1);
            }
        });
        return o;
    };

    var toStr = function(o, format){
        var str = format || that.params['format'],
            formats = function(o){
                return {
                    '%Y' : function(){
                        return o['year'];
                    },
                    '%m' : function(){
                        return o['month'];
                    },
                    '%d' : function(){
                        return o['day'];
                    }
                }
            };
        cm.forEach(formats(o), function(item, key){
            str = str.replace(key, item);
        });
        return str;
    };

    /* ******* MAIN ******* */

    that.get = function(format){
        format = format || that.params['format'];
        return toStr(that.selected, format);
    };

    that.getDate = function(){
        return that.selected;
    };

    that.set = function(str){
        set(str, true);
        return that;
    };

    init();
});
Com.Elements['Datepicker'] = {};

Com['GetDatepicker'] = function(id){
    return Com.Elements.Datepicker[id] || null;
};

cm.define('Com.Datepicker', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'Langs',
        'Stack'
    ],
    'events' : [
        'onRender',
        'onSelect',
        'onChange',
        'onClear',
        'onFocus',
        'onBlur'
    ],
    'params' : {
        'container' : false,
        'input' : cm.Node('input', {'type' : 'text'}),
        'name' : '',
        'renderInBody' : true,
        'format' : 'cm._config.dateFormat',
        'displayFormat' : 'cm._config.displayDateFormat',
        'isDateTime' : false,
        'dateTimeFormat' : 'cm._config.dateTimeFormat',
        'displayDateTimeFormat' : 'cm._config.displayDateTimeFormat',
        'minutesInterval' : 1,
        'startYear' : 1950,                                                 // number | current
        'endYear' : 'current + 10',                                         // number | current
        'startWeekDay' : 0,
        'showTodayButton' : true,
        'showClearButton' : false,
        'showTitleTooltip' : true,
        'showPlaceholder' : true,
        'title' : '',
        'placeholder' : '',
        'menuMargin' : 4,
        'value' : 0,
        'disabled' : false,
        'icons' : {
            'datepicker' : 'icon default linked',
            'clear' : 'icon default linked'
        },
        'langs' : {
            'daysAbbr' : ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
            'days' : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
            'months' : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
            'Clear date' : 'Clear date',
            'Today' : 'Today',
            'Now' : 'Now',
            'Time' : 'Time:'
        },
        'Com.Tooltip' : {
            'targetEvent' : 'click',
            'hideOnReClick' : true,
            'className' : 'com__datepicker__tooltip',
            'top' : 'cm._config.tooltipTop'
        }
    }
},
function(params){
    var that = this,
        nodes = {},
        components = {};

    that.date = null;
    that.value = null;
    that.previousValue = null;
    that.format = null;
    that.displayFormat = null;
    that.disabled = false;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['input']);
        validateParams();
        render();
        setLogic();
        // Add to stack
        that.addToStack(nodes['container']);
        // Set selected date
        if(that.params['value']){
            that.set(that.params['value'], that.format, false);
        }else{
            that.set(that.params['input'].value, that.format, false);
        }
        // Trigger events
        that.triggerEvent('onRender', that.value);
    };

    var validateParams = function(){
        if(cm.isNode(that.params['input'])){
            that.params['placeholder'] = that.params['input'].getAttribute('placeholder') || that.params['placeholder'];
            that.params['title'] = that.params['input'].getAttribute('title') || that.params['title'];
            that.params['disabled'] = that.params['input'].disabled || that.params['disabled'];
            that.params['name'] = that.params['input'].getAttribute('name') || that.params['name'];
        }
        if(that.params['value'] == 'now'){
            that.params['value'] = new Date();
        }
        if(/current/.test(that.params['startYear'])){
            that.params['startYear'] = eval(cm.strReplace(that.params['startYear'], {'current' : new Date().getFullYear()}));
        }
        if(/current/.test(that.params['endYear'])){
            that.params['endYear'] = eval(cm.strReplace(that.params['endYear'], {'current' : new Date().getFullYear()}));
        }
        that.format = that.params['isDateTime']? that.params['dateTimeFormat'] : that.params['format'];
        that.displayFormat = that.params['isDateTime']? that.params['displayDateTimeFormat'] : that.params['displayFormat'];
        that.disabled = that.params['disabled'];
    };

    var render = function(){
        /* *** RENDER STRUCTURE *** */
        nodes['container'] = cm.Node('div', {'class' : 'com__datepicker-input'},
            nodes['hidden'] = cm.Node('input', {'type' : 'hidden'}),
            nodes['target'] = cm.Node('div', {'class' : 'form-field has-icon-right'},
                nodes['input'] = cm.Node('input', {'type' : 'text', 'readOnly' : 'true'}),
                nodes['icon'] = cm.Node('div', {'class' : that.params['icons']['datepicker']})
            ),
            nodes['menuContainer'] = cm.Node('div', {'class' : 'form'},
                nodes['calendarContainer'] = cm.Node('div', {'class' : 'calendar-holder'})
            )
        );
        /* *** ATTRIBUTES *** */
        // Title
        if(that.params['showTitleTooltip'] && !cm.isEmpty(that.params['title'])){
            nodes['container'].title = that.params['title'];
        }
        // ID
        if(that.params['input'].id){
            nodes['container'].id = that.params['input'].id;
        }
        // Set hidden input attributes
        if(that.params['name']){
            nodes['hidden'].setAttribute('name', that.params['name']);
        }
        // Placeholder
        if(that.params['showPlaceholder'] && !cm.isEmpty(that.params['placeholder'])){
            nodes['input'].setAttribute('placeholder', that.params['placeholder']);
        }
        // Clear Button
        if(that.params['showClearButton']){
            cm.addClass(nodes['container'], 'has-clear-button');
            nodes['container'].appendChild(
                nodes['clearButton'] = cm.Node('div', {'class' : that.params['icons']['clear'], 'title' : that.lang('Clear date')})
            );
        }
        // Today / Now Button
        if(that.params['showTodayButton']){
            nodes['menuContainer'].appendChild(
                nodes['todayButton'] = cm.Node('div', {'class' : 'button today is-wide'}, that.lang(that.params['isDateTime']? 'Now' : 'Today'))
            );
        }
        // Time Select
        if(that.params['isDateTime']){
            nodes['timeHolder'] = cm.Node('div', {'class' : 'time-holder'},
                cm.Node('dl', {'class' : 'form-box'},
                    cm.Node('dt', that.lang('Time')),
                    nodes['timeContainer'] = cm.Node('dd')
                )
            );
            cm.insertAfter(nodes['timeHolder'], nodes['calendarContainer']);
        }
        /* *** INSERT INTO DOM *** */
        if(that.params['container']){
            that.params['container'].appendChild(nodes['container']);
        }else if(that.params['input'].parentNode){
            cm.insertBefore(nodes['container'], that.params['input']);
        }
        cm.remove(that.params['input']);
    };

    var setLogic = function(){
        // Add events on input to makes him clear himself when user wants that
        cm.addEvent(nodes['input'], 'keydown', function(e){
            e = cm.getEvent(e);
            cm.preventDefault(e);
            if(e.keyCode == 8){
                that.clear();
                components['menu'].hide(false);
            }
        });
        // Clear Button
        if(that.params['showClearButton']){
            cm.addEvent(nodes['clearButton'], 'click', function(){
                that.clear();
                components['menu'].hide(false);
            });
        }
        // Today / Now Button
        if(that.params['showTodayButton']){
            cm.addEvent(nodes['todayButton'], 'click', function(){
                that.set(new Date());
                components['menu'].hide(false);
            });
        }
        // Render tooltip
        components['menu'] = new Com.Tooltip(
            cm.merge(that.params['Com.Tooltip'], {
                'container' : that.params['renderInBody'] ? document.body : nodes['container'],
                'content' : nodes['menuContainer'],
                'target' : nodes['target'],
                'events' : {
                    'onShowStart' : show,
                    'onHideStart' : hide
                }
            })
        );
        // Render calendar
        components['calendar'] = new Com.Calendar({
            'container' : nodes['calendarContainer'],
            'renderSelectsInBody' : false,
            'className' : 'com__datepicker-calendar',
            'startYear' : that.params['startYear'],
            'endYear' : that.params['endYear'],
            'startWeekDay' : that.params['startWeekDay'],
            'langs' : that.params['langs'],
            'renderMonthOnInit' : false,
            'events' : {
                'onMonthRender' : function(){
                    if(that.date){
                        components['calendar'].selectDay(that.date);
                    }
                },
                'onDayClick' : function(calendar, params){
                    if(!that.date){
                        that.date = new Date();
                    }
                    components['calendar'].unSelectDay(that.date);
                    that.date.setDate(params['day']);
                    components['calendar'].selectDay(that.date);
                    set(true);
                    if(!that.params['isDateTime']){
                        components['menu'].hide(false);
                    }
                }
            }
        });
        // Render Time Select
        if(that.params['isDateTime']){
            components['time'] = new Com.TimeSelect({
                    'container' : nodes['timeContainer'],
                    'renderSelectsInBody' : false,
                    'minutesInterval' : that.params['minutesInterval']
                })
                .onChange(function(){
                    if(!that.date){
                        that.date = new Date();
                    }
                    components['calendar'].set(that.date.getFullYear(), that.date.getMonth(), false);
                    components['calendar'].selectDay(that.date);
                    set(true);
                });
        }

        // Enable / Disable
        if(that.disabled){
            that.disable();
        }else{
            that.enable();
        }
    };

    var show = function(){
        // Render calendar month
        if(that.date){
            components['calendar'].set(that.date.getFullYear(), that.date.getMonth())
        }
        components['calendar'].renderMonth();
        // Set classes
        cm.addClass(nodes['container'], 'active');
        that.triggerEvent('onFocus', that.value);
    };

    var hide = function(){
        nodes['input'].blur();
        cm.removeClass(nodes['container'], 'active');
        that.triggerEvent('onBlur', that.value);
    };

    var set = function(triggerEvents){
        that.previousValue = that.value;
        if(that.date){
            // Set date
            that.date.setFullYear(components['calendar'].getFullYear());
            that.date.setMonth(components['calendar'].getMonth());
            // Set time
            if(that.params['isDateTime']){
                that.date.setHours(components['time'].getHours());
                that.date.setMinutes(components['time'].getMinutes());
                that.date.setSeconds(0);
            }
            // Set value
            that.value = cm.dateFormat(that.date, that.format, that.lang());
            nodes['input'].value = cm.dateFormat(that.date, that.displayFormat, that.lang());
            nodes['hidden'].value = that.value;
        }else{
            that.value = cm.dateFormat(false, that.format, that.lang());
            nodes['input'].value = '';
            nodes['hidden'].value = cm.dateFormat(false, that.format, that.lang());
        }
        // Trigger events
        if(triggerEvents){
            that.triggerEvent('onSelect', that.value);
            onChange();
        }
    };
    
    var onChange = function(){
        if(!that.previousValue || (!that.value && that.previousValue) || (that.value != that.previousValue)){
            that.triggerEvent('onChange', that.value);
        }
    };

    /* ******* MAIN ******* */

    that.get = function(format){
        format = typeof format != 'undefined'? format : that.format;
        return cm.dateFormat(that.date, format, that.lang());
    };

    that.getDate = function(){
        return that.date;
    };

    that.getFullYear = function(){
        return that.date? that.date.getFullYear() : null;
    };

    that.getMonth = function(){
        return that.date? that.date.getMonth() : null;
    };

    that.getDay = function(){
        return that.date? that.date.getDate() : null;
    };

    that.getHours = function(){
        return that.date? that.date.getHours() : null;
    };

    that.getMinutes = function(){
        return that.date? that.date.getMinutes() : null;
    };

    that.set = function(str, format, triggerEvents){
        format = typeof format != 'undefined'? format : that.format;
        triggerEvents = typeof triggerEvents != 'undefined'? triggerEvents : true;
        // Get date
        if(cm.isEmpty(str) || typeof str == 'string' && new RegExp(cm.dateFormat(false, format, that.lang())).test(str)){
            that.clear();
            return that;
        }else if(typeof str == 'object'){
            that.date = str;
        }else{
            that.date = cm.parseDate(str, format);
        }
        // Set parameters into components
        components['calendar'].set(that.date.getFullYear(), that.date.getMonth(), false);
        if(that.params['isDateTime']){
            components['time'].set(that.date, null, false);
        }
        // Set date
        set(triggerEvents);
        return that;
    };

    that.clear = function(triggerEvents){
        triggerEvents = typeof triggerEvents != 'undefined'? triggerEvents : true;
        // Clear date
        that.date = null;
        // Clear components
        components['calendar'].clear(false);
        if(that.params['isDateTime']){
            components['time'].clear(false);
        }
        // Set date
        set(false);
        // Trigger events
        if(triggerEvents){
            that.triggerEvent('onClear', that.value);
            onChange();
        }
        return that;
    };

    that.disable = function(){
        that.disabled = true;
        cm.addClass(nodes['container'], 'disabled');
        nodes['input'].disabled = true;
        components['menu'].disable();
        return that;
    };

    that.enable = function(){
        that.disabled = false;
        cm.removeClass(nodes['container'], 'disabled');
        nodes['input'].disabled = false;
        components['menu'].enable();
        return that;
    };

    that.getNodes = function(key){
        return nodes[key] || nodes;
    };

    init();
});
cm.define('Com.Dialog', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig',
        'Stack'
    ],
    'events' : [
        'onRender',
        'onOpenStart',
        'onOpen',
        'onCloseStart',
        'onClose'
    ],
    'params' : {
        'container' : 'document.body',
        'name' : '',
        'size' : 'auto',                // auto | fullscreen
        'width' : 700,                  // number, %, px
        'height' : 'auto',              // number, %, px, auto
        'minHeight' : 0,                // number, %, auto, not applicable when using height
        'maxHeight' : 'auto',           // number, %, auto, not applicable when using height
        'position' : 'fixed',
        'indentY' : 24,
        'indentX' : 24,
        'theme' : 'theme-default',      // theme css class name, default: theme-default
        'className' : '',               // custom css class name
        'content' : cm.Node('div'),
        'title' : '',
        'buttons' : false,
        'titleOverflow' : false,
        'titleReserve': true,
        'closeButtonOutside' : false,
        'closeButton' : true,
        'closeTitle' : true,
        'closeOnBackground' : false,
        'openTime' : 'cm._config.animDuration',
        'autoOpen' : true,
        'appendOnRender' : false,
        'removeOnClose' : true,
        'scroll' : true,
        'documentScroll' : false,
        'icons' : {
            'closeInside' : 'icon default linked',
            'closeOutside' : 'icon default linked'
        },
        'langs' : {
            'closeTitle' : 'Close',
            'close' : ''
        }
    }
},
function(params){
    var that = this,
        contentHeight,
        nodes = {},
        anim = {};

    that.isOpen = false;
    that.isFocus = false;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['content']);
        validateParams();
        render();
        that.addToStack(nodes['container']);
        // Trigger onRender event
        that.triggerEvent('onRender');
        // Open
        that.params['autoOpen'] && open();
    };
    
    var validateParams = function(){
        if(that.params['size'] == 'fullscreen'){
            that.params['width'] = '100%';
            that.params['height'] = '100%';
            that.params['indentX'] = 0;
            that.params['indentY'] = 0;
        }
    };

    var render = function(){
        // Structure
        nodes['container'] = cm.Node('div', {'class' : 'com__dialog'},
            nodes['bg'] = cm.Node('div', {'class' : 'bg'}),
            nodes['window'] = cm.Node('div', {'class' : 'window'},
                nodes['windowInner'] = cm.Node('div', {'class' : 'inner'})
            )
        );
        if(that.params['appendOnRender']){
            that.params['container'].appendChild(nodes['container']);
        }
        // Set that.params styles
        nodes['container'].style.position = that.params['position'];
        nodes['window'].style.width = that.params['width'] + 'px';
        // Add CSS Classes
        !cm.isEmpty(that.params['theme']) && cm.addClass(nodes['container'], that.params['theme']);
        !cm.isEmpty(that.params['className']) && cm.addClass(nodes['container'], that.params['className']);
        if(that.params['size'] == 'fullscreen'){
            cm.addClass(nodes['container'], 'is-fullscreen');
        }
        if(that.params['titleReserve']){
            cm.addClass(nodes['container'], 'is-title-reserve');
        }
        // Render close button
        if(that.params['closeButtonOutside']){
            nodes['bg'].appendChild(
                nodes['closeOutside'] = cm.Node('div', {'class' : that.params['icons']['closeOutside']}, that.lang('close'))
            );
            if(that.params['closeTitle']){
                nodes['closeOutside'].title = that.lang('closeTitle');
            }
            cm.addEvent(nodes['closeOutside'], 'click', close);
        }
        if(that.params['closeButton']){
            cm.addClass(nodes['container'], 'has-close-inside');
            nodes['window'].appendChild(
                nodes['closeInside'] = cm.Node('div', {'class' : that.params['icons']['closeInside']}, that.lang('close'))
            );
            if(that.params['closeTitle']){
                nodes['closeInside'].title = that.lang('closeTitle');
            }
            cm.addEvent(nodes['closeInside'], 'click', close);
        }
        if(that.params['closeOnBackground']){
            cm.addClass(nodes['container'], 'has-close-background');
            cm.addEvent(nodes['bg'], 'click', close);
            if(that.params['closeTitle']){
                nodes['bg'].title = that.lang('closeTitle');
            }
        }
        // Set title
        renderTitle(that.params['title']);
        // Embed content
        renderContent(that.params['content']);
        // Embed buttons
        renderButtons(that.params['buttons']);
        // Init animation
        anim['container'] = new cm.Animation(nodes['container']);
        // Events
        cm.addEvent(nodes['container'], 'mouseover', function(e){
            var target = cm.getEventTarget(e);
            if(cm.isParent(nodes['container'], target, true)){
                that.isFocus = true;
            }
        });
        cm.addEvent(nodes['container'], 'mouseout', function(e){
            var target = cm.getRelatedTarget(e);
            if(!cm.isParent(nodes['container'], target, true)){
                that.isFocus = false;
            }
        });
        // Resize
        animFrame(resize);
    };

    var renderTitle = function(title){
        if(!cm.isEmpty(title)){
            // Remove old nodes
            cm.remove(nodes['title']);
            // Render new nodes
            nodes['title'] = cm.Node('div', {'class' : 'title'}, title);
            if(that.params['titleOverflow']){
                cm.addClass(nodes['title'], 'cm__text-overflow');
            }
            cm.insertFirst(nodes['title'], nodes['windowInner']);
        }
    };

    var renderContent = function(node){
        if(!nodes['descr']){
            nodes['descr'] = cm.Node('div', {'class' : 'descr'},
                nodes['scroll'] = cm.Node('div', {'class' : 'scroll'},
                    nodes['inner'] = cm.Node('div', {'class' : 'inner com__dialog__inner'})
                )
            );
            if(!that.params['scroll']){
                cm.addClass(nodes['scroll'], 'is-no-scroll');
            }
            if(nodes['title']){
                cm.insertAfter(nodes['descr'], nodes['title']);
            }else if(nodes['buttons']){
                cm.insertBefore(nodes['descr'], nodes['buttons']);
            }else{
                cm.insertLast(nodes['descr'], nodes['windowInner']);
            }
        }
        if(cm.isNode(node)){
            cm.clearNode(nodes['inner']).appendChild(node);
        }
    };

    var renderButtons = function(node){
        if(cm.isNode(node)){
            // Remove old nodes
            cm.remove(nodes['buttons']);
            // Render new nodes
            nodes['buttons'] = cm.Node('div', {'class' : 'buttons'}, node);
            cm.insertLast(nodes['buttons'], nodes['windowInner']);
        }
    };

    var resize = function(){
        if(that.isOpen){
            var winHeight = nodes['container'].offsetHeight - (that.params['indentY'] * 2),
                winWidth = nodes['container'].offsetWidth - (that.params['indentX'] * 2),
                windowHeight = nodes['window'].offsetHeight,
                windowWidth = nodes['window'].offsetWidth,
                insetHeight = nodes['inner'].offsetHeight,

                AWidth,
                AHeight,
                NAHeight,

                maxHeight,
                minHeight,
                setHeight,
                setWidth;
            // Calculate available width / height
            AHeight = winHeight
                - (nodes['title'] && nodes['title'].offsetHeight || 0)
                - (nodes['buttons'] && nodes['buttons'].offsetHeight || 0)
                - cm.getIndentY(nodes['windowInner'])
                - cm.getIndentY(nodes['descr']);
            NAHeight = winHeight - AHeight;
            AWidth = winWidth;
            // Calculate min / max height
            if(that.params['maxHeight'] == 'auto'){
                maxHeight = AHeight;
            }else if(/%/.test(that.params['maxHeight'])){
                maxHeight = ((winHeight / 100) * parseFloat(that.params['maxHeight'])) - NAHeight;
            }else{
                if(/px/.test(that.params['maxHeight'])){
                    that.params['maxHeight'] = parseFloat(that.params['maxHeight']);
                }
                maxHeight = that.params['maxHeight'] - NAHeight;
            }
            if(that.params['minHeight'] == 'auto'){
                minHeight = 0;
            }else if(/%/.test(that.params['minHeight'])){
                minHeight = ((winHeight / 100) * parseFloat(that.params['minHeight'])) - NAHeight;
            }else{
                if(/px/.test(that.params['minHeight'])){
                    that.params['minHeight'] = parseFloat(that.params['minHeight']);
                }
                minHeight = that.params['minHeight'] - NAHeight;
            }
            // Calculate height
            if(that.params['height'] == 'auto'){
                if(insetHeight < minHeight){
                    setHeight = minHeight;
                }else if(insetHeight > maxHeight){
                    setHeight = maxHeight;
                }else{
                    setHeight = insetHeight;
                }
            }else if(/%/.test(that.params['height'])){
                setHeight = ((winHeight / 100) * parseFloat(that.params['height'])) - NAHeight;
            }else{
                if(/px/.test(that.params['height'])){
                    that.params['height'] = parseFloat(that.params['height']);
                }
                setHeight = that.params['height'] - NAHeight;
            }
            setHeight = Math.min(Math.max(setHeight, 0), AHeight);
            // Calculate width
            if(/%/.test(that.params['width'])){
                setWidth = ((winWidth / 100) * parseFloat(that.params['width']));
            }else{
                if(/px/.test(that.params['width'])){
                    that.params['width'] = parseFloat(that.params['width']);
                }
                setWidth = that.params['width'];
            }
            setWidth = Math.min(setWidth, AWidth);
            // Set window height
            if(windowHeight != setHeight + NAHeight || contentHeight != insetHeight){
                contentHeight = insetHeight;
                if(insetHeight <= setHeight){
                    cm.removeClass(nodes['scroll'], 'is-scroll');
                }else if(that.params['scroll']){
                    cm.addClass(nodes['scroll'], 'is-scroll');
                }
                nodes['scroll'].style.height = [setHeight, 'px'].join('');
            }
            // Set window width
            if(windowWidth != setWidth){
                nodes['window'].style.width = [setWidth, 'px'].join('')
            }
        }
        animFrame(resize);
    };

    var open = function(){
        if(!that.isOpen){
            that.isOpen = true;
            if(!cm.inDOM(nodes['container'])){
                that.params['container'].appendChild(nodes['container']);
            }
            nodes['container'].style.display = 'block';
            // Show / Hide Document Scroll
            if(!that.params['documentScroll']){
                cm.addClass(cm.getDocumentHtml(), 'cm__scroll--none');
            }
            // Add close event on Esc press
            cm.addEvent(window, 'keydown', windowClickEvent);
            // Animate
            anim['container'].go({'style' : {'opacity' : '1'}, 'duration' : that.params['openTime'], 'onStop' : function(){
                // Open Event
                that.triggerEvent('onOpen');
            }});
            // Open Event
            that.triggerEvent('onOpenStart');
        }
    };

    var close = function(){
        if(that.isOpen){
            that.isOpen = false;
            // Remove close event on Esc press
            cm.removeEvent(window, 'keydown', windowClickEvent);
            // Show / Hide Document Scroll
            if(!that.params['documentScroll']){
                cm.removeClass(cm.getDocumentHtml(), 'cm__scroll--none');
            }
            // Animate
            anim['container'].go({
                'style' : {'opacity' : '0'}, 'duration' : that.params['openTime'], 'onStop' : function(){
                    nodes['container'].style.display = 'none';
                    // Close Event
                    that.triggerEvent('onClose');
                    // Remove Window
                    that.params['removeOnClose'] && remove();
                }
            });
            // Close Event
            that.triggerEvent('onCloseStart');
        }
    };

    var remove = function(){
        that.isOpen = false;
        // Remove dialog container node
        cm.remove(nodes['container']);
    };

    var windowClickEvent = function(e){
        e = cm.getEvent(e);
        if(e.keyCode == 27){
            // ESC key
            that.isFocus && close();
        }
    };

    /* ******* MAIN ******* */

    that.set = function(title, content, buttons){
        renderTitle(title);
        renderContent(content);
        renderButtons(buttons);
        return that;
    };

    that.setTitle = function(title){
        renderTitle(title);
        return that;
    };

    that.setContent = function(content){
        renderContent(content);
        return that;
    };

    that.setButtons = function(buttons){
        renderButtons(buttons);
        return that;
    };

    that.open = function(){
        open();
        return that;
    };

    that.close = function(){
        close();
        return that;
    };

    that.setWidth = function(width){
        that.params['width'] = width;
        return that;
    };

    that.setHeight = function(height){
        that.params['height'] = height;
        return that;
    };

    that.setMinHeight = function(height){
        that.params['minHeight'] = height;
        return that;
    };

    that.setMaxHeight = function(height){
        that.params['maxHeight'] = height;
        return that;
    };

    that.remove = function(){
        remove();
        return that;
    };

    that.getNodes = function(key){
        return nodes[key] || nodes;
    };

    init();
});
cm.define('Com.Draganddrop', {
    'modules' : [
        'Params',
        'Events'
    ],
    'events' : [
        'onRender',
        'onInit',
        'onDragStart',
        'onDrop',
        'onRemove',
        'onReplace'
    ],
    'params' : {
        'container' : cm.Node('div'),
        'chassisTag' : 'div',
        'draggableContainer' : 'document.body',      // HTML node | selfParent
        'scroll' : true,
        'scrollNode' : window,
        'scrollSpeed' : 1,                           // ms per 1px
        'renderTemporaryAria' : false,
        'useCSSAnimation' : true,
        'useGracefulDegradation' : true,
        'dropDuration' : 400,
        'moveDuration' : 200,
        'direction' : 'both',                        // both | vertical | horizontal
        'limit' : false,
        'highlightAreas' : true,                     // highlight areas on drag start
        'highlightChassis' : false,
        'animateRemove' : true,
        'removeNode' : true,
        'classes' : {
            'area' : null
        }
    }
},
function(params){
    var that = this,
        nodes = {},
        anims = {},
        areas = [],
        areasList = [],
        draggableList = [],
        filteredAvailableAreas = [],
        checkInt,
        chassisInt,
        pageSize,
        isScrollProccess = false,
        isGracefulDegradation = false,
        isHighlightedAreas = false,

        current,
        currentAboveItem,
        currentPosition,
        currentArea,
        currentChassis,
        previousArea;

    /* *** INIT *** */

    var init = function(){
        var areasNodes;

        getCSSHelpers();
        that.setParams(params);
        that.convertEvents(that.params['events']);

        if(that.params['container']){
            // Check Graceful Degradation, and turn it to mobile and old ie.
            if(that.params['useGracefulDegradation'] && ((cm.is('IE') && cm.isVersion() < 9) || cm.isMobile())){
                isGracefulDegradation = true;
            }
            // Init misc
            anims['scroll'] = new cm.Animation(that.params['scrollNode']);
            // Render temporary area
            if(that.params['renderTemporaryAria']){
                nodes['temporaryArea'] = cm.Node('div');
                initArea(nodes['temporaryArea'], {
                    'isTemporary' : true
                });
            }
            // Find drop areas
            areasNodes = cm.getByAttr('data-com-draganddrop', 'area', that.params['container']);
            // Init areas
            cm.forEach(areasNodes, function(area){
                initArea(area, {});
            });
            /* *** EXECUTE API EVENTS *** */
            that.triggerEvent('onInit', {});
            that.triggerEvent('onRender', {});
        }
    };

    var getCSSHelpers = function(){
        that.params['dropDuration'] = cm.getTransitionDurationFromRule('.pt__dnd-helper__drop-duration');
        that.params['moveDuration'] = cm.getTransitionDurationFromRule('.pt__dnd-helper__move-duration');
    };

    var initArea = function(node, params){
        // Check, if area already exists
        if(cm.inArray(areasList, node)){
            return;
        }
        // Config
        var area = cm.merge({
                'node' : node,
                'styleObject' : cm.getStyleObject(node),
                'type' : 'area',
                'isLocked' : false,
                'isTemporary' : false,
                'isSystem' : false,
                'isRemoveZone' : false,
                'draggableInChildNodes' : true,
                'cloneDraggable' : false,
                'items' : [],
                'chassis' : [],
                'dimensions' : {}
            }, params),
            childNodes;
        // Add mark classes
        cm.addClass(area['node'], 'pt__dnd-area');
        cm.addClass(area['node'], that.params['classes']['area']);
        if(area['isLocked']){
            cm.addClass(area['node'], 'is-locked');
        }else{
            cm.addClass(area['node'], 'is-available');
        }
        // Find draggable elements
        if(area['draggableInChildNodes']){
            childNodes = area['node'].childNodes;
            cm.forEach(childNodes, function(node){
                if(node.tagName && node.getAttribute('data-com-draganddrop') == 'draggable'){
                    area['items'].push(
                        initDraggable(node, area, {})
                    );
                }
            });
        }else{
            childNodes = cm.getByAttr('data-com-draganddrop', 'draggable', area['node']);
            cm.forEach(childNodes, function(node){
                area['items'].push(
                    initDraggable(node, area, {})
                );
            });
        }
        // Push to areas array
        areasList.push(area['node']);
        areas.push(area);
    };

    var initDraggable = function(node, area, params){
        // Config
        var draggable = cm.merge({
            'node' : node,
            'styleObject' : cm.getStyleObject(node),
            'type' : 'item',
            'chassis' : {
                'top' : null,
                'bottom' : null
            },
            'dimensions' : {
                'offsetX' : 0,
                'offsetY' : 0
            }
        }, params);
        draggable['area'] = area;
        draggable['anim'] = new cm.Animation(draggable['node']);
        // Set draggable event on element
        initDraggableDrag(draggable);
        // Return item to push in area array
        draggableList.push(draggable);
        return draggable;
    };

    var initDraggableDrag = function(draggable){
        var dragNode;
        draggable['drag'] = cm.getByAttr('data-com-draganddrop', 'drag', draggable['node'])[0];
        draggable['drag-bottom'] = cm.getByAttr('data-com-draganddrop', 'drag-bottom', draggable['node'])[0];
        // Set draggable event on element
        dragNode = draggable['drag'] || draggable['node'];
        cm.addEvent(dragNode, 'mousedown', function(e){
            start(e, draggable);
        });
        if(draggable['drag-bottom']){
            cm.addEvent(draggable['drag-bottom'], 'mousedown', function(e){
                start(e, draggable);
            });
        }
    };

    /* *** DRAG AND DROP PROCESS ** */

    var start = function(e, draggable){
        // If current exists, we don't need to start another drag event until previous will not stop
        if(current){
            return;
        }
        cm.preventDefault(e);
        // Hide IFRAMES and EMBED tags
        cm.hideSpecialTags();
        // Check event type and get cursor / finger position
        var x = cm._clientPosition['x'],
            y = cm._clientPosition['y'],
            tempCurrentAboveItem,
            tempCurrentPosition;
        if(!cm.isTouch){
            // If not left mouse button, don't duplicate drag event
            if((cm.is('IE') && cm.isVersion() < 9 && e.button != 1) || (!cm.is('IE') && e.button)){
                return;
            }
        }
        pageSize = cm.getPageSize();
        // API onDragStart Event
        that.triggerEvent('onDragStart', {
            'item' : draggable,
            'node' : draggable['node'],
            'from' : draggable['area']
        });
        // Filter areas
        filteredAvailableAreas = areas.filter(function(area){
            // Filter out locked areas and inner areas
            if(cm.isParent(draggable['node'], area['node']) || area['isLocked']){
                return false;
            }
            // True - pass area
            return true;
        });
        // Highlight Areas
        if(that.params['highlightAreas']){
            toggleHighlightAreas();
        }
        // Get position and dimension of current draggable item
        getPosition(draggable);
        // Get offset position relative to touch point (cursor or finger position)
        draggable['dimensions']['offsetX'] = x - draggable['dimensions']['absoluteX1'];
        draggable['dimensions']['offsetY'] = y - draggable['dimensions']['absoluteY1'];
        // Set draggable item to current
        if(draggable['area']['cloneDraggable']){
            current = cloneDraggable(draggable);
        }else{
            current = draggable;
        }
        // Set position and dimension to current draggable node, before we insert it to draggableContainer
        current['node'].style.top = 0;
        current['node'].style.left = 0;
        current['node'].style.width = [current['dimensions']['width'], 'px'].join('');
        cm.setCSSTranslate(current['node'], [current['dimensions']['absoluteX1'], 'px'].join(''), [current['dimensions']['absoluteY1'], 'px'].join(''));
        // Unset area from draggable item
        unsetDraggableFromArea(current);
        // Insert draggable element to body
        if(that.params['draggableContainer'] && that.params['draggableContainer'] != 'selfParent'){
            that.params['draggableContainer'].appendChild(current['node']);
        }
        cm.addClass(current['node'], 'pt__dnd-helper');
        cm.addClass(current['node'], 'is-active', true);
        // Calculate elements position and dimension
        getPositionsAll();
        // Render Chassis Blocks
        renderChassisBlocks();
        // Find above draggable item
        cm.forEach(current['area']['items'], function(draggable){
            if(x >= draggable['dimensions']['absoluteX1'] && x < draggable['dimensions']['absoluteX2'] && y >= draggable['dimensions']['absoluteY1'] && y <= draggable['dimensions']['absoluteY2']){
                tempCurrentAboveItem = draggable;
                // Check above block position
                if((y - tempCurrentAboveItem['dimensions']['absoluteY1']) < (tempCurrentAboveItem['dimensions']['absoluteHeight'] / 2)){
                    tempCurrentPosition = 'top';
                }else{
                    tempCurrentPosition = 'bottom';
                }
            }
        });
        // If current current draggable not above other draggable items
        if(!tempCurrentAboveItem && current['area']['items'].length){
            if(y < current['area']['dimensions']['y1']){
                tempCurrentAboveItem = current['area']['items'][0];
                tempCurrentPosition = 'top';
            }else{
                tempCurrentAboveItem = current['area']['items'][current['area']['items'].length - 1];
                tempCurrentPosition = 'bottom';
            }
        }
        // Set chassis
        if(tempCurrentAboveItem){
            currentChassis = tempCurrentAboveItem['chassis'][tempCurrentPosition];
        }else{
            currentChassis = current['area']['chassis'][0];
        }
        if(currentChassis){
            cm.addClass(currentChassis['node'], 'is-active');
            if(that.params['highlightChassis']){
                cm.addClass(currentChassis['node'], 'is-highlight');
            }
            currentChassis['node'].style.height = [current['dimensions']['absoluteHeight'], 'px'].join('');
        }
        // Set current area and above
        currentArea = current['area'];
        currentAboveItem = tempCurrentAboveItem;
        currentPosition = tempCurrentPosition;
        cm.addClass(currentArea['node'], 'is-active');
        // Set check position event
        //checkInt = setInterval(checkPosition, 5);
        // Add move event on document
        cm.addClass(document.body, 'pt__dnd-body');
        cm.addEvent(window, 'mousemove', move);
        cm.addEvent(window, 'mouseup', stop);
    };

    var move = function(e){
        cm.preventDefault(e);
        // Check event type and get cursor / finger position
        var x = cm._clientPosition['x'],
            y = cm._clientPosition['y'],
            posY = y - current['dimensions']['offsetY'],
            posX = x - current['dimensions']['offsetX'],
            styleX,
            styleY,
            tempCurrentArea,
            tempCurrentAboveItem,
            tempCurrentPosition;
        // Calculate drag direction and set new position
        switch(that.params['direction']){
            case 'both':
                styleX = [posX, 'px'].join('');
                styleY = [posY, 'px'].join('');
                break;
            case 'vertical':
                styleX = [current['dimensions']['absoluteX1'], 'px'].join('');
                if(that.params['limit']){
                    if(posY < current['area']['dimensions']['y1']){
                        styleY = [current['area']['dimensions']['y1'], 'px'].join('');
                    }else if(posY > current['area']['dimensions']['y2']){
                        styleY = [current['area']['dimensions']['y2'], 'px'].join('');
                    }else{
                        styleY = [posY, 'px'].join('');
                    }
                }else{
                    styleY = [posY, 'px'].join('');
                }
                break;
            case 'horizontal':
                styleX = [posX, 'px'].join('');
                styleY = [current['dimensions']['absoluteY1'], 'px'].join('');
                break;
        }
        cm.setCSSTranslate(current['node'], styleX, styleY);
        // Scroll node
        if(that.params['scroll']){
        //if(false){
            if(y + 48 > pageSize['winHeight']){
                toggleScroll(1);
            }else if(y - 48 < 0){
                toggleScroll(-1);
            }else{
                toggleScroll(0);
            }
        }
        // Check and recalculate position
        checkPosition();
        // Find above area
        cm.forEach(filteredAvailableAreas, function(area){
            if(x >= area['dimensions']['x1'] && x < area['dimensions']['x2'] && y >= area['dimensions']['y1'] && y <= area['dimensions']['y2']){
                if(!tempCurrentArea){
                    tempCurrentArea = area;
                }else if(area['dimensions']['width'] < tempCurrentArea['dimensions']['width'] || area['dimensions']['height'] < tempCurrentArea['dimensions']['height']){
                    tempCurrentArea = area;
                }
            }
        });
        // Find above draggable item
        if(tempCurrentArea){
            cm.forEach(tempCurrentArea['items'], function(draggable){
                if(x >= draggable['dimensions']['absoluteX1'] && x < draggable['dimensions']['absoluteX2'] && y >= draggable['dimensions']['absoluteY1'] && y <= draggable['dimensions']['absoluteY2']){
                    tempCurrentAboveItem = draggable;
                    // Check above block position
                    if((y - tempCurrentAboveItem['dimensions']['absoluteY1']) < (tempCurrentAboveItem['dimensions']['absoluteHeight'] / 2)){
                        tempCurrentPosition = 'top';
                    }else{
                        tempCurrentPosition = 'bottom';
                    }
                }
            });
        }else{
            tempCurrentArea = currentArea;
        }
        // If current current draggable not above other draggable items
        if(!tempCurrentAboveItem && tempCurrentArea['items'].length){
            if(y < tempCurrentArea['dimensions']['innerY1']){
                tempCurrentAboveItem = tempCurrentArea['items'][0];
                tempCurrentPosition = 'top';
            }else{
                tempCurrentAboveItem = tempCurrentArea['items'][tempCurrentArea['items'].length - 1];
                tempCurrentPosition = 'bottom';
            }
        }
        // Animate previous chassis and get current
        if(currentChassis){
            cm.removeClass(currentChassis['node'], 'is-active is-highlight');
        }
        if(currentAboveItem && tempCurrentAboveItem && currentAboveItem['chassis'][currentPosition] != tempCurrentAboveItem['chassis'][tempCurrentPosition]){
            animateChassis(currentAboveItem['chassis'][currentPosition], 0, that.params['moveDuration']);
            currentChassis = tempCurrentAboveItem['chassis'][tempCurrentPosition];
        }else if(!currentAboveItem && tempCurrentAboveItem){
            animateChassis(currentArea['chassis'][0], 0, that.params['moveDuration']);
            currentChassis = tempCurrentAboveItem['chassis'][tempCurrentPosition];
        }else if(currentAboveItem && !tempCurrentAboveItem){
            animateChassis(currentAboveItem['chassis'][currentPosition], 0, that.params['moveDuration']);
            currentChassis = tempCurrentArea['chassis'][0];
        }else if(!currentAboveItem && !tempCurrentAboveItem && currentArea != tempCurrentArea){
            animateChassis(currentArea['chassis'][0], 0, that.params['moveDuration']);
            currentChassis = tempCurrentArea['chassis'][0];
        }
        // Animate current chassis
        if(currentChassis){
            cm.addClass(currentChassis['node'], 'is-active');
            if(that.params['highlightChassis']){
                cm.addClass(currentChassis['node'], 'is-highlight');
            }
            animateChassis(currentChassis, current['dimensions']['absoluteHeight'], that.params['moveDuration']);
        }
        // Unset classname from previous active area
        if(currentArea && currentArea != tempCurrentArea){
            cm.removeClass(currentArea['node'], 'is-active');
            previousArea = currentArea;
        }
        // Set current to global
        currentArea = tempCurrentArea;
        currentAboveItem = tempCurrentAboveItem;
        currentPosition = tempCurrentPosition;
        // Set active area class name
        if(!(previousArea && previousArea['isTemporary'] && currentArea['isRemoveZone'])){
            cm.addClass(currentArea['node'], 'is-active');
        }
    };

    var stop = function(e){
        var currentHeight;
        // Remove check position event
        //checkInt && clearInterval(checkInt);
        // Remove move events attached on document
        cm.removeClass(document.body, 'pt__dnd-body');
        cm.removeEvent(window, 'mousemove', move);
        cm.removeEvent(window, 'mouseup', stop);
        // Calculate height of draggable block, like he already dropped in area, to animate height of fake empty space
        getPosition(current);
        current['node'].style.width = [(currentArea['dimensions']['innerWidth'] - current['dimensions']['margin']['left'] - current['dimensions']['margin']['right']), 'px'].join('');
        currentHeight = current['node'].offsetHeight + current['dimensions']['margin']['top'] + current['dimensions']['margin']['bottom'];
        current['node'].style.width = [current['dimensions']['width'], 'px'].join('');
        // If current draggable located above another draggable item, drops after/before it, or drops in area
        if(currentAboveItem){
            // Animate chassis blocks
            if(currentHeight != currentAboveItem['chassis'][currentPosition]['node'].offsetHeight){
                animateChassis(currentAboveItem['chassis'][currentPosition], currentHeight, that.params['dropDuration']);
            }
            // Drop Item to Area
            dropDraggableToArea(current, currentArea, {
                'target' : currentAboveItem['node'],
                'append' : currentPosition == 'top' ? 'before' : 'after',
                'index' : currentArea['items'].indexOf(currentAboveItem) + (currentPosition == 'top' ? 0 : 1),
                'top' : [currentPosition == 'top'? currentAboveItem['dimensions']['absoluteY1'] : currentAboveItem['dimensions']['absoluteY2'], 'px'].join(''),
                'onStop' : unsetCurrentDraggable
            });
        }else if(currentArea['isRemoveZone'] || currentArea['isTemporary']){
            removeDraggable(current, {
                'onStop' : unsetCurrentDraggable
            });
        }else{
            // Animate chassis blocks
            animateChassis(currentArea['chassis'][0], currentHeight, that.params['dropDuration']);
            // Drop Item to Area
            dropDraggableToArea(current, currentArea, {
                'onStop' : unsetCurrentDraggable
            });
        }
        // Unset chassis
        if(currentChassis){
            cm.removeClass(currentChassis['node'], 'is-active is-highlight');
        }
        // Unset active area classname
        if(currentArea){
            cm.removeClass(currentArea['node'], 'is-active');
        }
        // Un Highlight Areas
        if(that.params['highlightAreas']){
            toggleHighlightAreas();
        }
        // Show IFRAMES and EMBED tags
        cm.showSpecialTags();
    };

    /* *** DRAGGABLE MANIPULATION FUNCTIONS *** */

    var cloneDraggable = function(draggable){
        var clonedNode = draggable['node'].cloneNode(true),
            area = that.params['renderTemporaryAria']? areas[0] : draggable['area'],
            clonedDraggable = initDraggable(clonedNode, area, {});

        clonedDraggable['dimensions'] = cm.clone(draggable['dimensions']);
        area['items'].push(clonedDraggable);
        return clonedDraggable;
    };

    var dropDraggableToArea = function(draggable, area, params){
        params = cm.merge({
            'target' : area['node'],
            'append' : 'child',
            'index' : 0,
            'width' : [area['dimensions']['innerWidth'], 'px'].join(''),
            'top' : [area['dimensions']['innerY1'] - draggable['dimensions']['margin']['top'], 'px'].join(''),
            'left' : [area['dimensions']['innerX1'] - draggable['dimensions']['margin']['left'], 'px'].join(''),
            'onStart' : function(){},
            'onStop' : function(){}
        }, params);
        // System onStart event
        params['onStart']();
        // Animate draggable item, like it drops in area
        cm.addClass(draggable['node'], 'is-drop', true);
        draggable['node'].style.width = params['width'];
        cm.setCSSTranslate(draggable['node'], params['left'], params['top']);
        // On Dnimate Stop
        setTimeout(function(){
            // Append element in new position
            switch(params['append']){
                case 'child' :
                    cm.appendChild(draggable['node'], params['target']);
                    break;
                case 'before' :
                    cm.insertBefore(draggable['node'], params['target']);
                    break;
                case 'after' :
                    cm.insertAfter(draggable['node'], params['target']);
                    break;
                case 'first' :
                    cm.insertFirst(draggable['node'], params['target']);
                    break;
            }
            // Remove draggable helper classname
            cm.removeClass(draggable['node'], 'pt__dnd-helper is-drop is-active', true);
            // Reset styles
            draggable['node'].style.left = 'auto';
            draggable['node'].style.top = 'auto';
            draggable['node'].style.width = 'auto';
            cm.setCSSTranslate(current['node'], 'auto', 'auto');
            // Set index of draggable item in new area
            area['items'].splice(params['index'], 0, draggable);
            // API onDrop Event
            that.triggerEvent('onDrop', {
                'item' : draggable,
                'node' : draggable['node'],
                'to' : area,
                'from' : draggable['area'],
                'index' : params['index']
            });
            // Set draggable new area
            draggable['area'] = area;
            // System onStop event
            params['onStop']();
        }, that.params['dropDuration']);
    };

    var removeDraggable = function(draggable, params){
        var style, anim, node;
        // Remove handler
        var handler = function(){
            if(that.params['removeNode']){
                cm.remove(node);
            }
            // Remove from draggable list
            draggableList = draggableList.filter(function(item){
                return item != draggable;
            });
            unsetDraggableFromArea(draggable);
            // API onRemove Event
            if(!params['noEvent']){
                that.triggerEvent('onRemove', {
                    'item' : draggable,
                    'node' : draggable['node'],
                    'from' : draggable['area']
                });
            }
            // System onStop event
            params['onStop']();
        };
        // Config
        params = cm.merge({
            'isCurrent' : draggable === current,
            'isInDOM' : cm.inDOM(draggable['node']),
            'onStart' : function(){},
            'onStop' : function(){}
        }, params);
        // System onStart event
        params['onStart']();
        // If draggable not in DOM, we don't need to wrap and animate it
        if(params['isInDOM'] && that.params['animateRemove']){
            // If draggable is current - just animate pull out left, else - wrap to removable node
            if(params['isCurrent']){
                node = draggable['node'];
                anim = draggable['anim'];
                style = {
                    'left' : [-(draggable['dimensions']['absoluteWidth'] + 50), 'px'].join(''),
                    'opacity' : 0
                }
            }else{
                node = cm.wrap(cm.Node('div', {'class' : 'pt__dnd-removable'}), draggable['node']);
                anim = new cm.Animation(node);
                style = {
                    'height' : '0px',
                    'opacity' : 0
                }
            }
            // Animate draggable, like it disappear
            anim.go({
                'duration' : that.params['dropDuration'],
                'anim' : 'smooth',
                'style' : style,
                'onStop' : handler
            });
        }else{
            node = draggable['node'];
            handler();
        }
    };

    var unsetDraggableFromArea = function(draggable){
        draggable['area']['items'] = draggable['area']['items'].filter(function(item){
            return item != draggable;
        });
    };

    var unsetCurrentDraggable = function(){
        // Remove chassis blocks
        removeChassisBlocks();
        // Reset other
        current = false;
        currentAboveItem = false;
        currentArea = false;
        previousArea = false;
    };

    /* *** CHASSIS FUNCTIONS *** */

    var renderChassisBlocks = function(){
        var chassis;
        cm.forEach(areas, function(area){
            if(area['isLocked']){
                return;
            }

            if(!area['items'].length){
                chassis = renderChassis();
                cm.appendChild(chassis['node'], area['node']);
                area['chassis'].push(chassis);
            }
            cm.forEach(area['items'], function(draggable, i){
                if(i === 0){
                    chassis = renderChassis();
                    cm.insertBefore(chassis['node'], draggable['node']);
                    area['chassis'].push(chassis);
                }
                chassis = renderChassis();
                cm.insertAfter(chassis['node'], draggable['node']);
                area['chassis'].push(chassis);
                // Associate with draggable
                draggable['chassis']['top'] = area['chassis'][i];
                draggable['chassis']['bottom'] = area['chassis'][i + 1];
            });
        });
    };

    var renderChassis = function(){
        var node = cm.Node(that.params['chassisTag'], {'class' : 'pt__dnd-chassis'});
        return {
            'node' : node,
            'anim' : new cm.Animation(node),
            'isShow' : false
        };
    };

    var removeChassisBlocks = function(){
        cm.forEach(areas, function(area){
            cm.forEach(area['chassis'], function(chassis){
                cm.remove(chassis['node']);
            });
            area['chassis'] = [];
        });
    };

    var animateChassis = function(chassis, height, duration) {
        var style;
        height = [height, 'px'].join('');
        if(that.params['useCSSAnimation'] || isGracefulDegradation){
            if(!isGracefulDegradation && (style = cm.getSupportedStyle('transition-duration'))){
                chassis['node'].style[style] = [duration, 'ms'].join('');
            }
            chassis['node'].style.height = height;
        }else{
            chassis['anim'].go({'style' : {'height' : height}, 'anim' : 'smooth', 'duration' : duration});
        }
    };

    /* *** POSITION CALCULATION FUNCTIONS *** */

    var getPosition = function(item){
        item['dimensions'] = cm.extend(item['dimensions'], cm.getFullRect(item['node'], item['styleObject']));
    };

    var getPositions = function(arr){
        cm.forEach(arr, getPosition);
    };

    var getPositionsAll = function(){
        getPositions(areas);
        cm.forEach(areas, function(area){
            getPositions(area['items']);
        });
    };

    var recalculatePosition = function(item){
        //item['dimensions']['x1'] = cm.getRealX(item['node']);
        item['dimensions']['y1'] = cm.getRealY(item['node']);
        //item['dimensions']['x2'] = item['dimensions']['x1'] + item['dimensions']['width'];
        item['dimensions']['y2'] = item['dimensions']['y1'] + item['dimensions']['height'];

        //item['dimensions']['innerX1'] = item['dimensions']['x1'] + item['dimensions']['padding']['left'];
        item['dimensions']['innerY1'] = item['dimensions']['y1'] + item['dimensions']['padding']['top'];
        //item['dimensions']['innerX2'] = item['dimensions']['innerX1'] + item['dimensions']['innerWidth'];
        item['dimensions']['innerY2'] = item['dimensions']['innerY1'] + item['dimensions']['innerHeight'];

        //item['dimensions']['absoluteX1'] = item['dimensions']['x1'] - item['dimensions']['margin']['left'];
        item['dimensions']['absoluteY1'] = item['dimensions']['y1'] - item['dimensions']['margin']['top'];
        //item['dimensions']['absoluteX2'] = item['dimensions']['x2'] + item['dimensions']['margin']['right'];
        item['dimensions']['absoluteY2'] = item['dimensions']['y2'] + item['dimensions']['margin']['bottom'];
    };

    var recalculatePositions = function(arr){
        cm.forEach(arr, recalculatePosition);
    };

    var recalculatePositionsAll = function(){
        var chassisHeight = 0;
        // Reset current active chassis height, cause we need to calculate clear positions
        if(currentChassis){
            cm.addClass(currentChassis['node'], 'is-immediately');
            chassisHeight = currentChassis['node'].offsetHeight;
            currentChassis['node'].style.height = 0;
        }
        recalculatePositions(areas);
        cm.forEach(areas, function(area){
            recalculatePositions(area['items']);
        });
        // Restoring chassis height after calculation
        if(currentChassis && chassisHeight){
            currentChassis['node'].style.height = [chassisHeight, 'px'].join('');
            (function(currentChassis){
                setTimeout(function(){
                    cm.removeClass(currentChassis['node'], 'is-immediately');
                }, 5);
            })(currentChassis);
        }
    };

    var checkPosition = function(){
        var filteredAreas = getFilteredAreas();
        if(filteredAreas[0]['dimensions']['y1'] != cm.getRealY(filteredAreas[0]['node'])){
            recalculatePositionsAll();
        }
    };

    /* *** AREA FUNCTIONS *** */

    var getFilteredAreas = function(){
        return areas.filter(function(area){
            // Filter out locked areas and inner areas
            if(area['isTemporary'] || area['isSystem']){
                return false;
            }
            // True - pass area
            return true;
        });
    };

    var getRemoveZones = function(){
        return areas.filter(function(area){
            return area['isRemoveZone'];
        });
    };

    var toggleHighlightAreas = function(){
        if(filteredAvailableAreas){
            if(isHighlightedAreas){
                isHighlightedAreas = false;
                cm.forEach(filteredAvailableAreas, function(area){
                    cm.removeClass(area['node'], 'is-highlight');
                });
            }else{
                isHighlightedAreas = true;
                cm.forEach(filteredAvailableAreas, function(area){
                    cm.addClass(area['node'], 'is-highlight');
                });
            }
        }
    };

    /* *** HELPERS *** */

    var toggleScroll = function(speed){
        var scrollRemaining,
            duration,
            styles = {};

        if(speed == 0){
            isScrollProccess = false;
            anims['scroll'].stop();
        }else if(speed < 0 && !isScrollProccess){
            isScrollProccess = true;
            duration = cm.getScrollTop(that.params['scrollNode']) * that.params['scrollSpeed'];
            if(cm.isWindow(that.params['scrollNode'])){
                styles['docScrollTop'] = 0;
            }else{
                styles['scrollTop'] = 0;
            }
            anims['scroll'].go({'style' : styles, 'duration' : duration, 'onStop' : function(){
                isScrollProccess = false;
                //getPositionsAll();
                //recalculatePositionsAll();
            }});
        }else if(speed > 0 && !isScrollProccess){
            isScrollProccess = true;
            scrollRemaining = cm.getScrollHeight(that.params['scrollNode']) - pageSize['winHeight'];
            if(cm.isWindow(that.params['scrollNode'])){
                styles['docScrollTop'] = scrollRemaining;
            }else{
                styles['scrollTop'] = scrollRemaining;
            }
            duration = scrollRemaining * that.params['scrollSpeed'];
            anims['scroll'].go({'style' : styles, 'duration' : duration, 'onStop' : function(){
                isScrollProccess = false;
                //getPositionsAll();
                //recalculatePositionsAll();
            }});
        }
    };

    /* ******* MAIN ******* */

    that.getArea = function(node){
        var area;
        cm.forEach(areas, function(item){
            if(item['node'] === node){
                area = item;
            }
        });
        return area;
    };

    that.registerArea = function(node, params){
        if(cm.isNode(node) && node.tagName){
            initArea(node, params || {});
        }
        return that;
    };

    that.removeArea = function(node, params){
        if(cm.isNode(node) && cm.inArray(areasList, node)){
            areasList = areasList.filter(function(area){
                return area != node;
            });
            areas = areas.filter(function(area){
                return area['node'] != node;
            });
        }
        return that;
    };

    that.getDraggable = function(node){
        var draggable;
        cm.forEach(draggableList, function(item){
            if(item['node'] === node){
                draggable = item;
            }
        });
        return draggable;
    };

    that.getDraggableList = function(){
        return draggableList;
    };

    that.registerDraggable = function(node, areaNode, params){
        var draggable, area, newDraggable, index, childNodes, draggableNodes = [];
        // Find draggable item by node
        draggable = that.getDraggable(node);
        // If draggable already exists - reinit it, else - init like new draggable item
        if(draggable){
            initDraggableDrag(draggable);
        }else if(cm.inArray(areasList, areaNode)){
            node.setAttribute('data-com-draganddrop', 'draggable');
            // Fins area item by node
            area = that.getArea(areaNode);
            // Find draggable index
            if(area['draggableInChildNodes']){
                childNodes = area['node'].childNodes;
                cm.forEach(childNodes, function(node){
                    if(node.tagName && node.getAttribute('data-com-draganddrop') == 'draggable'){
                        draggableNodes.push(node);
                    }
                });
            }else{
                draggableNodes = cm.getByAttr('data-com-draganddrop', 'draggable', area['node']);
            }
            index = draggableNodes.indexOf(node);
            // Register draggable
            newDraggable = initDraggable(node, area, params || {});
            area['items'].splice(index, 0, newDraggable);
        }
        return that;
    };

    that.replaceDraggable = function(oldDraggableNode, newDraggableNode, params){
        var oldDraggable,
            newDraggable;
        // Find draggable item
        cm.forEach(draggableList, function(item){
            if(item['node'] === oldDraggableNode){
                oldDraggable = item;
            }
        });
        if(oldDraggable){
            // Find old draggable area and index in area
            var area = oldDraggable['area'],
                index = area['items'].indexOf(oldDraggable),
                node = cm.wrap(cm.Node('div', {'class' : 'pt__dnd-removable', 'style' : 'height: 0px;'}), newDraggableNode),
                anim = new cm.Animation(node);
            // Append new draggable into DOM
            cm.insertAfter(node, oldDraggableNode);
            // Remove old draggable
            removeDraggable(oldDraggable, params);
            // Animate new draggable
            anim.go({'style' : {'height' : [cm.getRealHeight(node, 'offset', 0), 'px'].join(''), 'opacity' : 1}, 'duration' : 300, 'anim' : 'simple', 'onStop' : function(){
                cm.insertAfter(newDraggableNode, node);
                cm.remove(node);
                // Register new draggable
                newDraggable = initDraggable(newDraggableNode, area);
                area['items'].splice(index, 0, newDraggable);
                // API onEmbed event
                that.triggerEvent('onReplace', {
                    'item' : newDraggable,
                    'node' : newDraggable['node'],
                    'to' : newDraggable['to']
                });
            }});
        }
        return that;
    };

    that.removeDraggable = function(node, params){
        var draggable;
        // Find draggable item
        cm.forEach(draggableList, function(item){
            if(item['node'] === node){
                draggable = item;
            }
        });
        if(draggable){
            // Remove
            removeDraggable(draggable, params || {});
        }
        return that;
    };

    that.getOrderingNodes = function(){
        var results = [],
            arr,
            filteredAreas = getFilteredAreas();
        // Build array
        cm.forEach(filteredAreas, function(area){
            arr = {
                'area' : area['node'],
                'items' : []
            };
            cm.forEach(area['items'], function(item){
                arr['items'].push(item['node']);
            });
            results.push(arr);
        });
        return filteredAreas.length == 1 ? arr['items'] : results;
    };

    that.getOrderingIDs = function(){
        var results = {},
            arr,
            filteredAreas = getFilteredAreas();
        // Build array
        cm.forEach(filteredAreas, function(area){
            arr = {};
            cm.forEach(area['items'], function(item, i){
                if(!item['id']){
                    throw new Error('Attribute "data-id" not specified on item node.');
                }
                arr[item['id']] = i;
            });
            results[area['id']] = arr;
        });
        return filteredAreas.length == 1 ? arr : results;
    };
    
    init();
});
cm.define('Com.Draggable', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig'
    ],
    'events' : [
        'onRender',
        'onStart',
        'onMove',
        'onStop',
        'onSet'
    ],
    'params' : {
        'node' : cm.Node('div'),            // Node, for drag
        'target' : false,                   // Node, for drag target event
        'limiter' : false,                  // Node, for limit draggable in it
        'minY' : false,
        'direction' : 'both',               // both | vertical | horizontal
        'alignNode' : false
    }
},
function(params){
    var that = this;

    that.startX = 0;
    that.startY = 0;
    that.nodeStartX = 0;
    that.nodeStartY = 0;
    that.isDrag = false;
    that.dimensions = {
        'target' : {}
    };

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['node']);
        validateParams();
        render();
        that.triggerEvent('onRender');
    };

    var validateParams = function(){
        if(!that.params['target']){
            that.params['target'] = that.params['node'];
        }
    };

    var render = function(){
        // Calculate dimensions and position
        that.getDimensions();
        // Add drag start event
        cm.addEvent(that.params['target'], 'mousedown', start);
    };

    var start = function(e){
        if(that.isDrag){
            return;
        }
        that.isDrag = true;
        cm.preventDefault(e);
        // Hide IFRAMES and EMBED tags
        cm.hideSpecialTags();
        // Check event type and get cursor / finger position
        that.startX = cm._clientPosition['x'];
        that.startY = cm._clientPosition['y'];
        if(!cm.isTouch){
            // If not left mouse button, don't duplicate drag event
            if((cm.is('IE') && cm.isVersion() < 9 && e.button != 1) || (!cm.is('IE') && e.button)){
                return;
            }
        }
        // Calculate dimensions and position
        that.getDimensions();
        that.nodeStartX = cm.getStyle(that.params['node'], 'left', true);
        that.nodeStartY = cm.getStyle(that.params['node'], 'top', true);
        setPosition(that.startX, that.startY);
        // Add move event on document
        cm.addEvent(window, 'mousemove', move);
        cm.addEvent(window, 'mouseup', stop);
        // Trigger Event
        that.triggerEvent('onStart');
    };

    var move = function(e){
        cm.preventDefault(e);
        // Calculate dimensions and position
        setPosition(cm._clientPosition['x'], cm._clientPosition['y']);
        // Trigger Event
        that.triggerEvent('onMove');
    };

    var stop = function(){
        that.isDrag = false;
        // Remove move events attached on document
        cm.removeEvent(window, 'mousemove', move);
        cm.removeEvent(window, 'mouseup', stop);
        // Show IFRAMES and EMBED tags
        cm.showSpecialTags();
        // Trigger Event
        that.triggerEvent('onStop');
    };
    
    /* *** HELPERS *** */

    var setPosition = function(x, y){
        var posX = x,
            posY = y;
        if(that.params['node'] === that.params['target']){
            posX += that.nodeStartX - that.startX;
            posY += that.nodeStartY - that.startY;
        }else{
            posX -= that.dimensions['target']['absoluteX1'];
            posY -= that.dimensions['target']['absoluteY1'];
        }
        that.setPosition(posX, posY, true);
    };

    /* ******* MAIN ******* */

    that.getDimensions = function(){
        that.dimensions['target'] = cm.getFullRect(that.params['target']);
        that.dimensions['node'] = cm.getFullRect(that.params['node']);
        that.dimensions['limiter'] = cm.getFullRect(that.params['limiter']);
        return that.dimensions;
    };

    that.setPosition = function(posX, posY, triggerEvents){
        var nodePosY,
            nodePosX;
        triggerEvents = typeof triggerEvents == 'undefined'? true : triggerEvents;
        // Check limit
        if(that.params['limiter']){
            if(posY < 0){
                posY = 0;
            }else if(posY > that.dimensions['limiter']['absoluteHeight']){
                posY = that.dimensions['limiter']['absoluteHeight'];
            }
            if(posX < 0){
                posX = 0;
            }else if(posX > that.dimensions['limiter']['absoluteWidth']){
                posX = that.dimensions['limiter']['absoluteWidth'];
            }
        }
        // Limiters
        if(!isNaN(that.params['minY']) && posY < that.params['minY']){
            posY = that.params['minY'];
        }
        // Align node
        nodePosY = posY;
        nodePosX = posX;
        if(that.params['alignNode']){
            nodePosY -= (that.dimensions['node']['absoluteHeight'] / 2);
            nodePosX -= (that.dimensions['node']['absoluteWidth'] / 2);
        }
        // Set styles
        switch(that.params['direction']){
            case 'vertical' :
                that.params['node'].style.top = [nodePosY, 'px'].join('');
                break;
            case 'horizontal' :
                that.params['node'].style.left = [nodePosX, 'px'].join('');
                break;
            default :
                that.params['node'].style.top = [nodePosY, 'px'].join('');
                that.params['node'].style.left = [nodePosX, 'px'].join('');
                break;
        }
        // Trigger Event
        if(triggerEvents){
            that.triggerEvent('onSet', {
                'posY' : posY,
                'posX' : posX,
                'nodePosY' : nodePosY,
                'nodePosX' : nodePosX
            })
        }
        return that;
    };

    init();
});
cm.define('Com.Gallery', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig',
        'DataNodes'
    ],
    'events' : [
        'onRender',
        'onSet',
        'onChange',
        'onItemLoad',
        'onItemSet'
    ],
    'params' : {
        'container' : cm.Node('div'),
        'node' : cm.Node('div'),
        'data' : [],
        'duration' : 500,
        'showCaption' : true,
        'showArrowTitles' : false,
        'autoplay' : true,
        'zoom' : true,
        'icons' : {
            'prev' : 'icon default prev',
            'next' : 'icon default next',
            'zoom' : 'icon cm-i default zoom'
        },
        'Com.Zoom' : {
            'autoOpen' : false,
            'removeOnClose' : true,
            'documentScroll' : true
        }
    }
},
function(params){
    var that = this,
        items = [],
        anim = {};

    that.components = {};

    that.current = null;
    that.previous = null;
    that.isProcess = false;

    that.nodes = {
        'items' : []
    };

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node'], that.params['nodesDataMarker'], false);
        that.getDataConfig(that.params['node']);
        render();
        // Collect items
        cm.forEach(that.nodes['items'], collectItem);
        // Process config items
        cm.forEach(that.params['data'], processItem);
        afterRender();
        that.triggerEvent('onRender');
    };

    var render = function(){
        // Structure
        that.nodes['container'] = cm.Node('div', {'class' : 'com__gallery'},
            that.nodes['holder'] = cm.Node('div', {'class' : 'holder'}),
            that.nodes['bar'] = cm.Node('div', {'class' : 'com__gallery-controls is-full'},
                cm.Node('div', {'class' : 'inner'},
                    that.nodes['prev'] = cm.Node('div', {'class' : 'bar-arrow prev'},
                        cm.Node('div', {'class' : that.params['icons']['prev']})
                    ),
                    that.nodes['next'] = cm.Node('div', {'class' : 'bar-arrow next'},
                        cm.Node('div', {'class' : that.params['icons']['next']})
                    ),
                    that.nodes['zoom'] = cm.Node('div', {'class' : 'bar-zoom'},
                        cm.Node('div', {'class' : that.params['icons']['zoom']})
                    )
                )
            ),
            that.nodes['loader'] = cm.Node('div', {'class' : 'loader'},
                cm.Node('div', {'class' : 'bg'}),
                cm.Node('div', {'class' : 'icon small loader centered'})
            )
        );
        // Arrow titles
        if(that.params['showArrowTitles']){
            that.nodes['next'].setAttribute('title', that.lang('Next'));
            that.nodes['prev'].setAttribute('title', that.lang('Previous'));
        }
        // Zoom
        if(that.params['zoom']){
            cm.getConstructor('Com.Zoom', function(classConstructor){
                that.components['zoom'] = new classConstructor(that.params['Com.Zoom']);
                cm.addEvent(that.nodes['zoom'], 'click', zoom);
            });
        }else{
            cm.remove(that.nodes['zoom']);
        }
        // Set events
        cm.addEvent(that.nodes['next'], 'click', next);
        cm.addEvent(that.nodes['prev'], 'click', prev);
        // Init animation
        anim['loader'] = new cm.Animation(that.nodes['loader']);
        // Embed
        that.params['container'].appendChild(that.nodes['container']);
    };

    var afterRender = function(){
        if(items.length < 2){
            that.nodes['next'].style.display = 'none';
            that.nodes['prev'].style.display = 'none';
        }else{
            that.nodes['next'].style.display = '';
            that.nodes['prev'].style.display = '';
        }
    };

    var collectItem = function(item){
        if(!item['link']){
            item['link'] = cm.Node('a')
        }
        item = cm.merge({
            'src' : item['link'].getAttribute('href') || '',
            'title' : item['link'].getAttribute('title') || ''
        }, item);
        processItem(item);
    };

    var processItem = function(item){
        item = cm.merge({
            'index' : items.length,
            'isLoad' : false,
            'type' : 'image',        // image | iframe
            'nodes' : {},
            'src' : '',
            'title' : ''
        }, item);
        // Check type
        item['type'] = /(\.jpg|\.png|\.gif|\.jpeg|\.bmp|\.tga)$/gi.test(item['src']) ? 'image' : 'iframe';
        // Structure
        if(!item['link']){
            item['link'] = cm.Node('a')
        }
        item['nodes']['container'] = cm.Node('div', {'class' : 'pt__image is-centered'},
            item['nodes']['inner'] = cm.Node('div', {'class' : 'inner'})
        );
        // Render by type
        if(item['type'] == 'image'){
            item['nodes']['inner'].appendChild(
                item['nodes']['content'] = cm.Node('img', {'class' : 'descr', 'alt' : item['title'], 'title' : item['title']})
            );
        }else{
            item['nodes']['inner'].appendChild(
                item['nodes']['content'] = cm.Node('iframe', {'class' : 'descr'})
            );
        }
        // Caption
        if(that.params['showCaption'] && !cm.isEmpty(item['title'] && item['type'] == 'image')){
            item['nodes']['inner'].appendChild(
                cm.Node('div', {'class' : 'title'},
                    cm.Node('div', {'class' : 'inner'}, item['title'])
                )
            );
        }
        // Init animation
        item['anim'] = new cm.Animation(item['nodes']['container']);
        // Set image on thumb click
        cm.addEvent(item['link'], 'click', function(e){
            e = cm.getEvent(e);
            cm.preventDefault(e);
            set(item['index']);
        }, true, true);
        // Push item to array
        items.push(item);
    };

    var set = function(i){
        var item, itemOld;
        if(!that.isProcess){
            that.isProcess = true;
            // Get item
            item = items[i];
            itemOld = items[that.current];
            // API onSet
            that.triggerEvent('onSet', {
                'current' : item,
                'previous' : itemOld
            });
            // If current active item not equal new item - process with new item, else redraw window alignment and dimensions
            if(i != that.current){
                // API onSet
                that.triggerEvent('onChange', {
                    'current' : item,
                    'previous' : itemOld
                });
                // Check type
                if(item['type'] == 'image'){
                    setItemImage(i, item, itemOld);
                }else{
                    setItemIframe(i, item, itemOld);
                }
            }else{
                that.isProcess = false;
            }
        }
    };

    var setItemImage = function(i, item, itemOld){
        cm.replaceClass(that.nodes['bar'], 'is-partial', 'is-full');
        if(!item['isLoad']){
            setLoader(i, item, itemOld);
        }else{
            setItem(i, item, itemOld);
        }
    };

    var setItemIframe = function(i, item, itemOld){
        cm.replaceClass(that.nodes['bar'], 'is-full', 'is-partial');
        that.nodes['holder'].appendChild(item['nodes']['container']);
        setLoader(i, item, itemOld);
    };

    var setLoader = function(i, item, itemOld){
        that.nodes['loader'].style.display = 'block';
        anim['loader'].go({'style' : {'opacity' : 1}, 'anim' : 'smooth', 'duration' : that.params['duration']});
        // Add image load event and src
        cm.addEvent(item['nodes']['content'], 'load', function(){
            item['isLoad'] = true;
            // Hide loader
            removeLoader();
            // Set and show item
            setItem(i, item, itemOld);
        });
        cm.addEvent(item['nodes']['content'], 'error', function(){
            item['isLoad'] = false;
            // Hide loader
            removeLoader();
            // Set and show item
            setItem(i, item, itemOld);
        });
        item['nodes']['content'].src = item['src'];
    };

    var removeLoader = function(){
        anim['loader'].go({'style' : {'opacity' : 0}, 'anim' : 'smooth', 'duration' : that.params['duration'], 'onStop' : function(){
            that.nodes['loader'].style.display = 'none';
        }});
    };

    var setItem = function(i, item, itemOld){
        // Set new active
        that.previous = that.current;
        that.current = i;
        // API onImageSetStart
        that.triggerEvent('onItemLoad', item);
        // Embed item content
        if(itemOld){
            itemOld['nodes']['container'].style.zIndex = 1;
            item['nodes']['container'].style.zIndex = 2;
        }
        if(item['type'] == 'image'){
            that.nodes['holder'].appendChild(item['nodes']['container']);
        }
        // Animate Slide
        item['anim'].go({'style' : {'opacity' : 1}, 'anim' : 'smooth', 'duration' : that.params['duration'], 'onStop' : function(){
            // Remove old item
            if(itemOld){
                cm.setOpacity(itemOld['nodes']['container'], 0);
                cm.remove(itemOld['nodes']['container']);
            }
            // API onImageSet event
            that.triggerEvent('onItemSet', item);
            that.isProcess = false;
        }});
    };

    var next = function(){
        set((that.current == items.length - 1)? 0 : that.current + 1);
    };

    var prev = function(){
        set((that.current == 0)? items.length - 1 : that.current - 1);
    };

    var zoom = function(){
        that.components['zoom']
            .set(items[that.current]['src'])
            .open();
    };

    /* ******* MAIN ******* */

    that.set = function(i){
        if(!isNaN(i) && items[i]){
            set(i);
        }
        return that;
    };

    that.next = function(){
        next();
        return that;
    };

    that.prev = function(){
        prev();
        return that;
    };

    that.getCount = function(){
        return items.length;
    };

    that.stop = function(){
        that.isProcess = false;
        return that;
    };

    that.collect = function(node){
        var nodes;
        if(cm.isNode(node)){
            nodes = cm.getNodes(node);
            // Collect items
            if(nodes['items']){
                cm.forEach(nodes['items'], collectItem);
                afterRender();
            }
        }
        return that;
    };

    init();
});
cm.define('Com.GalleryLayout', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'DataNodes'
    ],
    'events' : [
        'onRender',
        'onChange'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'barDirection' : 'horizontal',      // horizontal | vertical
        'hasBar' : true,
        'Com.Gallery' : {},
        'Com.Scroll' : {
            'step' : 25,
            'time' : 25
        }
    }
},
function(params){
    var that = this,
        components = {},
        items = [];
    
    that.nodes = {
        'inner' : cm.Node('div'),
        'preview-inner' : cm.Node('div'),
        'bar-inner' : cm.Node('div'),
        'bar-items' : []
    };

    /* *** CLASS FUNCTIONS *** */

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node'], that.params['nodesDataMarker'], false);
        that.getDataConfig(that.params['node']);
        collectItems();
        render();
    };

    var render = function(){
        // Scroll
        components['scroll'] = new Com.Scroll(
            cm.merge(that.params['Com.Scroll'], {
                'nodes' : that.nodes['ComScroll']
            })
        );
        // Gallery
        components['gallery'] = new Com.Gallery(
                cm.merge(that.params['Com.Gallery'], {
                    'container' : that.nodes['preview-inner'],
                    'data' : items
                })
            )
            .addEvent('onChange', onChange)
            .set(0);
        // API onRender event
        that.triggerEvent('onRender');
    };

    var collectItems = function(){
        cm.forEach(that.nodes['bar-items'], function(item){
            item['title'] = item['link']? item['link'].getAttribute('title') || '' : '';
            item['src'] = item['link']? item['link'].getAttribute('href') || '' : '';
            items.push(item);
        });
    };

    var onChange = function(gallery, data){
        var item = data['current'],
            left,
            top;
        
        if(that.params['hasBar']){
            // Thumbs classes
            if(data['previous']){
                cm.removeClass(data['previous']['container'], 'active');
            }
            cm.addClass(item['container'], 'active');
            // Move bar
            if(that.params['barDirection'] == 'vertical'){
                top = item['container'].offsetTop - (that.nodes['inner'].offsetHeight / 2) + (item['container'].offsetHeight / 2);
                components['scroll'].scrollY(top);
            }else{
                left = item['container'].offsetLeft - (that.nodes['inner'].offsetWidth / 2) + (item['container'].offsetWidth / 2);
                components['scroll'].scrollX(left);
            }
        }
        // API onSet event
        that.triggerEvent('onChange', data);
    };

    /* ******* MAIN ******* */

    init();
});
cm.define('Com.GalleryPopup', {
    'modules' : [
        'Params',
        'DataConfig',
        'Events',
        'Stack'
    ],
    'events' : [
        'onOpen',
        'onClose',
        'onChange'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'name' : '',
        'size' : 'fullscreen',                   // fullscreen | auto
        'aspectRatio' : 'auto',                  // auto | 1x1 | 4x3 | 3x2 | 16x10 | 16x9 | 2x1 | 21x9 | 35x10 | 3x4 | 2x3 | 10x16 | 9x16 | 1x2
        'theme' : 'theme-black',
        'showCounter' : true,
        'showTitle' : true,
        'data' : [],
        'openOnSelfClick' : false,
        'Com.Dialog' : {
            'width' : '700',
            'autoOpen' : false,
            'titleOverflow' : true,
            'closeOnBackground' : true,
            'className' : 'com__gallery-popup'
        },
        'Com.Gallery' : {
            'showCaption' : false
        }
    }
},
function(params){
    var that = this,
        nodes = {},
        components = {};

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['node']);
        that.addToStack(that.params['node']);
        validateParams();
        render();
        setLogic();
    };

    var validateParams = function(){
        that.params['Com.Dialog']['theme'] = that.params['theme'];
        that.params['Com.Dialog']['size'] = that.params['size'];
        if(that.params['size'] == 'fullscreen'){
            that.params['Com.Dialog']['documentScroll'] = false;
        }
    };

    var render = function(){
        // Structure
        nodes['container'] = cm.Node('div', {'class' : 'com__gallery-preview bottom'},
            nodes['galleryContainer'] = cm.Node('div', {'class' : 'inner'})
        );
        // Set aspect ration
        if(that.params['aspectRatio'] != 'auto'){
            cm.addClass(nodes['container'], ['cm__aspect', that.params['aspectRatio']].join('-'))
        }
    };

    var setLogic = function(){
        // Dialog
        cm.getConstructor('Com.Dialog', function(classConstructor){
            components['dialog'] = new classConstructor(
                    cm.merge(that.params['Com.Dialog'], {
                        'content' : nodes['container']
                    })
                )
                .addEvent('onOpen', function(){
                    cm.addEvent(window, 'keydown', keyboardEvents);
                    that.triggerEvent('onOpen');
                })
                .addEvent('onClose', function(){
                    components['gallery'].stop();
                    cm.removeEvent(window, 'keydown', keyboardEvents);
                    that.triggerEvent('onClose');
                });
        });
        // Gallery
        cm.getConstructor('Com.Gallery', function(classConstructor){
            components['gallery'] = new classConstructor(
                    cm.merge(that.params['Com.Gallery'], {
                        'node' : that.params['node'],
                        'container' : nodes['galleryContainer'],
                        'data' : that.params['data']
                    })
                )
                .addEvent('onSet', components['dialog'].open)
                .addEvent('onChange', onChange);
        });
        // Node's self click
        if(that.params['openOnSelfClick']){
            cm.addEvent(that.params['node'], 'click', that.open);
        }
    };

    var onChange = function(gallery, data){
        var title;
        // Set caption
        if(that.params['showCounter']){
            title = [(data['current']['index'] + 1), gallery.getCount()].join('/');
        }
        if(that.params['showTitle']){
            if(that.params['showCounter']){
                if(!cm.isEmpty(data['current']['title'])){
                    title = [title, data['current']['title']].join(' - ');
                }
            }else{
                title = data['current']['title'];
            }
        }
        if(that.params['showCounter'] || that.params['showTitle']){
            components['dialog'].setTitle(title);
        }
        that.triggerEvent('onChange', data);
    };

    var keyboardEvents = function(e){
        e = cm.getEvent(e);
        switch(e.keyCode){
            case 37:
                components['dialog'].isFocus && components['gallery'].prev();
                break;
            case 39:
                components['dialog'].isFocus && components['gallery'].next();
                break;
        }
    };

    /* ******* MAIN ******* */

    that.open = function(){
        that.set(0);
        return that;
    };

    that.close = function(){
        components['dialog'].close();
        return that;
    };

    that.set = function(i){
        components['gallery'].set(i);
        return that;
    };

    that.next = function(){
        components['gallery'].next();
        return that;
    };

    that.prev = function(){
        components['gallery'].prev();
        return that;
    };

    that.collect = function(node){
        components['gallery'].collect(node);
        return that;
    };

    init();
});
cm.define('Com.Glossary', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'DataNodes'
    ],
    'require' : [
        'Com.Tooltip'
    ],
    'events' : [
        'onRender'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'showTitle' : true,
        'Com.Tooltip' : {
            'className' : 'com__glossary__tooltip',
            'targetEvent' : 'hover'
        }
    }
},
function(params){
    var that = this;

    that.components = {};
    that.nodes = {
        'container' : cm.Node('div'),
        'title' : cm.Node('div'),
        'content' : cm.Node('div')
    };

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);
        render();
    };

    var render = function(){
        // Init tooltip
        that.components['tooltip'] = new Com.Tooltip(
            cm.merge(that.params['Com.Tooltip'], {
                'target' : that.nodes['container'],
                'content' : that.nodes['content'],
                'title' : that.params['showTitle']? that.nodes['title'].cloneNode(true) : ''
            })
        );
        that.triggerEvent('onRender', {});
    };

    /* ******* MAIN ******* */

    init();
});
cm.define('Com.Gridlist', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig'
    ],
    'events' : [
        'onSort',
        'onCheckAll',
        'onUnCheckAll',
        'onCheck',
        'onUnCheck',
        'onRenderStart',
        'onRenderEnd'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'container' : false,
        'data' : [],
        'cols' : [],
        'sort' : true,
        'sortBy' : 'id',                                    // default sort by key in array
        'orderBy' : 'ASC',
        'childsBy' : false,
        'pagination' : true,
        'perPage' : 25,
        'showCounter' : false,
        'className' : '',
        'dateFormat' : 'cm._config.dateTimeFormat',        // input date format
        'visibleDateFormat' : 'cm._config.dateTimeFormat', // render date format
        'langs' : {
            'counter' : 'Count: ',
            'check_all' : 'Check all',
            'uncheck_all' : 'Uncheck all',
            'empty' : 'Items does not found'
        },
        'icons' : {
            'arrow' : {
                'desc' : 'icon arrow desc',
                'asc' : 'icon arrow asc'
            }
        },
        'statuses' : ['active', 'success', 'danger', 'warning'],
        'Com.Pagination' : {
            'renderStructure' : true,
            'animateSwitch' : true,
            'animatePrevious' : true
        }
    }
},
function(params){
    var that = this,
        rows = [],
        sortBy,
        orderBy;

    that.nodes = {};
    that.components = {};
    that.isCheckedAll = false;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['node']);
        validateParams();
        render();
    };

    var validateParams = function(){
        if(!that.params['container']){
            that.params['container'] = that.params['node'];
        }
        // Pagination
        that.params['Com.Pagination']['count'] = that.params['data'].length;
        that.params['Com.Pagination']['perPage'] = that.params['perPage'];
    };

    /* *** TABLE RENDER FUNCTION *** */

    var render = function(){
        // Container
        that.params['container'].appendChild(
            that.nodes['container'] = cm.Node('div', {'class' : 'com__gridlist'})
        );
        // Add css class
        !cm.isEmpty(that.params['className']) && cm.addClass(that.nodes['container'], that.params['className']);
        // Counter
        if(that.params['showCounter']){
            that.nodes['container'].appendChild(
                cm.Node('div', {'class' : 'pt__gridlist__counter'}, that.lang('counter') + that.params['data'].length)
            );
        }
        // Sort data array for first time
        that.params['sort'] && arraySort(that.params['sortBy']);
        // Render table
        if(that.params['data'].length){
            if(that.params['pagination']){
                that.components['pagination'] = new Com.Pagination(
                    cm.merge(that.params['Com.Pagination'], {
                        'container' : that.nodes['container'],
                        'events' : {
                            'onPageRender' : function(pagination, data){
                                renderTable(data['page'], data['container']);
                            }
                        }
                    })
                );
            }else{
                renderTable(1, that.nodes['container']);
            }
        }else{
            that.nodes['container'].appendChild(
                cm.Node('div', {'class' : 'cm__empty'}, that.lang('empty'))
            );
        }
    };

    var renderTable = function(page, container){
        var start, end;
        /*
        If pagination not exists we need to clean up table before render new one, cause on ech sort will be rendered new table.
        When pagination exists, ech rendered table will be have his own container, and no needs to clean up previous table.
        */
        if(!that.params['pagination']){
            cm.remove(that.nodes['table']);
        }
        // API onRenderStart event
        that.triggerEvent('onRenderStart', {
            'container' : container,
            'page' : page
        });
        // Render Table
        that.nodes['table'] = cm.Node('div', {'class' : 'pt__gridlist'},
            cm.Node('table',
                cm.Node('thead',
                    that.nodes['title'] = cm.Node('tr')
                ),
                that.nodes['content'] = cm.Node('tbody')
            )
        );
        // Render Table Title
        cm.forEach(that.params['cols'], renderTh);
        // Render Table Row
        if(that.params['pagination']){
            end = that.params['perPage'] * page;
            start = end - that.params['perPage'];
        }else{
            end = that.params['data'].length;
            start = 0;
        }
        for(var i = start, l = Math.min(end, that.params['data'].length); i < l; i++){
            renderRow(rows, that.params['data'][i], i);
        }
        // Append
        container.appendChild(that.nodes['table']);
        // API onRenderEnd event
        that.triggerEvent('onRenderEnd', {
            'container' : container,
            'page' : page,
            'rows' : rows
        });
    };

    var renderTh = function(item, i){
        // Config
        item = that.params['cols'][i] = cm.merge({
            'width' : 'auto',               // number | % | auto
            'access' : true,                // Render column if is accessible
            'type' : 'text',		        // text | number | url | date | html | icon | checkbox | empty | actions
            'key' : '',                     // Data array key
            'title' : '',                   // Table th title
            'sort' : that.params['sort'],   // Sort this column or not
            'textOverflow' : false,         // Overflow long text to single line
            'class' : '',		            // Icon css class, for type="icon"
            'target' : '_blank',            // Link target, for type="url"
            'showTitle' : false,            // Show title on hover
            'titleText' : '',               // Alternative title text, if not specified - will be shown key text
            'altText' : '',                 // Alternative column text
            'urlKey' : false,               // Alternative link href, for type="url"
            'actions' : [],                 // Render actions menu, for type="actions"
            'onClick' : false,              // Cell click handler
            'onRender' : false              // Cell onRender handler
        }, item);
        item['nodes'] = {};
        // Check access
        if(item['access']){
            // Structure
            that.nodes['title'].appendChild(
                item['nodes']['container'] = cm.Node('th', {'width' : item['width']},
                    item['nodes']['inner'] = cm.Node('div', {'class' : 'inner'})
                )
            );
            // Insert specific specified content in th
            switch(item['type']){
                case 'checkbox' :
                    cm.addClass(item['nodes']['container'], 'control');
                    item['nodes']['inner'].appendChild(
                        item['nodes']['checkbox'] = cm.Node('input', {'type' : 'checkbox', 'title' : that.lang('check_all')})
                    );
                    item['nodes']['checkbox'].checked = that.isCheckedAll;
                    cm.addEvent(item['nodes']['checkbox'], 'click', function(){
                        if(that.isCheckedAll == true){
                            that.unCheckAll();
                        }else{
                            that.checkAll();
                        }
                    });
                    that.nodes['checkbox'] = item['nodes']['checkbox'];
                    break;

                default:
                    item['nodes']['inner'].appendChild(
                        cm.Node('span', item['title'])
                    );
                    break;
            }
            // Render sort arrow and set function on click to th
            if(!/icon|empty|actions|checkbox/.test(item['type']) && item['sort']){
                cm.addClass(item['nodes']['container'], 'sort');
                if(item['key'] == sortBy){
                    item['nodes']['inner'].appendChild(
                        cm.Node('div', {'class' : that.params['icons']['arrow'][orderBy.toLowerCase()]})
                    );
                }
                cm.addEvent(item['nodes']['inner'], 'click', function(){
                    arraySort(item['key']);
                    if(that.params['pagination']){
                        that.components['pagination'].rebuild();
                    }else{
                        renderTable(1, that.nodes['container']);
                    }
                });
            }
        }
    };

    var renderRow = function(parent, row, i){
        // Config
        var item = {
            'index' : i,
            'data' : row,
            'childs' : [],
            'isChecked' : row['_checked'] || false,
            'status' : row['_status'] || false,
            'nodes' : {
                'cols' : []
            }
        };
        // Structure
        that.nodes['content'].appendChild(
            item['nodes']['container'] = cm.Node('tr')
        );
        // Render cells
        cm.forEach(that.params['cols'], function(col){
            renderCell(col, item);
        });
        // Render childs
        if(that.params['childsBy']){
            cm.forEach(row[that.params['childsBy']], function(child, childI){
                renderRow(item['childs'], child, childI);
            });
        }
        // Push to rows array
        rows.push(item);
    };

    var renderCell = function(col, item){
        var nodes = {},
            text,
            title,
            href;
        // Check access
        if(col['access']){
            text = cm.isEmpty(item['data'][col['key']])? '' : item['data'][col['key']];
            title = cm.isEmpty(col['titleText'])? text : col['titleText'];
            // Structure
            item['nodes']['container'].appendChild(
                nodes['container'] = cm.Node('td')
            );
            // Text overflow
            if(col['textOverflow']){
                nodes['inner'] = cm.Node('div', {'class' : 'inner'});
                nodes['container'].appendChild(nodes['inner']);
            }else{
                nodes['inner'] = nodes['container'];
            }
            // Insert value by type
            switch(col['type']){
                case 'number' :
                    nodes['inner'].innerHTML = cm.splitNumber(text);
                    break;

                case 'date' :
                    if(that.params['dateFormat'] != that.params['visibleDateFormat']){
                        nodes['inner'].innerHTML = cm.dateFormat(
                            cm.parseDate(text, that.params['dateFormat']),
                            that.params['visibleDateFormat']
                        );
                    }else{
                        nodes['inner'].innerHTML = text;
                    }
                    break;

                case 'icon' :
                    nodes['inner'].appendChild(
                        nodes['node'] = cm.Node('div', {'class' : col['class']})
                    );
                    cm.addClass(nodes['node'], 'icon linked inline');
                    break;

                case 'url' :
                    text = cm.decode(text);
                    href = col['urlKey'] && item['data'][col['urlKey']]? cm.decode(item['data'][col['urlKey']]) : text;
                    nodes['inner'].appendChild(
                        nodes['node'] = cm.Node('a', {'target' : col['target'], 'href' : href}, !cm.isEmpty(col['altText'])? col['altText'] : text)
                    );
                    break;

                case 'checkbox' :
                    cm.addClass(nodes['container'], 'control');
                    nodes['inner'].appendChild(
                        nodes['node'] = cm.Node('input', {'type' : 'checkbox'})
                    );
                    item['nodes']['checkbox'] = nodes['node'];
                    if(item['isChecked']){
                        checkRow(item, false);
                    }
                    cm.addEvent(nodes['node'], 'click', function(){
                        if(!item['isChecked']){
                            checkRow(item, true);
                        }else{
                            unCheckRow(item, true);
                        }
                    });
                    break;

                case 'actions':
                    nodes['actions'] = [];
                    nodes['inner'].appendChild(
                        nodes['node'] = cm.Node('div', {'class' : ['pt__links', col['class']].join(' ')},
                            nodes['actionsList'] = cm.Node('ul')
                        )
                    );
                    cm.forEach(col['actions'], function(actionItem){
                        var actionNode;
                        actionItem = cm.merge({
                            'label' : '',
                            'attr' : {},
                            'events' : {}
                        }, actionItem);
                        cm.forEach(item['data'], function(itemValue, itemKey){
                            actionItem['attr'] = cm.replaceDeep(actionItem['attr'], new RegExp([cm.strWrap(itemKey, '%'), cm.strWrap(itemKey, '%25')].join('|'), 'g'), itemValue);
                        });
                        nodes['actionsList'].appendChild(
                            cm.Node('li',
                                actionNode = cm.Node('a', actionItem['attr'], actionItem['label'])
                            )
                        );
                        cm.forEach(actionItem['events'], function(actionEventHandler, actionEventName){
                            cm.addEvent(actionNode, actionEventName, actionEventHandler);
                        });
                        nodes['actions'].push(actionNode);
                    });
                    break;

                case 'empty' :
                    break;

                default :
                    nodes['inner'].innerHTML = text;
                    break;
            }
            // Statuses
            if(item['status']){
                setRowStatus(item, item['status']);
            }
            // onHover Title
            if(col['showTitle']){
                if(nodes['node']){
                    nodes['node'].title = title;
                }else{
                    nodes['inner'].title = title;
                }
            }
            // onClick handler
            if(col['onClick']){
                cm.addEvent(nodes['node'] || nodes['inner'], 'click', function(e){
                    e = cm.getEvent(e);
                    cm.preventDefault(e);
                    // Column onClick event
                    col['onClick'](that, item);
                });
            }
            // onCellRender handler
            if(col['onRender']){
                col['onRender'](that, {
                    'nodes' : nodes,
                    'col' : col,
                    'row' : item
                });
            }
            // Push cell to row nodes array
            item['nodes']['cols'].push(nodes);
        }
    };

    /* *** HELPING FUNCTIONS *** */

    var arraySort = function(key){
        sortBy = key;
        orderBy = !orderBy? that.params['orderBy'] : (orderBy == 'ASC' ? 'DESC' : 'ASC');
        // Get item
        var item, textA, textB, t1, t2, value;
        cm.forEach(that.params['cols'], function(col){
            if(col['key'] == key){
                item = col;
            }
        });
        // Sort
        if(that.params['data'].sort){
            that.params['data'].sort(function(a, b){
                textA = a[key];
                textB = b[key];
                switch(item['type']){
                    case 'html':
                        t1 = cm.getTextNodesStr(cm.strToHTML(textA));
                        t2 = cm.getTextNodesStr(cm.strToHTML(textB));
                        value = (t1 < t2)? -1 : ((t1 > t2)? 1 : 0);
                        return (orderBy == 'ASC')? value : (-1 * value);
                        break;

                    case 'date':
                        t1 = cm.parseDate(textA, that.params['dateFormat']);
                        t2 = cm.parseDate(textB, that.params['dateFormat']);
                        return (orderBy == 'ASC')? (t1 - t2) : (t2 - t1);
                        break;

                    case 'number':
                        value = textA - textB;
                        return (orderBy == 'ASC')? value : (-1 * value);
                        break;

                    default :
                        t1 = textA? textA.toLowerCase() : '';
                        t2 = textB? textB.toLowerCase() : '';
                        value = (t1 < t2)? -1 : ((t1 > t2)? 1 : 0);
                        return (orderBy == 'ASC')? value : (-1 * value);
                        break;
                }
            });
        }
        // API onSort Event
        that.triggerEvent('onSort', {
            'sortBy' : sortBy,
            'orderBy' : orderBy,
            'data' : that.params['data']
        });
    };

    var checkRow = function(row, execute){
        if(row['nodes']['checkbox']){
            row['nodes']['checkbox'].checked = true;
        }
        row['isChecked'] = true;
        row['data']['_checked'] = true;
        if(row['status']){
            cm.removeClass(row['nodes']['container'], row['status']);
        }
        cm.addClass(row['nodes']['container'], 'active');
        if(execute){
            // API onCheck Event
            that.triggerEvent('onCheck', row);
        }
    };

    var unCheckRow = function(row, execute){
        if(row['nodes']['checkbox']){
            row['nodes']['checkbox'].checked = false;
        }
        row['isChecked'] = false;
        row['data']['_checked'] = false;
        cm.removeClass(row['nodes']['container'], 'active');
        if(row['status']){
            cm.addClass(row['nodes']['container'], row['status']);
        }
        if(execute){
            // API onUnCheck Event
            that.triggerEvent('onUnCheck', row);
        }
    };

    var setRowStatus = function(row, status){
        row['status'] = status;
        row['data']['_status'] = status;
        cm.removeClass(row['nodes']['container'], that.params['statuses'].join(' '));
        if(row['isChecked']){
            cm.addClass(row['nodes']['container'], 'active');
        }else if(cm.inArray(that.params['statuses'], status)){
            cm.addClass(row['nodes']['container'], status);
        }
    };

    var clearRowStatus = function(row){
        row['status'] = null;
        row['data']['_status'] = null;
        cm.removeClass(row['nodes']['container'], that.params['statuses'].join(' '));
    };

    /* ******* MAIN ******* */

    that.check = function(index){
        if(that.params['data'][index]){
            that.params['data'][index]['_checked'] = true;
        }
        cm.forEach(rows, function(row){
            if(row['index'] == index){
                checkRow(row, true);
            }
        });
        return that;
    };

    that.unCheck = function(index){
        if(that.params['data'][index]){
            that.params['data'][index]['_checked'] = false;
        }
        cm.forEach(rows, function(row){
            if(row['index'] == index){
                unCheckRow(row, true);
            }
        });
        return that;
    };

    that.checkAll = function(){
        that.isCheckedAll = true;
        that.nodes['checkbox'].checked = true;
        cm.forEach(that.params['data'], function(row){
            row['_checked'] = true;
        });
        cm.forEach(rows, function(row){
            checkRow(row);
        });
        // API onUnCheckAll Event
        that.triggerEvent('onCheckAll', that.params['data']);
        return that;
    };

    that.unCheckAll = function(){
        that.isCheckedAll = false;
        that.nodes['checkbox'].checked = false;
        cm.forEach(that.params['data'], function(row){
            row['_checked'] = false;
        });
        cm.forEach(rows, function(row){
            unCheckRow(row);
        });
        // API onUnCheckAll Event
        that.triggerEvent('onUnCheckAll', that.params['data']);
        return that;
    };

    that.getChecked = function(){
        var checkedRows = [];
        cm.forEach(rows, function(row){
            row['isChecked'] && checkedRows.push(row);
        });
        return checkedRows;
    };

    that.getCheckedData = function(){
        var checkedRows = [];
        cm.forEach(that.params['data'], function(row){
            row['_checked'] && checkedRows.push(row);
        });
        return checkedRows;
    };

    that.setRowStatus = function(index, status){
        cm.forEach(rows, function(row){
            if(row['index'] == index){
                setRowStatus(row, status);
            }
        });
        return that;
    };

    that.clearRowStatus = function(index){
        cm.forEach(rows, function(row){
            if(row['index'] == index){
                clearRowStatus(row);
            }
        });
        return that;
    };

    init();
});
cm.define('Com.GridlistHelper', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig',
        'DataNodes',
        'Stack'
    ],
    'events' : [
        'onRender',
        'onColumnsChange',
        'onColumnsResize'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'name' : '',
        'isEditMode' : true,
        'columns' : {
            'showDrag' : false,
            'ajax' : {
                'type' : 'json',
                'method' : 'post',
                'url' : '',                                             // Request URL. Variables: %items%, %callback% for JSONP.
                'params' : ''                                           // Params object. %items%, %callback% for JSONP.
            }
        }
    }
},
function(params){
    var that = this;

    that.nodes = {
        'container' : cm.node('div'),
        'thead' : cm.node('thead'),
        'items' : []
    };
    that.components = {};
    that.isEditMode = false;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);
        validateParams();
        render();
        that.addToStack(that.nodes['container']);
        that.triggerEvent('onRender');
    };

    var validateParams = function(){
        that.nodes['container'] = that.params['node'];
        that.isEditMode = that.params['isEditMode'];
    };

    var render = function(){
        // Get Nodes
        that.nodes['thead'] = that.nodes['container'].getElementsByTagName('thead')[0] || that.nodes['thead'];
        that.nodes['items'] = that.nodes['thead'].getElementsByTagName('th');
        // Init Columns
        cm.getConstructor('Com.ColumnsHelper', function(classConstructor){
            that.components['columns'] = new classConstructor(
                cm.merge(that.params['columns'], {
                    'isEditMode' : false,
                    'node' : that.nodes['container'],
                    'items' : that.nodes['items'],
                    'events' : {
                        'onDragStart' : function(){
                            cm.addClass(that.nodes['container'], 'is-active');
                        },
                        'onDragStop' : function(){
                            cm.removeClass(that.nodes['container'], 'is-active');
                        },
                        'onChange' : function(my, items){
                            that.triggerEvent('onColumnsChange', items);
                        },
                        'onResize' : function(my, items){
                            that.triggerEvent('onColumnsResize', items);
                        }
                    }
                })
            );
        });
        // Edit mode
        if(that.isEditMode){
            that.enableEditMode();
        }
    };

    /* ******* PUBLIC ******* */

    that.enableEditMode = function(){
        that.isEditMode = true;
        cm.addClass(that.nodes['container'], 'is-editable');
        if(that.components['columns']){
            that.components['columns'].enableEditMode();
        }
        return that;
    };

    that.disableEditMode = function(){
        that.isEditMode = false;
        cm.removeClass(that.nodes['container'], 'is-editable');
        if(that.components['columns']){
            that.components['columns'].disableEditMode();
        }
        return that;
    };

    init();
});
cm.define('Com.HelpBubble', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig',
        'DataNodes',
        'Stack'
    ],
    'events' : [
        'onRender'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'name' : '',
        'renderStructure' : false,
        'container' : false,
        'content' : cm.node('span'),
        'Com.Tooltip' : {
            'className' : 'com__help-bubble__tooltip'
        }
    }
},
function(params){
    var that = this;

    that.nodes = {
        'container' : cm.node('span'),
        'button' : cm.node('span'),
        'content' : cm.node('span')
    };

    that.components = {};

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);
        render();
        that.addToStack(that.nodes['container']);
        that.triggerEvent('onRender');
    };

    var render = function(){
        // Render structure
        if(that.params['renderStructure']){
            that.nodes['container'] = cm.node('span', {'class' : 'com__help-bubble'},
                that.nodes['button'] = cm.node('span', {'class' : 'icon default linked'}),
                that.nodes['content'] = cm.node('span', {'class' : 'com__help-bubble__content'},
                    that.params['content']
                )
            );
            // Embed
            if(that.params['container']){
                that.params['container'].appendChild(that.nodes['container']);
            }
        }
        // Render tooltip
        cm.getConstructor('Com.Tooltip', function(classConstructor){
            that.components['tooltip'] = new classConstructor(that.params['Com.Tooltip']);
            that.components['tooltip']
                .setTarget(that.nodes['button'])
                .setContent(that.nodes['content']);
        });
    };

    /* ******* PUBLIC ******* */

    that.set = function(node){
        if(cm.isNode(node)){
            cm.clearNode(that.nodes['content']);
            that.nodes['content'].appendChild(node);
        }
        return that;
    };

    init();
});
cm.define('Com.ImageBox', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'DataNodes',
        'Stack'
    ],
    'events' : [
        'onRender'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'name' : '',
        'animated' : false,
        'effect' : 'none',
        'zoom' : false,
        'scrollNode' : window,
        'Com.GalleryPopup' : {}
    }
},
function(params){
    var that = this,
        dimensions = {},
        pageDimensions = {};

    that.nodes = {
        'items' : []
    };
    that.components = {};
    that.processed = false;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['node']);
        that.getDataNodes(that.params['node']);
        validateParams();
        render();
        that.addToStack(that.params['node']);
        that.triggerEvent('onRender');
    };

    var validateParams = function(){
        that.params['Com.GalleryPopup']['node'] = that.params['node'];
    };

    var render = function(){
        if(that.params['animated']){
            cm.addClass(that.params['node'], 'cm-animate');
            cm.addClass(that.params['node'], ['pre', that.params['effect']].join('-'));
            cm.addEvent(that.params['scrollNode'], 'scroll', process);
            process();
        }
        if(that.params['zoom']){
            cm.getConstructor('Com.GalleryPopup', function(classConstructor){
                that.components['popup'] = new classConstructor(that.params['Com.GalleryPopup']);
            });
        }
        // Add custom event
        cm.customEvent.add(that.params['node'], 'redraw', function(){
            that.redraw();
        });
    };

    var process = function(){
        if(!that.processed){
            getDimensions();
            getPageDimensions();
            // Rules for different block sizes.
            if(dimensions['height'] < pageDimensions['winHeight']){
                // Rules for block, which size is smaller than page's.
                if(
                    dimensions['top'] >= 0 &&
                    dimensions['bottom'] <= pageDimensions['winHeight']
                ){
                    set();
                }
            }else{
                // Rules for block, which size is larger than page's.
                if(
                    (dimensions['top'] < 0 && dimensions['bottom'] >= pageDimensions['winHeight'] / 2) ||
                    (dimensions['bottom'] > pageDimensions['winHeight'] && dimensions['top'] <= pageDimensions['winHeight'] / 2)
                ){
                    set();
                }
            }
        }
    };

    var set = function(){
        that.processed = true;
        cm.addClass(that.params['node'], ['animated', that.params['effect']].join(' '));
    };

    var restore = function(){
        that.processed = false;
        cm.removeClass(that.params['node'], ['animated', that.params['effect']].join(' '));
    };
    
    var getDimensions = function(){
        dimensions = cm.getRect(that.params['node']);
    };

    var getPageDimensions = function(){
        pageDimensions = cm.getPageSize();
    };

    /* ******* PUBLIC ******* */

    that.redraw = function(){
        if(that.params['animated']){
            restore();
            process();
        }
        return that;
    };

    init();
});
cm.define('Com.Menu', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'DataNodes',
        'Stack'
    ],
    'events' : [
        'onRender'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'name' : '',
        'event' : 'hover',
        'Com.Tooltip' : {
            'className' : 'com__menu-tooltip',
            'top' : 'targetHeight',
            'targetEvent' : 'hover',
            'hideOnReClick' : true,
            'theme' : false
        }
    }
},
function(params){
    var that = this;

    that.nodes = {
        'button' : cm.Node('div'),
        'target' : cm.Node('div')
    };
    that.components = {};

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);
        validateParams();
        render();
        that.addToStack(that.params['node']);
        that.triggerEvent('onRender');
    };

    var validateParams = function(){
        that.params['Com.Tooltip']['targetEvent'] = that.params['event'];
    };

    var render = function(){
        // Tooltip
        cm.getConstructor('Com.Tooltip', function(classConstructor){
            that.components['tooltip'] = new classConstructor(
                cm.merge(that.params['Com.Tooltip'], {
                    'target' : that.nodes['button'],
                    'content' : that.nodes['target'],
                    'events' : {
                        'onShowStart' : function(){
                            cm.addClass(that.params['node'], 'active');
                            cm.addClass(that.nodes['button'], 'active');
                        },
                        'onHideStart' : function(){
                            cm.removeClass(that.params['node'], 'active');
                            cm.removeClass(that.nodes['button'], 'active');
                        }
                    }
                })
            );
        });
    };

    /* ******* PUBLIC ******* */

    init();
});
cm.define('Com.MultiField', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'DataNodes',
        'Stack',
        'Langs'
    ],
    'events' : [
        'onRender',
        'onItemAdd',
        'onItemRemove',
        'onItemProcess',
        'onItemSort',
        'onItemIndexChange'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'name' : '',
        'renderStructure' : false,
        'container' : false,
        'renderItems' : 0,
        'maxItems' : 0,                         // 0 - infinity
        'template' : null,                      // Html node or string with items template
        'templateAttributeReplace' : false,
        'templateAttribute' : 'name',           // Replace specified items attribute by pattern, example: data-attribute-name="test[%index%]", available variables: %index%
        'sortable' : true,                      // Use drag and drop to sort items
        'duration' : 200,
        'langs' : {
            'add' : 'Add',
            'remove' : 'Remove'
        },
        'icons' : {
            'drag' : 'icon drag linked',
            'add' : 'icon add linked',
            'remove' : 'icon remove linked'
        },
        'Com.Sortable' : {
            'process' : false
        }
    }
}, function(params){
    var that = this,
        toolbarHeight = 0,
        toolbarVisible = true;

    that.nodes = {
        'container' : cm.node('div'),
        'content' : cm.node('ul'),
        'toolbar' : cm.node('li'),
        'add' : cm.node('div'),
        'items' : []
    };
    that.components = {};
    that.items = [];

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);
        validateParams();
        render();
        that.addToStack(that.nodes['container']);
        that.triggerEvent('onRender');
    };

    var validateParams = function(){
        // Check sortable
        if(that.params['sortable']){
            cm.getConstructor('Com.Sortable', function(classConstructor){
                that.components['sortable'] = new classConstructor(that.params['Com.Sortable']);
            });
            if(!that.components['sortable']){
                that.params['sortable'] = false;
            }
        }
    };

    var render = function(){
        // Render Structure
        if(that.params['renderStructure']){
            that.nodes['container'] = cm.node('div', {'class' : 'com__multifield'},
                that.nodes['content'] = cm.node('div', {'class' : 'com__multifield__content'}),
                that.nodes['toolbar'] = cm.node('div', {'class' : 'com__multifield__toolbar'},
                    cm.node('div', {'class' : 'com__multifield__item'},
                        that.nodes['add'] = cm.node('div', {'class' : that.params['icons']['add'], 'title' : that.lang('add')})
                    )
                )
            );
            // Embed
            if(that.params['container']){
                that.params['container'].appendChild(that.nodes['container']);
            }
        }
        // Add button events
        cm.addEvent(that.nodes['add'], 'click', function(e){
            cm.preventDefault(e);
            renderItem();
        });
        // Init Sortable
        if(that.params['sortable']){
            that.components['sortable'].addEvent('onSort', function(my, data){
                var item = that.items.find(function(item){
                    return item['container'] === data['node']
                });
                if(item){
                    sortItem(item, data['index']);
                }
            });
            that.components['sortable'].addGroup(that.nodes['content']);
        }
        // Process rendered items
        cm.forEach(that.nodes['items'], processItem);
        // Render items
        cm.forEach(Math.max(that.params['renderItems'] - that.items.length, 0), renderItem);
    };

    var renderItem = function(){
        if(that.params['maxItems'] == 0 || that.items.length < that.params['maxItems']){
            var item = {
                'isVisible' : false
            };
            // Structure
            item['container'] = cm.node('div', {'class' : 'com__multifield__item', 'data-node' : 'items:[]:container'},
                item['field'] = cm.node('div', {'class' : 'field', 'data-node' : 'field'}),
                item['remove'] = cm.node('div', {'class' : that.params['icons']['remove'], 'title' : that.lang('remove'), 'data-node' : 'remove'})
            );
            // Template
            if(cm.isNode(that.params['template'])){
                cm.appendChild(that.params['template'], item['field']);
            }else if(!cm.isEmpty(that.params['template'])){
                cm.appendChild(cm.strToHTML(that.params['template']), item['field']);
            }
            // Sortable
            if(that.params['sortable']){
                item['drag'] = cm.node('div', {'class' : that.params['icons']['drag'], 'data-node' : 'drag'});
                cm.insertFirst(item['drag'], item['container']);
            }
            // Embed
            that.nodes['content'].appendChild(item['container']);
            // Process
            processItem(item);
            // Trigger event
            that.triggerEvent('onItemAdd', item);
        }
    };

    var processItem = function(item){
        // Register sortable item
        if(that.params['sortable']){
            that.components['sortable'].addItem(item['container'], that.nodes['content']);
        }else{
            cm.remove(item['drag']);
        }
        // Events
        cm.addEvent(item['remove'], 'click', function(e){
            cm.preventDefault(e);
            removeItem(item);
        });
        // Push
        that.items.push(item);
        resetIndexes();
        // Animate
        toggleItemVisibility(item);
        // Toggle toolbar visibility
        toggleToolbarVisibility();
        // Trigger event
        that.triggerEvent('onItemProcess', item);
    };

    var removeItem = function(item){
        // Remove sortable item
        if(that.params['sortable']){
            that.components['sortable'].removeItem(item['container']);
        }
        // Remove from array
        that.items.splice(that.items.indexOf(item), 1);
        resetIndexes();
        // Animate
        toggleItemVisibility(item, function(){
            // Remove from DOM
            cm.remove(item['container']);
        });
        // Toggle toolbar visibility
        toggleToolbarVisibility();
        // Trigger event
        that.triggerEvent('onItemRemove', item);
    };

    var sortItem = function(item, index){
        // Resort items in array
        that.items.splice(that.items.indexOf(item), 1);
        that.items.splice(index, 0, item);
        resetIndexes();
        // Trigger event
        that.triggerEvent('onItemSort', item);
    };

    var resetIndexes = function(){
        cm.forEach(that.items, function(item, index){
            if(item['index'] != index){
                // Set index
                item['index'] = index;
                // Process data attributes
                if(that.params['templateAttributeReplace']){
                    cm.processDataAttributes(item['field'], that.params['templateAttribute'], {'%index%' : index});
                }
                // Trigger event
                that.triggerEvent('onItemIndexChange', item);
            }
        });
    };

    var itemInArray = function(item){
        return !!that.items.find(function(find){
            return find === item;
        });
    };

    var toggleToolbarVisibility = function(){
        if(!toolbarHeight){
            toolbarHeight = that.nodes['toolbar'].offsetHeight;
        }
        if(that.params['maxItems'] > 0 && that.items.length == that.params['maxItems']){
            if(toolbarVisible){
                toolbarVisible = false;
                that.nodes['toolbar'].style.overflow = 'hidden';
                cm.transition(that.nodes['toolbar'], {
                    'properties' : {'height' : '0px', 'opacity' : 0},
                    'duration' : that.params['duration'],
                    'easing' : 'ease-in-out'
                });
            }
        }else{
            if(!toolbarVisible){
                toolbarVisible = true;
                that.nodes['toolbar'].style.overflow = 'hidden';
                cm.transition(that.nodes['toolbar'], {
                    'properties' : {'height' : [toolbarHeight, 'px'].join(''), 'opacity' : 1},
                    'duration' : that.params['duration'],
                    'easing' : 'ease-in-out',
                    'clear' : true,
                    'onStop' : function(){
                        that.nodes['toolbar'].style.overflow = '';
                    }
                });
            }
        }
    };

    var toggleItemVisibility = function(item, callback){
        callback = typeof callback == 'function' ? callback : function(){};
        if(!item['height']){
            item['height'] = item['container'].offsetHeight;
        }
        if(typeof item['isVisible'] == 'undefined'){
            item['isVisible'] = true;
        }else if(item['isVisible']){
            item['isVisible'] = false;
            item['container'].style.overflow = 'hidden';
            cm.transition(item['container'], {
                'properties' : {'height' : '0px', 'opacity' : 0},
                'duration' : that.params['duration'],
                'easing' : 'ease-in-out',
                'onStop' : callback
            });
        }else{
            item['isVisible'] = true;
            item['container'].style.overflow = 'hidden';
            item['container'].style.height = '0px';
            item['container'].style.opacity = 0;
            cm.transition(item['container'], {
                'properties' : {'height' : [item['height'], 'px'].join(''), 'opacity' : 1},
                'duration' : that.params['duration'],
                'easing' : 'ease-in-out',
                'clear' : true,
                'onStop' : function(){
                    item['container'].style.overflow = '';
                    callback();
                }
            });
        }
    };

    /* ******* PUBLIC ******* */

    that.addItem = function(){
        renderItem();
        return that;
    };

    that.removeItem = function(item){
        if(typeof item == 'number' && that.items[item]){
            removeItem(that.items[item]);
        }else if(itemInArray(item)){
            removeItem(item);
        }
        return that;
    };

    that.getItem = function(index){
        if(that.items[index]){
            return that.items[index];
        }
        return null;
    };

    that.getItems = function(){
        return that.items;
    };

    init();
});
cm.define('Com.OldBrowserAlert', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'Storage',
        'Stack'
    ],
    'events' : [
        'onRender'
    ],
    'params' : {
        'name' : 'default',
        'remember' : true,
        'versions' : {
            'IE' : 10,
            'FF' : 31,
            'Chrome' : 40,
            'Safari' : 6,
            'Opera' : 26
        },
        'langs' : {
            'title' : 'Thank you for visiting our site!',
            'descr' : 'It seems that you are using an outdated browser <b>(%browser% %version%)</b>. As a result, we cannot provide you with the best user experience while visiting our site. Please upgrade your <b>%browser%</b> to version <b>%minimum_version%</b> or above, or use another standards based browser such as Firefox, Chrome or Safari, by clicking on the icons below.',
            'continue' : 'Skip for now'
        }
    }
},
function(params){
    var that = this,
        userAgent = Com.UA.get();

    that.nodes = {};
    that.compoennts = {};

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.addToStack();
        check();
        that.triggerEvent('onRender');
    };

    var check = function(){
        cm.forEach(that.params['versions'], function(version, browser){
            if(Com.UA.is(browser) && Com.UA.isVersion() < version){
                // Parse description string, insert browser name and version
                that.params['langs']['descr'] = that.lang('descr', {
                    '%browser%' : userAgent['full_name'],
                    '%version%' : userAgent['full_version'],
                    '%minimum_version%' : version
                });
                // Render window
                if(!that.params['remember'] || (that.params['remember'] && !that.storageRead('isShow'))){
                    render();
                }
            }
        });
    };

    var render = function(){
        // Structure
        that.nodes['container'] = cm.Node('div', {'class' : 'com__oldbrowser-alert'},
            cm.Node('div', {'class' : 'b-descr'},
                cm.Node('p', {'innerHTML' : that.lang('descr')})
            ),
            cm.Node('ul', {'class' : 'b-browsers'},
                cm.Node('li', cm.Node('a', {'class' : 'icon linked chrome', 'title' : 'Google Chrome', 'href' : 'http://www.google.com/chrome/', 'target' : '_blank'})),
                cm.Node('li', cm.Node('a', {'class' : 'icon linked firefox', 'title' : 'Mozilla Firefox', 'href' : 'http://www.mozilla.com/', 'target' : '_blank'})),
                cm.Node('li', cm.Node('a', {'class' : 'icon linked safari', 'title' : 'Apple Safari', 'href' : 'http://www.apple.com/safari/', 'target' : '_blank'})),
                cm.Node('li', cm.Node('a', {'class' : 'icon linked msie', 'title' : 'Microsoft Internet Explorer', 'href' : 'http://ie.microsoft.com/', 'target' : '_blank'}))
            ),
            cm.Node('div', {'class' : 'form'},
                cm.Node('div', {'class' : 'btn-wrap pull-center'},
                    that.nodes['button'] = cm.Node('input', {'type' : 'button', 'value' : that.lang('continue')})
                )
            )
        );
        // Init dialog
        cm.getConstructor('Com.Dialog', function(classConstructor){
            that.compoennts['dialog'] = new classConstructor({
                'title' : that.lang('title'),
                'content' : that.nodes['container'],
                'autoOpen' : false,
                'width' : 500,
                'events' : {
                    'onClose' : function(){
                        if(that.params['remember']){
                            that.storageWrite('isShow', true);
                        }
                    }
                }
            });
            // Add event on continue button
            cm.addEvent(that.nodes['button'], 'click', that.compoennts['dialog'].close);
            // Open dialog
            that.compoennts['dialog'].open();
        });
    };

    /* ******* MAIN ******* */

    init();
});
cm.define('Com.Overlay', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'Stack'
    ],
    'events' : [
        'onRender',
        'onOpenStart',
        'onOpen',
        'onCloseStart',
        'onClose'
    ],
    'params' : {
        'name' : '',
        'container' : 'document.body',
        'theme' : 'default',            // transparent | default | light | dark
        'position' : 'fixed',
        'showSpinner' : true,
        'showContent' : true,
        'autoOpen' : true,
        'removeOnClose' : true,
        'duration' : 500
    }
},
function(params){
    var that = this,
        themes = ['transparent', 'default', 'light', 'dark'];

    that.nodes = {};
    that.isOpen = false;
    that.isShowSpinner = false;
    that.isShowContent = false;

    var init = function(){
        getCSSHelpers();
        that.setParams(params);
        that.convertEvents(that.params['events']);
        validateParams();
        render();
        that.addToStack(that.nodes['container']);
        that.triggerEvent('onRender');
        that.params['autoOpen'] && that.open();
    };
    
    var getCSSHelpers = function(){
        that.params['duration'] = cm.getTransitionDurationFromRule('.pt__overlay-helper__duration');
    };

    var validateParams = function(){
        that.params['position'] = cm.inArray(['static', 'relative', 'absolute', 'fixed'], that.params['position']) ? that.params['position'] : 'fixed';
    };

    var render = function(){
        // Structure
        that.nodes['container'] = cm.Node('div', {'class' : 'com__overlay pt__overlay'},
            that.nodes['spinner'] = cm.Node('div', {'class' : 'overlay__spinner'}),
            that.nodes['content'] = cm.Node('div', {'class' : 'overlay__content'})
        );
        // Set position
        that.nodes['container'].style.position = that.params['position'];
        // Show spinner
        that.params['showSpinner'] && that.showSpinner();
        // Show content
        that.params['showContent'] && that.showContent();
        // Set theme
        that.setTheme(that.params['theme']);
    };

    /* ******* MAIN ******* */

    that.open = function(){
        if(!that.isOpen){
            that.isOpen = true;
            if(!cm.inDOM(that.nodes['container'])){
                that.params['container'].appendChild(that.nodes['container']);
            }
            that.triggerEvent('onOpenStart');
            cm.addClass(that.nodes['container'], 'is-open', true);
            setTimeout(function(){
                that.triggerEvent('onOpen');
            }, that.params['duration']);
        }
        return that;
    };

    that.close = function(){
        if(that.isOpen){
            that.isOpen = false;
            that.triggerEvent('onCloseStart');
            cm.removeClass(that.nodes['container'], 'is-open');
            setTimeout(function(){
                if(that.params['removeOnClose']){
                    cm.remove(that.nodes['container']);
                }
                that.triggerEvent('onClose');
            }, that.params['duration']);
        }
        // Close Event
        return that;
    };
    
    that.toggle = function(){
        if(that.isOpen){
            that.hide();
        }else{
            that.show();
        }
    };

    that.remove = function(){
        if(that.isOpen){
            that.close();
            if(!that.params['removeOnClose']){
                setTimeout(function(){
                    cm.remove(that.nodes['container']);
                }, that.params['duration']);
            }
        }else{
            cm.remove(that.nodes['container']);
        }
        return that;
    };

    that.setTheme = function(theme){
        if(cm.inArray(themes, theme)){
            cm.addClass(that.nodes['container'], ['theme', theme].join('-'));
            cm.forEach(themes, function(item){
                if(item != theme){
                    cm.removeClass(that.nodes['container'], ['theme', item].join('-'));
                }
            });
        }
        return that;
    };

    that.showSpinner = function(){
        that.isShowSpinner = true;
        cm.addClass(that.nodes['spinner'], 'is-show');
        return that;
    };

    that.hideSpinner = function(){
        that.isShowSpinner = false;
        cm.removeClass(that.nodes['spinner'], 'is-show');
        return that;
    };

    that.setContent = function(node){
        if(cm.isNode(node)){
            that.nodes['content'].appendChild(node);
        }
        return that;
    };

    that.showContent = function(){
        that.isShowContent = true;
        cm.addClass(that.nodes['content'], 'is-show');
        return that;
    };

    that.hideContent = function(){
        that.isShowContent = false;
        cm.removeClass(that.nodes['content'], 'is-show');
        return that;
    };

    that.embed = function(node){
        if(cm.isNode(node)){
            that.params['container'] = node;
            node.appendChild(that.nodes['container']);
        }
        return that;
    };

    that.getNodes = function(key){
        return that.nodes[key] || that.nodes;
    };

    init();
});
cm.define('Com.Pagination', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig',
        'DataNodes',
        'Callbacks',
        'Stack'
    ],
    'events' : [
        'onRender',
        'onStart',
        'onAbort',
        'onError',
        'onPageRender',
        'onPageRenderEnd',
        'onPageSwitched',
        'onEnd'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'name' : '',
        'renderStructure' : false,                                  // Render wrapper nodes if not exists in html
        'container' : false,
        'scrollNode' : window,
        'data' : [],                                                // Static data
        'count' : 0,
        'perPage' : 0,                                              // 0 - render all data in one page
        'startPage' : 1,                                            // Start page
        'startPageToken' : '',
        'pageCount' : 0,
        'showLoader' : true,
        'loaderDelay' : 300,                                        // in ms
        'barPosition' : 'bottom',                                   // top | bottom | both, require renderStructure
        'barAlign' : 'left',                                        // left | center | right, require renderStructure
        'barCountLR' : 3,
        'barCountM' : 1,                                            // 1 for drawing 3 center pagination buttons, 2 - 5, 3 - 7, etc
        'switchManually' : false,                                   // Switch pages manually
        'animateSwitch' : false,
        'animateDuration' : 300,
        'animatePrevious' : false,                                  // Animating of hiding previous page, require animateSwitch
        'pageTag' : 'div',
        'pageAttributes' : {
            'class' : 'com__pagination__page'
        },
        'responseCountKey' : 'count',                               // Take items count from response
        'responseKey' : 'data',                                     // Instead of using filter callback, you can provide response array key
        'responseHTML' : false,                                     // If true, html will append automatically
        'ajax' : {
            'type' : 'json',
            'method' : 'get',
            'url' : '',                                             // Request URL. Variables: %page%, %token%, %perPage%, %callback% for JSONP.
            'params' : ''                                           // Params object. %page%, %token%, %perPage%, %callback% for JSONP.
        },
        'Com.Overlay' : {
            'position' : 'absolute',
            'autoOpen' : false,
            'removeOnClose' : true
        },
        'langs' : {
            'prev' : 'Previous',
            'next' : 'Next'
        }
    }
},
function(params){

    var that = this;

    that.nodes = {
        'container' : cm.Node('div'),
        'content' : cm.Node('div'),
        'pages' : cm.Node('div'),
        'bar' : []
    };

    that.components = {};
    that.animations = {};
    that.pages = {};
    that.ajaxHandler = null;
    that.loaderDelay = null;

    that.isAjax = false;
    that.isProcess = false;
    that.isRendering = false;

    that.page = null;
    that.pageToken = null;
    that.currentPage = null;
    that.previousPage = null;
    that.pageCount = 0;

    var init = function(){
        getCSSHelpers();
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);
        that.callbacksProcess();
        validateParams();
        render();
        that.addToStack(that.nodes['container']);
        that.triggerEvent('onRender');
        set(that.params['startPage']);
    };

    var getCSSHelpers = function(){
        that.params['animateDuration'] = cm.getTransitionDurationFromRule('.com__pagination-helper__duration');
    };

    var validateParams = function(){
        // If URL parameter exists, use ajax data
        if(!cm.isEmpty(that.params['ajax']['url'])){
            that.isAjax = true;
        }else{
            if(!cm.isEmpty(that.params['data'])){
                that.params['count'] = that.params['data'].length;
            }
            that.params['showLoader'] = false;
        }
        if(that.params['pageCount'] == 0){
            that.pageCount = Math.ceil(that.params['count'] / that.params['perPage']);
        }else{
            that.pageCount = that.params['pageCount'];
        }
        // Set start page token
        that.setToken(that.params['startPage'], that.params['startPageToken']);
        // Loader
        that.params['Com.Overlay']['container'] = that.nodes['content'];
    };

    var render = function(){
        // Render Structure
        if(that.params['renderStructure']){
            that.nodes['container'] = cm.Node('div', {'class' : 'com__pagination'},
                that.nodes['content'] = cm.Node('div', {'class' : 'com__pagination__content'},
                    that.nodes['pages'] = cm.Node('div', {'class' : 'com__pagination__pages'})
                )
            );
            // Bars
            if(/top|both/.test(that.params['barPosition'])){
                that.nodes['bar'].push(
                    that.callbacks.renderBar(that, {
                        'align' : that.params['barAlign'],
                        'position' : 'top'
                    })
                );
            }
            if(/bottom|both/.test(that.params['barPosition'])){
                that.nodes['bar'].push(
                    that.callbacks.renderBar(that, {
                        'align' : that.params['barAlign'],
                        'position' : 'bottom'
                    })
                );
            }
            // Embed
            if(that.params['container']){
                that.params['container'].appendChild(that.nodes['container']);
            }
        }
        // Reset styles and variables
        reset();
        // Overlay
        cm.getConstructor('Com.Overlay', function(classConstructor){
            that.components['loader'] = new classConstructor(that.params['Com.Overlay']);
        });
        // Animated
        if(that.params['animateSwitch']){
            cm.addClass(that.nodes['container'], 'is-animated');
        }
        that.animations['content'] = new cm.Animation(that.nodes['content']);
    };

    var reset = function(){
        // Clear render pages
        cm.clearNode(that.nodes['pages']);
    };

    var set = function(page){
        var config;
        if(that.isProcess){
            that.abort();
        }
        if((!that.pageCount || page <= that.pageCount) && !that.isProcess && !that.isRendering){
            // Preset next page and page token
            that.page = page;
            that.pageToken = that.pages[that.page]? that.pages[that.page]['token'] : '';
            // Render bars
            that.callbacks.rebuildBars(that);
            // Request

            if(!that.currentPage || page != that.currentPage){
                if(that.pages[that.page] && that.pages[that.page]['isRendered']){
                    that.callbacks.cached(that, that.pages[that.page]['data']);
                }else if(that.isAjax){
                    config = cm.clone(that.params['ajax']);
                    that.ajaxHandler = that.callbacks.request(that, config);
                }else{
                    that.callbacks.data(that, that.params['data']);
                }
            }
        }
    };

    /* ******* CALLBACKS ******* */

    /* *** AJAX *** */

    that.callbacks.prepare = function(that, config){
        // Prepare
        config['url'] = cm.strReplace(config['url'], {
            '%perPage%' : that.params['perPage'],
            '%page%' : that.page,
            '%token%' : that.pageToken
        });
        config['params'] = cm.objectReplace(config['params'], {
            '%perPage%' : that.params['perPage'],
            '%page%' : that.page,
            '%token%' : that.pageToken
        });
        return config;
    };

    that.callbacks.request = function(that, config){
        config = that.callbacks.prepare(that, config);

        // Return ajax handler (XMLHttpRequest) to providing abort method.
        return cm.ajax(
            cm.merge(config, {
                'onStart' : function(){
                    that.callbacks.start(that);
                },
                'onSuccess' : function(response){
                    that.callbacks.response(that, config, response);
                },
                'onError' : function(){
                    that.callbacks.error(that, config);
                },
                'onAbort' : function(){
                    that.callbacks.abort(that, config);
                },
                'onEnd' : function(){
                    that.callbacks.end(that);
                }
            })
        );
    };

    that.callbacks.filter = function(that, config, response){
        var data = [],
            dataItem = cm.objectSelector(that.params['responseKey'], response),
            countItem = cm.objectSelector(that.params['responseCountKey'], response);
        if(dataItem && !cm.isEmpty(dataItem)){
            data = dataItem;
        }
        if(countItem){
            that.setCount(countItem);
        }
        return data;
    };

    that.callbacks.response = function(that, config, response){
        that.setPage();
        // Response
        if(response){
            response = that.callbacks.filter(that, config, response);
        }
        that.callbacks.render(that, response);
    };

    that.callbacks.error = function(that, config){
        that.triggerEvent('onError');
    };

    that.callbacks.abort = function(that, config){
        that.triggerEvent('onAbort');
    };

    /* *** STATIC *** */

    that.callbacks.data = function(that, data){
        var length, start, end, pageData;
        that.callbacks.start(that);
        that.setPage();
        if(!cm.isEmpty(data)){
            // Get page data and render
            if(that.params['perPage'] == 0){
                that.callbacks.render(that, data);
            }else if(that.params['perPage'] > 0){
                length = data.length;
                start = (that.page - 1) * that.params['perPage'];
                end = (that.page * that.params['perPage']);
                if(start < length){
                    pageData = data.slice(start , Math.min(end, length));
                    that.callbacks.render(that, pageData);
                }
            }
        }else{
            that.callbacks.render(that, data);
        }
        that.callbacks.end(that);
    };

    that.callbacks.cached = function(that, data){
        that.callbacks.start(that);
        that.setPage();
        that.callbacks.render(that, data);
        that.callbacks.end(that);
    };

    /* *** RENDER PAGE *** */

    that.callbacks.renderContainer = function(that, page){
        return cm.Node(that.params['pageTag'], that.params['pageAttributes']);
    };

    that.callbacks.render = function(that, data){
        that.isRendering = true;
        var page = {
            'page' : that.page,
            'token' : that.pageToken,
            'pages' : that.nodes['pages'],
            'container' : cm.Node(that.params['pageTag']),
            'data' : data,
            'isVisible' : true,
            'isRendered' : true
        };
        page['container'] = that.callbacks.renderContainer(that, page);
        that.pages[that.page] = page;
        // Render
        that.triggerEvent('onPageRender', page);
        that.callbacks.renderPage(that, page);
        // Embed
        that.nodes['pages'].appendChild(page['container']);
        cm.addClass(page['container'], 'is-visible', true);
        that.triggerEvent('onPageRenderEnd', page);
        // Switch
        if(!that.params['switchManually']){
            that.callbacks.switchPage(that, page);
        }
    };

    that.callbacks.renderPage = function(that, page){
        var nodes;
        if(that.params['responseHTML']){
            nodes = cm.strToHTML(page['data']);
            if(!cm.isEmpty(nodes)){
                if(cm.isNode(nodes)){
                    page['container'].appendChild(nodes);
                }else{
                    while(nodes.length){
                        if(cm.isNode(nodes[0])){
                            page['container'].appendChild(nodes[0]);
                        }else{
                            cm.remove(nodes[0]);
                        }
                    }
                }
            }
        }
    };

    that.callbacks.switchPage = function(that, page){
        var contentRect = cm.getRect(that.nodes['content']),
            pageRect = cm.getRect(page['container']);
        // Hide previous page
        if(that.previousPage){
            that.callbacks.hidePage(that, that.pages[that.previousPage]);
        }
        // Show new page
        if(that.params['animateSwitch']){
            that.nodes['content'].style.overflow = 'hidden';
            that.nodes['content'].style.height = [contentRect['height'], 'px'].join('');
            that.animations['content'].go({'style' : {'height' : [pageRect['height'], 'px'].join('')}, 'duration' : that.params['animateDuration'], 'anim' : 'smooth', 'onStop' : function(){
                that.nodes['content'].style.overflow = 'visible';
                that.nodes['content'].style.height = 'auto';
                that.isRendering = false;
                that.triggerEvent('onPageSwitched', page);
            }});
        }else{
            that.isRendering = false;
            that.triggerEvent('onPageSwitched', page);
        }
    };

    that.callbacks.hidePage = function(that, page){
        page['isVisible'] = false;
        if(that.params['animateSwitch']){
            if(that.params['animatePrevious']){
                cm.removeClass(page['container'], 'is-visible');
                setTimeout(function(){
                    cm.remove(page['container']);
                }, that.params['animateDuration']);
            }else{
                setTimeout(function(){
                    cm.remove(page['container']);
                    cm.removeClass(page['container'], 'is-visible');
                }, that.params['animateDuration']);
            }
        }else{
            cm.remove(page['container']);
            cm.removeClass(page['container'], 'is-visible');
        }
    };

    /* *** RENDER BAR *** */

    that.callbacks.renderBar = function(that, params){
        params = cm.merge({
            'align' : 'left',
            'position' : 'bottom'
        }, params);
        var item = {};
        // Structure
        item['container'] = cm.Node('div', {'class' : 'com__pagination__bar'},
            item['items'] = cm.Node('ul')
        );
        cm.addClass(item['container'], ['pull', params['align']].join('-'));
        // Embed
        switch(params['position']){
            case 'top':
                cm.insertFirst(item['container'], that.nodes['container']);
                break;
            case 'bottom':
                cm.insertLast(item['container'], that.nodes['container']);
                break;
        }
        return item;
    };

    that.callbacks.rebuildBars = function(that){
        cm.forEach(that.nodes['bar'], function(item){
            that.callbacks.rebuildBar(that, item);
        });
    };

    that.callbacks.rebuildBar = function(that, item){
        // Clear items
        cm.clearNode(item['items']);
        // Show / Hide
        if(that.pageCount < 2){
            cm.addClass(item['container'], 'is-hidden');
        }else{
            cm.removeClass(item['container'], 'is-hidden');
            // Render items
            that.callbacks.renderBarItems(that, item);
        }
    };

    that.callbacks.renderBarItems = function(that, item){
        var dots = false;
        // Previous page buttons
        that.callbacks.renderBarArrow(that, item, {
            'text' : '<',
            'title' : that.lang('prev'),
            'className' : 'prev',
            'callback' : that.prev
        });
        // Page buttons
        cm.forEach(that.pageCount, function(page){
            ++page;
            if(page == that.page){
                that.callbacks.renderBarItem(that, item, {
                    'page' : page,
                    'isActive' : true
                });
                dots = true;
            }else{
                if(
                    page <= that.params['barCountLR'] ||
                    (that.currentPage && page >= that.page - that.params['barCountM'] && page <= that.page + that.params['barCountM']) ||
                    page > that.pageCount - that.params['barCountLR']
                ){
                    dots = true;
                    that.callbacks.renderBarItem(that, item, {
                        'page' : page,
                        'isActive' : false
                    });
                }else if(dots){
                    dots = false;
                    that.callbacks.renderBarPoints(that, item, {});
                }

            }
        });
        // Next page buttons
        that.callbacks.renderBarArrow(that, item, {
            'text' : '>',
            'title' : that.lang('next'),
            'className' : 'next',
            'callback' : that.next
        });
    };

    that.callbacks.renderBarArrow = function(that, item, params){
        params = cm.merge({
            'text' : '',
            'title' : '',
            'className' : '',
            'callback' : function(){}
        }, params);
        // Structure
        params['container'] = cm.Node('li', {'class' : params['className']},
            params['link'] = cm.Node('a', {'title' : params['title']}, params['text'])
        );
        // Events
        cm.addEvent(params['link'], 'click', function(e){
            e = cm.getEvent(e);
            cm.preventDefault(e);
            params['callback']();
        });
        // Append
        item['items'].appendChild(params['container']);
    };

    that.callbacks.renderBarPoints = function(that, item, params){
        params = cm.merge({
            'text' : '...',
            'className' : 'points'
        }, params);
        // Structure
        params['container'] = cm.Node('li', {'class' : params['className']}, params['text']);
        // Append
        item['items'].appendChild(params['container']);
    };

    that.callbacks.renderBarItem = function(that, item, params){
        params = cm.merge({
            'page' : null,
            'isActive' : false
        }, params);
        // Structure
        params['container'] = cm.Node('li',
            params['link'] = cm.Node('a', params['page'])
        );
        // Active Class
        if(params['isActive']){
            cm.addClass(params['container'], 'active');
        }
        // Events
        cm.addEvent(params['link'], 'click', function(e){
            e = cm.getEvent(e);
            cm.preventDefault(e);
            that.set(params['page']);
        });
        // Append
        item['items'].appendChild(params['container']);
    };

    /* *** HELPERS *** */

    that.callbacks.start = function(that){
        that.isProcess = true;
        // Show Loader
        if(that.params['showLoader']){
            that.loaderDelay = setTimeout(function(){
                if(that.components['loader'] && !that.components['loader'].isOpen){
                    that.components['loader'].open();
                }
            }, that.params['loaderDelay']);
        }
        that.triggerEvent('onStart');
    };

    that.callbacks.end = function(that){
        that.isProcess = false;
        // Hide Loader
        if(that.params['showLoader']){
            that.loaderDelay && clearTimeout(that.loaderDelay);
            if(that.components['loader'] && that.components['loader'].isOpen){
                that.components['loader'].close();
            }
        }
        that.triggerEvent('onEnd');
    };

    /* ******* PUBLIC ******* */

    that.set = function(page){
        set(page);
        return that;
    };

    that.next = function(){
        set(that.pageCount == that.currentPage ? 1 : that.currentPage + 1);
        return that;
    };

    that.prev = function(){
        set(that.currentPage - 1 || that.pageCount);
        return that;
    };

    that.rebuild = function(params){
        // Cleanup
        if(that.isProcess){
            that.abort();
        }
        that.pages = {};
        that.currentPage = null;
        that.previousPage = null;
        // Reset styles and variables
        reset();
        // Set new parameters
        that.setParams(params);
        validateParams();
        // Render
        set(that.params['startPage']);
    };

    that.setToken = function(page, token){
        if(!that.pages[page]){
            that.pages[page] = {};
        }
        that.pages[page]['token'] = token;
        return that;
    };

    that.setCount = function(count){
        if(count && (count = parseInt(count.toString())) && count != that.params['count']){
            that.params['count'] = count;
            if(that.params['pageCount'] == 0){
                that.pageCount = Math.ceil(that.params['count'] / that.params['perPage']);
            }else{
                that.pageCount = that.params['pageCount'];
            }
            that.callbacks.rebuildBars(that);
        }
        return that;
    };

    that.setPage = function(){
        that.previousPage = that.currentPage;
        that.currentPage = that.page;
        return that;
    };

    that.abort = function(){
        if(that.ajaxHandler && that.ajaxHandler.abort){
            that.ajaxHandler.abort();
        }
        return that;
    };

    that.isParent = function(node, flag){
        return cm.isParent(that.nodes['container'], node, flag);
    };

    init();
});
cm.define('Com.Palette', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig',
        'Storage',
        'Stack'
    ],
    'require' : [
        'Com.Draggable',
        'tinycolor'
    ],
    'events' : [
        'onRender',
        'onDraw',
        'onSet',
        'onSelect',
        'onChange'
    ],
    'params' : {
        'name' : '',
        'container' : cm.node('div'),
        'value' : 'transparent',
        'defaultValue' : 'rgb(255, 255, 255)',
        'setOnInit' : true,
        'langs' : {
            'new' : 'new',
            'previous' : 'previous',
            'select' : 'Select',
            'hue' : 'Hue',
            'opacity' : 'Opacity',
            'hex' : 'HEX'
        }
    }
},
function(params){
    var that = this,
        rangeContext,
        paletteContext,
        opacityContext;

    that.nodes = {};
    that.componnets = {};
    that.value = null;
    that.previousValue = null;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['node']);
        render();
        initComponents();
        that.addToStack(that.nodes['container']);
        that.triggerEvent('onRender');
        that.params['setOnInit'] && that.set(that.params['value'], false);
    };

    var render = function(){
        // Structure
        that.nodes['container'] = cm.node('div', {'class' : 'com__palette'},
            that.nodes['inner'] = cm.node('div', {'class' : 'inner'},
                cm.node('div', {'class' : 'b-palette'},
                    that.nodes['paletteZone'] = cm.node('div', {'class' : 'inner'},
                        that.nodes['paletteDrag'] = cm.node('div', {'class' : 'drag'}),
                        that.nodes['paletteCanvas'] = cm.node('canvas', {'width' : '100%', 'height' : '100%'})
                    )
                ),
                cm.node('div', {'class' : 'b-range', 'title' : that.lang('hue')},
                    that.nodes['rangeZone'] = cm.node('div', {'class' : 'inner'},
                        that.nodes['rangeDrag'] = cm.node('div', {'class' : 'drag'}),
                        that.nodes['rangeCanvas'] = cm.node('canvas', {'width' : '100%', 'height' : '100%'})
                    )
                ),
                cm.node('div', {'class' : 'b-range b-opacity', 'title' : that.lang('opacity')},
                    that.nodes['opacityZone'] = cm.node('div', {'class' : 'inner'},
                        that.nodes['opacityDrag'] = cm.node('div', {'class' : 'drag'}),
                        that.nodes['opacityCanvas'] = cm.node('canvas', {'width' : '100%', 'height' : '100%'})
                    )
                ),
                cm.node('div', {'class' : 'b-stuff'},
                    cm.node('div', {'class' : 'inner'},
                        cm.node('div', {'class' : 'b-preview-color'},
                            cm.node('div', {'class' : 'b-title'}, that.lang('new')),
                            cm.node('div', {'class' : 'b-colors'},
                                that.nodes['previewNew'] = cm.node('div', {'class' : 'b-color'}),
                                that.nodes['previewPrev'] = cm.node('div', {'class' : 'b-color'})
                            ),
                            cm.node('div', {'class' : 'b-title'}, that.lang('previous'))
                        ),
                        cm.node('div', {'class' : 'b-bottom'},
                            cm.node('div', {'class' : 'b-preview-inputs'},
                                that.nodes['inputHEX'] = cm.node('input', {'type' : 'text', 'maxlength' : 7, 'title' : that.lang('hex')})
                            ),
                            cm.node('div', {'class' : 'b-buttons'},
                                that.nodes['buttonSelect'] = cm.node('div', {'class' : 'button button-primary is-wide'}, that.lang('select'))
                            )
                        )
                    )
                )
            )
        );
        // Render canvas
        paletteContext = that.nodes['paletteCanvas'].getContext('2d');
        rangeContext = that.nodes['rangeCanvas'].getContext('2d');
        opacityContext = that.nodes['opacityCanvas'].getContext('2d');
        renderRangeCanvas();
        //renderOpacityCanvas();
        // Add events
        cm.addEvent(that.nodes['inputHEX'], 'input', inputHEXHandler);
        cm.addEvent(that.nodes['inputHEX'], 'keypress', inputHEXKeypressHandler);
        cm.addEvent(that.nodes['buttonSelect'], 'click', buttonSelectHandler);
        // Embed
        that.params['container'].appendChild(that.nodes['container']);
    };

    var initComponents = function(){
        that.componnets['paletteDrag'] = new Com.Draggable({
            'target' : that.nodes['paletteZone'],
            'node' : that.nodes['paletteDrag'],
            'limiter' : that.nodes['paletteZone'],
            'events' : {
                'onSet' : function(my, data){
                    var dimensions = my.getDimensions();
                    that.value['v'] = cm.toFixed((100 - (100 / dimensions['limiter']['absoluteHeight']) * data['posY']) / 100, 2);
                    that.value['s'] = cm.toFixed(((100 / dimensions['limiter']['absoluteWidth']) * data['posX']) / 100, 2);
                    if(that.value['a'] == 0){
                        that.value['a'] = 1;
                        setOpacityDrag();
                    }
                    renderOpacityCanvas();
                    setColor();
                }
            }
        });
        that.componnets['rangeDrag'] = new Com.Draggable({
            'target' : that.nodes['rangeZone'],
            'node' : that.nodes['rangeDrag'],
            'limiter' : that.nodes['rangeZone'],
            'direction' : 'vertical',
            'events' : {
                'onSet' : function(my, data){
                    var dimensions = my.getDimensions();
                    that.value['h'] = Math.floor(360 - (360 / 100) * ((100 / dimensions['limiter']['absoluteHeight']) * data['posY']));
                    if(that.value['a'] == 0){
                        that.value['a'] = 1;
                        setOpacityDrag();
                    }
                    renderPaletteCanvas();
                    renderOpacityCanvas();
                    setColor();
                }
            }
        });
        that.componnets['opacityDrag'] = new Com.Draggable({
            'target' : that.nodes['opacityZone'],
            'node' : that.nodes['opacityDrag'],
            'limiter' : that.nodes['opacityZone'],
            'direction' : 'vertical',
            'events' : {
                'onSet' : function(my, data){
                    var dimensions = my.getDimensions();
                    that.value['a'] = cm.toFixed((100 - (100 / dimensions['limiter']['absoluteHeight']) * data['posY']) / 100, 2);
                    setColor();
                }
            }
        });
    };

    /* *** COLORS *** */

    var setRangeDrag = function(){
        var dimensions = that.componnets['rangeDrag'].getDimensions(),
            posY;
        if(that.value['h'] == 0){
            posY = 0;
        }else if(that.value['h'] == 360){
            posY = dimensions['limiter']['absoluteHeight'];
        }else{
            posY = dimensions['limiter']['absoluteHeight'] - (dimensions['limiter']['absoluteHeight'] / 100) * ((100 / 360) * that.value['h']);
        }
        that.componnets['rangeDrag'].setPosition(0, posY, false);
    };

    var setPaletteDrag = function(){
        var dimensions = that.componnets['paletteDrag'].getDimensions(),
            posY,
            posX;
        posY = dimensions['limiter']['absoluteHeight'] - (dimensions['limiter']['absoluteHeight'] / 100) * (that.value['v'] * 100);
        posX = (dimensions['limiter']['absoluteWidth'] / 100) * (that.value['s'] * 100);
        that.componnets['paletteDrag'].setPosition(posX, posY, false);
    };

    var setOpacityDrag = function(){
        var dimensions = that.componnets['opacityDrag'].getDimensions(),
            posY;
        posY = dimensions['limiter']['absoluteHeight'] - (dimensions['limiter']['absoluteHeight'] / 100) * (that.value['a'] * 100);
        that.componnets['opacityDrag'].setPosition(0, posY, false);
    };

    var inputHEXHandler = function(){
        var color = that.nodes['inputHEX'].value;
        if(!/^#/.test(color)){
            that.nodes['inputHEX'].value = '#' + color;
        }else{
            set(color, true, {'setInput' : false});
        }
    };

    var inputHEXKeypressHandler = function(e){
        var color;
        e = cm.getEvent(e);
        if(e.keyCode == 13){
            color = that.nodes['inputHEX'].value;
            set(color, true);
            buttonSelectHandler();
        }
    };

    var buttonSelectHandler = function(){
        setColorPrev();
        that.triggerEvent('onSelect', that.value);
        eventOnChange();
    };

    var set = function(color, triggerEvent, params){
        if(cm.isEmpty(color)){
            color = that.params['defaultValue'];
        }else if(color == 'transparent'){
            color = {'h' : 360,  's' : 0,  'v' : 1, 'a' : 0};
        }
        that.value = tinycolor(color).toHsv();
        that.redraw(true, params);
        // Trigger onSet event
        if(triggerEvent){
            that.triggerEvent('onSet', that.value);
        }
    };
    
    var setColor = function(){
        setPreviewNew();
        setPreviewInputs();
        setPaletteDragColor();
        that.triggerEvent('onSet', that.value);
    };

    var setColorPrev = function(){
        if(that.value){
            that.previousValue = cm.clone(that.value);
        }else{
            if(!cm.isEmpty(that.params['value'])){
                that.previousValue = tinycolor(that.params['value']).toHsv();
            }else{
                that.previousValue = tinycolor(that.params['defaultValue']).toHsv();
            }
        }
        setPreviewPrev();
    };

    var setPaletteDragColor = function(){
        var color = tinycolor(cm.clone(that.value));
        if(color.isDark()){
            cm.replaceClass(that.nodes['paletteDrag'], 'is-light', 'is-dark');
        }else{
            cm.replaceClass(that.nodes['paletteDrag'], 'is-dark', 'is-light');
        }
    };

    var setPreviewNew = function(){
        var color = tinycolor(cm.clone(that.value));
        that.nodes['previewNew'].style.backgroundColor = color.toHslString();
    };

    var setPreviewPrev = function(){
        var color = tinycolor(cm.clone(that.previousValue));
        that.nodes['previewPrev'].style.backgroundColor = color.toHslString();
    };

    var setPreviewInputs = function(){
        var color = tinycolor(cm.clone(that.value));
        that.nodes['inputHEX'].value = color.toHexString();
    };

    var eventOnChange = function(){
        if(JSON.stringify(that.value) === JSON.stringify(that.previousValue) ){
            that.triggerEvent('onChange', that.value);
        }
    };

    /* *** CANVAS *** */

    var renderRangeCanvas = function(){
        var gradient = rangeContext.createLinearGradient(0, 0, 0, 100);
        gradient.addColorStop(0, 'rgb(255, 0, 0)');
        gradient.addColorStop(1/6, 'rgb(255, 0, 255)');
        gradient.addColorStop(2/6, 'rgb(0, 0, 255)');
        gradient.addColorStop(3/6, 'rgb(0, 255, 255)');
        gradient.addColorStop(4/6, 'rgb(0, 255, 0)');
        gradient.addColorStop(5/6, 'rgb(255, 255, 0)');
        gradient.addColorStop(1, 'rgb(255, 0, 0)');
        rangeContext.fillStyle = gradient;
        rangeContext.fillRect(0, 0, 100, 100);
    };

    var renderPaletteCanvas = function(){
        var gradient;
        // Fill color
        paletteContext.rect(0, 0, 100, 100);
        paletteContext.fillStyle = 'hsl(' +that.value['h']+', 100%, 50%)';
        paletteContext.fill();
        // Fill saturation
        gradient = paletteContext.createLinearGradient(0, 0, 100, 0);
        paletteContext.fillStyle = gradient;
        gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
        paletteContext.fillRect(0, 0, 100, 100);
        // Fill brightness
        gradient = paletteContext.createLinearGradient(0, 0, 0, 100);
        paletteContext.fillStyle = gradient;
        gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 1)');
        paletteContext.fillRect(0, 0, 100, 100);
    };

    var renderOpacityCanvas = function(){
        opacityContext.clearRect(0, 0, 100, 100);
        var gradient = opacityContext.createLinearGradient(0, 0, 0, 100),
            startColor = cm.clone(that.value),
            endColor = cm.clone(that.value);
        startColor['a'] = 1;
        endColor['a'] = 0;
        opacityContext.fillStyle = gradient;
        gradient.addColorStop(0, tinycolor(startColor).toRgbString());
        gradient.addColorStop(1, tinycolor(endColor).toRgbString());
        opacityContext.fillRect(0, 0, 100, 100);
    };

    /* ******* MAIN ******* */

    that.set = function(color, triggerEvent, params){
        triggerEvent = typeof triggerEvent == 'undefined'? true : triggerEvent;
        params = typeof params == 'undefined' ? {} : params;
        // Render new color
        set(color, triggerEvent, params);
        // Render previous color
        setColorPrev();
        return that;
    };

    that.get = function(method){
        var color = tinycolor(cm.clone(that.value));
        switch(method){
            case 'rgb':
                color = color.toRgbString();
                break;
            case 'hsl':
                color = color.toHslString();
                break;
            case 'hsv':
            case 'hsb':
                color = color.toHsvString();
                break;
            case 'hex':
            default:
                color = color.toHexString();
                break;
        }
        return color;
    };

    that.getRaw = function(method){
        var color = tinycolor(cm.clone(that.value));
        switch(method){
            case 'hsl':
                color = color.toHsl();
                break;
            case 'hsv':
            case 'hsb':
            default:
                // Color already in HSV
                break;
        }
        return color;
    };

    that.redraw = function(triggerEvent, params){
        triggerEvent = typeof triggerEvent == 'undefined'? true : triggerEvent;
        params = typeof params == 'undefined'? {} : params;
        params = cm.merge({
            'setInput' : true
        }, params);
        setOpacityDrag();
        setRangeDrag();
        setPaletteDrag();
        setPreviewNew();
        setPaletteDragColor();
        renderPaletteCanvas();
        renderOpacityCanvas();
        if(params['setInput']){
            setPreviewInputs();
        }
        if(triggerEvent){
            that.triggerEvent('onDraw');
        }
        return that;
    };

    that.isLight = function(){
        var color = tinycolor(cm.clone(that.value));
        return color.isLight();
    };

    that.isDark = function(){
        var color = tinycolor(cm.clone(that.value));
        return color.isDark();
    };

    init();
});
Com['Scroll'] = function(o){
    var that = this,
        config = cm.merge({
            'node' : cm.Node('div'),
            'step' : 15,
            'time' : 50,
            'duration' : 300,
            'nodes' : {},
            'events' : {}
        }, o),
        API = {
            'onScroll' : [],
            'onScrollStart' : [],
            'onScrollEnd' : []
        },
        nodes = {
            'left' : cm.Node('div'),
            'right' : cm.Node('div'),
            'up' : cm.Node('div'),
            'down' : cm.Node('div'),
            'scroll' : cm.Node('div')
        },
        anim,
        animInterval,
        top,
        left;

    var init = function(){
        convertEvents(config['events']);
        getNodes(config['node'], 'ComScroll');
        render();
    };

    var render = function(){
        // Init animation
        anim = new cm.Animation(nodes['scroll']);
        // Reset
        nodes['scroll'].scrollTop = 0;
        nodes['scroll'].scrollLeft = 0;
        // Events
        cm.addEvent(nodes['up'], 'mousedown', startMoveUp);
        cm.addEvent(nodes['up'], 'mouseup', endAnimation);
        cm.addEvent(nodes['up'], 'mouseout', endAnimation);
        cm.addEvent(nodes['down'], 'mousedown', startMoveDown);
        cm.addEvent(nodes['down'], 'mouseup', endAnimation);
        cm.addEvent(nodes['down'], 'mouseout', endAnimation);
        cm.addEvent(nodes['left'], 'mousedown', startMoveLeft);
        cm.addEvent(nodes['left'], 'mouseup', endAnimation);
        cm.addEvent(nodes['left'], 'mouseout', endAnimation);
        cm.addEvent(nodes['right'], 'mousedown', startMoveRight);
        cm.addEvent(nodes['right'], 'mouseup', endAnimation);
        cm.addEvent(nodes['right'], 'mouseout', endAnimation);
    };

    var startMoveUp = function(){
        endAnimation();
        animInterval = setInterval(moveUp, config['time']);
        moveUp();
    };

    var startMoveDown = function(){
        endAnimation();
        animInterval = setInterval(moveDown, config['time']);
        moveDown();
    };

    var startMoveLeft = function(){
        endAnimation();
        animInterval = setInterval(moveLeft, config['time']);
        moveLeft();
    };

    var startMoveRight = function(){
        endAnimation();
        animInterval = setInterval(moveRight, config['time']);
        moveRight();
    };

    var endAnimation = function(){
        animInterval && clearInterval(animInterval);
    };

    var moveUp = function(){
        top = Math.max((nodes['scroll'].scrollTop - config['step']), 0);
        anim.go({'style' : {'scrollTop' : top}, 'duration' : config['time'], 'amim' : 'simple'});
    };

    var moveDown = function(){
        top = Math.min((nodes['scroll'].scrollTop + config['step']), (nodes['scroll'].scrollHeight - nodes['scroll'].offsetHeight));
        anim.go({'style' : {'scrollTop' : top}, 'duration' : config['time'], 'amim' : 'simple'});
    };

    var moveLeft = function(){
        left = Math.max((nodes['scroll'].scrollLeft - config['step']), 0);
        anim.go({'style' : {'scrollLeft' : left}, 'duration' : config['time'], 'amim' : 'simple'});
    };

    var moveRight = function(){
        left = Math.min((nodes['scroll'].scrollLeft + config['step']), (nodes['scroll'].scrollWidth - nodes['scroll'].offsetWidth));
        anim.go({'style' : {'scrollLeft' : left}, 'duration' : config['time'], 'amim' : 'simple'});
    };

    /* *** MISC FUNCTIONS *** */

    var convertEvents = function(o){
        cm.forEach(o, function(item, key){
            if(API[key] && typeof item == 'function'){
                API[key].push(item);
            }
        });
    };

    var getNodes = function(container, marker){
        if(container){
            var sourceNodes = {};
            if(marker){
                sourceNodes = cm.getNodes(container)[marker] || {};
            }else{
                sourceNodes = cm.getNodes(container);
            }
            nodes = cm.merge(nodes, sourceNodes);
        }
        nodes = cm.merge(nodes, config['nodes']);
    };

    var executeEvent = function(event, params){
        API[event].forEach(function(item){
            item(that, params || {});
        });
    };

    /* ******* MAIN ******* */

    that.scrollY = function(num){
        var top = Math.max(Math.min(num, nodes['scroll'].scrollHeight - nodes['scroll'].offsetHeight), 0);
        anim.go({'style' : {'scrollTop' : top}, 'duration' : config['duration'], 'amim' : 'smooth'});
        return that;
    };

    that.scrollX = function(num){
        var left = Math.max(Math.min(num, nodes['scroll'].scrollWidth - nodes['scroll'].offsetWidth), 0);
        anim.go({'style' : {'scrollLeft' : left}, 'duration' : config['duration'], 'amim' : 'smooth'});
        return that;
    };

    that.addEvent = function(event, handler){
        if(API[event] && typeof handler == 'function'){
            API[event].push(handler);
        }
        return that;
    };

    that.removeEvent = function(event, handler){
        if(API[event] && typeof handler == 'function'){
            API[event] = API[event].filter(function(item){
                return item != handler;
            });
        }
        return that;
    };

    init();
};
cm.define('Com.ScrollPagination', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig',
        'DataNodes',
        'Callbacks',
        'Stack'
    ],
    'events' : [
        'onRender',
        'onRebuild',
        'onStart',
        'onAbort',
        'onError',
        'onPageRender',
        'onPageRenderEnd',
        'onPageShow',
        'onPageHide',
        'onEnd',
        'onFinalize'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'name' : '',
        'renderStructure' : false,                                  // Render wrapper nodes if not exists in html
        'container' : false,
        'scrollNode' : window,
        'scrollIndent' : 'Math.min(%scrollHeight% / 2, 600)',       // Variables: %blockHeight%.
        'data' : [],                                                // Static data
        'perPage' : 0,                                              // 0 - render all data in one page
        'startPage' : 1,                                            // Start page
        'startPageToken' : '',
        'pageCount' : 0,                                              // Render only count of pages. 0 - infinity
        'showButton' : true,                                        // true - always | once - show once after first loaded page
        'showLoader' : true,
        'loaderDelay' : 100,                                        // in ms
        'stopOnESC' : true,
        'pageTag' : 'div',
        'pageAttributes' : {
            'class' : 'com__scroll-pagination__page'
        },
        'responseKey' : 'data',                                     // Instead of using filter callback, you can provide response array key
        'responseHTML' : false,                                     // If true, html will append automatically
        'ajax' : {
            'type' : 'json',
            'method' : 'get',
            'url' : '',                                             // Request URL. Variables: %page%, %token%, %perPage%, %callback% for JSONP.
            'params' : ''                                           // Params object. %page%, %token%, %perPage%, %callback% for JSONP.
        },
        'langs' : {
            'load_more' : 'Load More'
        }
    }
},
function(params){
    var that = this;

    that.nodes = {
        'container' : cm.Node('div'),
        'scroll' : null,
        'bar' : cm.Node('div'),
        'content' : cm.Node('div'),
        'pages' : cm.Node('div'),
        'button' : cm.Node('div'),
        'loader' : cm.Node('div')
    };

    that.components = {};
    that.pages = {};
    that.ajaxHandler = null;
    that.loaderDelay = null;

    that.isAjax = false;
    that.isProcess = false;
    that.isFinalize = false;
    that.isButton = false;

    that.page = null;
    that.pageToken = null;
    that.currentPage = null;
    that.previousPage = null;
    that.nextPage = null;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);
        that.callbacksProcess();
        validateParams();
        render();
        that.addToStack(that.nodes['container']);
        that.triggerEvent('onRender');
        set();
    };

    var validateParams = function(){
        // Set Scroll Node
        if(that.nodes['scroll']){
            that.params['scrollNode'] = that.nodes['scroll'];
        }
        // If URL parameter exists, use ajax data
        if(!cm.isEmpty(that.params['ajax']['url'])){
            that.isAjax = true;
        }else{
            that.params['showLoader'] = false;
        }
        // Set start page token
        that.setToken(that.params['startPage'], that.params['startPageToken']);
        // Set next page token
        that.nextPage = that.params['startPage'];
    };

    var render = function(){
        // Render Structure
        if(that.params['renderStructure']){
            that.nodes['container'] = cm.Node('div', {'class' : 'com__scroll-pagination'},
                that.nodes['content'] = cm.Node('div', {'class' : 'com__scroll-pagination__content'},
                    that.nodes['pages'] = cm.Node('div', {'class' : 'com__scroll-pagination__pages'})
                ),
                that.nodes['bar'] = cm.Node('div', {'class' : 'com__scroll-pagination__bar'},
                    that.nodes['button'] = cm.Node('div', {'class' : 'button button-primary'}, that.lang('load_more')),
                    that.nodes['loader'] = cm.Node('div', {'class' : 'button button-clear has-icon has-icon has-icon-small'},
                        cm.Node('div', {'class' : 'icon small loader'})
                    )
                )
            );
            if(that.params['container']){
                that.params['container'].appendChild(that.nodes['container']);
            }
        }
        // Reset styles and variables
        reset();
        // Events
        cm.addEvent(that.nodes['button'], 'click', function(e){
            e = cm.getEvent(e);
            cm.preventDefault(e);
            set();
        });
        if(that.params['stopOnESC']){
            cm.addEvent(window, 'keydown', ESCHandler);
        }
        cm.addScrollEvent(that.params['scrollNode'], scrollHandler);
        cm.addEvent(window, 'resize', resizeHandler);
    };

    var reset = function(){
        // Clear render pages
        cm.clearNode(that.nodes['pages']);
        // Load More Button
        if(!that.params['showButton']){
            that.callbacks.hideButton(that);
        }else{
            that.callbacks.showButton(that);
        }
        // Hide Loader
        cm.addClass(that.nodes['loader'], 'is-hidden');
    };

    var set = function(){
        var config;
        if(!that.isProcess && !that.isFinalize){
            // Preset next page and page token
            that.page = that.nextPage;
            that.pageToken = that.pages[that.page]? that.pages[that.page]['token'] : '';
            // Request
            if(that.isAjax){
                config = cm.clone(that.params['ajax']);
                that.ajaxHandler = that.callbacks.request(that, config);
            }else{
                that.callbacks.data(that, that.params['data']);
            }
        }
    };

    var scrollHandler = function(){
        var scrollRect = cm.getRect(that.params['scrollNode']),
            pagesRect = cm.getRect(that.nodes['pages']),
            scrollIndent;
        if((!that.params['showButton'] || (that.params['showButton'] == 'once' && that.params['startPage'] != that.currentPage)) && !cm.isProcess && !that.isFinalize && !that.isButton){
            scrollIndent = eval(cm.strReplace(that.params['scrollIndent'], {
                '%scrollHeight%' : scrollRect['bottom'] - scrollRect['top']
            }));
            if(pagesRect['bottom'] - scrollRect['bottom'] <= scrollIndent){
                set();
            }
        }
        // Show / Hide non visible pages
        cm.forEach(that.pages, function(page){
            that.isPageVisible(page, scrollRect);
        });
    };

    var ESCHandler = function(e){
        e = cm.getEvent(e);

        if(e.keyCode == 27){
            if(!cm.isProcess && !cm.isFinalize){
                that.callbacks.showButton(that);
            }
        }
    };

    var resizeHandler = function(){
        // Show / Hide non visible pages
        cm.forEach(that.pages, function(page){
            that.isPageVisible(page);
        });
    };

    /* ******* CALLBACKS ******* */

    /* *** AJAX *** */

    that.callbacks.prepare = function(that, config){
        // Prepare
        config['url'] = cm.strReplace(config['url'], {
            '%perPage%' : that.params['perPage'],
            '%page%' : that.page,
            '%token%' : that.pageToken
        });
        config['params'] = cm.objectReplace(config['params'], {
            '%perPage%' : that.params['perPage'],
            '%page%' : that.page,
            '%token%' : that.pageToken
        });
        return config;
    };

    that.callbacks.request = function(that, config){
        config = that.callbacks.prepare(that, config);
        // Return ajax handler (XMLHttpRequest) to providing abort method.
        return cm.ajax(
            cm.merge(config, {
                'onStart' : function(){
                    that.callbacks.start(that);
                },
                'onSuccess' : function(response){
                    that.callbacks.response(that, config, response);
                },
                'onError' : function(){
                    that.callbacks.error(that, config);
                },
                'onAbort' : function(){
                    that.callbacks.abort(that, config);
                },
                'onEnd' : function(){
                    that.callbacks.end(that);
                }
            })
        );
    };

    that.callbacks.filter = function(that, config, response){
        var data = [],
            dataItem = cm.objectSelector(that.params['responseKey'], response);
        if(dataItem && !cm.isEmpty(dataItem)){
            data = dataItem;
        }
        return data;
    };

    that.callbacks.response = function(that, config, response){
        // Set next page
        that.setPage();
        // Response
        if(response){
            response = that.callbacks.filter(that, config, response);
        }
        if(!cm.isEmpty(response)){
            that.callbacks.render(that, response);
        }else{
            that.callbacks.finalize(that);
        }
    };

    that.callbacks.error = function(that, config){
        that.triggerEvent('onError');
    };

    that.callbacks.abort = function(that, config){
        that.triggerEvent('onAbort');
    };

    /* *** STATIC *** */

    that.callbacks.data = function(that, data){
        var length, start, end, pageData;
        that.callbacks.start(that);
        that.setPage();
        if(!cm.isEmpty(data)){
            // Get page data and render
            if(that.params['perPage'] == 0){
                that.callbacks.render(that, data);
                that.callbacks.finalize(that);
            }else if(that.params['perPage'] > 0){
                length = data.length;
                start = (that.page - 1) * that.params['perPage'];
                end = (that.page * that.params['perPage']);
                if(start >= length){
                    that.callbacks.finalize(that);
                }else{
                    pageData = data.slice(start , Math.min(end, length));
                    that.callbacks.render(that, pageData);
                }
                if(end >= length){
                    that.callbacks.finalize(that);
                }
            }
        }else{
            that.callbacks.render(that, data);
        }
        that.callbacks.end(that);
    };

    /* *** RENDER *** */

    that.callbacks.renderContainer = function(that, page){
        return cm.Node(that.params['pageTag'], that.params['pageAttributes']);
    };

    that.callbacks.render = function(that, data){
        var scrollTop = cm.getScrollTop(that.params['scrollNode']),
            page = {
                'page' : that.page,
                'token' : that.pageToken,
                'pages' : that.nodes['pages'],
                'container' : cm.Node(that.params['pageTag']),
                'data' : data,
                'isVisible' : false
            };
        page['container'] = that.callbacks.renderContainer(that, page);
        that.pages[that.page] = page;
        that.triggerEvent('onPageRender', page);
        that.callbacks.renderPage(that, page);
        // Embed
        that.nodes['pages'].appendChild(page['container']);
        // Restore scroll position
        cm.setScrollTop(that.params['scrollNode'], scrollTop);
        that.triggerEvent('onPageRenderEnd', page);
        that.isPageVisible(page);
    };

    that.callbacks.renderPage = function(that, page){
        var nodes;
        if(that.params['responseHTML']){
            nodes = cm.strToHTML(page['data']);
            if(!cm.isEmpty(nodes)){
                if(cm.isNode(nodes)){
                    page['container'].appendChild(nodes);
                }else{
                    while(nodes.length){
                        if(cm.isNode(nodes[0])){
                            page['container'].appendChild(nodes[0]);
                        }else{
                            cm.remove(nodes[0]);
                        }
                    }
                }
            }
        }
    };

    /* *** HELPERS *** */

    that.callbacks.start = function(that){
        that.isProcess = true;
        // Show Loader
        if(that.params['showLoader']){
            if(that.isButton){
                cm.addClass(that.nodes['button'], 'is-hidden');
                cm.removeClass(that.nodes['loader'], 'is-hidden');
            }else{
                that.loaderDelay = setTimeout(function(){
                    cm.removeClass(that.nodes['loader'], 'is-hidden');
                    cm.removeClass(that.nodes['bar'], 'is-hidden');
                }, that.params['loaderDelay']);
            }
        }
        that.triggerEvent('onStart');
    };

    that.callbacks.end = function(that){
        that.isProcess = false;
        // Hide Loader
        that.loaderDelay && clearTimeout(that.loaderDelay);
        cm.addClass(that.nodes['loader'], 'is-hidden');
        // Check pages count
        if(that.params['pageCount'] > 0 && that.params['pageCount'] == that.currentPage){
            that.callbacks.finalize(that);
        }
        // Show / Hide Load More Button
        that.callbacks.toggleButton(that);
        that.triggerEvent('onEnd');
    };

    that.callbacks.finalize = function(that){
        if(!that.isFinalize){
            that.isFinalize = true;
            that.callbacks.hideButton(that);
            that.triggerEvent('onFinalize');
        }
    };

    that.callbacks.toggleButton = function(that){
        if(!that.isFinalize && (that.params['showButton'] === true || (that.params['showButton'] == 'once' && that.params['startPage'] == that.page))){
            that.callbacks.showButton(that);
        }else{
            that.callbacks.hideButton(that);
        }
    };

    that.callbacks.showButton = function(that){
        that.isButton = true;
        cm.removeClass(that.nodes['button'], 'is-hidden');
        cm.removeClass(that.nodes['bar'], 'is-hidden');
    };

    that.callbacks.hideButton = function(that){
        that.isButton = false;
        cm.addClass(that.nodes['button'], 'is-hidden');
        cm.addClass(that.nodes['bar'], 'is-hidden');
    };

    /* ******* PUBLIC ******* */

    that.set = function(){
        set();
        return that;
    };

    that.setToken = function(page, token){
        if(!that.pages[page]){
            that.pages[page] = {};
        }
        that.pages[page]['token'] = token;
        return that;
    };

    that.setPage = function(){
        that.previousPage = that.currentPage;
        that.currentPage = that.nextPage;
        that.nextPage++;
        return that;
    };

    that.rebuild = function(params){
        // Cleanup
        if(that.isProcess){
            that.abort();
        }
        that.pages = {};
        that.currentPage = null;
        that.previousPage = null;
        // Set new parameters
        that.setParams(params);
        validateParams();
        // Reset styles and variables
        reset();
        that.triggerEvent('onRebuild');
        // Render new pge
        set();
    };

    that.isPageVisible = function(page, scrollRect){
        if(page['container']){
            scrollRect = typeof scrollRect == 'undefined' ? cm.getRect(that.params['scrollNode']) : scrollRect;
            var pageRect = cm.getRect(page['container']);

            if(cm.inRange(pageRect['top'], pageRect['bottom'], scrollRect['top'], scrollRect['bottom'])){
                if(!page['isVisible']){
                    page['isVisible'] = true;
                    cm.removeClass(page['container'], 'is-hidden');
                    cm.triggerEvent('onPageShow', page);
                }
            }else{
                if(page['isVisible']){
                    page['isVisible'] = false;
                    cm.addClass(page['container'], 'is-hidden');
                    cm.triggerEvent('onPageHide', page);
                }
            }
            return page['isVisible'];
        }
        return false;
    };

    that.abort = function(){
        if(that.ajaxHandler && that.ajaxHandler.abort){
            that.ajaxHandler.abort();
        }
        return that;
    };

    that.isParent = function(node, flag){
        return cm.isParent(that.nodes['container'], node, flag);
    };

    init();
});
Com.Elements['Selects'] = {};

Com['GetSelect'] = function(id){
    return Com.Elements.Selects[id] || null;
};

cm.define('Com.Select', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'Stack'
    ],
    'events' : [
        'onRender',
        'onSelect',
        'onChange',
        'onFocus',
        'onBlur'
    ],
    'params' : {
        'container' : false,                    // Component container that is required in case content is rendered without available select.
        'select' : cm.Node('select'),           // Html select node to decorate.
        'name' : '',
        'renderInBody' : true,                  // Render dropdowns in document.body, else they will be rendrered in component container.
        'multiple' : false,                     // Render multiple select.
        'placeholder' : '',
        'showTitleTag' : true,                  // Copy title from available select node to component container. Will be shown on hover.
        'title' : false,                        // Title text. Will be shown on hover.
        'options' : [],                         // Listing of options, for rendering through java-script. Example: [{'value' : 'foo', 'text' : 'Bar'}].
        'selected' : 0,                         // Option value / array of option values.
        'disabled' : false,
        'icons' : {
            'arrow' : 'icon default linked'
        },
        'Com.Tooltip' : {
            'targetEvent' : 'click',
            'hideOnReClick' : true,
            'className' : 'com__select__tooltip',
            'width' : 'targetWidth',
            'top' : 'cm._config.tooltipTop'
        }
    }
},
function(params){
    var that = this,
        nodes = {
            'menu' : {}
        },
        components = {},
        options = {},
        optionsList = [],
        optionsLength,
        groups = [],

        oldActive,
        active;

    that.disabled = false;

    /* *** CLASS FUNCTIONS *** */

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['select']);
        validateParams();
        render();
        setMiscEvents();
        // Set selected option
        if(that.params['multiple']){
            active = [];
            if(that.params['selected'] && cm.isArray(that.params['selected'])){
                cm.forEach(that.params['selected'], function(item){
                    if(options[item]){
                        set(options[item], true);
                    }
                });
            }else{
                cm.forEach(that.params['select'].options, function(item){
                    item.selected && set(options[item.value]);
                });
            }
        }else{
            if(that.params['selected'] && options[that.params['selected']]){
                set(options[that.params['selected']]);
            }else if(options[that.params['select'].value]){
                set(options[that.params['select'].value]);
            }else if(optionsLength){
                set(optionsList[0]);
            }
        }
        // Final events
        that.addToStack(nodes['container']);
        that.triggerEvent('onRender', active);
    };

    var validateParams = function(){
        if(cm.isNode(that.params['select'])){
            that.params['placeholder'] = that.params['select'].getAttribute('placeholder') || that.params['placeholder'];
            that.params['multiple'] = that.params['select'].multiple;
            that.params['title'] = that.params['select'].getAttribute('title') || that.params['title'];
            that.params['name'] = that.params['select'].getAttribute('name') || that.params['name'];
            that.params['disabled'] = that.params['select'].disabled || that.params['disabled'];
        }
        that.disabled = that.params['disabled'];
    };

    var render = function(){
        var tabindex;
        /* *** RENDER STRUCTURE *** */
        if(that.params['multiple']){
            renderMultiple();
        }else{
            renderSingle();
        }
        /* *** ATTRIBUTES *** */
        // Add class name
        if(that.params['select'].className){
            cm.addClass(nodes['container'], that.params['select'].className);
        }
        // Title
        if(that.params['showTitleTag'] && that.params['title']){
            nodes['container'].title = that.params['title'];
        }
        // Tabindex
        if(tabindex = that.params['select'].getAttribute('tabindex')){
            nodes['container'].setAttribute('tabindex', tabindex);
        }
        // ID
        if(that.params['select'].id){
            nodes['container'].id = that.params['select'].id;
        }
        // Data
        cm.forEach(that.params['select'].attributes, function(item){
            if(/^data-/.test(item.name) && item.name != 'data-element'){
                nodes['container'].setAttribute(item.name, item.value);
            }
        });
        // Set hidden input attributes
        if(that.params['name']){
            nodes['hidden'].setAttribute('name', that.params['name']);
        }
        // Placeholder
        if(!cm.isEmpty(that.params['placeholder'])){
            nodes['items'].appendChild(
                nodes['placeholder'] = cm.Node('li', {'class' : 'title'}, that.params['placeholder'])
            );
        }
        /* *** RENDER OPTIONS *** */
        collectSelectOptions();
        cm.forEach(that.params['options'], function(item){
            renderOption(item.value, item.text);
        });
        /* *** INSERT INTO DOM *** */
        if(that.params['container']){
            that.params['container'].appendChild(nodes['container']);
        }else if(that.params['select'].parentNode){
            cm.insertBefore(nodes['container'], that.params['select']);
        }
        cm.remove(that.params['select']);
    };

    var renderSingle = function(){
        nodes['container'] = cm.Node('div', {'class' : 'com__select'},
            nodes['hidden'] = cm.Node('select', {'class' : 'display-none'}),
            nodes['target'] = cm.Node('div', {'class' : 'form-field has-icon-right'},
                nodes['arrow'] = cm.Node('div', {'class' : that.params['icons']['arrow']}),
                nodes['text'] = cm.Node('input', {'type' : 'text', 'readOnly' : 'true'})
            ),
            nodes['scroll'] = cm.Node('div', {'class' : 'pt__listing-items'},
                nodes['items'] = cm.Node('ul')
            )
        );
    };

    var renderMultiple = function(){
        nodes['container'] = cm.Node('div', {'class' : 'com__select-multi'},
            nodes['hidden'] = cm.Node('select', {'class' : 'display-none', 'multiple' : true}),
            nodes['inner'] = cm.Node('div', {'class' : 'inner'},
                nodes['scroll'] = cm.Node('div', {'class' : 'pt__listing-items'},
                    nodes['items'] = cm.Node('ul')
                )
            )
        );
    };

    var setMiscEvents = function(){
        if(!that.params['multiple']){
            // Switch items on arrows press
            cm.addEvent(nodes['container'], 'keydown', function(e){
                e = cm.getEvent(e);
                if(optionsLength){
                    var item = options[active],
                        index = optionsList.indexOf(item),
                        option;

                    switch(e.keyCode){
                        case 38:
                            if(index - 1 >= 0){
                                option = optionsList[index - 1];
                            }else{
                                option = optionsList[optionsLength - 1];
                            }
                            break;

                        case 40:
                            if(index + 1 < optionsLength){
                                option = optionsList[index + 1];
                            }else{
                                option = optionsList[0];
                            }
                            break;

                        case 13:
                            components['menu'].hide();
                            break;
                    }

                    if(option){
                        set(option, true);
                        scrollToItem(option);
                    }
                }
            });
            cm.addEvent(nodes['container'], 'focus', function(){
                cm.addEvent(document.body, 'keydown', blockDocumentArrows);
            });
            cm.addEvent(nodes['container'], 'blur', function(){
                cm.removeEvent(document.body, 'keydown', blockDocumentArrows);
            });
            // Render tooltip
            components['menu'] = new Com.Tooltip(
                cm.merge(that.params['Com.Tooltip'], {
                    'container' : that.params['renderInBody']? document.body : nodes['container'],
                    'content' : nodes['scroll'],
                    'target' : nodes['target'],
                    'events' : {
                        'onShowStart' : show,
                        'onHideStart' : hide
                    }
                })
            );
            nodes['menu'] = components['menu'].getNodes();
        }
        // Enable / Disable
        if(that.disabled){
            that.disable();
        }else{
            that.enable();
        }
    };

    /* *** COLLECTORS *** */

    var collectSelectOptions = function(){
        var myChildes = that.params['select'].childNodes,
            myOptionsNodes,
            myOptions;
        cm.forEach(myChildes, function(myChild){
            if(cm.isElementNode(myChild)){
                if(myChild.tagName.toLowerCase() == 'optgroup'){
                    myOptionsNodes = myChild.querySelectorAll('option');
                    myOptions = [];
                    cm.forEach(myOptionsNodes, function(optionNode){
                        myOptions.push({
                            'value' : optionNode.value,
                            'text' : optionNode.innerHTML
                        });
                    });
                    renderGroup(myChild.getAttribute('label'), myOptions);
                }else if(myChild.tagName.toLowerCase() == 'option'){
                    renderOption(myChild.value, myChild.innerHTML);
                }
            }
        });
    };

    /* *** GROUPS *** */

    var renderGroup = function(myName, myOptions){
        // Config
        var item = {
            'name' : myName,
            'options' : myOptions
        };
        // Structure
        item['optgroup'] = cm.Node('optgroup', {'label' : myName});
        item['container'] = cm.Node('li', {'class' : 'group'},
            item['items'] = cm.Node('ul', {'class' : 'pt__listing-items'})
        );
        if(!cm.isEmpty(myName)){
            cm.insertFirst(
                cm.Node('div', {'class' : 'title', 'innerHTML' : myName}),
                item['container']
            );
        }
        // Render options
        cm.forEach(myOptions, function(myOption){
            renderOption(myOption.value, myOption.text, item);
        });
        // Append
        nodes['items'].appendChild(item['container']);
        nodes['hidden'].appendChild(item['optgroup']);
        // Push to groups array
        groups.push(item);
    };

    /* *** OPTIONS *** */

    var renderOption = function(value, text, group){
        // Check for exists
        if(options[value]){
            removeOption(options[value]);
        }
        // Config
        var item = {
            'selected' : false,
            'value' : value,
            'text' : text,
            'group': group
        };
        // Structure
        item['node'] = cm.Node('li',
            cm.Node('a', {'innerHTML' : text})
        );
        item['option'] = cm.Node('option', {'value' : value, 'innerHTML' : text});
        // Label onlick event
        cm.addEvent(item['node'], 'click', function(){
            if(!that.disabled){
                set(item, true);
            }
            !that.params['multiple'] && components['menu'].hide(false);
        });
        // Append
        if(group){
            group['items'].appendChild(item['node']);
            group['optgroup'].appendChild(item['option']);
        }else{
            nodes['items'].appendChild(item['node']);
            nodes['hidden'].appendChild(item['option']);
        }
        // Push
        optionsList.push(options[value] = item);
        optionsLength = optionsList.length;
    };

    var editOption = function(option, text){
        var value = typeof option['value'] != 'undefined'? option['value'] : option['text'];
        option['text'] = text;
        option['node'].innerHTML = text;
        option['option'].innerHTML = text;

        if(!that.params['multiple'] && value === active){
            nodes['text'].value = cm.decode(text);
        }
    };

    var removeOption = function(option){
        var value = typeof option['value'] != 'undefined'? option['value'] : option['text'];
        // Remove option from list and array
        cm.remove(option['node']);
        cm.remove(option['option']);
        optionsList = optionsList.filter(function(item){
            return option != item;
        });
        optionsLength = optionsList.length;
        delete options[option['value']];
        // Set new active option, if current active is nominated for remove
        if(that.params['multiple']){
            active = active.filter(function(item){
                return value != item;
            });
        }else{
            if(value === active){
                if(optionsLength){
                    set(optionsList[0], true);
                }else{
                    active = null;
                    nodes['text'].value = ''
                }
            }
        }
    };

    /* *** SETTERS *** */

    var set = function(option, execute){
        if(option){
            if(that.params['multiple']){
                setMultiple(option);
            }else{
                setSingle(option);
            }
        }
        if(execute){
            that.triggerEvent('onSelect', active);
            onChange();
        }
    };

    var setMultiple = function(option){
        var value = typeof option['value'] != 'undefined'? option['value'] : option['text'];

        if(option['selected']){
            deselectMultiple(option);
        }else{
            active.push(value);
            option['option'].selected = true;
            option['selected'] = true;
            cm.addClass(option['node'], 'active');
        }
    };

    var setSingle = function(option){
        oldActive = active;
        active = typeof option['value'] != 'undefined'? option['value'] : option['text'];
        optionsList.forEach(function(item){
            cm.removeClass(item['node'], 'active');
        });
        if(option['group']){
            nodes['text'].value = [cm.decode(option['group']['name']), cm.decode(option['text'])].join(' > ');
        }else{
            nodes['text'].value = cm.decode(option['text']);
        }
        option['option'].selected = true;
        nodes['hidden'].value = active;
        cm.addClass(option['node'], 'active');
    };

    var deselectMultiple = function(option){
        var value = typeof option['value'] != 'undefined'? option['value'] : option['text'];

        active = active.filter(function(item){
            return value != item;
        });
        option['option'].selected = false;
        option['selected'] = false;
        cm.removeClass(option['node'], 'active');
    };

    var onChange = function(){
        if(that.params['multiple'] || active != oldActive){
            that.triggerEvent('onChange', active);
        }
    };

    /* *** DROPDOWN *** */

    var show = function(){
        if(!optionsLength){
            components['menu'].hide();
        }else{
            // Set classes
            cm.addClass(nodes['container'], 'active');
            nodes['text'].focus();
            // Scroll to active element
            if(active && options[active]){
                scrollToItem(options[active]);
            }
        }
        that.triggerEvent('onFocus', active);
    };

    var hide = function(){
        nodes['text'].blur();
        cm.removeClass(nodes['container'], 'active');
        that.triggerEvent('onBlur', active);
    };

    var scrollToItem = function(option){
        nodes['menu']['content'].scrollTop = option['node'].offsetTop - nodes['menu']['content'].offsetTop;
    };

    /* *** HELPERS *** */

    var blockDocumentArrows = function(e){
        e = cm.getEvent(e);
        if(e.keyCode == 38 || e.keyCode == 40){
            cm.preventDefault(e);
        }
    };

    /* ******* MAIN ******* */

    that.get = function(){
        return active;
    };

    that.set = function(value, execute){
        execute = typeof execute == 'undefined'? true : execute;
        // Select option and execute events
        if(typeof value != 'undefined'){
            if(cm.isArray(value)){
                cm.forEach(value, function(item){
                    if(options[item]){
                        set(options[item]);
                    }
                });
                /* *** EXECUTE API EVENTS *** */
                if(execute){
                    that.triggerEvent('onSelect', active);
                    that.triggerEvent('onChange', active);
                }
            }else if(options[value]){
                set(options[value], execute);
            }
        }
        return that;
    };

    that.selectAll = function(){
        if(that.params['multiple']){
            cm.forEach(options, deselectMultiple);
            cm.forEach(options, setMultiple);
            that.triggerEvent('onSelect', active);
            onChange();
        }
        return that;
    };

    that.deselectAll = function(){
        if(that.params['multiple']){
            cm.forEach(options, deselectMultiple);
            that.triggerEvent('onSelect', active);
            onChange();
        }
        return that;
    };

    that.addOption = function(value, text){
        renderOption(value, text);
        return that;
    };

    that.addOptions = function(arr){
        cm.forEach(arr, function(item){
            renderOption(item['value'], item['text']);
        });
        return that;
    };

    that.editOption = function(value, text){
        if(typeof value != 'undefined' && options[value]){
            editOption(options[value], text);
        }
        return that;
    };

    that.removeOption = function(value){
        if(typeof value != 'undefined' && options[value]){
            removeOption(options[value]);
        }
        return that;
    };

    that.removeOptionsAll = function(){
        cm.forEach(options, function(item){
            removeOption(item);
        });
        return that;
    };

    that.getOption = function(value){
        if(typeof value != 'undefined' && options[value]){
            return options[value];
        }
        return null;
    };

    that.getOptions = function(arr){
        var optionsArr = [];
        cm.forEach(arr, function(item){
            if(options[item]){
                optionsArr.push(options[item]);
            }
        });
        return optionsArr;
    };

    that.getOptionsAll = that.getAllOptions = function(){
        var result = [];
        cm.forEach(optionsList, function(item){
            result.push({
                'text' : item['text'],
                'value' : item['value']
            });
        });
        return result;
    };

    that.disable = function(){
        that.disabled = true;
        cm.addClass(nodes['container'], 'disabled');
        cm.addClass(nodes['scroll'], 'disabled');
        if(!that.params['multiple']){
            nodes['text'].disabled = true;
            components['menu'].disable();
        }
        return that;
    };

    that.enable = function(){
        that.disabled = false;
        cm.removeClass(nodes['container'], 'disabled');
        cm.removeClass(nodes['scroll'], 'disabled');
        if(!that.params['multiple']){
            nodes['text'].disabled = false;
            components['menu'].enable();
        }
        return that;
    };

    that.getNodes = function(key){
        return nodes[key] || nodes;
    };

    init();
});

/* ****** FORM FIELD COMPONENT ******* */

Com.FormFields.add('Com.Select', {
    'node' : cm.node('select'),
    'isComponent' : true,
    'callbacks' : {
        'component' : function(params){
            var that = this;
            return new that.params['constructor'](
                cm.merge(params, {
                    'select' : that.params['node'],
                    'name' : that.params['name'],
                    'options' : that.params['options']
                })
            );
        },
        'set' : function(value){
            var that = this;
            that.component.set(value);
            return value;
        },
        'get' : function(){
            var that = this;
            return that.component.get();
        }
    }
});
cm.define('Com.Slider', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'DataNodes',
        'Stack'
    ],
    'events' : [
        'onRender',
        'onChangeStart',
        'onChange',
        'onPause',
        'onStart'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'name' : '',
        'time' : 500,                   // Fade time
        'delay' : 4000,                 // Delay before slide will be changed
        'slideshow' : true,             // Turn on / off slideshow
        'direction' : 'forward',        // Slideshow direction: forward | backward | random
        'pauseOnHover' : true,
        'fadePrevious' : false,         // Fade out previous slide, needed when using transparency slides
        'buttons' : true,               // Display buttons, can hide exists buttons
        'numericButtons' : false,       // Render slide index on button
        'arrows' : true,                // Display arrows, can hide exists arrows
        'effect' : 'fade',              // none | edit | fade | fade-out | push | pull | pull-parallax | pull-overlap
        'transition' : 'smooth',        // smooth | simple | acceleration | inhibition,
        'height' : 'auto',              // auto | max | slide
        'minHeight' : 48,               // Set min-height of slider, work with calculateMaxHeight parameter
        'hasBar' : false,
        'barDirection' : 'horizontal',  // horizontal | vertical
        'editMode' : false,
        'Com.Scroll' : {
            'step' : 25,
            'time' : 25
        }
    }
},
function(params){
    var that = this,
        components = {},
        slideshowInterval,
        minHeightDimension;
    
    that.nodes = {
        'container' : cm.Node('div'),
        'inner' : cm.Node('div'),
        'slides' : cm.Node('div'),
        'slidesInner' : cm.Node('ul'),
        'next' : cm.Node('div'),
        'prev' : cm.Node('div'),
        'buttons' : cm.Node('ul'),
        'items' : [],
        'layout-inner' : cm.Node('div'),
        'bar-inner' : cm.Node('div'),
        'bar-items' : []
    };

    that.anim = {};
    that.items = [];
    that.itemsLength = 0;

    that.effect = null;
    that.direction = 'next';
    that.current = null;
    that.previous = null;
    that.paused = false;
    that.pausedOutside = false;
    that.isProcess = false;

    var init = function(){
        getCSSHelpers();
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);

        validateParams();
        renderSlider();
        renderLayout();
        that.setEffect(that.params['effect']);
        that.params['editMode'] && that.enableEditMode();
        that.addToStack(that.params['node']);
        that.triggerEvent('onRender');
    };

    var getCSSHelpers = function(){
        that.params['time'] = cm.getTransitionDurationFromRule('.com__slider-helper__duration');
    };

    var validateParams = function(){
        if(cm.isNode(that.params['node'])){
            that.params['name'] = that.params['node'].getAttribute('name') || that.params['name'];
        }
        that.params['direction'] = {'forward' : 1, 'backward' : 1, 'random' : 1}[that.params['direction']] ? that.params['direction'] : 'forward';
        that.params['effect'] = Com.SliderEffects[that.params['effect']] ? that.params['effect'] : 'fade';
        that.params['transition'] = {'smooth' : 1, 'simple' : 1, 'acceleration' : 1, 'inhibition' : 1}[that.params['transition']] ? that.params['transition'] : 'smooth';
        that.params['height'] = {'auto' : 1, 'max' : 1, 'slide' : 1}[that.params['height']] ? that.params['height'] : 'auto';
        if(that.params['minHeight'] && isNaN(that.params['minHeight'])){
            minHeightDimension = getDimension(that.params['minHeight']);
            that.params['minHeight'] = parseFloat(that.params['minHeight']);
        }
    };

    var renderSlider = function(){
        var transitionRule = cm.getSupportedStyle('transition');
        // Collect items
        cm.forEach(that.nodes['items'], collectItem);
        // Arrows
        if(that.params['arrows']){
            cm.addEvent(that.nodes['next'], 'click', that.next);
            cm.addEvent(that.nodes['prev'], 'click', that.prev);
        }
        if(!that.params['arrows'] || that.itemsLength < 2){
            that.nodes['next'].style.display = 'none';
            that.nodes['prev'].style.display = 'none';
        }
        // Buttons
        if(that.params['buttons']){
            cm.forEach(that.items, renderButton);
        }
        if(!that.params['buttons'] || that.itemsLength < 2){
            that.nodes['buttons'].style.display = 'none';
        }
        // Height Type Parameters
        that.nodes['inner'].style[transitionRule] = [that.params['time'], 'ms'].join('');
        if(/max|slide/.test(that.params['height'])){
            cm.addClass(that.nodes['container'], 'is-adaptive-content');
        }
        // Pause slider when it hovered
        if(that.params['slideshow'] && that.params['pauseOnHover']){
            cm.addEvent(that.nodes['container'], 'mouseover', function(e){
                e = cm.getEvent(e);
                var target = cm.getObjToEvent(e);
                if(!cm.isParent(that.nodes['container'], target, true)){
                    stopSlideshow();
                }
            });
            cm.addEvent(that.nodes['container'], 'mouseout', function(e){
                e = cm.getEvent(e);
                var target = cm.getObjToEvent(e);
                if(!cm.isParent(that.nodes['container'], target, true)){
                    startSlideshow();
                }
            });
        }
        // Init animations
        that.anim['slides'] = new cm.Animation(that.nodes['slides']);
        that.anim['slidesInner'] = new cm.Animation(that.nodes['slidesInner']);
        // Resize events
        cm.addEvent(window, 'resize', function(){
            that.redraw();
        });
        // Add custom event
        cm.customEvent.add(that.params['node'], 'redraw', function(){
            that.redraw();
        });
    };

    var renderLayout = function(){
        if(that.params['hasBar']){
            that.nodes['ComScroll'] = cm.getNodes(that.params['node'])['ComScroll'];
            components['scroll'] = new Com.Scroll(
                cm.merge(that.params['Com.Scroll'], {
                    'nodes' : that.nodes['ComScroll']
                })
            );
        }
    };

    var calculateHeight = function(){
        switch(that.params['height']){
            case 'max' :
                calculateMaxHeight();
                break;

            case 'slide' :
                calculateSlideHeight();
                break;
        }
    };

    var calculateMaxHeight = function(){
        var height = 0;
        cm.forEach(that.items, function(item){
            height = Math.max(height, cm.getRealHeight(item.nodes['container'], 'offsetRelative'));
            if(item.nodes['inner']){
                height = Math.max(height, cm.getRealHeight(item.nodes['inner'], 'offsetRelative'));
            }
        });
        if(minHeightDimension == '%'){
            height = Math.max(height, (that.nodes['inner'].offsetWidth / 100 * that.params['minHeight']));
        }else{
            height = Math.max(height, that.params['minHeight']);
        }
        if(height != that.nodes['inner'].offsetHeight){
            that.nodes['inner'].style.height = [height, 'px'].join('');
        }
    };

    var calculateSlideHeight = function(){
        var item,
            height = 0;
        if(that.current !== null){
            item = that.items[that.current];
            height = Math.max(height, cm.getRealHeight(item.nodes['container'], 'offsetRelative'));
            if(item.nodes['inner']){
                height = Math.max(height, cm.getRealHeight(item.nodes['inner'], 'offsetRelative'));
            }
        }
        if(minHeightDimension == '%'){
            height = Math.max(height, (that.nodes['inner'].offsetWidth / 100 * that.params['minHeight']));
        }else{
            height = Math.max(height, that.params['minHeight']);
        }
        if(height != that.nodes['inner'].offsetHeight){
            that.nodes['inner'].style.height = [height, 'px'].join('');
        }
    };

    var collectItem = function(item, i){
        // Configuration
        item = {
            'index' : i,
            'nodes' : item
        };
        // Bar
        if(that.params['hasBar']){
            item['bar'] = that.nodes['bar-items'][i];
            item['bar']['title'] = item['bar']['link']? item['bar']['link'].getAttribute('title') || '' : '';
            item['bar']['src'] = item['bar']['link']? item['bar']['link'].getAttribute('href') || '' : '';
        }
        // Process item
        processItem(item);
    };

    var processItem = function(item){
        // Configuration
        item = cm.merge({
            'index' : that.items.length,
            'nodes' : {
                'container' : cm.Node('li'),
                'inner' : null
            }
        }, item);
        // Bar
        if(that.params['hasBar']){
            // Set image on thumb click
            cm.addEvent(item['bar']['link'], 'click', function(e){
                e = cm.getEvent(e);
                cm.preventDefault(e);
                set(item['index']);
            });
        }
        // Init animation
        item['anim'] = new cm.Animation(item['nodes']['container']);
        // Push to items array
        that.items.push(item);
        that.itemsLength = that.items.length;
    };

    var resetStyles = function(){
        that.nodes['slidesInner'].scrollLeft = 0;
        cm.forEach(that.items, function(item){
            item.nodes['container'].style.display = '';
            item.nodes['container'].style.opacity = '';
            item.nodes['container'].style.left = '';
            item.nodes['container'].style.zIndex = '';
        });
    };

    var renderButton = function(item){
        // Structure
        that.nodes['buttons'].appendChild(
            item['nodes']['button'] = cm.Node('li')
        );
        if(that.params['numericButtons']){
            item['nodes']['button'].innerHTML = item['index'] + 1;
        }
        // Event
        cm.addEvent(item['nodes']['button'], 'click', function(){
            that.direction = 'next';
            set(item['index']);
        });
    };

    var set = function(index){
        if(!that.isProcess){
            that.isProcess = true;
            // Renew slideshow delay
            that.params['slideshow'] && renewSlideshow();
            // Set current active slide
            var current = that.items[index],
                previous = that.items[that.current];
            that.previous = that.current;
            that.current = index;
            // API onChangeStart event
            that.triggerEvent('onChangeStart', {
                'current' : current,
                'previous' : previous
            });
            // Reset active slide
            if(previous){
                if(that.params['buttons']){
                    cm.removeClass(previous['nodes']['button'], 'active');
                }
            }
            // Set active slide
            if(that.params['buttons']){
                cm.addClass(current['nodes']['button'], 'active');
            }
            // Set bar item
            if(that.params['hasBar']){
                setBarItem(current, previous);
            }
            // Transition effect and callback
            Com.SliderEffects[that.effect](that, current, previous, function(){
                that.isProcess = false;
                // API onChange event
                that.triggerEvent('onChange', {
                    'current' : current,
                    'previous' : previous
                });
                // Trigger custom event
                cm.customEvent.trigger(current['nodes']['container'], 'redraw', {
                    'type' : 'child',
                    'self' : false
                });
            });
            // Recalculate slider height dependence of height type
            calculateHeight();
        }
    };

    var setBarItem = function(current, previous){
        var left,
            top;
        // Thumbs classes
        if(previous){
            cm.removeClass(previous['bar']['container'], 'active');
        }
        cm.addClass(current['bar']['container'], 'active');
        // Move bar
        if(that.params['barDirection'] == 'vertical'){
            top = current['bar']['container'].offsetTop - (that.nodes['layout-inner'].offsetHeight / 2) + (current['bar']['container'].offsetHeight / 2);
            components['scroll'].scrollY(top);
        }else{
            left = current['bar']['container'].offsetLeft - (that.nodes['layout-inner'].offsetWidth / 2) + (current['bar']['container'].offsetWidth / 2);
            components['scroll'].scrollX(left);
        }
    };

    /* *** SLIDESHOW *** */

    var startSlideshow = function(){
        if(that.paused && !that.pausedOutside){
            that.paused = false;
            slideshowInterval = setTimeout(function(){
                switch(that.params['direction']){
                    case 'random':
                        set(cm.rand(0, (that.items.length - 1)));
                        break;

                    case 'backward':
                        that.prev();
                        break;

                    case 'forward':
                        that.next();
                        break;
                }
            }, that.params['delay']);
            that.triggerEvent('onStart');
        }
    };

    var stopSlideshow = function(){
        if(!that.paused){
            that.paused = true;
            slideshowInterval && clearTimeout(slideshowInterval);
            that.triggerEvent('onPause');
        }
    };

    var renewSlideshow = function(){
        if(!that.paused && !that.pausedOutside){
            stopSlideshow();
            startSlideshow();
        }
    };

    /* *** HELPERS *** */

    var resizeHandler = function(){
        // Recalculate slider height dependence of height type
        calculateHeight();
    };

    var getDimension = function(value){
        var pure = value.match(/\d+(\D*)/);
        return pure ? pure[1] : '';
    };

    /* ******* MAIN ******* */

    that.redraw = function(){
        resizeHandler();
        return that;
    };

    that.set = function(index){
        if(that.items[index]){
            set(index);
        }
        return that;
    };

    that.get = function(index){
        return that.items[index]? that.items[index] : null;
    };

    that.next = function(){
        that.direction = 'next';
        var i = ((that.current + 1) == that.items.length) ? 0 : (that.current + 1);
        set(i);
        return that;
    };

    that.prev = function(){
        that.direction = 'prev';
        var i = (that.current == 0) ? (that.items.length - 1) : (that.current - 1);
        set(i);
        return that;
    };

    that.pause = function(){
        that.pausedOutside = true;
        stopSlideshow();
        return that;
    };

    that.start = function(){
        that.pausedOutside = false;
        startSlideshow();
        return that;
    };

    that.enableEditMode = function(){
        that.pause();
        cm.addClass(that.nodes['container'], 'is-edit-mode');
        that.setEffect('edit');
    };

    that.disableEditMode = function(){
        that.start();
        cm.removeClass(that.nodes['container'], 'is-edit-mode');
        that.restoreEffect();
    };

    that.setEffect = function(effect){
        // Reset slides styles after previous effect
        cm.removeClass(that.nodes['slides'], ['effect', that.effect].join('-'));
        resetStyles();
        // Set new effect
        that.effect = Com.SliderEffects[effect] ? effect : 'fade';
        cm.addClass(that.nodes['slides'], ['effect', that.effect].join('-'));
        // Reset slide
        if(that.items[0]){
            set(0);
        }
        // Recalculate slider height
        calculateHeight();
        return that;
    };

    that.restoreEffect = function(){
        that.setEffect(that.params['effect']);
        return that;
    };

    init();
});

/* ******* SLIDER EFFECTS ******* */

Com.SliderEffects = {};

/* *** NONE *** */

Com.SliderEffects['none'] = function(slider, current, previous, callback){
    if(slider.itemsLength > 1 && previous && current != previous){
        previous['nodes']['container'].style.display = 'none';
        previous['nodes']['container'].style.zIndex = 1;
        current['nodes']['container'].style.zIndex = 2;
        current['nodes']['container'].style.display = 'block';
    }
    callback();
};

/* *** DEV *** */

Com.SliderEffects['edit'] = function(slider, current, previous, callback){
    if(slider.itemsLength > 1 && previous && current != previous){
        previous['nodes']['container'].style.display = 'none';
        previous['nodes']['container'].style.zIndex = 1;
        current['nodes']['container'].style.zIndex = 2;
        current['nodes']['container'].style.opacity = 1;
        current['nodes']['container'].style.display = 'block';
        current['nodes']['container'].style.left = 0;
    }
    callback();
};

/* *** FADE *** */

Com.SliderEffects['fade'] = function(slider, current, previous, callback){
    var hide = function(item){
        item['nodes']['container'].style.display = 'none';
        cm.setOpacity(item['nodes']['container'], 0);
    };

    if(slider.itemsLength > 1 && previous && current != previous){
        // Hide previous slide
        previous['nodes']['container'].style.zIndex = 1;
        if(slider.params['fadePrevious']){
            previous['anim'].go({'style' : {'opacity' : 0}, 'duration' : slider.params['time'], 'anim' : slider.params['transition'], 'onStop' : function(){
                hide(previous);
            }});
        }else{
            setTimeout(function(){
                hide(previous);
            }, slider.params['time']);
        }
        // Set visible new slide and animate it
        current['nodes']['container'].style.zIndex = 2;
        current['nodes']['container'].style.display = 'block';
        current['anim'].go({'style' : {'opacity' : 1}, 'duration' : slider.params['time'], 'anim' : slider.params['transition'], 'onStop' : callback});
    }else{
        callback();
    }
};

/* *** FADE *** */

Com.SliderEffects['fade-out'] = function(slider, current, previous, callback){
    var hide = function(item){
        item['nodes']['container'].style.display = 'none';
        cm.setOpacity(item['nodes']['container'], 0);
    };

    if(slider.itemsLength > 1 && previous && current != previous){
        // Hide previous slide
        previous['nodes']['container'].style.zIndex = 1;
        previous['anim'].go({'style' : {'opacity' : 0}, 'duration' : slider.params['time'], 'anim' : slider.params['transition'], 'onStop' : function(){
            hide(previous);
        }});
        // Set visible new slide and animate it
        current['nodes']['container'].style.zIndex = 2;
        current['nodes']['container'].style.display = 'block';
        current['anim'].go({'style' : {'opacity' : 1}, 'duration' : slider.params['time'], 'anim' : slider.params['transition'], 'onStop' : callback});
    }else{
        callback();
    }
};

/* *** PUSH *** */

Com.SliderEffects['push'] = function(slider, current, previous, callback){
    var left = current['nodes']['container'].offsetLeft;
    slider.anim['slidesInner'].go({'style' : {'scrollLeft' : left}, 'duration' : slider.params['time'], 'anim' : slider.params['transition'], 'onStop' : callback});
};

/* *** PULL *** */

Com.SliderEffects['pull'] = function(slider, current, previous, callback){
    if(slider.itemsLength > 1 && previous && current != previous){
        // Hide previous slide
        var style = slider.direction == 'next' ? '-100%' : '100%';
        previous['nodes']['container'].style.zIndex = 1;
        previous['anim'].go({'style' : {'left' : style}, 'duration' : slider.params['time'], 'anim' : slider.params['transition'], 'onStop' : function(){
            previous['nodes']['container'].style.display = 'none';
            previous['nodes']['container'].style.left = '100%';
        }});
        // Set visible new slide and animate it
        current['nodes']['container'].style.zIndex = 2;
        current['nodes']['container'].style.display = 'block';
        if(slider.direction == 'next'){
            current['nodes']['container'].style.left = '100%';
        }else if(slider.direction == 'prev'){
            current['nodes']['container'].style.left = '-100%';
        }
        current['anim'].go({'style' : {'left' : '0%'}, 'duration' : slider.params['time'], 'anim' : slider.params['transition'], 'onStop' : callback});
    }else{
        callback();
    }
};

/* *** PULL OVERLAP *** */

Com.SliderEffects['pull-overlap'] = function(slider, current, previous, callback){
    if(slider.itemsLength > 1 && previous && current != previous){
        // Hide previous slide
        previous['nodes']['container'].style.zIndex = 1;
        setTimeout(function(){
            previous['nodes']['container'].style.display = 'none';
            previous['nodes']['container'].style.left = '100%';
        }, slider.params['time']);
        // Set visible new slide and animate it
        current['nodes']['container'].style.zIndex = 2;
        current['nodes']['container'].style.display = 'block';
        if(slider.direction == 'next'){
            current['nodes']['container'].style.left = '100%';
        }else if(slider.direction == 'prev'){
            current['nodes']['container'].style.left = '-100%';
        }
        current['anim'].go({'style' : {'left' : '0%'}, 'duration' : slider.params['time'], 'anim' : slider.params['transition'], 'onStop' : callback});
    }else{
        callback();
    }
};

/* *** PULL PARALLAX *** */

Com.SliderEffects['pull-parallax'] = function(slider, current, previous, callback){
    if(slider.itemsLength > 1 && previous && current != previous){
        // Hide previous slide
        var style = slider.direction == 'next' ? '-50%' : '50%';
        previous['nodes']['container'].style.zIndex = 1;
        previous['anim'].go({'style' : {'left' : style}, 'duration' : slider.params['time'], 'anim' : slider.params['transition'], 'onStop' : function(){
            previous['nodes']['container'].style.display = 'none';
            previous['nodes']['container'].style.left = '100%';
        }});
        // Set visible new slide and animate it
        current['nodes']['container'].style.zIndex = 2;
        current['nodes']['container'].style.display = 'block';
        if(slider.direction == 'next'){
            current['nodes']['container'].style.left = '100%';
        }else if(slider.direction == 'prev'){
            current['nodes']['container'].style.left = '-100%';
        }
        current['anim'].go({'style' : {'left' : '0%'}, 'duration' : slider.params['time'], 'anim' : slider.params['transition'], 'onStop' : callback});
    }else{
        callback();
    }
};
cm.define('Com.Sortable', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'DataNodes'
    ],
    'events' : [
        'onRender',
        'onRemove',
        'onSort'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'process' : true,
        'Com.Draganddrop' : {
            'draggableContainer' : 'selfParent',
            'direction' : 'vertical',
            'limit' : true,
            'scroll' : false,
            'animateRemove' : false,
            'removeNode' : false
        }
    }
},
function(params){
    var that = this;

    that.components = {};
    that.nodes = {
        'groups' : []
    };

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);
        render();
    };

    var render = function(){
        // Init drag'n'drop class
        that.components['dd'] = new Com.Draganddrop(
                cm.merge(that.params['Com.Draganddrop'], {
                    'draggableContainer' : that.params['draggableContainer'],
                    'direction' : that.params['direction'],
                    'limit' : that.params['limit']
                })
            )
            .addEvent('onRemove', onRemove)
            .addEvent('onDrop', onSort);
        // Process items
        if(that.params['process']){
            cm.forEach(that.nodes['groups'], process);
        }
        // Trigger render event
        that.triggerEvent('onRender');
    };

    var onRemove = function(dd, widget){
        that.triggerEvent('onRemove', widget);
    };

    var onSort = function(dd, widget){
        that.triggerEvent('onSort', widget);
    };

    var process = function(group){
        if(group['container']){
            // Register group node
            that.addGroup(group['container']);
            // Register group's items
            if(group['items']){
                cm.forEach(group['items'], function(item){
                    processItem(item, group);
                });
            }
        }
    };

    var processItem = function(item, group){
        // Register item
        that.addItem(item['container'], group['container']);
        // Register sub groups
        if(item['groups']){
            cm.forEach(item['groups'], process);
        }
    };

    /* ******* MAIN ******* */

    that.addGroup = function(group){
        that.components['dd'].registerArea(group);
        return that;
    };

    that.removeGroup = function(group){
        that.components['dd'].removeArea(group);
        return that;
    };

    that.addItem = function(item, group){
        var nodes = cm.getNodes(item);
        if(nodes['items'][0]['drag']){
            nodes['items'][0]['drag'].setAttribute('data-com-draganddrop', 'drag');
        }
        that.components['dd'].registerDraggable(item, group);
        return that;
    };

    that.removeItem = function(item){
        that.components['dd'].removeDraggable(item);
        return that;
    };

    init();
});
cm.define('Com.Spacer', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'Stack'
    ],
    'required' : [
        'Com.Draggable'
    ],
    'events' : [
        'onRender',
        'onChange',
        'onResize'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'name' : '',
        'Com.Draggable' : {
            'direction' : 'vertical',
            'minY' : 24
        }
    }
},
function(params){
    var that = this;

    that.components = {};
    that.nodes = {};
    that.value = 0;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['node']);
        validateParams();
        render();
        setLogic();
        set(that.params['node'].style.height, false);
        that.addToStack(that.params['node']);
        that.triggerEvent('onRender');
    };

    var validateParams = function(){
        if(cm.isNode(that.params['node'])){
            that.params['name'] = that.params['node'].getAttribute('name') || that.params['name'];
        }
    };

    var render = function(){
        // Chassis Structure
        that.nodes['dragContainer'] = cm.Node('div', {'class' : 'com__spacer__chassis'},
            that.nodes['drag'] = cm.Node('div', {'class' : 'pt__drag is-vertical'},
                cm.Node('div', {'class' : 'line'}),
                cm.Node('div', {'class' : 'drag'},
                    cm.Node('div', {'class' : 'icon draggable'})
                )
            )
        );
        // Ruler Structure
        that.nodes['rulerContainer'] = cm.Node('div', {'class' : 'com__spacer__ruler'},
            that.nodes['ruler'] = cm.Node('div', {'class' : 'pt__ruler is-vertical is-small'},
                cm.Node('div', {'class' : 'line line-top'}),
                that.nodes['rulerCounter'] = cm.Node('div', {'class' : 'counter'}),
                cm.Node('div', {'class' : 'line line-bottom'})
            )
        );
        // Embed
        that.params['node'].appendChild(that.nodes['dragContainer']);
        that.params['node'].appendChild(that.nodes['rulerContainer']);
        // Add window event
        cm.addEvent(window, 'resize', function(){
            that.redraw();
        });
        // Add custom event
        cm.customEvent.add(that.params['node'], 'redraw', function(){
            that.redraw();
        });
    };

    var setLogic = function(){
        that.components['draggable'] = new Com.Draggable(
            cm.merge(that.params['Com.Draggable'], {
                'node': that.nodes['dragContainer'],
                'events' : {
                    'onStart' : start,
                    'onSet' : function(my, data){
                        that.value = data['posY'];
                        move();
                    },
                    'onStop' : stop
                }
            })
        );
    };

    var start = function(){
        cm.addClass(document.body, 'pt__drag__body--vertical');
        cm.addClass(that.params['node'], 'is-active');
        cm.addClass(that.nodes['drag'], 'is-active');
        cm.addClass(that.nodes['ruler'], 'is-active');
    };

    var move = function(){
        that.params['node'].style.height = [that.value, 'px'].join('');
        setRulerCounter();
        that.triggerEvent('onChange', {
            'height' : that.value
        });
    };

    var stop = function(){
        cm.removeClass(document.body, 'pt__drag__body--vertical');
        cm.removeClass(that.params['node'], 'is-active');
        cm.removeClass(that.nodes['drag'], 'is-active');
        cm.removeClass(that.nodes['ruler'], 'is-active');
        that.triggerEvent('onResize', {
            'height' : that.value
        });
    };

    var set = function(height, triggerEvents){
        that.value = height;
        setHeight(height);
        setRulerCounter();
        if(triggerEvents){
            that.triggerEvent('onChange', {
                'height' : that.value
            });
            that.triggerEvent('onResize', {
                'height' : that.value
            });
        }
    };

    var setRulerCounter = function(){
        that.nodes['rulerCounter'].innerHTML = [that.value, ' px'].join('');
    };

    var setHeight = function(height){
        that.params['node'].style.height = [height, 'px'].join('');
        that.nodes['dragContainer'].style.top = [that.params['node'].offsetHeight, 'px'].join('');
    };

    /* ******* MAIN ******* */

    that.redraw = function(){
        setHeight(that.value);
        return that;
    };

    that.set = function(height, triggerEvents){
        triggerEvents = typeof triggerEvents != 'undefined'? triggerEvents : true;
        if(!isNaN(height)){
            set(height, triggerEvents);
        }
        return that;
    };

    that.get = function(){
        return that.value;
    };

    init();
});
Com.Elements['Tabset'] = {};

Com['GetTabset'] = function(id){
    return Com.Elements.Tabset[id] || null;
};

cm.define('Com.Tabset', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'DataNodes',
        'Stack',
        'Structure'
    ],
    'events' : [
        'onRender',
        'onTabShowStart',
        'onTabShow',
        'onTabHideStart',
        'onTabHide'
    ],
    'params' : {
        'node' : cm.Node('div'),        // Tabs contained node
        'container' : false,
        'name' : '',
        'toggleOnHashChange' : true,
        'renderOnInit' : true,
        'active' : null,
        'className' : '',
        'tabsPosition' : 'top',         // top | right | bottom | left
        'tabsFlexible' : false,
        'tabsWidth' : 256,              // Only for tabsPosition left or right
        'showTabs' : true,
        'showTabsTitle' : true,         // Show title tooltip
        'switchManually' : false,       // Change tab manually, not implemented yet
        'animateSwitch' : true,
        'animateDuration' : 300,
        'calculateMaxHeight' : false,
        'tabs' : [],
        'icons' : {
            'menu' : 'icon default linked'
        }
    }
},
function(params){
    var that = this,
        hashInterval,
        resizeInterval;
    
    that.nodes = {
        'tabs' : []
    };
    that.anim = {};
    that.tabs = {};
    that.tabsListing = [];
    that.active = false;
    that.previous = false;
    that.isProcess = false;
    
    var init = function(){
        getCSSHelpers();
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node'], that.params['nodesDataMarker'], false);
        that.getDataConfig(that.params['node']);
        validateParams();
        // Render tabset view
        renderView();
        // Render active tab
        that.params['renderOnInit'] && render();
    };

    var getCSSHelpers = function(){
        var rule;
        that.params['animateDuration'] = cm.getTransitionDurationFromRule('.com__tabset-helper__duration');
        if(rule = cm.getCSSRule('.com__tabset-helper__column-width')[0]){
            that.params['tabsWidth'] = cm.styleToNumber(rule.style.width);
        }
    };

    var validateParams = function(){
        if(!cm.inArray(['top', 'right', 'bottom', 'left'], that.params['tabsPosition'])){
            that.params['tabsPosition'] = 'top';
        }
        if(typeof that.params['tabsWidth'] == 'number'){
            that.params['tabsWidth'] = [that.params['tabsWidth'], 'px'].join('');
        }
    };

    var render = function(){
        var id = that.params['active'];
        if(that.params['toggleOnHashChange']){
            // Init hash change handler
            initHashChange();
            // Set first active tab
            if(id && that.tabs[id]){
                set(id);
            }else{
                hashHandler();
            }
        }else{
            if(id = getValidID(id)){
                set(id);
            }
        }
    };

    var renderView = function(){
        /* *** STRUCTURE *** */
        that.nodes['container'] = cm.Node('div', {'class' : 'com__tabset'},
            that.nodes['content'] = cm.Node('div', {'class' : 'com__tabset__content'},
                that.nodes['contentUL'] = cm.Node('ul')
            )
        );
        that.nodes['headerTitle'] = cm.Node('div', {'class' : 'com__tabset__head-title'},
            that.nodes['headerTitleText'] = cm.Node('div', {'class' : 'com__tabset__head-text'}),
            cm.Node('div', {'class' : 'com__tabset__head-menu pt__menu'},
                cm.Node('div', {'class' : that.params['icons']['menu']}),
                that.nodes['headerMenuUL'] = cm.Node('ul', {'class' : 'pt__menu-dropdown'})
            )
        );
        that.nodes['headerTabs'] = cm.Node('div', {'class' : 'com__tabset__head-tabs'},
            that.nodes['headerUL'] = cm.Node('ul')
        );
        if(that.params['animateSwitch']){
            cm.addClass(that.nodes['content'], 'is-animated');
        }
        // Set Tabs Width
        if(/left|right/.test(that.params['tabsPosition'])){
            that.nodes['headerTabs'].style.width = that.params['tabsWidth'];
            that.nodes['content'].style.width = ['calc(100% - ', that.params['tabsWidth'], ')'].join('');
        }
        // Embed Tabs
        if(that.params['showTabs']){
            cm.insertBefore(that.nodes['headerTitle'], that.nodes['content']);
            if(/bottom|right/.test(that.params['tabsPosition'])){
                cm.insertAfter(that.nodes['headerTabs'], that.nodes['content']);
            }else{
                cm.insertBefore(that.nodes['headerTabs'], that.nodes['content']);
            }
        }
        // Init Animation
        that.anim['contentUL'] = new cm.Animation(that.nodes['contentUL']);
        /* *** RENDER TABS *** */
        cm.forEach(that.nodes['tabs'], function(item){
            renderTab(
                cm.merge({'content' : item['container']}, that.getNodeDataConfig(item['container']))
            );
        });
        cm.forEach(that.params['tabs'], function(item){
            renderTab(item);
        });
        /* *** ATTRIBUTES *** */
        // CSS
        cm.addClass(that.nodes['container'], ['is-tabs', that.params['tabsPosition']].join('-'));
        if(that.params['tabsFlexible']){
            cm.addClass(that.nodes['container'], 'is-tabs-flexible');
        }
        if(!cm.isEmpty(that.params['className'])){
            cm.addClass(that.nodes['container'], that.params['className']);
        }
        // ID
        if(that.params['node'].id){
            that.nodes['container'].id = that.params['node'].id;
        }
        /* *** INSERT INTO DOM *** */
        that.appendStructure(that.nodes['container']);
        cm.remove(that.params['node']);
        /* *** EVENTS *** */
        Part.Menu && Part.Menu();
        cm.addEvent(window, 'resize', resizeHandler);
        that.addToStack(that.nodes['container']);
        that.triggerEvent('onRender');
    };

    var renderTab = function(item){
        // Check for exists
        if(that.tabs[item['id']]){
            removeTab(that.tabs[item['id']]);
        }
        // Config
        item = cm.merge({
            'id' : '',
            'title' : '',
            'content' : cm.Node('li'),
            'isHide' : true,
            'onShowStart' : function(that, tab){},
            'onShow' : function(that, tab){},
            'onHideStart' : function(that, tab){},
            'onHide' : function(that, tab){}
        }, item);
        // Structure
        item['tab'] = renderTabLink(item);
        item['menu'] = renderTabLink(item);
        // Remove active tab class if exists
        cm.removeClass(item['content'], 'active');
        // Append tab
        that.nodes['headerUL'].appendChild(item['tab']['container']);
        that.nodes['headerMenuUL'].appendChild(item['menu']['container']);
        that.nodes['contentUL'].appendChild(item['content']);
        // Push
        that.tabsListing.push(item);
        that.tabs[item['id']] = item;
    };

    var renderTabLink = function(tab){
        var item = {};
        // Structure
        item['container'] = cm.Node('li',
            item['a'] = cm.Node('a', tab['title'])
        );
        if(that.params['showTabsTitle']){
            item['a'].setAttribute('title', tab['title']);
        }
        // Add click event
        if(that.params['toggleOnHashChange']){
            cm.addEvent(item['a'], 'click', function(e){
                e = cm.getEvent(e);
                cm.preventDefault(e);
                if(that.active != tab['id']){
                    window.location.href = [window.location.href.split('#')[0], tab['id']].join('#');
                }
            });
        }else{
            cm.addEvent(item['a'], 'click', function(e){
                e = cm.getEvent(e);
                cm.preventDefault(e);
                set(tab['id']);
            });
        }
        return item;
    };

    var removeTab = function(item){
        // Set new active tab, if current active is nominated for remove
        if(item['id'] === that.active && that.tabsListing[0]){
            set(that.tabsListing[0]);
        }
        // Remove tab from list and array
        cm.remove(item['tab']['container']);
        cm.remove(item['menu']['container']);
        cm.remove(item['content']);
        that.tabsListing = that.tabsListing.filter(function(tab){
            return item['id'] != tab['id'];
        });
        delete that.tabs[item['id']];
    };

    var set = function(id){
        if(!that.isProcess && id != that.active){
            that.isProcess = true;
            // Hide Previous Tab
            if(that.active && that.tabs[that.active]){
                that.previous = that.active;
                that.tabs[that.active]['isHide'] = true;
                // Hide Start Event
                that.tabs[that.active]['onHideStart'](that, that.tabs[that.active]);
                that.triggerEvent('onTabHideStart', that.tabs[that.active]);
                // Hide
                cm.removeClass(that.tabs[that.active]['tab']['container'], 'active');
                cm.removeClass(that.tabs[that.active]['menu']['container'], 'active');
                cm.removeClass(that.tabs[that.active]['content'], 'active');
                // Hide End Event
                that.tabs[that.active]['onHide'](that, that.tabs[that.active]);
                that.triggerEvent('onTabHide', that.tabs[that.active]);
            }
            // Show New Tab
            that.active = id;
            that.tabs[that.active]['isHide'] = false;
            // Show Start Event
            that.tabs[that.active]['onShowStart'](that, that.tabs[that.active]);
            that.triggerEvent('onTabShowStart', that.tabs[that.active]);
            // Show
            that.tabs[that.active]['content'].style.display = 'block';
            cm.addClass(that.tabs[that.active]['tab']['container'], 'active');
            cm.addClass(that.tabs[that.active]['menu']['container'], 'active');
            cm.addClass(that.tabs[that.active]['content'], 'active', true);
            that.nodes['headerTitleText'].innerHTML = that.tabs[that.active]['title'];
            // Animate
            if(!that.params['switchManually']){
                if(that.previous && that.params['animateSwitch'] && !that.params['calculateMaxHeight']){
                    animateSwitch();
                }else{
                    if(that.params['calculateMaxHeight']){
                        calculateMaxHeight();
                    }
                    if(that.previous){
                        that.tabs[that.previous]['content'].style.display = 'none';
                    }
                    switchTab();
                }
            }
        }
    };

    var switchTab = function(){
        // Show End Event
        that.tabs[that.active]['onShow'](that, that.tabs[that.active]);
        that.triggerEvent('onTabShow', that.tabs[that.active]);
        that.isProcess = false;
        // Trigger custom event
        cm.customEvent.trigger(that.tabs[that.active]['content'], 'redraw', {
            'type' : 'child',
            'self' : false
        });
    };

    /* *** HELPERS *** */

    var animateSwitch = function(){
        var previousHeight = 0,
            currentHeight = 0;
        // Get height
        if(that.previous){
            previousHeight = cm.getRealHeight(that.tabs[that.previous]['content'], 'offsetRelative');
        }
        if(that.active){
            currentHeight = cm.getRealHeight(that.tabs[that.active]['content'], 'offsetRelative');
        }
        // Animate
        that.nodes['contentUL'].style.overflow = 'hidden';
        that.nodes['contentUL'].style.height = [previousHeight, 'px'].join('');
        that.anim['contentUL'].go({'style' : {'height' : [currentHeight, 'px'].join('')}, 'duration' : that.params['animateDuration'], 'anim' : 'smooth', 'onStop' : function(){
            if(that.previous){
                that.tabs[that.previous]['content'].style.display = 'none';
            }
            that.nodes['contentUL'].style.overflow = 'visible';
            that.nodes['contentUL'].style.height = 'auto';
            switchTab();
        }});
    };

    var initHashChange = function(){
        var hash;
        if("onhashchange" in window && !cm.is('IE7')){
            cm.addEvent(window, 'hashchange', hashHandler);
        }else{
            hash = window.location.hash;
            hashInterval = setInterval(function(){
                if(hash != window.location.hash){
                    hash = window.location.hash;
                    hashHandler();
                }
            }, 25);
        }
    };

    var hashHandler = function(){
        var id = window.location.hash.replace('#', '');
        if(id = getValidID(id)){
            set(id);
        }
    };

    var getValidID = function(id){
        if(cm.isEmpty(that.tabsListing) || cm.isEmpty(that.tabs)){
            return null;
        }
        return id && that.tabs[id]? id : that.tabsListing[0]['id'];
    };

    var calculateMaxHeight = function(){
        var height = 0;
        cm.forEach(that.tabs, function(item){
            height = Math.max(height, cm.getRealHeight(item['content'], 'offsetRelative'));
        });
        if(height != that.nodes['contentUL'].offsetHeight){
            that.nodes['contentUL'].style.height = [height, 'px'].join('');
        }
    };

    var resizeHandler = function(){
        // Recalculate slider height
        if(that.params['calculateMaxHeight']){
            calculateMaxHeight();
        }
    };
    
    /* ******* MAIN ******* */

    that.render = function(){
        render();
        return that;
    };

    that.set = function(id){
        if(id && that.tabs[id]){
            set(id);
        }
        return that;
    };

    that.get = function(id){
        if(id && that.tabs[id]){
            return that.tabs[id];
        }
        return null;
    };

    that.getTabs = function(){
        return that.tabs;
    };

    that.addTab = function(item){
        if(item && item['id']){
            renderTab(item);
        }
        return that;
    };

    that.removeTab = function(id){
        if(id && that.tabs[id]){
            removeTab(that.tabs[id]);
        }
        return that;
    };

    that.setEvents = function(o){
        if(o){
            that.tabs = cm.merge(that.tabs, o);
        }
        return that;
    };

    that.remove = function(){
        cm.removeEvent(window, 'hashchange', hashHandler);
        cm.removeEvent(window, 'resize', resizeHandler);
        hashInterval && clearInterval(hashInterval);
        resizeInterval && clearInterval(resizeInterval);
        cm.remove(that.nodes['container']);
        return that;
    };

    that.getNodes = function(key){
        return that.nodes[key] || that.nodes;
    };

    init();
});
cm.define('Com.TabsetHelper', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'DataNodes',
        'Stack'
    ],
    'events' : [
        'onRender',
        'onTabShowStart',
        'onTabShow',
        'onTabHideStart',
        'onTabHide',
        'onLabelClick'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'name' : '',
        'active' : null,
        'setFirstTabImmediately' : true
    }
},
function(params){
    var that = this;

    that.nodes = {
        'container': cm.Node('div'),
        'labels' : [],
        'tabs' : []
    };

    that.current = false;
    that.previous = false;
    that.tabs = {};

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);
        render();
        that.addToStack(that.params['node']);
        that.triggerEvent('onRender');
        // Set active tab
        if(that.params['active'] && that.tabs[that.params['active']]){
            set(that.params['active'], true);
        }
    };

    var render = function(){
        // Process tabs
        cm.forEach(that.nodes['tabs'], function(item){
            processTab(item);
        });
        cm.forEach(that.nodes['labels'], function(item){
            processLabel(item);
        });
    };

    var processTab = function(item, config){
        config = cm.merge(
            cm.merge({
                    'id' : ''
                }, that.getNodeDataConfig(item['container'])
            ),
            config
        );
        config['container'] = item['container'];
        renderTab(config);
    };

    var processLabel = function(item, config){
        config = cm.merge(
            cm.merge({
                    'id' : ''
                }, that.getNodeDataConfig(item['container'])
            ),
            config
        );
        config['container'] = item['container'];
        renderLabel(config);
    };

    var renderTab = function(item){
        var tab;
        item = cm.merge({
            'id' : '',
            'container' : cm.Node('li')
        }, item);

        if(!cm.isEmpty(item['id']) && !(tab = that.tabs[item['id']])){
            that.tabs[item['id']] = {
                'id' : item['id'],
                'tab' : item['container'],
                'config' : item
            };
        }
    };

    var renderLabel = function(item){
        var tab;
        item = cm.merge({
            'id' : '',
            'container' : cm.Node('li')
        }, item);

        if(!cm.isEmpty(item['id']) && (tab = that.tabs[item['id']])){
            tab['label'] = item['container'];
            tab['config'] = cm.merge(tab['config'], item);
            cm.addEvent(tab['label'], 'click', function(){
                that.triggerEvent('onLabelClick', tab);
                set(tab['id']);
            });
        }
    };

    var set = function(id, triggerEvents){
        if(that.current != id){
            // Hide previous tab
            unset(triggerEvents);
            // Show new tab
            that.current = id;
            triggerEvents && that.triggerEvent('onTabShowStart', that.tabs[that.current]);
            if(!that.previous && that.params['setFirstTabImmediately']){
                cm.addClass(that.tabs[that.current]['tab'], 'is-immediately');
                cm.addClass(that.tabs[that.current]['label'], 'is-immediately');
                setTimeout(function(){
                    cm.removeClass(that.tabs[that.current]['tab'], 'is-immediately');
                    cm.removeClass(that.tabs[that.current]['label'], 'is-immediately');
                }, 5);
            }
            cm.addClass(that.tabs[that.current]['tab'], 'active');
            cm.addClass(that.tabs[that.current]['label'], 'active');
            triggerEvents && that.triggerEvent('onTabShow', that.tabs[that.current]);
        }
    };

    var unset = function(triggerEvents){
        if(that.current && that.tabs[that.current]){
            that.previous = that.current;
            triggerEvents && that.triggerEvent('onTabHideStart', that.tabs[that.current]);
            cm.removeClass(that.tabs[that.current]['tab'], 'active');
            cm.removeClass(that.tabs[that.current]['label'], 'active');
            triggerEvents && that.triggerEvent('onTabHide', that.tabs[that.current]);
            that.current = null;
        }
    };

    /* ******* MAIN ******* */

    that.set = function(id, triggerEvents){
        triggerEvents = typeof triggerEvents != 'undefined'? triggerEvents : true;
        if(id && that.tabs[id]){
            set(id, triggerEvents);
        }
        return that;
    };

    that.unset = function(triggerEvents){
        triggerEvents = typeof triggerEvents != 'undefined'? triggerEvents : true;
        unset(triggerEvents);
        that.previous = null;
        return that;
    };

    that.get = function(){
        return that.current;
    };

    that.addTab = function(tab, label, config){
        cm.isNode(tab) && processTab(tab, config);
        cm.isNode(label) && processLabel(label, config);
        return that;
    };

    that.addTabs = function(tabs, lables){
        tabs = cm.isArray(tabs) ? tabs : [];
        lables = cm.isArray(lables) ? lables : [];
        cm.forEach(tabs, function(item){
            processTab(item);
        });
        cm.forEach(lables, function(item){
            processLabel(item);
        });
        return that;
    };

    that.getTab = function(id){
        if(id && that.tabs[id]){
            return that.tabs[id];
        }
        return null;
    };

    init();
});
cm.define('Com.TagsInput', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig',
        'Stack'
    ],
    'require' : [
        'Com.Autocomplete'
    ],
    'events' : [
        'onRender',
        'onAdd',
        'onRemove',
        'onChange',
        'onOpen',
        'onClose'
    ],
    'params' : {
        'container' : false,
        'input' : cm.Node('input', {'type' : 'text'}),
        'name' : '',
        'data' : [],
        'maxSingleTagLength': 255,
        'autocomplete' : {                              // All parameters what uses in Com.Autocomplete
            'clearOnEmpty' : false
        },
        'icons' : {
            'add' : 'icon default linked',
            'remove' : 'icon default linked'
        },
        'langs' : {
            'tags' : 'Tags',
            'add' : 'Add Tag',
            'remove' : 'Remove Tag'
        }
    }
},
function(params){
    var that = this,
        nodes = {},
        tags = [],
        items = {},
        isOpen = false;

    that.components = {};
    that.isAutocomplete = false;

    var init = function(){
        var sourceTags;
        preValidateParams();
        // Init modules
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['input']);
        // Render
        render();
        setLogic();
        that.addToStack(nodes['container']);
        that.triggerEvent('onRender');
        // Set tags
        sourceTags = that.params['data'].concat(
            that.params['input'].value.split(',')
        );
        cm.forEach(sourceTags, function(tag){
            addTag(tag);
        });
    };

    var preValidateParams = function(){
        // Check for autocomplete
        that.isAutocomplete = !(!cm.isEmpty(params['autocomplete']) && !that.getNodeDataConfig(that.params['input'])['autocomplete']);
    };

    var render = function(){
        /* *** STRUCTURE *** */
        nodes['container'] = cm.Node('div', {'class' : 'com__tags-input'},
            nodes['hidden'] = cm.Node('input', {'type' : 'hidden'}),
            nodes['inner'] = cm.Node('div', {'class' : 'inner'})
        );
        // Render add button
        renderAddButton();
        /* *** ATTRIBUTES *** */
        // Set hidden input attributes
        if(that.params['input'].getAttribute('name')){
            nodes['hidden'].setAttribute('name', that.params['input'].getAttribute('name'));
        }
        /* *** INSERT INTO DOM *** */
        if(that.params['container']){
            that.params['container'].appendChild(nodes['container']);
        }else if(that.params['input'].parentNode){
            cm.insertBefore(nodes['container'], that.params['input']);
        }
        cm.remove(that.params['input']);

    };

    var setLogic = function(){
        // Autocomplete
        cm.getConstructor('Com.Autocomplete', function(classConstructor){
            that.components['autocomplete'] = new classConstructor(
                cm.merge(that.params['autocomplete'], {
                    'events' : {
                        'onClickSelect' : function(){
                            addAdderTags(true);
                        }
                    }
                })
            );
        });
    };

    var renderAddButton = function(){
        nodes['inner'].appendChild(
            nodes['addButtonContainer'] = cm.Node('div', {'class' : 'item'},
                nodes['addButton'] = cm.Node('div', {'class' : that.params['icons']['add'], 'title' : that.lang('add')})
            )
        );
        // Add event on "Add Tag" button
        cm.addEvent(nodes['addButton'], 'click', openAdder);
    };

    var openAdder = function(){
        var item = {};
        if(!isOpen){
            isOpen = true;
            // Structure
            item['container'] = cm.Node('div', {'class' : 'item adder'},
                item['input'] = cm.Node('input', {'type' : 'text', 'maxlength' : that.params['maxSingleTagLength'], 'class' : 'input'})
            );
            cm.insertBefore(item['container'], nodes['addButtonContainer']);
            // Show
            item['anim'] = new cm.Animation(item['container']);
            item['anim'].go({'style' : {'width' : [cm.getRealWidth(item['container']), 'px'].join(''), 'opacity' : 1}, 'duration' : 200, 'anim' : 'smooth', 'onStop' : function(){
                item['container'].style.overflow = 'visible';
                item['input'].focus();
                // API onOpen Event
                that.triggerEvent('onOpen');
            }});
            // Bind autocomplete
            if(that.isAutocomplete){
                that.components['autocomplete'].setTarget(item['input']);
                that.components['autocomplete'].setInput(item['input']);
            }
            // Set new tag on enter or on comma
            cm.addEvent(item['input'], 'keypress', function(e){
                e = cm.getEvent(e);
                if(e.keyCode == 13 || e.charCode == 44){
                    cm.preventDefault(e);
                    addAdderTags(true);
                    that.isAutocomplete && that.components['autocomplete'].hide();
                }
                if(e.keyCode == 27){
                    cm.preventDefault(e);
                    addAdderTags(true);
                    closeAdder(nodes['adder']);
                }
            });
            // Hide adder on document click
            cm.addEvent(document, 'mousedown', bodyEvent);
            // Add to nodes array
            nodes['adder'] = item;
        }else{
            addAdderTags(true);
        }
    };

    var closeAdder = function(item){
        cm.removeEvent(document, 'mousedown', bodyEvent);
        nodes['adder']['input'].blur();
        that.isAutocomplete && that.components['autocomplete'].hide();
        item['container'].style.overflow = 'hidden';
        item['anim'].go({'style' : {'width' : '0px', 'opacity' : 0}, 'duration' : 200, 'anim' : 'smooth', 'onStop' : function(){
            cm.remove(item['container']);
            nodes['adder'] = null;
            isOpen = false;
            // API onClose Event
            that.triggerEvent('onClose');
        }});
    };

    var addAdderTags = function(execute){
        var sourceTags = nodes['adder']['input'].value.split(',');
        cm.forEach(sourceTags, function(tag){
            addTag(tag, execute);
        });
        nodes['adder']['input'].value = '';
        nodes['adder']['input'].focus();
        that.isAutocomplete && that.components['autocomplete'].clear();
    };

    var addTag = function(tag, execute){
        tag = tag.trim();
        if(tag && tag.length && !/^[\s]*$/.test(tag) && !cm.inArray(tags, tag)){
            tags.push(tag);
            renderTag(tag);
            setHiddenInputData();
            // Execute events
            if(execute){
                // API onChange Event
                that.triggerEvent('onChange', {'tag' : tag});
                // API onAdd Event
                that.triggerEvent('onAdd', {'tag' : tag});
            }
        }
    };

    var renderTag = function(tag){
        var item = {
            'tag' : tag
        };
        // Structure
        item['container'] = cm.Node('div', {'class' : 'item'},
            cm.Node('div', {'class' : 'text', 'title' : tag}, tag),
            item['button'] = cm.Node('div', {'class' : that.params['icons']['remove'], 'title' : that.lang('remove')})
        );
        item['anim'] = new cm.Animation(item['container']);
        // Append
        if(isOpen){
            cm.addClass(item['container'], 'closed');
            cm.insertBefore(item['container'], nodes['adder']['container']);
            // Show
            item['anim'].go({'style' : {'width' : [cm.getRealWidth(item['container']), 'px'].join(''), 'opacity' : 1}, 'duration' : 200, 'anim' : 'smooth', 'onStop' : function(){
                cm.removeClass(item['container'], 'closed');
            }});
        }else{
            cm.insertBefore(item['container'], nodes['addButtonContainer']);
        }
        // Add click event on "Remove Tag" button
        cm.addEvent(item['button'], 'click', function(){
            if(isOpen){
                nodes['adder']['input'].focus();
            }
            removeTag(item);
        });
        // Push to global array
        items[tag] = item;
    };

    var removeTag = function(item){
        // Remove tag from data
        tags = tags.filter(function(tag){
            return item['tag'] != tag;
        });
        delete items[item['tag']];
        setHiddenInputData();
        // API onChange Event
        that.triggerEvent('onChange', {
            'tag' : item['tag']
        });
        // API onRemove Event
        that.triggerEvent('onRemove', {
            'tag' : item['tag']
        });
        // Animate
        item['anim'].go({'style' : {'width' : '0px', 'opacity' : 0}, 'duration' : 200, 'anim' : 'smooth', 'onStop' : function(){
            cm.remove(item['container']);
            item = null;
        }});
    };

    var setHiddenInputData = function(){
        nodes['hidden'].value = tags.join(',');
    };

    var bodyEvent = function(e){
        if(isOpen){
            e = cm.getEvent(e);
            var target = cm.getEventTarget(e);
            if(!cm.isParent(nodes['container'], target, true) && !that.components['autocomplete'].isOwnNode(target)){
                addAdderTags(true);
                closeAdder(nodes['adder']);
            }
        }
    };

    /* ******* MAIN ******* */

    that.add = function(tag /* or tags comma separated or array */){
        var sourceTags;
        if(!tag){
            sourceTags = [];
        }else if(cm.isArray(tag)){
            sourceTags = tag;
        }else{
            sourceTags = tag.split(',');
        }
        cm.forEach(sourceTags, function(tag){
            addTag(tag, true);
        });
        return that;
    };

    that.remove = function(tag){
        var sourceTags;
        if(!tag){
            sourceTags = [];
        }else if(cm.isArray(tag)){
            sourceTags = tag;
        }else{
            sourceTags = tag.split(',');
        }
        cm.forEach(sourceTags, function(tag){
            if(cm.inArray(tags, tag)){
                removeTag(items[tag]);
            }
        });
        return that;
    };

    init();
});
cm.define('Com.TimeSelect', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig'
    ],
    'events' : [
        'onRender',
        'onSelect',
        'onChange',
        'onClear'
    ],
    'params' : {
        'container' : false,
        'input' : cm.Node('input', {'type' : 'text'}),
        'renderSelectsInBody' : true,
        'format' : 'cm._config.timeFormat',
        'showTitleTag' : true,
        'title' : false,
        'withHours' : true,
        'hoursInterval' : 0,
        'withMinutes' : true,
        'minutesInterval' : 0,
        'withSeconds' : false,
        'secondsInterval' : 0,
        'selected' : 0,
        'langs' : {
            'separator' : ':',
            'Hours' : 'HH',
            'Minutes' : 'MM',
            'Seconds' : 'SS',
            'HoursTitle' : 'Hours',
            'MinutesTitle' : 'Minutes',
            'SecondsTitle' : 'Seconds'
        }
    }
},
function(params){
    var that = this,
        nodes = {},
        components = {};

    that.date = new Date();
    that.value = 0;
    that.previousValue = 0;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['input']);
        validateParams();
        render();
        setMiscEvents();
        // Set selected time
        if(that.params['selected']){
            that.set(that.params['selected'], that.params['format'], false);
        }else{
            that.set(that.params['input'].value, that.params['format'], false);
        }
    };

    var validateParams = function(){
        if(cm.isNode(that.params['input'])){
            that.params['title'] = that.params['input'].getAttribute('title') || that.params['title'];
        }
        if(cm.isEmpty(that.params['hoursInterval'])){
            that.params['hoursInterval'] = 1;
        }
        if(cm.isEmpty(that.params['minutesInterval'])){
            that.params['minutesInterval'] = 1;
        }
        if(cm.isEmpty(that.params['secondsInterval'])){
            that.params['secondsInterval'] = 1;
        }
    };

    var render = function(){
        var hours = 0,
            minutes = 0,
            seconds = 0;
        /* *** STRUCTURE *** */
        nodes['container'] = cm.Node('div', {'class' : 'com__timeselect'},
            nodes['hidden'] = cm.Node('input', {'type' : 'hidden'}),
            nodes['inner'] = cm.Node('div', {'class' : 'inner'})
        );
        /* *** ITEMS *** */
        // Hours
        if(that.params['withHours']){
            if(nodes['inner'].childNodes.length){
                nodes['inner'].appendChild(cm.Node('div', {'class' : 'sep'}, that.lang('separator')));
            }
            nodes['inner'].appendChild(cm.Node('div', {'class' : 'field'},
                nodes['selectHours'] = cm.Node('select', {'placeholder' : that.lang('Hours'), 'title' : that.lang('HoursTitle')})
            ));
            while(hours < 24){
                nodes['selectHours'].appendChild(
                    cm.Node('option', {'value' : hours},cm.addLeadZero(hours))
                );
                hours += that.params['hoursInterval'];
            }
        }
        // Minutes
        if(that.params['withMinutes']){
            if(nodes['inner'].childNodes.length){
                nodes['inner'].appendChild(cm.Node('div', {'class' : 'sep'}, that.lang('separator')));
            }
            nodes['inner'].appendChild(cm.Node('div', {'class' : 'field'},
                nodes['selectMinutes'] = cm.Node('select', {'placeholder' : that.lang('Minutes'), 'title' : that.lang('MinutesTitle')})
            ));
            while(minutes < 60){
                nodes['selectMinutes'].appendChild(
                    cm.Node('option', {'value' : minutes}, cm.addLeadZero(minutes))
                );
                minutes += that.params['minutesInterval'];
            }
        }
        // Seconds
        if(that.params['withSeconds']){
            if(nodes['inner'].childNodes.length){
                nodes['inner'].appendChild(cm.Node('div', {'class' : 'sep'}, that.lang('separator')));
            }
            nodes['inner'].appendChild(cm.Node('div', {'class' : 'field'},
                nodes['selectSeconds'] = cm.Node('select', {'placeholder' : that.lang('Seconds'), 'title' : that.lang('SecondsTitle')})
            ));
            while(seconds < 60){
                nodes['selectSeconds'].appendChild(
                    cm.Node('option', {'value' : seconds},cm.addLeadZero(seconds))
                );
                seconds += that.params['secondsInterval'];
            }
        }
        /* *** ATTRIBUTES *** */
        // Title
        if(that.params['showTitleTag'] && that.params['title']){
            nodes['container'].title = that.params['title'];
        }
        // Set hidden input attributes
        if(that.params['input'].getAttribute('name')){
            nodes['hidden'].setAttribute('name', that.params['input'].getAttribute('name'));
        }
        /* *** INSERT INTO DOM *** */
        if(that.params['container']){
            that.params['container'].appendChild(nodes['container']);
        }else if(that.params['input'].parentNode){
            cm.insertBefore(nodes['container'], that.params['input']);
        }
        cm.remove(that.params['input']);
    };

    var setMiscEvents = function(){
        // Hours select
        if(that.params['withHours']){
            components['selectHours'] = new Com.Select({
                    'select' : nodes['selectHours'],
                    'renderInBody' : that.params['renderSelectsInBody']
                }).addEvent('onChange', function(){
                    set(true);
                });
        }
        // Minutes select
        if(that.params['withMinutes']){
            components['selectMinutes'] = new Com.Select({
                    'select' : nodes['selectMinutes'],
                    'renderInBody' : that.params['renderSelectsInBody']
                }).addEvent('onChange', function(){
                    set(true);
                });
        }
        // Seconds select
        if(that.params['withSeconds']){
            components['selectSeconds'] = new Com.Select({
                    'select' : nodes['selectSeconds'],
                    'renderInBody' : that.params['renderSelectsInBody']
                })
                .addEvent('onChange', function(){
                    set(true);
                });
        }
        // Trigger onRender Event
        that.triggerEvent('onRender');
    };

    var set = function(triggerEvents){
        that.previousValue = that.value;
        that.params['withHours'] && that.date.setHours(components['selectHours'].get());
        that.params['withMinutes'] && that.date.setMinutes(components['selectMinutes'].get());
        that.params['withSeconds'] && that.date.setSeconds(components['selectSeconds'].get());
        that.value = cm.dateFormat(that.date, that.params['format']);
        nodes['hidden'].value = that.value;
        // Trigger events
        if(triggerEvents){
            that.triggerEvent('onSelect', that.value);
            onChange();
        }
    };

    var onChange = function(){
        if(!that.previousValue || (!that.value && that.previousValue) || (that.value != that.previousValue)){
            that.triggerEvent('onChange', that.value);
        }
    };

    /* ******* MAIN ******* */

    that.set = function(str, format, triggerEvents){
        format = typeof format != 'undefined'? format : that.params['format'];
        triggerEvents = typeof triggerEvents != 'undefined'? triggerEvents : true;
        // Get time
        if(cm.isEmpty(str) || typeof str == 'string' && new RegExp(cm.dateFormat(false, that.params['format'])).test(str)){
            that.clear();
            return that;
        }else if(typeof str == 'object'){
            that.date = str;
        }else{
            that.date = cm.parseDate(str, format);
        }
        // Set components
        that.params['withHours'] && components['selectHours'].set(that.date.getHours(), false);
        that.params['withMinutes'] && components['selectMinutes'].set(that.date.getMinutes(), false);
        that.params['withSeconds'] && components['selectSeconds'].set(that.date.getSeconds(), false);
        // Set time
        set(triggerEvents);
        return that;
    };

    that.get = function(){
        return that.value;
    };

    that.getDate = function(){
        return that.date;
    };

    that.getHours = function(){
        return that.date.getHours();
    };

    that.getMinutes = function(){
        return that.date.getMinutes();
    };

    that.getSeconds = function(){
        return that.date.getSeconds();
    };

    that.clear = function(triggerEvents){
        triggerEvents = typeof triggerEvents != 'undefined'? triggerEvents : true;
        // Clear time
        that.date.setHours(0);
        that.date.setMinutes(0);
        that.date.setSeconds(0);
        // Clear components
        that.params['withHours'] && components['selectHours'].set(that.date.getHours(), false);
        that.params['withMinutes'] && components['selectMinutes'].set(that.date.getMinutes(), false);
        that.params['withSeconds'] && components['selectSeconds'].set(that.date.getSeconds(), false);
        // Set time
        set(false);
        // Trigger events
        if(triggerEvents){
            that.triggerEvent('onClear', that.value);
            onChange();
        }
        return that;
    };

    init();
});
cm.define('Com.Timer', {
    'modules' : [
        'Params',
        'Events'
    ],
    'events' : [
        'onRender',
        'onStart',
        'onTick',
        'onEnd'
    ],
    'params' : {
        'count' : 0                 // ms
    }
},
function(params){
    var that = this;

    that.left = 0;
    that.pass = 0;

    that.isProcess = false;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        render();
        that.triggerEvent('onRender');
    };

    var render = function(){
        that.left = that.params['count'];
        that.start();
    };

    var getLeftTime = function(){
        var o = {};
        o['d_total'] = Math.floor(that.left / 1000 / 60 / 60 / 24);
        o['h_total'] = Math.floor(that.left / 1000 / 60 / 60);
        o['m_total'] = Math.floor(that.left / 1000 / 60);
        o['s_total'] = Math.floor(that.left / 1000);
        o['d'] = Math.floor(o['d_total']);
        o['h'] = Math.floor(o['h_total'] - (o['d'] * 24));
        o['m'] = Math.floor(o['m_total'] - (o['d'] * 24 * 60) - (o['h'] * 60));
        o['s'] = Math.floor(o['s_total'] - (o['d'] * 24 * 60 * 60) - (o['h'] * 60 * 60) - (o['m'] * 60));
        return o;
    };

    /* ******* PUBLIC ******* */

    that.start = function(){
        var o = getLeftTime(),
            left = that.left,
            startTime = Date.now(),
            currentTime;
        that.isProcess = true;
        that.triggerEvent('onStart', o);
        // Process
        (function process(){
            if(that.isProcess){
                currentTime = Date.now();
                that.left = Math.max(left - (currentTime - startTime), 0);
                that.pass = that.params['count'] - that.left;
                o = getLeftTime();
                that.triggerEvent('onTick', o);
                if(that.left == 0){
                    that.stop();
                    that.triggerEvent('onEnd', o);
                }else{
                    animFrame(process);
                }
            }
        })();
        return that;
    };

    that.stop = function(){
        that.isProcess = false;
        return that;
    };

    init();
});
cm.define('Com.ToggleBox', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'Structure',
        'DataConfig',
        'DataNodes',
        'Storage',
        'Stack'
    ],
    'events' : [
        'onRender',
        'onShowStart',
        'onShow',
        'onHideStart',
        'onHide'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'duration' : 500,
        'remember' : false,                                 // Remember toggle state
        'toggleTitle' : false,                              // Change title on toggle
        'renderStructure' : false,
        'container' : false,
        'title' : false,
        'content' : false,
        'className' : 'has-title-bg is-base is-hide',
        'eventNode' : 'title',                              // button | title
        'langs' : {
            'show' : 'Show',
            'hide' : 'Hide'
        }
    }
},
function(params){
    var that = this;

    that.nodes = {
        'container' : cm.node('div'),
        'button': cm.Node('div'),
        'target': cm.Node('div'),
        'title': cm.Node('div')
    };
    that.animations = {};

    that.isCollapsed = false;
    that.isProcess = false;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);
        validateParams();
        render();
        that.addToStack(that.nodes['container']);
        that.triggerEvent('onRender');
    };

    var validateParams = function(){
        if(that.params['renderStructure']){
            if(!that.params['title']){
                that.params['title'] = '';
                that.params['toggleTitle'] = true;
            }
        }
    };

    var render = function(){
        // Render Structure
        if(that.params['renderStructure']){
            that.nodes['container'] = cm.Node('dl', {'class' : 'com__togglebox'},
                that.nodes['titleContainer'] = cm.Node('dt',
                    that.nodes['button'] = cm.Node('span', {'class' : 'icon default linked'}),
                    that.nodes['title'] = cm.Node('span', {'class' : 'title'}, that.params['title'])
                ),
                that.nodes['target'] = cm.Node('dd',
                    that.nodes['content'] = cm.Node('div', {'class' : 'inner'})
                )
            );
            cm.addClass(that.nodes['container'], that.params['className']);
            // Embed
            that.appendStructure(that.nodes['container']);
            // Embed content
            if(that.params['content']){
                that.nodes['content'].appendChild(that.params['content']);
            }else{
                that.nodes['content'].appendChild(that.params['node']);
            }
            // Set events
            if(that.params['eventNode'] == 'button'){
                cm.addClass(that.nodes['container'], 'has-hover-icon');
                cm.addEvent(that.nodes['button'], 'click', that.toggle);
            }else{
                cm.addEvent(that.nodes['titleContainer'], 'click', that.toggle);
            }
        }else{
            cm.addEvent(that.nodes['button'], 'click', that.toggle);
        }
        // Animation
        that.animations['target'] = new cm.Animation(that.nodes['target']);
        // Check toggle class
        that.isCollapsed = cm.isClass(that.nodes['container'], 'is-hide') || !cm.isClass(that.nodes['container'], 'is-show');
        // Check storage
        if(that.params['remember']){
            that.isCollapsed = that.storageRead('isCollapsed');
        }
        // Trigger collapse event
        if(that.isCollapsed){
            that.collapse(true);
        }else{
            that.expand(true);
        }
    };

    var expandEnd = function(){
        that.isProcess = false;
        that.nodes['target'].style.opacity = 1;
        that.nodes['target'].style.height = 'auto';
        that.nodes['target'].style.overflow = 'visible';
        that.triggerEvent('onShow');
    };

    var collapseEnd = function(){
        that.isProcess = false;
        that.nodes['target'].style.opacity = 0;
        that.nodes['target'].style.height = 0;
        that.triggerEvent('onHide');
    };

    /* ******* MAIN ******* */

    that.toggle = function(){
        if(that.isCollapsed){
            that.expand();
        }else{
            that.collapse();
        }
    };

    that.expand = function(isImmediately){
        if(isImmediately || that.isCollapsed){
            that.isCollapsed = false;
            that.isProcess = 'show';
            that.triggerEvent('onShowStart');
            // Write storage
            if(that.params['remember']){
                that.storageWrite('isCollapsed', false);
            }
            cm.replaceClass(that.nodes['container'], 'is-hide', 'is-show');
            // Set title
            if(that.params['toggleTitle']){
                that.nodes['title'].innerHTML = that.lang('hide');
            }
            // Animate
            if(isImmediately){
                expandEnd();
            }else{
                that.nodes['target'].style.overflow = 'hidden';
                if(!that.nodes['target'].style.opacity){
                    that.nodes['target'].style.opacity = 0;
                }
                that.animations['target'].go({
                    'style' : {
                        'height' : [cm.getRealHeight(that.nodes['target'], 'offset', 'current'), 'px'].join(''),
                        'opacity' : 1
                    },
                    'anim' : 'smooth',
                    'duration' : that.params['duration'],
                    'onStop' : expandEnd
                });
            }
        }
    };

    that.collapse = function(isImmediately){
        if(isImmediately || !that.isHide){
            that.isCollapsed = true;
            that.isProcess = 'hide';
            that.triggerEvent('onHideStart');
            // Write storage
            if(that.params['remember']){
                that.storageWrite('isCollapsed', true);
            }
            cm.replaceClass(that.nodes['container'], 'is-show', 'is-hide');
            // Set title
            if(that.params['toggleTitle']){
                that.nodes['title'].innerHTML = that.lang('show');
            }
            // Animate
            that.nodes['target'].style.overflow = 'hidden';
            if(!that.nodes['target'].style.opacity){
                that.nodes['target'].style.opacity = 1;
            }
            if(isImmediately){
                collapseEnd();
            }else{
                that.animations['target'].go({
                    'style' : {
                        'height' : '0px',
                        'opacity' : 0
                    },
                    'anim' : 'smooth',
                    'duration' : that.params['duration'],
                    'onStop' : collapseEnd
                });
            }
        }
    };

    init();
});
cm.define('Com.Tooltip', {
    'modules' : [
        'Params',
        'Events',
        'Langs'
    ],
    'events' : [
        'onRender',
        'onShowStart',
        'onShow',
        'onHideStart',
        'onHide'
    ],
    'params' : {
        'target' : cm.Node('div'),
        'targetEvent' : 'hover',                        // hover | click | none
        'hideOnReClick' : false,                        // Hide tooltip when re-clicking on the target, requires setting value 'targetEvent' : 'click'
        'hideOnOut' : true,
        'preventClickEvent' : false,                    // Prevent default click event on the target, requires setting value 'targetEvent' : 'click'
        'top' : 0,                                      // Supported properties: targetHeight, selfHeight, number
        'left' : 0,                                     // Supported properties: targetWidth, selfWidth, number
        'width' : 'auto',                               // Supported properties: targetWidth, auto, number
        'duration' : 'cm._config.animDurationQuick',
        'position' : 'absolute',
        'className' : '',
        'theme' : 'theme-default',
        'adaptive' : true,
        'adaptiveX' : true,
        'adaptiveY' : true,
        'title' : '',
        'titleTag' : 'h3',
        'content' : cm.Node('div'),
        'container' : 'document.body'
    }
},
function(params){
    var that = this,
        anim;
    
    that.nodes = {};
    that.isShow = false;
    that.disabled = false;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        validateParams();
        render();
        setMiscEvents();
        that.triggerEvent('onRender');
    };

    var validateParams = function(){
        if(!that.params['adaptive']){
            that.params['adaptiveX'] = false;
            that.params['adaptiveY'] = false;
        }
        that.params['position'] = cm.inArray(['absolute', 'fixed'], that.params['position'])? that.params['position'] : 'absolute';
    };

    var render = function(){
        // Structure
        that.nodes['container'] = cm.Node('div', {'class' : 'com__tooltip'},
            that.nodes['inner'] = cm.Node('div', {'class' : 'inner'},
                that.nodes['content'] = cm.Node('div', {'class' : 'scroll'})
            )
        );
        // Add position style
        that.nodes['container'].style.position = that.params['position'];
        // Add theme css class
        !cm.isEmpty(that.params['theme']) && cm.addClass(that.nodes['container'], that.params['theme']);
        // Add css class
        !cm.isEmpty(that.params['className']) && cm.addClass(that.nodes['container'], that.params['className']);
        // Set title
        renderTitle(that.params['title']);
        // Embed content
        renderContent(that.params['content']);
    };

    var renderTitle = function(title){
        cm.remove(that.nodes['title']);
        if(!cm.isEmpty(title)){
            that.nodes['title'] = cm.Node('div', {'class' : 'title'},
                cm.Node(that.params['titleTag'], title)
            );
            cm.insertFirst(that.nodes['title'], that.nodes['inner']);
        }
    };

    var renderContent = function(node){
        cm.clearNode(that.nodes['content']);
        if(node){
            that.nodes['content'].appendChild(node);
        }
    };

    var setMiscEvents = function(){
        // Init animation
        anim = new cm.Animation(that.nodes['container']);
        // Add target event
        if(that.params['preventClickEvent']){
            that.params['target'].onclick = function(e){
                cm.preventDefault(e);
            };
        }
        setTargetEvent();
        // Check position
        animFrame(getPosition);
    };

    var targetEvent = function(){
        if(!that.disabled){
            if(that.isShow && that.params['targetEvent'] == 'click' && that.params['hideOnReClick']){
                hide(false);
            }else{
                show();
            }
        }
    };

    var setTargetEvent = function(){
        switch(that.params['targetEvent']){
            case 'hover' :
                cm.addEvent(that.params['target'], 'mouseover', targetEvent, true);
                break;
            case 'click' :
                cm.addEvent(that.params['target'], 'click', targetEvent, true);
                break;
        }
    };

    var removeTargetEvent = function(){
        switch(that.params['targetEvent']){
            case 'hover' :
                cm.removeEvent(that.params['target'], 'mouseover', targetEvent);
                break;
            case 'click' :
                cm.removeEvent(that.params['target'], 'click', targetEvent);
                break;
        }
    };

    var show = function(immediately){
        if(!that.isShow){
            that.isShow = true;
            // Append child tooltip into body and set position
            that.params['container'].appendChild(that.nodes['container']);
            // Show tooltip
            that.nodes['container'].style.display = 'block';
            // Animate
            anim.go({'style' : {'opacity' : 1}, 'duration' : immediately? 0 : that.params['duration'], 'onStop' : function(){
                that.triggerEvent('onShow');
            }});
            // Add document target event
            if(that.params['hideOnOut']){
                switch(that.params['targetEvent']){
                    case 'hover' :
                        cm.addEvent(document, 'mouseover', bodyEvent);
                        break;
                    case 'click' :
                    default :
                        cm.addEvent(document, 'mousedown', bodyEvent);
                        break;
                }
            }
            that.triggerEvent('onShowStart');
        }
    };

    var hide = function(immediately){
        if(that.isShow){
            that.isShow = false;
            // Remove document target event
            if(that.params['hideOnOut']){
                switch(that.params['targetEvent']){
                    case 'hover' :
                        cm.removeEvent(document, 'mouseover', bodyEvent);
                        break;
                    case 'click' :
                    default :
                        cm.removeEvent(document, 'mousedown', bodyEvent);
                        break;
                }
            }
            // Animate
            anim.go({'style' : {'opacity' : 0}, 'duration' : immediately? 0 : that.params['duration'], 'onStop' : function(){
                that.nodes['container'].style.display = 'none';
                cm.remove(that.nodes['container']);
                that.triggerEvent('onHide');
            }});
            that.triggerEvent('onHideStart');
        }
    };

    var getPosition = function(){
        if(that.isShow){
            var targetWidth =  that.params['target'].offsetWidth,
                targetHeight = that.params['target'].offsetHeight,
                selfHeight = that.nodes['container'].offsetHeight,
                selfWidth = that.nodes['container'].offsetWidth,
                pageSize = cm.getPageSize(),
                scrollTop = cm.getScrollTop(window),
                scrollLeft = cm.getScrollLeft(window);
            // Calculate size
            (function(){
                if(that.params['width'] != 'auto'){
                    var width = eval(
                        that.params['width']
                            .toString()
                            .replace('targetWidth', targetWidth)
                    );
                    if(width != selfWidth){
                        that.nodes['container'].style.width =  [width, 'px'].join('');
                    }
                }
            })();
            // Calculate position
            (function(){
                var top = cm.getRealY(that.params['target']),
                    topAdd = eval(
                        that.params['top']
                            .toString()
                            .replace('targetHeight', targetHeight)
                            .replace('selfHeight', selfHeight)
                    ),
                    left =  cm.getRealX(that.params['target']),
                    leftAdd = eval(
                        that.params['left']
                            .toString()
                            .replace('targetWidth', targetWidth)
                            .replace('selfWidth', selfWidth)
                    ),
                    positionTop,
                    positionLeft;
                // Calculate adaptive or static vertical position
                if(that.params['adaptiveY']){
                    positionTop = Math.max(
                        Math.min(
                            ((top + topAdd + selfHeight > pageSize['winHeight'])
                                    ? (top - topAdd - selfHeight + targetHeight)
                                    : (top + topAdd)
                            ),
                            (pageSize['winHeight'] - selfHeight)
                        ),
                        0
                    );
                }else{
                    positionTop = top + topAdd;
                }
                // Calculate adaptive or static horizontal position
                if(that.params['adaptiveX']){
                    positionLeft = Math.max(
                        Math.min(
                            ((left + leftAdd + selfWidth > pageSize['winWidth'])
                                    ? (left - leftAdd - selfWidth + targetWidth)
                                    : (left + leftAdd)
                            ),
                            (pageSize['winWidth'] - selfWidth)
                        ),
                        0
                    );
                }else{
                    positionLeft = left + leftAdd;
                }
                // Fix scroll position for absolute
                if(that.params['position'] == 'absolute'){
                    if(that.params['container'] == document.body){
                        positionTop += scrollTop;
                        positionLeft += scrollLeft;
                    }else{
                        positionTop -= cm.getRealY(that.params['container']);
                        positionLeft -= cm.getRealX(that.params['container']);
                    }
                }
                // Apply styles
                if(positionTop != that.nodes['container'].offsetTop){
                    that.nodes['container'].style.top =  [positionTop, 'px'].join('');
                }
                if(positionLeft != that.nodes['container'].offsetLeft){
                    that.nodes['container'].style.left = [positionLeft, 'px'].join('');
                }
            })();
        }
        animFrame(getPosition);
    };

    var bodyEvent = function(e){
        if(that.isShow){
            e = cm.getEvent(e);
            var target = cm.getEventTarget(e);
            if(!cm.isParent(that.nodes['container'], target, true) && !cm.isParent(that.params['target'], target, true)){
                hide(false);
            }
        }
    };

    /* ******* MAIN ******* */

    that.setTitle = function(title){
        renderTitle(title);
        return that;
    };

    that.setContent = function(node){
        renderContent(node);
        return that;
    };

    that.setTarget = function(node){
        removeTargetEvent();
        that.params['target'] = node || cm.Node('div');
        setTargetEvent();
        return that;
    };

    that.show = function(immediately){
        show(immediately);
        return that;
    };

    that.hide = function(immediately){
        hide(immediately);
        return that;
    };

    that.disable = function(){
        that.disabled = true;
        return that;
    };

    that.enable = function(){
        that.disabled = false;
        return that;
    };

    that.scrollToNode = function(node){
        if(cm.isNode(node) && cm.isParent(that.nodes['content'], node)){
            that.nodes['content'].scrollTop = node.offsetTop - that.nodes['content'].offsetTop;
        }
        return that;
    };

    that.isOwnNode = function(node){
        return cm.isParent(that.nodes['container'], node, true);
    };

    that.remove = function(){
        hide(true);
        removeTargetEvent();
        return that;
    };

    // Deprecated
    that.getNodes = function(key){
        return that.nodes[key] || that.nodes;
    };

    init();
});
Com['UA'] = {
    'hash' : {'ie':'MSIE','opera':'Opera','ff':'Firefox','firefox':'Firefox','webkit':'AppleWebKit','safari':'Safari','chrome':'Chrome','steam':'Steam'},
    'fullname' : {'MSIE':'Microsoft Internet Explorer','Firefox':'Mozilla Firefox','Chrome':'Google Chrome','Safari':'Apple Safari','Opera':'Opera','Opera Mini':'Opera Mini','Opera Mobile':'Opera Mobile','IE Mobile':'Internet Explorer Mobile','Steam':'Valve Steam GameOverlay'},
    'os' : {
        'Windows':{'NT 5.0':'2000','NT 5.1':'XP','NT 5.2':'Server 2003','NT 6.0':'Vista','NT 6.1':'7','NT 6.2':'8','NT 6.3':'8.1','NT 10.0':'10'},
        'Mac OS':{'X 10.0':'Cheetah','X 10.1':'Puma','X 10.2':'Jaguar','X 10.3':'Panther','X 10.4':'Tiger','X 10.5':'Leopard','X 10.6':'Snow Leopard','X 10.7':'Lion','X 10.8':'Mountain Lion','X 10.9':'Mavericks','X 10.10':'Yosemite'}
    },
    'str' : navigator.userAgent,
    'get' : function(str){
        var that = this,
            str = (str)? str : that.str,
            arr = {};
        // Check browser
        if(str.indexOf('IEMobile') > -1){
            arr['browser'] = 'IE Mobile';
            arr['hash'] = 'ie-mobile';
            arr['engine'] = 'Trident';
            arr['type'] = 'mobile';
            arr['full_version'] = str.replace(/^(?:.+)(?:IEMobile)(?:[\s\/]{0,})([0-9\.]{1,})(?:.+)$/, '$1');
            var sp = arr['full_version'].toString().split('.');
            arr['version'] = sp[0]+((sp[1])? '.'+sp[1].slice(0, 1) : '');
            arr['short_version'] = sp[0];
        }else if(str.indexOf('MSIE') > -1 || str.indexOf('Trident') > -1){
            arr['browser'] = 'MSIE';
            arr['hash'] = 'ie';
            arr['engine'] = 'Trident';
            if(str.indexOf('MSIE') > -1){
                arr['full_version'] = str.replace(/^(?:.+)(?:MSIE)(?:[\s\/]{0,})([0-9\.]{1,})(?:.+)$/, '$1');
            }else{
                arr['full_version'] = str.replace(/^(?:.+)(?:rv:)(?:[\s\/]{0,})([0-9\.]{1,})(?:.+)$/, '$1');
            }
            var sp = arr['full_version'].toString().split('.');
            arr['version'] = sp[0]+((sp[1])? '.'+sp[1].slice(0, 1) : '');
            arr['short_version'] = sp[0];
        }else if(str.indexOf('Opera Mobi') > -1){
            arr['browser'] = 'Opera Mobile';
            arr['hash'] = 'opera-mobile';
            arr['engine'] = 'Presto';
            arr['type'] = 'mobile';
            arr['version'] = arr['full_version'] = (str.indexOf('Version') > -1)? str.replace(/^(?:.+)(?:Version\/)([0-9\.]{1,})$/, '$1') : '';
            arr['short_version'] = arr['version'].split('.')[0];
        }else if(str.indexOf('Opera Mini') > -1){
            arr['browser'] = 'Opera Mini';
            arr['hash'] = 'opera-mini';
            arr['engine'] = 'Presto';
            arr['type'] = 'mobile';
            arr['full_version'] = str.replace(/^(?:.+)(?:Opera Mini\/)([0-9\.]{0,})(?:.+)$/, '$1');
            var sp = arr['full_version'].toString().split('.');
            arr['version'] = sp[0]+((sp[1])? '.'+sp[1].slice(0, 1) : '');
            arr['short_version'] = sp[0];
        }else if(str.indexOf('Opera') > -1){
            arr['browser'] = 'Opera';
            arr['hash'] = 'opera';
            arr['engine'] = 'Presto';
            arr['version'] = arr['full_version'] = (str.indexOf('Version') > -1)? str.replace(/^(?:.+)(?:Version\/)([0-9\.]{0,})(?:.{0,})$/, '$1') : str.replace(/^(?:Opera\/)([0-9\.]{1,})\s(?:.+)$/, '$1');
            arr['short_version'] = arr['version'].split('.')[0];
        }else if(str.indexOf('OPR') > -1){
            arr['browser'] = 'Opera';
            arr['hash'] = 'opera';
            arr['engine'] = 'Blink';
            arr['full_version'] = str.replace(/^(?:.+)(?:OPR\/)([0-9\.]{1,})(?:.+)$/, '$1');
            var sp = arr['full_version'].toString().split('.');
            arr['version'] = sp[0]+((sp[1])? '.'+sp[1] : '');
            arr['short_version'] = sp[0];
        }else if(str.indexOf('Fennec') > -1){
            arr['browser'] = 'Fennec';
            arr['hash'] = 'fennec';
            arr['engine'] = 'Gecko';
            arr['type'] = 'mobile';
            arr['full_version'] = str.replace(/^(?:.+)(?:Fennec)(?:[\/]{0,})([0-9\.]{0,})(?:.{0,})$/, '$1');
            var sp = arr['full_version'].toString().split('.');
            arr['version'] = sp[0]+((sp[1])? '.'+sp[1] : '');
            arr['short_version'] = sp[0];
        }else if(str.indexOf('Firefox') > -1){
            arr['browser'] = 'Firefox';
            arr['hash'] = 'firefox';
            arr['engine'] = 'Gecko';
            arr['full_version'] = str.replace(/^(?:.+)(?:Firefox)(?:[\/]{0,})([0-9\.]{0,})(?:.{0,})$/, '$1');
            var sp = arr['full_version'].toString().split('.');
            arr['version'] = sp[0]+((sp[1])? '.'+sp[1] : '');
            arr['short_version'] = sp[0];
        }else if(str.indexOf('Valve Steam GameOverlay') > -1){
            arr['browser'] = 'Steam';
            arr['hash'] = 'steam';
            arr['engine'] = 'AppleWebKit';
            arr['full_version'] = str.replace(/^(?:.+)(?:Chrome\/)([0-9\.]{1,})(?:.+)$/, '$1');
            var sp = arr['full_version'].toString().split('.');
            arr['version'] = sp[0]+((sp[1])? '.'+sp[1] : '');
            arr['short_version'] = sp[0];
        }else if(str.indexOf('Chrome') > -1){
            arr['browser'] = 'Chrome';
            arr['hash'] = 'chrome';
            arr['engine'] = 'Blink';
            arr['full_version'] = str.replace(/^(?:.+)(?:Chrome\/)([0-9\.]{1,})(?:.+)$/, '$1');
            var sp = arr['full_version'].toString().split('.');
            arr['version'] = sp[0]+((sp[1])? '.'+sp[1] : '');
            arr['short_version'] = sp[0];
        }else if(str.indexOf('Safari') > -1){
            arr['browser'] = 'Safari';
            arr['hash'] = 'safari';
            arr['engine'] = 'AppleWebKit';
            arr['full_version'] = (str.indexOf('Version') > -1)? str.replace(/^(?:.+)(?:Version\/)([0-9\.]{1,})(?:.+)$/, '$1') : '2';
            var sp = arr['full_version'].toString().split('.');
            arr['version'] = sp[0]+((sp[1])? '.'+sp[1] : '');
            arr['short_version'] = sp[0];
        }else{
            arr['version'] = arr['browser'] = 'unknown';
        }
        // Browser fullname
        arr['full_name'] = ((that.fullname[arr['browser']])? that.fullname[arr['browser']] : 'unknown');
        arr['browser_name'] = arr['full_name'] + ((arr['version'].length > 0 && arr['version'] != 'unknown')? ' '+arr['version'] : '');
        // Ckeck browser engine
        if(!arr['engine']){
            if(str.indexOf('AppleWebKit') > -1){
                arr['engine'] = 'AppleWebKit';
            }else if(str.indexOf('Trident') > -1){
                arr['engine'] = 'Trident';
            }else if(str.indexOf('Gecko') > -1){
                arr['engine'] = 'Gecko';
            }else{
                arr['engine'] = 'unknown';
            }
        }
        // Check OS
        if(str.indexOf('Windows Phone OS') > -1){
            arr['os'] = 'Windows Phone OS';
            arr['os_type'] = 'mobile';
            arr['os_version'] = str.replace(/^(?:.+)(?:Windows Phone OS)(?:[\s]{0,1})([a-zA-Z\s0-9\.]{0,})(?:.+)$/, '$1');
        }else if(str.indexOf('Windows CE') > -1){
            arr['os'] = 'Windows Mobile';
            arr['os_type'] = 'mobile';
            arr['os_version'] = '';
        }else if(str.indexOf('Windows') > -1){
            arr['os'] = 'Windows';
            arr['os_version'] = str.replace(/^(?:.+)(?:Windows)(?:[\s]{0,1})([a-zA-Z\s0-9\.]{0,})(?:.+)$/, '$1');
        }else if(str.indexOf('Android') > -1){
            arr['os'] = 'Android';
            arr['os_type'] = 'mobile';
            arr['os_version'] = str.replace(/^(?:.+)(?:Android)(?:[\s]{0,})([0-9\.]{0,})(?:.+)$/, '$1');
        }else if(str.indexOf('Linux') > -1){
            arr['os'] = 'Linux';
            arr['os_version'] = str.replace(/^(?:.+)(?:Linux)(?:[\s]{0,1})([a-zA-Z0-9\.\s_]{0,})(?:.+)$/, '$1');
        }else if(str.indexOf('iPhone') > -1){
            arr['os'] = 'iPhone';
            arr['os_type'] = 'mobile';
            arr['os_version'] =  str.replace(/^(?:.+)(?:CPU[ iPhone]{0,} OS )([a-zA-Z0-9\._]{0,})(?:.+)$/, '$1').replace(/_/gi,'.');
        }else if(str.indexOf('iPad') > -1){
            arr['os'] = 'iPad';
            arr['os_type'] = 'mobile';
            arr['os_version'] =  str.replace(/^(?:.+)(?:CPU[ iPhone]{0,} OS )([a-zA-Z0-9\._]{0,})(?:.+)$/, '$1').replace(/_/gi,'.');
        }else if(str.indexOf('Macintosh') > -1){
            arr['os'] = 'Mac OS';
            if((str.indexOf('Mac OS') > -1)){
                arr['os_full_version'] =  str.replace(/^(?:.+)(?:Mac OS )([a-zA-Z0-9\.\s_]{0,})(?:.+)$/, '$1').replace(/_/gi,'.');
                arr['os_version'] = arr['os_full_version'].slice(0, 6);
                var os = that.os[arr['os']];
                arr['os_name'] =  arr['os'] +' '+ arr['os_version'] + ((os && os[arr['os_version']])? ' '+os[arr['os_version']] : '');
            }else{
                arr['os_version'] = 'Classic';
            }
        }else if(str.indexOf('BlackBerry') > -1){
            arr['os'] = 'BlackBerry';
            arr['os_type'] = 'mobile';
            arr['os_version'] = str.replace(/^(?:.{0,})(?:BlackBerry)(?:[\s]{0,})([0-9\.]{0,})(?:.+)$/, '$1');
        }else if(str.indexOf('FreeBSD') > -1){
            arr['os'] = 'FreeBSD';
            arr['os_version'] = str.replace(/^(?:.+)(?:FreeBSD )([a-zA-Z0-9\.\s_]{0,})(?:.+)$/, '$1');
        }else if(str.indexOf('NetBSD') > -1){
            arr['os'] = 'NetBSD';
            arr['os_version'] = str.replace(/^(?:.+)(?:NetBSD )([a-zA-Z0-9\.\s_]{0,})(?:.+)$/, '$1');
        }else if(str.indexOf('OpenBSD') > -1){
            arr['os'] = 'OpenBSD';
            arr['os_version'] = str.replace(/^(?:.+)(?:OpenBSD )([a-zA-Z0-9\.\s_]{0,})(?:.+)$/, '$1');
        }else if(str.indexOf('SunOS') > -1){
            arr['os'] = 'SunOS';
            arr['os_version'] = str.replace(/^(?:.+)(?:SunOS )([a-zA-Z0-9\.\s_]{0,})(?:.+)$/, '$1');
        }else{
            arr['os'] = arr['os_version'] = 'unknown';
        }
        // Check OS Name
        if(!arr['os_name']){
            if(arr['os'] != 'unknown'){
                var os = that.os[arr['os']];
                arr['os_name'] =  arr['os'] + ((arr['os_version'].length > 0 && arr['os_version'] != 'unknown')? ' '+((os && os[arr['os_version']])? os[arr['os_version']] : arr['os_version']) : '');
            }
            else{
                arr['os_name'] = 'unknown';
            }
        }
        return arr;
    },
    'setBrowserClass' : function(){
        var user = Com.UA.get();
        if(user['hash']){
            cm.addClass(document.getElementsByTagName('html')[0], [user['engine'].toLowerCase(), user['hash'], user['hash']+user['short_version']].join(' '));
        }
    },
    'setEngineClass' : function(){
        var user = Com.UA.get();
        cm.addClass(document.getElementsByTagName('html')[0], user['engine'].toLowerCase());
    },
    'is' : function(str){
        var that = this,
            ver = str.replace(/[^0-9\.\,]/g,''),
            app = that.hash[str.replace(/[0-9\.\,\s]/g,'').toLowerCase()],
            user = that.get();
        return (app == user.browser && ((ver && ver.length > 0)? parseFloat(ver) == parseFloat(user.version) : true));
    },
    'isVersion' : function(){
        var that = this,
            user = that.get();
        return parseFloat(user.version);
    },
    'isMobile' : function(){
        var that = this,
            user = that.get();
        return user['os_type'] == 'mobile';
    }
};

/* Deprecated */

var is = function(str){
    cm.log('Warning. Method "is()" is deprecated. Please use "Com.UA.is()"');
    return Com.UA.is(str);
};

var isVersion = function(){
    cm.log('Warning. Method "isVersion()" is deprecated. Please use "Com.UA.isVersion()"');
    return Com.UA.isVersion();
};
cm.define('Com.Zoom', {
    'modules' : [
        'Params',
        'Events',
        'DataConfig',
        'Stack'
    ],
    'events' : [
        'onRender',
        'onOpenStart',
        'onOpen',
        'onClose',
        'onCloseStart'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'container' : 'document.body',
        'name' : '',
        'src' :'',
        'duration' : 'cm._config.animDuration',
        'autoOpen' : true,
        'removeOnClose' : true,
        'documentScroll' : false
    }
},
function(params){
    var that = this,
        imageRect,
        innerRect,
        widthRatio,
        heightRatio;

    that.isOpen = false;
    that.isLoad = false;
    that.nodes = {};

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['node']);
        render();
        that.addToStack(that.nodes['container']);
        that.triggerEvent('onRender');
        that.params['autoOpen'] && that.open();
    };

    var render = function(){
        // Structure
        that.nodes['container'] = cm.node('div', {'class' : 'com__zoom'},
            that.nodes['inner'] = cm.node('div', {'class' : 'inner'})
        );
        cm.addEvent(that.nodes['container'], 'click', that.close);
    };

    var renderImage = function(){
        that.nodes['image'] = cm.node('img');
        cm.addEvent(that.nodes['image'], 'load', function(){
            that.isLoad = true;
            // Get image properties
            calculateHelper();
            calculateAction();
        });
        that.nodes['image'].src = that.params['src'];
        // Append
        that.nodes['inner'].appendChild(that.nodes['image']);
    };

    var calculateHelper = function(){
        imageRect = cm.getRect(that.nodes['image']);
        innerRect = cm.getRect(that.nodes['inner']);
        widthRatio = (imageRect['width'] - innerRect['width']) / innerRect['width'];
        heightRatio = (imageRect['height'] - innerRect['height']) / innerRect['height'];
    };

    var calculateAction = function(){
        if(that.isLoad){
            var setX = -cm._clientPosition['x'] * widthRatio,
                setY = -cm._clientPosition['y'] * heightRatio;
            cm.setCSSTranslate(that.nodes['image'], [setX, 'px'].join(''), [setY, 'px'].join(''));
        }
    };

    var clickAction = function(e){
        e = cm.getEvent(e);
        if(e.keyCode == 27){
            // ESC key
            that.close();
        }
    };

    var resizeAction = function(){
        calculateHelper();
        calculateAction();
    };

    var moveAction = function(){
        calculateAction();
    };

    var appendEvents = function(){
        cm.addEvent(window, 'mousemove', moveAction);
        cm.addEvent(window, 'resize', resizeAction);
        cm.addEvent(window, 'keydown', clickAction);
    };

    var removeEvents = function(){
        cm.removeEvent(window, 'mousemove', moveAction);
        cm.removeEvent(window, 'resize', resizeAction);
        cm.removeEvent(window, 'keydown', clickAction);
    };

    /* ******* PUBLIC ******* */

    that.set = function(src){
        that.isLoad = false;
        that.params['src'] = src;
        return that;
    };

    that.open = function(){
        if(!that.isOpen){
            that.isOpen = true;
            appendEvents();
            // Show / Hide Document Scroll
            if(!that.params['documentScroll']){
                cm.addClass(cm.getDocumentHtml(), 'cm__scroll--none');
            }
            // Append
            that.nodes['container'].style.display = 'block';
            if(!cm.inDOM(that.nodes['container'])){
                that.params['container'].appendChild(that.nodes['container']);
            }
            renderImage();
            // Animate
            cm.transition(that.nodes['container'], {
                'properties' : {'opacity' : 1},
                'duration' : that.params['duration'],
                'easing' : 'ease-in-out',
                'onStop' : function(){
                    // Event
                    that.triggerEvent('onOpen');
                }
            });
            // Event
            that.triggerEvent('onOpenStart');
        }
        return that;
    };

    that.close = function(){
        if(that.isOpen){
            that.isOpen = false;
            removeEvents();
            // Show / Hide Document Scroll
            if(!that.params['documentScroll']){
                cm.removeClass(cm.getDocumentHtml(), 'cm__scroll--none');
            }
            // Animate
            cm.transition(that.nodes['container'], {
                'properties' : {'opacity' : 0},
                'duration' : that.params['duration'],
                'easing' : 'ease-in-out',
                'onStop' : function(){
                    // Remove Window
                    that.nodes['container'].style.display = 'none';
                    that.params['removeOnClose'] && cm.remove(that.nodes['container']);
                    cm.remove(that.nodes['image']);
                    // Event
                    that.triggerEvent('onClose');
                }
            });
            // Event
            that.triggerEvent('onCloseStart');
        }
        return that;
    };

    init();
});