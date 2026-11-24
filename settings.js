'use strict';
/*
 * ElyOffice 插件设置页：只负责展示与点击。
 * 经 BroadcastChannel 与插件逻辑（main.js）通信：先 /wake 唤醒，再按请求编号反复重发直到收到回执。
 * 界面语言只跟随 Cindy（/app-context）：zh-CN 显示中文，其余显示英文。
 */

(function () {
  var STRINGS = {
    'zh-CN': {
      checking: '正在检查 ElyOffice…',
      unresponsiveTitle: '插件后台没有响应',
      unresponsiveDesc: '请稍等几秒后重试；如果一直这样，可以在插件页把 ElyOffice 停用再启用。',
      retry: '重试',
      cancel: '取消',
      close: '关闭',
      preparingTitle: '正在准备…',
      preparingDesc: '正在查找 ElyOffice 最新版本，并核对官方签名。',
      downloadingTitle: function (v) { return '正在下载 ElyOffice ' + (v || ''); },
      verifying: '正在核对文件…',
      retrying: function (n) { return '网络不太稳定，正在重试' + (n ? '（第 ' + n + ' 次）' : '') + '…'; },
      etaSec: function (n) { return '大约还要 ' + n + ' 秒'; },
      etaMin: function (n) { return '大约还要 ' + n + ' 分钟'; },
      downloadNote: '可以离开这个页面，下载会在后台继续。',
      installingTitle: function (v) { return '正在安装 ElyOffice ' + (v || ''); },
      installingDesc: '已核对官方签名。安装不需要你操作，通常要几分钟，装好后会通知你。',
      waitingTitle: '请在系统安装器里完成安装',
      waitingDesc: '安装器已经打开，按提示点几下、输入一次电脑密码即可。装好后这里会自动更新。',
      waitingCancel: '不装了',
      uninstallingTitle: '正在卸载 ElyOffice…',
      uninstallingDesc: '通常不到一分钟。',
      continueDownload: '继续下载',
      closedContinue: '已关闭，继续',
      retryUninstall: '重新卸载',
      unsupportedTitle: '这台电脑暂不支持一键安装',
      unsupportedDesc: '请到 ElyOffice 官方主页按说明安装，装好后打开这个页面就会自动识别。',
      installTitle: '还差一步：安装 ElyOffice',
      installDesc: 'ElyOffice 是免费开源的办公软件。装好后，就能在 Cindy 里用它打开 Word、Excel、PPT，并让 AI 直接在文档里帮你改。',
      installMeta: function (v, size) { return '最新版本 ' + v + ' · 下载约 ' + size + ' · 装好后约占 1 GB · 来自 ElyOffice 官方 GitHub 发布页'; },
      latestLoading: '正在查找最新版本…',
      latestUnavailable: '暂时没取到最新版本信息，点「安装 ElyOffice」时会再试一次。',
      installBtn: '安装 ElyOffice',
      installNoteWin: '安装过程不需要你操作，也不会弹出窗口。装好后 ElyOffice 会在开机时于后台准备文档引擎，让打开文件更快。',
      installNoteMac: '下载并核对后会打开系统安装器，按提示点几下、输入一次电脑密码即可。',
      updateTitle: function (v) { return 'ElyOffice ' + v + ' 可以更新'; },
      updateDesc: function (cur) { return '当前是 ' + (cur || '旧版本') + '。更新前需要先关闭 ElyOffice。'; },
      updateMeta: function (size) { return '下载约 ' + size; },
      updateBtn: function (v) { return '更新到 ' + v; },
      installedTitle: function (v) { return 'ElyOffice ' + (v || '') + ' 已装好'; },
      readyTitle: function (v) { return 'ElyOffice ' + (v || '') + ' 已就绪'; },
      readyDesc: '试试对 AI 说：「用 ElyOffice 打开季度报告，把 TODO 改成 1280」',
      upToDate: '已是最新版本',
      updateCheckFailed: '暂时没能检查更新，稍后再试。',
      checkUpdate: '检查更新',
      readyNote: 'ElyOffice 会在开机时于后台准备文档引擎，让打开文件更快。',
      runningDocs: function (app, docs) { return app + ' 里还开着：' + docs.join('、'); },
      runningApp: function (app) { return app + ' 正在运行'; },
      confirmText: '卸载后，ElyOffice 的全部应用都会从这台电脑移除；你的文档不受影响。',
      confirmYes: '确定卸载',
      autosaveLabel: 'AI 改完自动保存',
      autosaveHint: function (key) {
        return '关闭时（推荐），AI 的改动只显示在 ElyOffice 窗口里，你检查后按 ' + key + ' 保存。打开后，AI 每次改完都会立即保存，也会一并保存你自己还没存的改动。';
      },
      homeLink: 'ElyOffice 官方主页 ↗',
      uninstallLink: '卸载 ElyOffice',
      errors: {
        APPS_RUNNING: ['请先关闭 ElyOffice', '更新或卸载前，要先保存并关闭 ElyOffice。'],
        DOWNLOAD_FAILED: ['下载没完成', '网络好像不太稳定。已经下载的部分会保留，点「继续下载」会接着下。'],
        DISK_FULL: ['磁盘空间不够', function (d) {
          return d ? '安装 ElyOffice 还需要约 ' + d.needGb + ' GB，' + d.drive + ' 只剩 ' + d.freeGb + ' GB。请先清理一些空间。' : '请先清理一些磁盘空间再试。';
        }],
        SIGNATURE_INVALID: ['文件没有通过安全核对', '下载的内容和 ElyOffice 官方签名对不上，已停止，没有安装任何东西。'],
        CHECKSUM_MISMATCH: ['文件没有通过安全核对', '下载的内容和 ElyOffice 官方签名对不上，已停止，没有安装任何东西。'],
        MANIFEST_INVALID: ['版本信息不对', 'ElyOffice 发布页上的版本信息不符合预期，已停止。请稍后再试。'],
        NETWORK_FAILED: ['连不上 GitHub', '请检查网络后重试。ElyOffice 从它在 GitHub 上的官方发布页下载。'],
        INSTALL_FAILED: ['安装没有完成', {
          busy: '部分文件正被占用。请关闭所有 ElyOffice 窗口后点「重试」。',
          timeout: '等了很久也没有看到 ElyOffice 装好。如果系统安装器还开着，请完成安装后点「重试」。',
          generic: '请点「重试」；如果还是不行，可以到 ElyOffice 官方主页手动下载安装。',
        }],
        UNINSTALL_FAILED: ['卸载没有完成', '请关闭所有 ElyOffice 窗口后再试，或在 Windows「设置 → 应用」里卸载。'],
        UNINSTALLER_MISSING: ['找不到卸载程序', '请在 Windows「设置 → 应用」里卸载 ElyOffice。'],
        UNSUPPORTED_PLATFORM: ['这台电脑暂不支持一键安装', '请到 ElyOffice 官方主页按说明安装。'],
        JOB_RUNNING: ['正在进行另一项操作', '请等它完成后再试。'],
        NODE_UNAVAILABLE: ['插件后台没有响应', '请稍等几秒后重试。'],
      },
      errorTitle: '出了点问题',
    },
    en: {
      checking: 'Checking ElyOffice…',
      unresponsiveTitle: 'The plugin is not responding',
      unresponsiveDesc: 'Wait a few seconds and try again. If this keeps happening, turn ElyOffice off and on again on the Plugins page.',
      retry: 'Try again',
      cancel: 'Cancel',
      close: 'Close',
      preparingTitle: 'Getting ready…',
      preparingDesc: 'Finding the latest ElyOffice release and checking its official signature.',
      downloadingTitle: function (v) { return 'Downloading ElyOffice ' + (v || ''); },
      verifying: 'Checking the file…',
      retrying: function (n) { return 'The connection is unstable. Retrying' + (n ? ' (attempt ' + n + ')' : '') + '…'; },
      etaSec: function (n) { return 'About ' + n + ' s left'; },
      etaMin: function (n) { return 'About ' + n + ' min left'; },
      downloadNote: 'You can leave this page. The download continues in the background.',
      installingTitle: function (v) { return 'Installing ElyOffice ' + (v || ''); },
      installingDesc: 'The official signature checked out. Installation needs nothing from you and usually takes a few minutes. You will be notified when it is done.',
      waitingTitle: 'Finish installing in the system installer',
      waitingDesc: 'The installer is open. Follow its steps and enter your Mac password once. This page updates when it is done.',
      waitingCancel: 'Stop',
      uninstallingTitle: 'Uninstalling ElyOffice…',
      uninstallingDesc: 'This usually takes less than a minute.',
      continueDownload: 'Resume download',
      closedContinue: 'I closed it, continue',
      retryUninstall: 'Uninstall again',
      unsupportedTitle: 'One-click install is not available on this computer',
      unsupportedDesc: 'Install ElyOffice from its official page. This page detects it once it is installed.',
      installTitle: 'One more step: install ElyOffice',
      installDesc: 'ElyOffice is a free, open-source office suite. Once it is installed, you can open Word, Excel and PowerPoint files with it from Cindy and let AI edit them right in the document.',
      installMeta: function (v, size) { return 'Latest version ' + v + ' · ' + size + ' download · about 1 GB installed · from the official ElyOffice GitHub releases'; },
      latestLoading: 'Finding the latest version…',
      latestUnavailable: "Couldn't get the latest version yet. Installing tries again.",
      installBtn: 'Install ElyOffice',
      installNoteWin: 'Installation runs in the background, with no windows to click through. Afterwards, ElyOffice prepares its document engines at startup so files open faster.',
      installNoteMac: 'After the download is checked, the system installer opens. Follow its steps and enter your Mac password once.',
      updateTitle: function (v) { return 'ElyOffice ' + v + ' is available'; },
      updateDesc: function (cur) { return 'You have ' + (cur || 'an older version') + '. Close ElyOffice before updating.'; },
      updateMeta: function (size) { return size + ' download'; },
      updateBtn: function (v) { return 'Update to ' + v; },
      installedTitle: function (v) { return 'ElyOffice ' + (v || '') + ' is installed'; },
      readyTitle: function (v) { return 'ElyOffice ' + (v || '') + ' is ready'; },
      readyDesc: 'Try asking AI: "Open the quarterly report in ElyOffice and change TODO to 1280."',
      upToDate: "You're up to date",
      updateCheckFailed: "Couldn't check for updates. Try again later.",
      checkUpdate: 'Check for updates',
      readyNote: 'ElyOffice prepares its document engines at startup so files open faster.',
      runningDocs: function (app, docs) { return app + ' still has open: ' + docs.join(', '); },
      runningApp: function (app) { return app + ' is running'; },
      confirmText: 'This removes all ElyOffice apps from this computer. Your documents are not affected.',
      confirmYes: 'Uninstall',
      autosaveLabel: 'Save automatically after AI edits',
      autosaveHint: function (key) {
        return 'When off (recommended), AI edits only appear in the ElyOffice window, and you press ' + key + ' to save after checking them. When on, each AI edit is saved right away, together with any of your own unsaved changes.';
      },
      homeLink: 'ElyOffice home page ↗',
      uninstallLink: 'Uninstall ElyOffice',
      errors: {
        APPS_RUNNING: ['Close ElyOffice first', 'Save your work and close ElyOffice before updating or uninstalling it.'],
        DOWNLOAD_FAILED: ["The download didn't finish", 'The connection seems unstable. What was already downloaded is kept; Resume download picks up where it left off.'],
        DISK_FULL: ['Not enough disk space', function (d) {
          return d ? 'ElyOffice needs about ' + d.needGb + ' GB, but ' + d.drive + ' has only ' + d.freeGb + ' GB free. Free up some space first.' : 'Free up some disk space and try again.';
        }],
        SIGNATURE_INVALID: ['The file failed the security check', "The download doesn't match ElyOffice's official signature. Nothing was installed."],
        CHECKSUM_MISMATCH: ['The file failed the security check', "The download doesn't match ElyOffice's official signature. Nothing was installed."],
        MANIFEST_INVALID: ['The release information looks wrong', 'The version information on the ElyOffice releases page is not what was expected. Try again later.'],
        NETWORK_FAILED: ["Can't reach GitHub", 'Check your connection and try again. ElyOffice downloads from its official GitHub releases.'],
        INSTALL_FAILED: ["Installation didn't finish", {
          busy: 'Some files are in use. Close all ElyOffice windows and try again.',
          timeout: "ElyOffice still isn't installed. If the system installer is open, finish it and try again.",
          generic: 'Try again. If it still fails, download and install ElyOffice from its official page.',
        }],
        UNINSTALL_FAILED: ["Uninstall didn't finish", 'Close all ElyOffice windows and try again, or uninstall it in Windows Settings > Apps.'],
        UNINSTALLER_MISSING: ["Can't find the uninstaller", 'Uninstall ElyOffice in Windows Settings > Apps.'],
        UNSUPPORTED_PLATFORM: ['One-click install is not available on this computer', 'Install ElyOffice from its official page.'],
        JOB_RUNNING: ['Another operation is running', 'Wait for it to finish, then try again.'],
        NODE_UNAVAILABLE: ['The plugin is not responding', 'Wait a few seconds and try again.'],
      },
      errorTitle: 'Something went wrong',
    },
  };

  var channel = new BroadcastChannel('elyoffice');
  var pending = new Map();
  var seq = 0;
  var state = null;
  var confirmingUninstall = false;
  var unresponsive = false;
  var lang = 'en';
  var T = STRINGS.en;

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    icon: $('status-icon'),
    title: $('title'),
    desc: $('desc'),
    progress: $('progress'),
    fill: $('fill'),
    progressText: $('progress-text'),
    running: $('running'),
    meta: $('meta'),
    actions: $('actions'),
    note: $('note'),
    confirm: $('confirm'),
    confirmYes: $('confirm-yes'),
    confirmNo: $('confirm-no'),
    autosave: $('autosave'),
    autosaveHint: $('autosave-hint'),
    uninstall: $('uninstall'),
  };

  async function loadLang() {
    try {
      var r = await (await fetch('/app-context')).json();
      var ctx = (r && r.context) || {};
      var l = ctx.uiLocale || ctx.locale;
      lang = l === 'zh-CN' ? 'zh-CN' : 'en';
    } catch (e) {
      lang = 'en';
    }
    T = STRINGS[lang];
    document.documentElement.lang = lang === 'zh-CN' ? 'zh-CN' : 'en';
    document.querySelectorAll('[data-i18n]').forEach(function (node) {
      var v = T[node.getAttribute('data-i18n')];
      if (typeof v === 'string') node.textContent = v;
    });
  }

  function request(action, args, timeoutMs) {
    var id = 'r' + Date.now().toString(36) + '-' + (seq += 1);
    return new Promise(function (resolve) {
      var resend = null;
      var timer = setTimeout(function () {
        if (resend) clearInterval(resend);
        pending.delete(id);
        resolve(null);
      }, timeoutMs || 20000);
      pending.set(id, function (data) {
        if (resend) clearInterval(resend);
        clearTimeout(timer);
        resolve(data);
      });
      var send = function () {
        channel.postMessage({ type: 'req', id: id, action: action, args: args || {} });
      };
      // 插件逻辑按需启动：先唤醒，再每 500ms 重发，直到收到回执（对方按编号去重）。
      fetch('/wake').catch(function () {}).then(function () {
        if (!pending.has(id)) return;
        send();
        resend = setInterval(send, 500);
      });
    });
  }

  channel.onmessage = function (ev) {
    var msg = ev && ev.data;
    if (!msg) return;
    if (msg.type === 'res' && pending.has(msg.id)) {
      var done = pending.get(msg.id);
      pending.delete(msg.id);
      done(msg.data);
      if (msg.data && typeof msg.data === 'object' && 'job' in msg.data) apply(msg.data);
    } else if (msg.type === 'state' && msg.state) {
      apply(msg.state);
    } else if (msg.type === 'locale') {
      loadLang().then(render);
    }
  };

  function apply(next) {
    state = next;
    unresponsive = false;
    render();
  }

  // ───────────── 文案工具 ─────────────

  function mb(bytes) {
    if (!bytes && bytes !== 0) return '';
    return Math.max(1, Math.round(bytes / 1048576)) + ' MB';
  }

  function eta(loaded, total, speed) {
    if (!speed || !total || loaded >= total) return '';
    var s = (total - loaded) / speed;
    if (s < 60) return T.etaSec(Math.max(1, Math.round(s)));
    return T.etaMin(Math.round(s / 60));
  }

  function button(label, opts) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (opts.primary ? ' primary' : '');
    b.textContent = label;
    b.addEventListener('click', function () {
      b.disabled = true;
      Promise.resolve(opts.onClick()).finally(function () {
        b.disabled = false;
      });
    });
    return b;
  }

  function act(action) {
    return function () { return request(action); };
  }

  function setActions(list) {
    el.actions.replaceChildren.apply(el.actions, list);
    el.actions.hidden = list.length === 0;
  }

  function setText(node, text) {
    node.textContent = text || '';
    node.hidden = !text;
  }

  function setProgress(mode, ratio, text) {
    if (!mode) {
      el.progress.hidden = true;
      return;
    }
    el.progress.hidden = false;
    el.progress.classList.toggle('indeterminate', mode === 'indeterminate');
    el.fill.style.width = mode === 'indeterminate' ? '' : Math.round(Math.max(0, Math.min(1, ratio || 0)) * 100) + '%';
    el.progressText.textContent = text || '';
    el.progressText.hidden = !text;
  }

  function setRunning(list) {
    if (!list || !list.length) {
      el.running.hidden = true;
      el.running.replaceChildren();
      return;
    }
    var items = list.map(function (r) {
      var li = document.createElement('li');
      li.textContent = r.docs && r.docs.length ? T.runningDocs(r.app, r.docs) : T.runningApp(r.app);
      return li;
    });
    el.running.replaceChildren.apply(el.running, items);
    el.running.hidden = false;
  }

  function errorText(j) {
    var entry = T.errors[j.errorCode];
    if (!entry) return [T.errorTitle, lang === 'zh-CN' ? j.message || '' : ''];
    var body = entry[1];
    if (typeof body === 'function') body = body(j.detail);
    else if (body && typeof body === 'object') body = body[j.reason] || body.generic;
    return [entry[0], body];
  }

  function busy(kind, title, desc) {
    el.icon.dataset.kind = kind;
    el.title.textContent = title;
    setText(el.desc, desc);
  }

  // ───────────── 渲染 ─────────────

  function render() {
    var s = state;
    el.confirm.hidden = !confirmingUninstall;
    el.uninstall.hidden = true;
    setText(el.note, '');
    setRunning(null);
    var mac = Boolean(s && s.platform === 'darwin');
    el.autosaveHint.textContent = T.autosaveHint(mac ? 'Cmd+S' : 'Ctrl+S');

    if (unresponsive) {
      busy('error', T.unresponsiveTitle, T.unresponsiveDesc);
      setProgress(null);
      setText(el.meta, '');
      setActions([button(T.retry, { primary: true, onClick: load })]);
      el.autosave.disabled = true;
      return;
    }
    if (!s || !s.ready) {
      busy('busy', T.checking, '');
      setProgress(null);
      setText(el.meta, '');
      setActions([]);
      el.autosave.disabled = true;
      return;
    }

    el.autosave.disabled = false;
    el.autosave.checked = Boolean(s.autoSave);
    var j = s.job || { phase: 'idle' };

    if (j.phase === 'checking') {
      busy('busy', T.preparingTitle, T.preparingDesc);
      setProgress('indeterminate');
      setText(el.meta, '');
      setActions([button(T.cancel, { onClick: act('cancel') })]);
      return;
    }

    if (j.phase === 'downloading' || j.phase === 'verifying') {
      busy('busy', T.downloadingTitle(j.version), '');
      var ratio = j.total ? (j.loaded || 0) / j.total : 0;
      var line;
      if (j.phase === 'verifying') line = T.verifying;
      else if (j.retrying) line = T.retrying(j.attempt);
      else line = [mb(j.loaded || 0) + ' / ' + mb(j.total), eta(j.loaded || 0, j.total, j.speedBps)].filter(Boolean).join(' · ');
      setProgress(j.phase === 'verifying' ? 'indeterminate' : 'determinate', ratio, line);
      setText(el.meta, '');
      setActions([button(T.cancel, { onClick: act('cancel') })]);
      setText(el.note, T.downloadNote);
      return;
    }

    if (j.phase === 'installing') {
      busy('busy', T.installingTitle(j.version), T.installingDesc);
      setProgress('indeterminate');
      setText(el.meta, '');
      setActions([]);
      return;
    }

    if (j.phase === 'waiting-user') {
      busy('busy', T.waitingTitle, T.waitingDesc);
      setProgress('indeterminate');
      setText(el.meta, '');
      setActions([button(T.waitingCancel, { onClick: act('cancel') })]);
      return;
    }

    if (j.phase === 'uninstalling') {
      busy('busy', T.uninstallingTitle, T.uninstallingDesc);
      setProgress('indeterminate');
      setText(el.meta, '');
      setActions([]);
      return;
    }

    setProgress(null);

    if (j.phase === 'error') {
      var text = errorText(j);
      busy('error', text[0], text[1]);
      setRunning(j.running);
      setText(el.meta, '');
      var retryLabel = j.errorCode === 'DOWNLOAD_FAILED' ? T.continueDownload
        : j.errorCode === 'APPS_RUNNING' ? T.closedContinue
          : j.errorCode === 'UNINSTALL_FAILED' ? T.retryUninstall : T.retry;
      var retryAction = j.errorCode === 'UNINSTALL_FAILED' ? 'uninstall' : 'install';
      setActions([
        button(retryLabel, { primary: true, onClick: act(retryAction) }),
        button(T.close, { onClick: act('dismiss') }),
      ]);
      return;
    }

    if (!s.installed) {
      if (s.installSupported === false) {
        busy('info', T.unsupportedTitle, T.unsupportedDesc);
        setText(el.meta, '');
        setActions([]);
        return;
      }
      busy('install', T.installTitle, T.installDesc);
      setText(el.meta, s.latest ? T.installMeta(s.latest.version, mb(s.latest.bytes)) : (s.latestError ? T.latestUnavailable : T.latestLoading));
      setActions([button(T.installBtn, { primary: true, onClick: act('install') })]);
      setText(el.note, mac ? T.installNoteMac : T.installNoteWin);
      return;
    }

    // 已安装
    el.uninstall.hidden = s.platform !== 'win32' || confirmingUninstall;
    if (s.updateAvailable && s.latest) {
      busy('update', T.updateTitle(s.latest.version), T.updateDesc(s.version));
      setText(el.meta, T.updateMeta(mb(s.latest.bytes)));
      setActions([button(T.updateBtn(s.latest.version), { primary: true, onClick: act('install') })]);
      return;
    }
    var justInstalled = j.phase === 'done' && j.kind === 'install';
    busy('ready', justInstalled ? T.installedTitle(s.version) : T.readyTitle(s.version), T.readyDesc);
    setText(el.meta, s.latest ? T.upToDate : (s.latestError ? T.updateCheckFailed : ''));
    setActions([button(T.checkUpdate, { onClick: act('check-update') })]);
    setText(el.note, T.readyNote);
  }

  // ───────────── 交互 ─────────────

  el.autosave.addEventListener('change', function () {
    var value = el.autosave.checked;
    el.autosave.disabled = true;
    request('set-auto-save', { value: value }).finally(function () {
      el.autosave.disabled = false;
    });
  });

  el.uninstall.addEventListener('click', function () {
    confirmingUninstall = true;
    render();
    el.confirmNo.focus();
  });
  el.confirmNo.addEventListener('click', function () {
    confirmingUninstall = false;
    render();
  });
  el.confirmYes.addEventListener('click', function () {
    confirmingUninstall = false;
    render();
    request('uninstall');
  });

  async function load() {
    unresponsive = false;
    render();
    var data = await request('state');
    if (!data) {
      unresponsive = true;
      render();
    }
  }

  loadLang().then(load);
})();
