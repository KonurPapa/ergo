/* @ds-bundle: {"format":4,"namespace":"Ergo","components":[{"name":"Button"},{"name":"Input"},{"name":"Kbd"},{"name":"Badge"},{"name":"StatusIcon"},{"name":"AgentStatus"},{"name":"Tabs"},{"name":"SegmentedControl"},{"name":"Menu"},{"name":"Dialog"},{"name":"Toast"},{"name":"EditorToolbar"},{"name":"TaskLine"},{"name":"Composer"},{"name":"Terminal"},{"name":"Banner"},{"name":"EmptyState"},{"name":"CodeBlock"}]} */
(function () {
  "use strict";
  var R = window.React;
  var h = R ? R.createElement : null;
  var ICONS = {"arrow-left":"<path d=\"m12 19-7-7 7-7\" /> <path d=\"M19 12H5\" />","check":"<path d=\"M20 6 9 17l-5-5\" />","circle":"<circle cx=\"12\" cy=\"12\" r=\"10\" />","play":"<polygon points=\"6 3 20 12 6 21 6 3\" />","square":"<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" />","pause":"<rect x=\"14\" y=\"4\" width=\"4\" height=\"16\" rx=\"1\" /> <rect x=\"6\" y=\"4\" width=\"4\" height=\"16\" rx=\"1\" />","plus":"<path d=\"M5 12h14\" /> <path d=\"M12 5v14\" />","search":"<circle cx=\"11\" cy=\"11\" r=\"8\" /> <path d=\"m21 21-4.3-4.3\" />","settings":"<path d=\"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z\" /> <circle cx=\"12\" cy=\"12\" r=\"3\" />","chevron-down":"<path d=\"m6 9 6 6 6-6\" />","chevron-right":"<path d=\"m9 18 6-6-6-6\" />","chevron-left":"<path d=\"m15 18-6-6 6-6\" />","folder":"<path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\" />","file":"<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\" /> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\" />","file-text":"<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\" /> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\" /> <path d=\"M10 9H8\" /> <path d=\"M16 13H8\" /> <path d=\"M16 17H8\" />","terminal":"<polyline points=\"4 17 10 11 4 5\" /> <line x1=\"12\" x2=\"20\" y1=\"19\" y2=\"19\" />","link":"<path d=\"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\" /> <path d=\"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\" />","at-sign":"<circle cx=\"12\" cy=\"12\" r=\"4\" /> <path d=\"M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8\" />","slash":"<path d=\"M22 2 2 22\" />","x":"<path d=\"M18 6 6 18\" /> <path d=\"m6 6 12 12\" />","ellipsis":"<circle cx=\"12\" cy=\"12\" r=\"1\" /> <circle cx=\"19\" cy=\"12\" r=\"1\" /> <circle cx=\"5\" cy=\"12\" r=\"1\" />","grip-vertical":"<circle cx=\"9\" cy=\"12\" r=\"1\" /> <circle cx=\"9\" cy=\"5\" r=\"1\" /> <circle cx=\"9\" cy=\"19\" r=\"1\" /> <circle cx=\"15\" cy=\"12\" r=\"1\" /> <circle cx=\"15\" cy=\"5\" r=\"1\" /> <circle cx=\"15\" cy=\"19\" r=\"1\" />","arrow-up-right":"<path d=\"M7 7h10v10\" /> <path d=\"M7 17 17 7\" />","triangle-alert":"<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\" /> <path d=\"M12 9v4\" /> <path d=\"M12 17h.01\" />","info":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"M12 16v-4\" /> <path d=\"M12 8h.01\" />","plug":"<path d=\"M12 22v-5\" /> <path d=\"M9 8V2\" /> <path d=\"M15 8V2\" /> <path d=\"M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z\" />","unplug":"<path d=\"m19 5 3-3\" /> <path d=\"m2 22 3-3\" /> <path d=\"M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z\" /> <path d=\"M7.5 13.5 10 11\" /> <path d=\"M10.5 16.5 13 14\" /> <path d=\"m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z\" />","refresh-cw":"<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\" /> <path d=\"M21 3v5h-5\" /> <path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\" /> <path d=\"M8 16H3v5\" />","download":"<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\" /> <polyline points=\"7 10 12 15 17 10\" /> <line x1=\"12\" x2=\"12\" y1=\"15\" y2=\"3\" />","copy":"<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\" /> <path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\" />","history":"<path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\" /> <path d=\"M3 3v5h5\" /> <path d=\"M12 7v5l4 2\" />","book-open":"<path d=\"M12 7v14\" /> <path d=\"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z\" />","library":"<path d=\"m16 6 4 14\" /> <path d=\"M12 6v14\" /> <path d=\"M8 8v12\" /> <path d=\"M4 4v16\" />","keyboard":"<path d=\"M10 8h.01\" /> <path d=\"M12 12h.01\" /> <path d=\"M14 8h.01\" /> <path d=\"M16 12h.01\" /> <path d=\"M18 8h.01\" /> <path d=\"M6 8h.01\" /> <path d=\"M7 16h10\" /> <path d=\"M8 12h.01\" /> <rect width=\"20\" height=\"16\" x=\"2\" y=\"4\" rx=\"2\" />","command":"<path d=\"M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3\" />","sun":"<circle cx=\"12\" cy=\"12\" r=\"4\" /> <path d=\"M12 2v2\" /> <path d=\"M12 20v2\" /> <path d=\"m4.93 4.93 1.41 1.41\" /> <path d=\"m17.66 17.66 1.41 1.41\" /> <path d=\"M2 12h2\" /> <path d=\"M20 12h2\" /> <path d=\"m6.34 17.66-1.41 1.41\" /> <path d=\"m19.07 4.93-1.41 1.41\" />","moon":"<path d=\"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z\" />","cpu":"<rect width=\"16\" height=\"16\" x=\"4\" y=\"4\" rx=\"2\" /> <rect width=\"6\" height=\"6\" x=\"9\" y=\"9\" rx=\"1\" /> <path d=\"M15 2v2\" /> <path d=\"M15 20v2\" /> <path d=\"M2 15h2\" /> <path d=\"M2 9h2\" /> <path d=\"M20 15h2\" /> <path d=\"M20 9h2\" /> <path d=\"M9 2v2\" /> <path d=\"M9 20v2\" />","shield":"<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\" />","gauge":"<path d=\"m12 14 4-4\" /> <path d=\"M3.34 19a10 10 0 1 1 17.32 0\" />","puzzle":"<path d=\"M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z\" />","folder-git-2":"<path d=\"M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5\" /> <circle cx=\"13\" cy=\"12\" r=\"2\" /> <path d=\"M18 19c-2.8 0-5-2.2-5-5v8\" /> <circle cx=\"20\" cy=\"19\" r=\"2\" />","corner-down-left":"<polyline points=\"9 10 4 15 9 20\" /> <path d=\"M20 4v7a4 4 0 0 1-4 4H4\" />","list-plus":"<path d=\"M11 12H3\" /> <path d=\"M16 6H3\" /> <path d=\"M16 18H3\" /> <path d=\"M18 9v6\" /> <path d=\"M21 12h-6\" />","circle-check":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"m9 12 2 2 4-4\" />","circle-x":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"m15 9-6 6\" /> <path d=\"m9 9 6 6\" />","clock":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <polyline points=\"12 6 12 12 16 14\" />","layers":"<path d=\"m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z\" /> <path d=\"m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65\" /> <path d=\"m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65\" />","sliders-horizontal":"<line x1=\"21\" x2=\"14\" y1=\"4\" y2=\"4\" /> <line x1=\"10\" x2=\"3\" y1=\"4\" y2=\"4\" /> <line x1=\"21\" x2=\"12\" y1=\"12\" y2=\"12\" /> <line x1=\"8\" x2=\"3\" y1=\"12\" y2=\"12\" /> <line x1=\"21\" x2=\"16\" y1=\"20\" y2=\"20\" /> <line x1=\"12\" x2=\"3\" y1=\"20\" y2=\"20\" /> <line x1=\"14\" x2=\"14\" y1=\"2\" y2=\"6\" /> <line x1=\"8\" x2=\"8\" y1=\"10\" y2=\"14\" /> <line x1=\"16\" x2=\"16\" y1=\"18\" y2=\"22\" />","panel-right":"<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" /> <path d=\"M15 3v18\" />","hash":"<line x1=\"4\" x2=\"20\" y1=\"9\" y2=\"9\" /> <line x1=\"4\" x2=\"20\" y1=\"15\" y2=\"15\" /> <line x1=\"10\" x2=\"8\" y1=\"3\" y2=\"21\" /> <line x1=\"16\" x2=\"14\" y1=\"3\" y2=\"21\" />","git-branch":"<line x1=\"6\" x2=\"6\" y1=\"3\" y2=\"15\" /> <circle cx=\"18\" cy=\"6\" r=\"3\" /> <circle cx=\"6\" cy=\"18\" r=\"3\" /> <path d=\"M18 9a9 9 0 0 1-9 9\" />","user":"<path d=\"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2\" /> <circle cx=\"12\" cy=\"7\" r=\"4\" />","list-checks":"<path d=\"m3 17 2 2 4-4\" /> <path d=\"m3 7 2 2 4-4\" /> <path d=\"M13 6h8\" /> <path d=\"M13 12h8\" /> <path d=\"M13 18h8\" />","pencil":"<path d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\" /> <path d=\"m15 5 4 4\" />","trash-2":"<path d=\"M3 6h18\" /> <path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\" /> <path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\" /> <line x1=\"10\" x2=\"10\" y1=\"11\" y2=\"17\" /> <line x1=\"14\" x2=\"14\" y1=\"11\" y2=\"17\" />","arrow-right":"<path d=\"M5 12h14\" /> <path d=\"m12 5 7 7-7 7\" />","scroll-text":"<path d=\"M15 12h-5\" /> <path d=\"M15 8h-5\" /> <path d=\"M19 17V5a2 2 0 0 0-2-2H4\" /> <path d=\"M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3\" />","archive":"<rect width=\"20\" height=\"5\" x=\"2\" y=\"3\" rx=\"1\" /> <path d=\"M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8\" /> <path d=\"M10 12h4\" />","inbox":"<polyline points=\"22 12 16 12 14 15 10 15 8 12 2 12\" /> <path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\" />","filter":"<polygon points=\"22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3\" />","list-filter":"<path d=\"M3 6h18\" /> <path d=\"M7 12h10\" /> <path d=\"M10 18h4\" />","monitor":"<rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\" /> <line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\" /> <line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\" />","external-link":"<path d=\"M15 3h6v6\" /> <path d=\"M10 14 21 3\" /> <path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\" />","rotate-ccw":"<path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\" /> <path d=\"M3 3v5h5\" />","circle-pause":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <line x1=\"10\" x2=\"10\" y1=\"15\" y2=\"9\" /> <line x1=\"14\" x2=\"14\" y1=\"15\" y2=\"9\" />","heading-1":"<path d=\"M4 12h8\" /> <path d=\"M4 18V6\" /> <path d=\"M12 18V6\" /> <path d=\"m17 12 3-2v8\" />","heading-2":"<path d=\"M4 12h8\" /> <path d=\"M4 18V6\" /> <path d=\"M12 18V6\" /> <path d=\"M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1\" />","heading-3":"<path d=\"M4 12h8\" /> <path d=\"M4 18V6\" /> <path d=\"M12 18V6\" /> <path d=\"M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2\" /> <path d=\"M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2\" />","bold":"<path d=\"M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8\" />","italic":"<line x1=\"19\" x2=\"10\" y1=\"4\" y2=\"4\" /> <line x1=\"14\" x2=\"5\" y1=\"20\" y2=\"20\" /> <line x1=\"15\" x2=\"9\" y1=\"4\" y2=\"20\" />","strikethrough":"<path d=\"M16 4H9a3 3 0 0 0-2.83 4\" /> <path d=\"M14 12a4 4 0 0 1 0 8H6\" /> <line x1=\"4\" x2=\"20\" y1=\"12\" y2=\"12\" />","code":"<polyline points=\"16 18 22 12 16 6\" /> <polyline points=\"8 6 2 12 8 18\" />","list":"<path d=\"M3 12h.01\" /> <path d=\"M3 18h.01\" /> <path d=\"M3 6h.01\" /> <path d=\"M8 12h13\" /> <path d=\"M8 18h13\" /> <path d=\"M8 6h13\" />","list-ordered":"<path d=\"M10 12h11\" /> <path d=\"M10 18h11\" /> <path d=\"M10 6h11\" /> <path d=\"M4 10h2\" /> <path d=\"M4 6h1v4\" /> <path d=\"M6 18H4c0-1 2-2 2-3s-1-1.5-2-1\" />","list-todo":"<rect x=\"3\" y=\"5\" width=\"6\" height=\"6\" rx=\"1\" /> <path d=\"m3 17 2 2 4-4\" /> <path d=\"M13 6h8\" /> <path d=\"M13 12h8\" /> <path d=\"M13 18h8\" />","indent-increase":"<path d=\"M21 12H11\" /> <path d=\"M21 18H11\" /> <path d=\"M21 6H11\" /> <path d=\"m3 8 4 4-4 4\" />","indent-decrease":"<path d=\"M21 12H11\" /> <path d=\"M21 18H11\" /> <path d=\"M21 6H11\" /> <path d=\"m7 8-4 4 4 4\" />","quote":"<path d=\"M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z\" /> <path d=\"M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z\" />","square-code":"<path d=\"M10 9.5 8 12l2 2.5\" /> <path d=\"m14 9.5 2 2.5-2 2.5\" /> <rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" />","minus":"<path d=\"M5 12h14\" />","undo-2":"<path d=\"M9 14 4 9l5-5\" /> <path d=\"M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11\" />","redo-2":"<path d=\"m15 14 5-5-5-5\" /> <path d=\"M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13\" />","file-code":"<path d=\"M10 12.5 8 15l2 2.5\" /> <path d=\"m14 12.5 2 2.5-2 2.5\" /> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\" /> <path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z\" />","type":"<polyline points=\"4 7 4 4 20 4 20 7\" /> <line x1=\"9\" x2=\"15\" y1=\"20\" y2=\"20\" /> <line x1=\"12\" x2=\"12\" y1=\"4\" y2=\"20\" />","pilcrow":"<path d=\"M13 4v16\" /> <path d=\"M17 4v16\" /> <path d=\"M19 4H9.5a4.5 4.5 0 0 0 0 9H13\" />","message-square-text":"<path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\" /> <path d=\"M13 8H7\" /> <path d=\"M17 12H7\" />"};

  function cx() { var o = []; for (var i = 0; i < arguments.length; i++) if (arguments[i]) o.push(arguments[i]); return o.join(" "); }
  function omit(p, keys) { var o = {}; for (var k in p) if (keys.indexOf(k) < 0) o[k] = p[k]; return o; }

  var STATUS = {
    todo: '<circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    queued: '<circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 2.2"/>',
    progress: '<circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor"/>',
    review: '<circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="7" cy="7" r="2" fill="currentColor"/>',
    done: '<circle cx="7" cy="7" r="6" fill="currentColor"/><path d="M4.4 7.2l1.8 1.8 3.5-3.6" fill="none" stroke="var(--canvas)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    failed: '<circle cx="7" cy="7" r="6" fill="currentColor"/><path d="M5 5l4 4M9 5l-4 4" fill="none" stroke="var(--canvas)" stroke-width="1.5" stroke-linecap="round"/>'
  };
  var STATUS_LABEL = { todo: "To do", queued: "Queued", progress: "In progress", review: "Needs review", done: "Done", failed: "Failed" };
  function bars(n) {
    var s = ""; var hs = [4, 7, 10];
    for (var i = 0; i < 3; i++) s += '<rect x="' + (1.5 + i * 4) + '" y="' + (12 - hs[i]) + '" width="2.5" height="' + hs[i] + '" rx="0.75" fill="currentColor"' + (i < n ? "" : ' opacity="0.3"') + "/>";
    return s;
  }
  var PRIO = {
    none: '<path d="M3 7h1.5M6.25 7h1.5M9.5 7H11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    low: bars(1), medium: bars(2), high: bars(3),
    urgent: '<rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor"/><path d="M7 4v3.5" stroke="var(--canvas)" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="10" r="0.9" fill="var(--canvas)"/>'
  };
  var PRIO_LABEL = { none: "No priority", low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };

  function iconSvg(name) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || "") + "</svg>"; }
  function statusSvg(s) { return '<svg viewBox="0 0 14 14" aria-hidden="true">' + (STATUS[s] || STATUS.todo) + "</svg>"; }
  function prioSvg(p) { return '<svg viewBox="0 0 14 14" aria-hidden="true">' + (PRIO[p] || PRIO.none) + "</svg>"; }

  /* For static HTML: <i data-i="play"></i>, <i data-s="done"></i>, <i data-p="high"></i> */
  function hydrateIcons(root) {
    root = root || document;
    var n = root.querySelectorAll("i[data-i],i[data-s],i[data-p]");
    for (var k = 0; k < n.length; k++) {
      var el = n[k], span = document.createElement("span");
      if (el.dataset.i) { span.className = cx("eg-icon", el.className); span.innerHTML = iconSvg(el.dataset.i); }
      else if (el.dataset.s) { span.className = cx("eg-status", "eg-status-" + el.dataset.s, el.className); span.innerHTML = statusSvg(el.dataset.s); span.setAttribute("role", "img"); span.setAttribute("aria-label", STATUS_LABEL[el.dataset.s] || el.dataset.s); }
      else { span.className = cx("eg-prio", el.dataset.p === "urgent" && "eg-prio-urgent", el.className); span.innerHTML = prioSvg(el.dataset.p); span.setAttribute("role", "img"); span.setAttribute("aria-label", PRIO_LABEL[el.dataset.p] || el.dataset.p); }
      if (el.getAttribute("style")) span.setAttribute("style", el.getAttribute("style"));
      el.replaceWith(span);
    }
  }

  var api = { icons: ICONS, iconSvg: iconSvg, statusSvg: statusSvg, prioSvg: prioSvg, hydrateIcons: hydrateIcons, STATUS_LABEL: STATUS_LABEL, PRIO_LABEL: PRIO_LABEL };

  if (R) {
    var Icon = function (p) { return h("span", { className: cx("eg-icon", p.size === "sm" && "eg-icon-sm", p.className), style: p.style, dangerouslySetInnerHTML: { __html: iconSvg(p.name) } }); };
    var Kbd = function (p) {
      var keys = Array.isArray(p.keys) ? p.keys : [p.keys || p.children];
      return h("span", { className: "eg-kbds" }, keys.map(function (k, i) { return h("kbd", { key: i, className: "eg-kbd" }, k); }));
    };
    var Button = function (p) {
      var v = p.variant || "secondary";
      return h("button", Object.assign({ type: "button" }, omit(p, ["variant", "size", "icon", "iconRight", "kbd", "className", "children"]), {
        className: cx("eg-btn", "eg-btn-" + v, p.size && "eg-btn-" + p.size, p.className)
      }), p.icon && h(Icon, { name: p.icon }), p.children, p.iconRight && h(Icon, { name: p.iconRight }), p.kbd && h(Kbd, { keys: p.kbd }));
    };
    var IconButton = function (p) {
      return h("button", Object.assign({ type: "button", "aria-label": p.label, title: p.label }, omit(p, ["variant", "size", "icon", "label", "className"]), {
        className: cx("eg-btn", "eg-btn-icon", "eg-btn-" + (p.variant || "ghost"), p.size && "eg-btn-" + p.size, p.className)
      }), h(Icon, { name: p.icon }));
    };
    var Input = function (p) {
      var input = h("input", Object.assign({}, omit(p, ["icon", "kbd", "invalid", "mono", "className"]), { className: cx("eg-input", p.mono && "eg-input-mono", p.invalid && "is-invalid", p.className), "aria-invalid": p.invalid || undefined }));
      if (!p.icon && !p.kbd) return input;
      return h("div", { className: "eg-input-wrap" }, p.icon && h(Icon, { name: p.icon }), input, p.kbd && h(Kbd, { keys: p.kbd }));
    };
    var Field = function (p) {
      return h("label", { className: "eg-field" }, p.label && h("span", { className: "eg-field-label" }, p.label), p.children,
        p.error ? h("span", { className: "eg-field-error" }, h(Icon, { name: "circle-x", size: "sm" }), p.error) : p.help && h("span", { className: "eg-field-help" }, p.help));
    };
    var Checkbox = function (p) { return h("input", Object.assign({ type: "checkbox" }, p, { className: cx("eg-check", p.className) })); };
    var Switch = function (p) { return h("input", Object.assign({ type: "checkbox", role: "switch" }, p, { className: cx("eg-switch", p.className) })); };
    var Badge = function (p) {
      return h("span", { className: cx("eg-badge", p.tone && p.tone !== "neutral" && "eg-badge-" + p.tone, p.outline && "eg-badge-outline", p.className) }, p.icon && h(Icon, { name: p.icon }), p.children);
    };
    var StatusDot = function (p) {
      var s = p.state || "idle";
      return h("span", { className: cx("eg-dot", s !== "idle" && "eg-dot-" + s), role: p.label ? "img" : undefined, "aria-label": p.label });
    };
    var StatusIcon = function (p) {
      var s = p.status || "todo";
      return h("span", { className: cx("eg-status", "eg-status-" + s), role: "img", "aria-label": STATUS_LABEL[s], title: STATUS_LABEL[s], dangerouslySetInnerHTML: { __html: statusSvg(s) } });
    };
    var PriorityIcon = function (p) {
      var s = p.priority || "none";
      return h("span", { className: cx("eg-prio", s === "urgent" && "eg-prio-urgent"), role: "img", "aria-label": PRIO_LABEL[s], title: PRIO_LABEL[s], dangerouslySetInnerHTML: { __html: prioSvg(s) } });
    };
    var AgentStatus = function (p) {
      var state = p.state || "running";
      var dot = { running: "live", waiting: "warning", done: "success", failed: "danger", idle: "idle" }[state];
      var tag = p.onClick ? "button" : "span";
      return h(tag, { className: "eg-agent", onClick: p.onClick, type: p.onClick ? "button" : undefined, "aria-live": "polite" },
        h(StatusDot, { state: dot }),
        h("span", { className: "eg-agent-text" }, p.agent && h("b", null, p.agent + " "), p.action, p.target && h(R.Fragment, null, " ", h("code", null, p.target))),
        (p.elapsed || p.tokens) && h("span", { className: "eg-agent-meta" }, [p.elapsed, p.tokens].filter(Boolean).join(" · ")));
    };
    var Tabs = function (p) {
      return h("div", { className: "eg-tabs", role: "tablist" }, p.items.map(function (t) {
        return h("button", { key: t.id, role: "tab", type: "button", className: "eg-tab", "aria-selected": t.id === p.value ? "true" : "false", onClick: p.onChange && function () { p.onChange(t.id); } },
          t.icon && h(Icon, { name: t.icon, size: "sm" }), t.label, t.count != null && h("span", { className: "eg-count" }, t.count));
      }));
    };
    var SegmentedControl = function (p) {
      return h("div", { className: cx("eg-seg", p.full && "eg-seg-full"), role: "radiogroup", "aria-label": p.label }, p.options.map(function (o) {
        var id = typeof o === "string" ? o : o.id, lbl = typeof o === "string" ? o : o.label;
        return h("button", { key: id, type: "button", role: "radio", className: "eg-seg-item", "aria-checked": id === p.value ? "true" : "false", onClick: p.onChange && function () { p.onChange(id); } }, lbl);
      }));
    };
    var Menu = function (p) {
      return h("div", { className: "eg-menu", role: "menu", style: p.style }, p.items.map(function (it, i) {
        if (it.separator) return h("div", { key: i, className: "eg-menu-sep", role: "separator" });
        if (it.section) return h("div", { key: i, className: "eg-menu-label" }, it.section);
        return h("button", { key: i, type: "button", role: it.checked != null ? "menuitemcheckbox" : "menuitem", "aria-checked": it.checked != null ? String(!!it.checked) : undefined, className: cx("eg-menu-item", it.danger && "eg-menu-item-danger"), "data-active": it.active ? "true" : undefined, onClick: it.onSelect },
          it.icon && h(Icon, { name: it.icon }), it.label,
          it.checked ? h(Icon, { name: "check", className: "eg-menu-check" }) : it.hint && h("span", { className: "eg-menu-hint" }, it.hint));
      }));
    };
    var Dialog = function (p) {
      var box = h("div", { className: "eg-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "eg-dlg-t", style: p.width ? { width: p.width } : undefined },
        h("div", { className: "eg-dialog-head" },
          h("div", { style: { flex: 1 } }, h("h2", { className: "eg-dialog-title", id: "eg-dlg-t" }, p.title), p.description && h("p", { className: "eg-dialog-desc" }, p.description)),
          p.onClose !== false && h(IconButton, { icon: "x", label: "Close", size: "sm", onClick: p.onClose })),
        h("div", { className: "eg-dialog-body" }, p.children),
        p.footer && h("div", { className: "eg-dialog-foot" }, p.footer));
      return p.inline ? box : h("div", { className: "eg-scrim" }, box);
    };
    var Toast = function (p) {
      var tone = p.tone || "neutral";
      var icon = p.icon || { success: "circle-check", warning: "triangle-alert", danger: "circle-x", neutral: "info" }[tone];
      return h("div", { className: cx("eg-toast", "eg-toast-" + tone), role: tone === "danger" ? "alert" : "status" },
        h("span", { className: "eg-toast-icon" }, h(Icon, { name: icon })),
        h("div", { style: { flex: 1, minWidth: 0 } }, h("div", { className: "eg-toast-title" }, p.title), p.text && h("div", { className: "eg-toast-text" }, p.text)),
        p.actions && h("div", { className: "eg-toast-actions" }, p.actions));
    };
    var DocHeading = function (p) {
      var lv = p.level || 2;
      return h("h" + lv, { className: "eg-doc-h" + lv }, p.children, p.count != null && h("span", { className: "eg-doc-h-count" }, p.count));
    };
    var RunState = function (p) {
      var s = p.state;
      if (!s) return null;
      var cls = { live: "eg-runstate-live", review: "eg-runstate-review", failed: "eg-runstate-failed" }[s];
      var lead = s === "live" ? h(StatusDot, { state: "live" }) : s === "queued" ? h(StatusIcon, { status: "queued" }) : s === "review" ? h(StatusDot, { state: "warning" }) : s === "failed" ? h(StatusDot, { state: "danger" }) : h(StatusDot, { state: "success" });
      return h("span", { className: cx("eg-runstate", cls) }, lead, p.label, p.target && h("code", null, p.target), p.meta && h("span", { style: { color: "var(--ink-subtle)" } }, p.meta));
    };
    var TaskLine = function (p) {
      var kind = p.kind || "task";
      var marker = kind === "task" ? h("input", { type: "checkbox", className: "eg-tcheck", defaultChecked: !!p.done, "aria-label": p.done ? "Mark not done" : "Mark done", tabIndex: -1 })
        : kind === "number" ? h("span", { className: "eg-line-num" }, (p.num || 1) + ".")
        : kind === "bullet" ? h("span", { className: "eg-line-bullet", "aria-hidden": "true" }) : null;
      return h("div", { className: cx("eg-line", p.done && "is-done", p.current && "is-current", p.selected && "is-selected"), style: { "--d": p.depth || 0 }, "data-kind": kind },
        h("span", { className: "eg-line-grip" }, h("button", { type: "button", "aria-label": "Insert below" }, h(Icon, { name: "plus" })), h("button", { type: "button", "aria-label": "Drag to move" }, h(Icon, { name: "grip-vertical" }))),
        p.hasChildren && h("button", { type: "button", className: "eg-line-twisty", "aria-expanded": String(!p.collapsed), "aria-label": p.collapsed ? "Expand" : "Collapse" }, h(Icon, { name: p.collapsed ? "chevron-right" : "chevron-down" })),
        marker,
        h("span", { className: "eg-line-text" }, p.children || h("span", { className: "eg-ph" }, p.placeholder || "Type a task, or / for blocks and skills"),
          p.collapsed && p.childCount ? h("span", { className: "eg-line-collapsed" }, p.childCount + " more") : null),
        kind === "task" && (p.run || p.actions !== false) && h("span", { className: "eg-line-side" },
          p.run && h(RunState, p.run),
          p.actions !== false && !p.done && h("span", { className: "eg-line-acts" },
            h(IconButton, { icon: "file-text", label: "Open brief", size: "sm" }),
            p.run && p.run.state === "live" ? h(IconButton, { icon: "square", label: "Stop run", size: "sm" }) : h(IconButton, { icon: "play", label: "Run", size: "sm" }))));
    };
    var EditorToolbar = function (p) {
      var on = p.active || [];
      var b = function (icon, label) { return h("button", { key: icon, type: "button", className: "eg-tb-btn", "aria-label": label, title: label, "aria-pressed": on.indexOf(icon) >= 0 ? "true" : undefined }, h(Icon, { name: icon })); };
      var sep = function (k) { return h("span", { key: k, className: "eg-tb-sep", "aria-hidden": "true" }); };
      return h("div", { className: "eg-toolbar", role: "toolbar", "aria-label": "Formatting" },
        b("undo-2", "Undo ⌘Z"), b("redo-2", "Redo ⇧⌘Z"), sep(1),
        h("button", { type: "button", className: "eg-tb-select", "aria-label": "Block type" }, p.block || "Task", h(Icon, { name: "chevron-down" })), sep(2),
        b("bold", "Bold ⌘B"), b("italic", "Italic ⌘I"), b("strikethrough", "Strikethrough ⇧⌘X"), b("code", "Inline code ⌘E"), b("link", "Link ⌘K"), sep(3),
        b("list-todo", "Checklist ⇧⌘9"), b("list", "Bulleted list ⇧⌘8"), b("list-ordered", "Numbered list ⇧⌘7"), b("indent-decrease", "Outdent ⇧Tab"), b("indent-increase", "Indent Tab"), sep(4),
        b("quote", "Quote"), b("square-code", "Code block"), b("minus", "Divider"),
        h("span", { className: "eg-spacer" }), p.right);
    };
    var SelectionToolbar = function (p) {
      var b = function (icon, label) { return h("button", { key: icon, type: "button", className: "eg-tb-btn", "aria-label": label, title: label }, h(Icon, { name: icon })); };
      return h("div", { className: "eg-seltb", role: "toolbar", "aria-label": "Selection" },
        b("bold", "Bold"), b("italic", "Italic"), b("strikethrough", "Strikethrough"), b("code", "Code"), b("link", "Link"),
        h("span", { className: "eg-tb-sep" }),
        h(Button, { variant: "ghost", size: "sm", icon: "list-plus" }, p.draftLabel || "Draft tasks from this"),
        p.runCount ? h(Button, { variant: "ghost", size: "sm", icon: "play" }, "Run " + p.runCount) : null);
    };
    var Composer = function (p) {
      var parts = p.parts || [];
      return h("div", { className: "eg-composer" },
        h("div", { className: "eg-composer-input", role: "textbox", "aria-multiline": "true", contentEditable: p.readOnly ? undefined : true, suppressContentEditableWarning: true },
          parts.length ? parts.map(function (x, i) {
            if (typeof x === "string") return x;
            if (x.file) return h("span", { key: i, className: "eg-ref", contentEditable: false }, "@" + x.file);
            if (x.skill) return h("span", { key: i, className: "eg-ref eg-ref-skill", contentEditable: false }, "/" + x.skill);
            if (x.caret) return h("span", { key: i, className: "eg-caret" });
            return null;
          }) : h("span", { className: "eg-ph" }, p.placeholder || "Describe a task — @ to reference a file, / for a skill")),
        h("div", { className: "eg-composer-foot" },
          h(IconButton, { icon: "at-sign", label: "Reference a file", size: "sm" }),
          h(IconButton, { icon: "slash", label: "Use a skill", size: "sm" }),
          h("span", { className: "eg-spacer" }),
          p.model && h(Button, { variant: "ghost", size: "sm", iconRight: "chevron-down" }, p.model),
          h(Button, { variant: p.primary === false ? "secondary" : "primary", size: "sm", kbd: p.submitKbd || "⌘↵" }, p.submitLabel || "Draft")));
    };
    var Terminal = function (p) {
      return h("div", { className: "eg-term", style: p.height ? { height: p.height } : undefined },
        h("div", { className: "eg-term-head" }, h(Icon, { name: "terminal", size: "sm" }), h("span", null, p.title || "Output"), h("span", { className: "eg-spacer" }), p.actions),
        h("pre", { className: "eg-term-body", "aria-live": p.live ? "polite" : undefined }, (p.lines || []).map(function (l, i) {
          return typeof l === "string" ? l + "\n" : h("span", { key: i, className: l.k ? "t-" + l.k : undefined }, l.t + "\n");
        })),
        p.prompt && h("div", { className: "eg-term-prompt" }, h(Icon, { name: "chevron-right", size: "sm" }), p.prompt));
    };
    var RunRow = function (p) {
      return h("div", { className: cx("eg-run", p.live && "is-live") },
        p.live ? h(StatusDot, { state: "live" }) : h(StatusIcon, { status: p.status || "done" }),
        h("div", { style: { minWidth: 0 } }, h("div", { className: "eg-run-title" }, p.title), p.detail && h("div", { className: "eg-run-meta" }, p.detail)),
        h("span", { className: "eg-run-meta" }, p.meta));
    };
    var Banner = function (p) {
      return h("div", { className: cx("eg-banner", p.tone && "eg-banner-" + p.tone), role: p.tone === "warning" ? "status" : undefined },
        h(Icon, { name: p.icon || "info" }),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { className: "eg-banner-title" }, p.title), p.text && h("div", { className: "eg-banner-text" }, p.text),
          p.steps && h("ol", { className: "eg-steps" }, p.steps.map(function (s, i) { return h("li", { key: i }, h("span", null, s)); })),
          p.actions && h("div", { className: "eg-banner-actions" }, p.actions)));
    };
    var EmptyState = function (p) {
      return h("div", { className: "eg-empty" }, h("div", { className: "eg-empty-icon" }, h(Icon, { name: p.icon || "inbox" })),
        h("div", { className: "eg-empty-title" }, p.title), p.text && h("div", { className: "eg-empty-text" }, p.text),
        p.actions && h("div", { className: "eg-empty-actions" }, p.actions));
    };
    var CodeBlock = function (p) {
      return h("div", { className: "eg-code" },
        h("div", { className: "eg-code-head" }, h("span", null, p.file || p.lang), h("span", { className: "eg-spacer" }), h(IconButton, { icon: "copy", label: "Copy code", size: "sm" })),
        h("pre", null, h("code", null, p.code)));
    };

    Object.assign(api, { Icon: Icon, Button: Button, IconButton: IconButton, Kbd: Kbd, Input: Input, Field: Field, Checkbox: Checkbox, Switch: Switch, Badge: Badge, StatusDot: StatusDot, StatusIcon: StatusIcon, PriorityIcon: PriorityIcon, AgentStatus: AgentStatus, Tabs: Tabs, SegmentedControl: SegmentedControl, Menu: Menu, Dialog: Dialog, Toast: Toast, DocHeading: DocHeading, RunState: RunState, TaskLine: TaskLine, EditorToolbar: EditorToolbar, SelectionToolbar: SelectionToolbar, Composer: Composer, Terminal: Terminal, RunRow: RunRow, Banner: Banner, EmptyState: EmptyState, CodeBlock: CodeBlock });
  }
  window.Ergo = Object.assign(window.Ergo || {}, api);
})();
