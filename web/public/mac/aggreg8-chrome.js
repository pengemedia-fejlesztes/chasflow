// A felhasználó saját Chrome-jának vezérlése a folyamatazonosító (PID) alapján – így nem keveredik össze a gépen
// futó másik (pl. robot) Chrome-példánnyal. Használat: osascript -l JavaScript aggreg8-chrome.js <pid> <művelet> [a1] [a2]
function run(argv) {
  var pid = Number(argv[0]),
    act = argv[1],
    a1 = argv[2] || '',
    a2 = argv[3] || '';
  var app = Application(pid);
  var tabs = [];
  var ws = app.windows();
  for (var i = 0; i < ws.length; i++) {
    var w = ws[i],
      ts = w.tabs();
    for (var j = 0; j < ts.length; j++) {
      var t = ts[j];
      tabs.push({ w: w, t: t, j: j + 1, id: String(t.id()), url: String(t.url() || '') });
    }
  }
  var find = function (id) {
    return tabs.filter(function (x) {
      return x.id === id;
    })[0];
  };
  var exec = function (t, code) {
    var r = app.execute(t, { javascript: code });
    return r === undefined || r === null ? 'missing value' : String(r);
  };
  switch (act) {
    case 'ids':
      return tabs
        .map(function (x) {
          return x.id;
        })
        .join(',');
    case 'urls':
      return tabs
        .map(function (x) {
          return x.url.replace(/^https?:\/\/([^\/]+).*$/, '$1');
        })
        .join(',');
    case 'findnew':
      var n = tabs.filter(function (x) {
        return /aggreg8\.hu|google\.com/.test(x.url) && a1.indexOf(',' + x.id + ',') < 0;
      })[0];
      return n ? n.id : '';
    case 'js':
      var x = find(a1);
      return x ? exec(x.t, a2) : 'NOTAB';
    case 'gjs':
      var g = tabs.filter(function (x) {
        return /accounts\.google\.com/.test(x.url);
      })[0];
      return g ? exec(g.t, a2) : 'NOGOOGLE';
    case 'seturl':
      var y = find(a1);
      if (!y) return 'NOTAB';
      y.t.url = a2;
      return 'OK';
    case 'front':
      var z = find(a1);
      if (!z) return 'NOTAB';
      z.w.activeTabIndex = z.j;
      z.w.index = 1;
      app.activate();
      return 'OK';
    case 'closewin':
      var c = find(a1);
      if (!c) return 'NOTAB';
      c.w.close();
      return 'OK';
  }
  return 'BAD';
}
