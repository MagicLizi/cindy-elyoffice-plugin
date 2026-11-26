'use strict';
/*
 * ElyOffice 插件设置页：只负责展示与点击，三行与 Cindy 原生设置行同一规格。
 * 经 BroadcastChannel 与插件逻辑（main.js）通信：先 /wake 唤醒，再按请求编号反复重发直到收到回执。
 * 界面语言只跟随 Cindy（/app-context）：zh-CN 显示中文，其余显示英文。
 */

(function () {
  var STRINGS = {
    'zh-CN': {
      githubTitle: 'GitHub 连接',
      githubDesc: '可选。常规版本检查无需 Token；旧版 Cindy 获取安装包大小时使用。由 Cindy 加密保存，仅发给 GitHub API。',
      githubLabel: '备用 GitHub Personal Access Token',
      githubSave: '保存 Token', githubClear: '清除 Token', githubGet: '创建 Token',
      githubHost: '已检测到本机 GitHub 登录，将优先使用。',
      githubSaved: '备用 Token 已保存', githubMissing: '未保存备用 Token。请填写后保存，或连接本机 GitHub 账号。',
      githubFailed: '操作失败，请重试。', githubSavedFeedback: '已保存。可点击上方“重试”或“检查更新”。',
      githubCleared: '已清除备用 Token；本机 GitHub 登录仍可使用。', githubEmpty: '请先输入 Token。',
      appTitle: 'ElyOffice 应用',
      homeLink: '官网',
      checking: '正在检查…',
      ready: '已就绪',
      notInstalled: '未安装',
      unsupported: '这台电脑暂不支持一键安装',
      versionLabel: function (v) { return '版本 ' + v; },
      upToDate: '已是最新版本',
      checkingUpdate: '正在检查更新…',
      updateCheckFailed: '暂时没能检查更新',
      updateCheckRateLimited: '暂时没能检查更新：GitHub 限制了当前网络的查询次数，稍后再试',
      updateAvailable: function (v) { return '有新版本 ' + v; },
      installDesc: '免费开源的办公软件。装好后，Cindy 里的 Word、Excel、PPT 可以用它打开，AI 也能直接在文档里修改。',
      installMeta: function (v, size) {
        return '最新版本 ' + v + (size ? ' · 下载约 ' + size : '') + ' · 装好后约占 1 GB';
      },
      installNoteWin: '后台安装，不弹窗口；之后会随开机预热，打开文件更快。',
      installNoteMac: '下载并核对后会打开系统安装器，按提示点几下、输入一次电脑密码即可。',
      unsupportedDesc: '请到 ElyOffice 官网按说明安装，装好后这里会自动识别。',
      manualLead: '也可以自己下载安装：',
      manualDirect: function (v) { return '下载 ElyOffice' + (v ? ' ' + v : '') + ' 安装包'; },
      manualPage: '打开 ElyOffice 发布页',
      manualTail: '。装好后回到这里，会自动识别。',
      preparing: '正在准备',
      preparingDesc: '正在查找最新版本，并核对官方签名。',
      downloading: function (v) { return '正在下载 ' + (v || ''); },
      verifying: '正在核对文件…',
      retrying: function (n) { return '网络不太稳定，正在重试' + (n ? '（第 ' + n + ' 次）' : '') + '…'; },
      etaSec: function (n) { return '大约还要 ' + n + ' 秒'; },
      etaMin: function (n) { return '大约还要 ' + n + ' 分钟'; },
      downloadNote: '可以离开这个页面，下载会在后台继续。',
      installing: function (v) { return '正在安装 ' + (v || ''); },
      installingDesc: '已核对官方签名。不需要你操作，通常要几分钟，装好后会通知你。',
      waiting: '等待系统安装器',
      waitingDesc: '安装器已经打开，按提示点几下、输入一次电脑密码即可。装好后这里会自动更新。',
      uninstalling: '正在卸载',
      uninstallingDesc: '通常不到一分钟。',
      install: '安装',
      update: function (v) { return '更新到 ' + v; },
      checkUpdate: '检查更新',
      cancel: '取消',
      stop: '不装了',
      retry: '重试',
      resume: '继续下载',
      closedContinue: '已关闭，继续',
      retryUninstall: '重新卸载',
      dismiss: '知道了',
      autosaveTitle: 'AI 改完自动保存',
      autosaveDesc: function (key) {
        return '关闭时，AI 改完由你检查，再按 ' + key + ' 保存。打开后每次改完立即保存，你没存的改动也会一起存下。';
      },
      uninstallTitle: '卸载 ElyOffice',
      uninstallDesc: '从这台电脑移除全部 ElyOffice 应用，你的文档不受影响。',
      uninstallConfirm: '确定卸载吗？ElyOffice 的全部应用都会被移除。',
      uninstall: '卸载',
      uninstallYes: '确定卸载',
      unresponsive: '插件后台没有响应',
      unresponsiveDesc: '稍等几秒再试；如果一直这样，可以把插件停用再启用。',
      runningDocs: function (app, docs) { return app + ' 里还开着：' + docs.join('、'); },
      runningApp: function (app) { return app + ' 正在运行'; },
      errors: {
        APPS_RUNNING: ['请先关闭 ElyOffice', '更新或卸载前，要先保存并关闭 ElyOffice。'],
        DOWNLOAD_FAILED: ['下载没完成', '网络好像不太稳定。已经下载的部分会保留，点「继续下载」会接着下。'],
        DISK_FULL: ['磁盘空间不够', function (d) {
          return d ? '安装还需要约 ' + d.needGb + ' GB，' + d.drive + ' 只剩 ' + d.freeGb + ' GB。请先清理一些空间。' : '请先清理一些磁盘空间再试。';
        }],
        SIGNATURE_INVALID: ['没有通过安全核对', '下载的内容和 ElyOffice 官方签名对不上，已停止，没有安装任何东西。'],
        CHECKSUM_MISMATCH: ['没有通过安全核对', '下载的内容和 ElyOffice 官方签名对不上，已停止，没有安装任何东西。'],
        MANIFEST_INVALID: ['版本信息不对', 'ElyOffice 发布页上的版本信息不符合预期，已停止。请稍后再试。'],
        GITHUB_RATE_LIMITED: ['GitHub 请求额度已用完', '请稍后重试，或在下方配置 GitHub Token。'],
        GITHUB_AUTH_FAILED: ['GitHub Token 无效或无权访问', '请检查本机 GitHub 登录，或在下方替换备用 Token。'],
        NETWORK_FAILED: ['连不上 GitHub', '请检查网络后重试。ElyOffice 从它在 GitHub 上的官方发布页下载。'],
        INSTALL_FAILED: ['安装没有完成', {
          busy: '部分文件正被占用。请关闭所有 ElyOffice 窗口后重试。',
          timeout: '等了很久也没有看到 ElyOffice 装好。如果系统安装器还开着，请完成安装后重试。',
          generic: '请重试；如果还是不行，可以到 ElyOffice 官网手动下载安装。',
        }],
        UNINSTALL_FAILED: ['卸载没有完成', '请关闭所有 ElyOffice 窗口后再试，或在 Windows「设置 → 应用」里卸载。'],
        UNINSTALLER_MISSING: ['找不到卸载程序', '请在 Windows「设置 → 应用」里卸载 ElyOffice。'],
        UNSUPPORTED_PLATFORM: ['这台电脑暂不支持一键安装', '请到 ElyOffice 官网按说明安装。'],
        JOB_RUNNING: ['正在进行另一项操作', '请等它完成后再试。'],
        NODE_UNAVAILABLE: ['插件后台没有响应', '稍等几秒再试。'],
      },
      errorTitle: '出了点问题',
    },
    en: {
      githubTitle: 'GitHub Connection',
      githubDesc: 'Optional. Normal release checks need no token. Older Cindy uses it for the installer-size API request. Cindy encrypts it and sends it only to the GitHub API.',
      githubLabel: 'Backup GitHub Personal Access Token',
      githubSave: 'Save Token', githubClear: 'Clear Token', githubGet: 'Create Token',
      githubHost: 'Local GitHub sign-in detected; it takes priority.',
      githubSaved: 'Backup token saved', githubMissing: 'No backup token saved. Save a token or connect your local GitHub account.',
      githubFailed: 'Operation failed. Please try again.', githubSavedFeedback: 'Saved. Use Try Again or Check for Updates above.',
      githubCleared: 'Backup token cleared. Local GitHub sign-in is still available.', githubEmpty: 'Enter a token first.',
      appTitle: 'ElyOffice App',
      homeLink: 'Website',
      checking: 'Checking…',
      ready: 'Ready',
      notInstalled: 'Not installed',
      unsupported: 'One-click install is not available on this computer',
      versionLabel: function (v) { return 'Version ' + v; },
      upToDate: "You're up to date",
      checkingUpdate: 'Checking for updates…',
      updateCheckFailed: "Couldn't check for updates",
      updateCheckRateLimited: "Couldn't check for updates: GitHub is limiting requests from this network. Try again later.",
      updateAvailable: function (v) { return 'Version ' + v + ' is available'; },
      installDesc: 'A free, open-source office suite. Once installed, Word, Excel and PowerPoint files from Cindy can open in it, and AI can edit them right in the document.',
      installMeta: function (v, size) {
        return 'Latest ' + v + (size ? ' · ' + size + ' download' : '') + ' · about 1 GB installed';
      },
      installNoteWin: 'Installs quietly in the background, then warms up at startup so files open faster.',
      installNoteMac: 'After the download is checked, the system installer opens. Follow its steps and enter your Mac password once.',
      unsupportedDesc: 'Install ElyOffice from its website. This page detects it once it is installed.',
      manualLead: 'You can also install it yourself: ',
      manualDirect: function (v) { return 'Download the ElyOffice' + (v ? ' ' + v : '') + ' installer'; },
      manualPage: 'Open the ElyOffice releases page',
      manualTail: '. Come back here afterwards and it is detected automatically.',
      preparing: 'Getting ready',
      preparingDesc: 'Finding the latest release and checking its official signature.',
      downloading: function (v) { return 'Downloading ' + (v || ''); },
      verifying: 'Checking the file…',
      retrying: function (n) { return 'The connection is unstable. Retrying' + (n ? ' (attempt ' + n + ')' : '') + '…'; },
      etaSec: function (n) { return 'About ' + n + ' s left'; },
      etaMin: function (n) { return 'About ' + n + ' min left'; },
      downloadNote: 'You can leave this page. The download continues in the background.',
      installing: function (v) { return 'Installing ' + (v || ''); },
      installingDesc: 'The official signature checked out. Nothing to do here; it usually takes a few minutes and you will be notified.',
      waiting: 'Waiting for the system installer',
      waitingDesc: 'The installer is open. Follow its steps and enter your Mac password once. This page updates when it is done.',
      uninstalling: 'Uninstalling',
      uninstallingDesc: 'This usually takes less than a minute.',
      install: 'Install',
      update: function (v) { return 'Update to ' + v; },
      checkUpdate: 'Check for Updates',
      cancel: 'Cancel',
      stop: 'Stop',
      retry: 'Try Again',
      resume: 'Resume',
      closedContinue: 'Continue',
      retryUninstall: 'Uninstall Again',
      dismiss: 'OK',
      autosaveTitle: 'Save Automatically After AI Edits',
      autosaveDesc: function (key) {
        return 'When off, you review AI edits and press ' + key + ' to save. When on, each AI edit is saved right away, along with any unsaved changes of yours.';
      },
      uninstallTitle: 'Uninstall ElyOffice',
      uninstallDesc: 'Removes all ElyOffice apps from this computer. Your documents are not affected.',
      uninstallConfirm: 'Uninstall? All ElyOffice apps will be removed.',
      uninstall: 'Uninstall',
      uninstallYes: 'Uninstall',
      unresponsive: 'The plugin is not responding',
      unresponsiveDesc: 'Wait a few seconds and try again. If it keeps happening, turn the plugin off and on again.',
      runningDocs: function (app, docs) { return app + ' still has open: ' + docs.join(', '); },
      runningApp: function (app) { return app + ' is running'; },
      errors: {
        APPS_RUNNING: ['Close ElyOffice first', 'Save your work and close ElyOffice before updating or uninstalling it.'],
        DOWNLOAD_FAILED: ["The download didn't finish", 'The connection seems unstable. What was already downloaded is kept; Resume picks up where it left off.'],
        DISK_FULL: ['Not enough disk space', function (d) {
          return d ? 'ElyOffice needs about ' + d.needGb + ' GB, but ' + d.drive + ' has only ' + d.freeGb + ' GB free. Free up some space first.' : 'Free up some disk space and try again.';
        }],
        SIGNATURE_INVALID: ['Failed the security check', "The download doesn't match ElyOffice's official signature. Nothing was installed."],
        CHECKSUM_MISMATCH: ['Failed the security check', "The download doesn't match ElyOffice's official signature. Nothing was installed."],
        MANIFEST_INVALID: ['The release information looks wrong', 'The version information on the ElyOffice releases page is not what was expected. Try again later.'],
        GITHUB_RATE_LIMITED: ['GitHub rate limit exceeded', 'Try later or configure a GitHub token below.'],
        GITHUB_AUTH_FAILED: ['GitHub authentication failed', 'Check local GitHub sign-in or replace the backup token below.'],
        NETWORK_FAILED: ["Can't reach GitHub", 'Check your connection and try again. ElyOffice downloads from its official GitHub releases.'],
        INSTALL_FAILED: ["Installation didn't finish", {
          busy: 'Some files are in use. Close all ElyOffice windows and try again.',
          timeout: "ElyOffice still isn't installed. If the system installer is open, finish it and try again.",
          generic: 'Try again. If it still fails, download and install ElyOffice from its website.',
        }],
        UNINSTALL_FAILED: ["Uninstall didn't finish", 'Close all ElyOffice windows and try again, or uninstall it in Windows Settings > Apps.'],
        UNINSTALLER_MISSING: ["Can't find the uninstaller", 'Uninstall ElyOffice in Windows Settings > Apps.'],
        UNSUPPORTED_PLATFORM: ['One-click install is not available here', 'Install ElyOffice from its website.'],
        JOB_RUNNING: ['Another operation is running', 'Wait for it to finish, then try again.'],
        NODE_UNAVAILABLE: ['The plugin is not responding', 'Wait a few seconds and try again.'],
      },
      errorTitle: 'Something went wrong',
    },
  };

  // 已装好 ElyOffice 时，这几类失败只影响更新，不影响使用。
  var SOFT_ERRORS = { NETWORK_FAILED: true, GITHUB_RATE_LIMITED: true, DOWNLOAD_FAILED: true };

  var channel = new BroadcastChannel('elyoffice');
  var pending = new Map();
  var seq = 0;
  var state = null;
  var confirmingUninstall = false;
  var unresponsive = false;
  var checkingUpdate = false;
  var lang = 'en';
  var T = STRINGS.en;

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    appDot: $('app-dot'),
    appStatus: $('app-status'),
    appVersion: $('app-version'),
    appLatest: $('app-latest'),
    appLink: $('app-link'),
    appDesc: $('app-desc'),
    appActions: $('app-actions'),
    appExtra: $('app-extra'),
    meter: $('meter'),
    meterFill: $('meter-fill'),
    meterText: $('meter-text'),
    notice: $('notice'),
    noticeText: $('notice-text'),
    noticeList: $('notice-list'),
    appNote: $('app-note'),
    manual: $('manual'),
    manualLead: $('manual-lead'),
    manualLink: $('manual-link'),
    manualTail: $('manual-tail'),
    autosaveRow: $('autosave-row'),
    autosave: $('autosave'),
    autosaveDesc: $('autosave-desc'),
    uninstallRow: $('uninstall-row'),
    uninstallDesc: $('uninstall-desc'),
    uninstallActions: $('uninstall-actions'),
  };

  // ───────────── 语言与通信 ─────────────

  async function loadLang() {
    try {
      var r = await (await fetch('/app-context')).json();
      var ctx = (r && r.context) || {};
      lang = (ctx.uiLocale || ctx.locale) === 'zh-CN' ? 'zh-CN' : 'en';
    } catch (e) {
      lang = 'en';
    }
    T = STRINGS[lang];
    document.documentElement.lang = lang;
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
      loadLang().then(function () { render(); loadGithub(); });
    }
  };

  function apply(next) {
    state = next;
    unresponsive = false;
    render();
  }

  // ───────────── 小工具 ─────────────

  function mb(bytes) {
    if (!bytes && bytes !== 0) return '';
    return Math.max(1, Math.round(bytes / 1048576)) + ' MB';
  }

  function eta(loaded, total, speed) {
    if (!speed || !total || loaded >= total) return '';
    var s = (total - loaded) / speed;
    return s < 60 ? T.etaSec(Math.max(1, Math.round(s))) : T.etaMin(Math.round(s / 60));
  }

  function button(label, kind, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (kind ? ' ' + kind : '');
    b.textContent = label;
    b.addEventListener('click', function () {
      b.disabled = true;
      Promise.resolve(onClick()).finally(function () {
        b.disabled = false;
      });
    });
    return b;
  }

  function act(action) {
    return function () { return request(action); };
  }

  function show(node, text) {
    node.textContent = text || '';
    node.hidden = !text;
  }

  function setActions(container, list) {
    container.replaceChildren.apply(container, list);
    container.hidden = list.length === 0;
  }

  function setStatus(tone, text) {
    if (tone) el.appDot.dataset.tone = tone;
    else delete el.appDot.dataset.tone;
    el.appStatus.textContent = text;
  }

  function setMeter(mode, ratio, text) {
    el.meter.hidden = !mode;
    if (mode) {
      el.meter.dataset.mode = mode;
      el.meterFill.style.width = mode === 'determinate' ? Math.round(Math.max(0, Math.min(1, ratio || 0)) * 100) + '%' : '';
    }
    show(el.meterText, mode ? text : '');
  }

  function setNotice(text, running) {
    el.notice.hidden = !text;
    el.noticeText.textContent = text || '';
    var items = (running || []).map(function (r) {
      var li = document.createElement('li');
      li.textContent = r.docs && r.docs.length ? T.runningDocs(r.app, r.docs) : T.runningApp(r.app);
      return li;
    });
    el.noticeList.replaceChildren.apply(el.noticeList, items);
    el.noticeList.hidden = items.length === 0;
  }

  // 自动下载失败时的手动下载入口。普通同页链接由 Cindy 交给系统浏览器打开（会先确认地址）。
  function setManual(s) {
    var m = s && s.manualDownload;
    el.manual.hidden = !(m && typeof m.url === 'string');
    if (el.manual.hidden) return;
    el.manualLink.href = m.url;
    el.manualLink.textContent = m.direct ? T.manualDirect(m.version) : T.manualPage;
    el.manualLead.textContent = T.manualLead;
    el.manualTail.textContent = T.manualTail;
  }

  function syncExtra() {
    el.appExtra.hidden = el.meter.hidden && el.notice.hidden && el.appNote.hidden && el.meterText.hidden && el.manual.hidden;
  }

  function errorText(j) {
    var entry = T.errors[j.errorCode];
    if (!entry) return [T.errorTitle, j.message || ''];
    var body = entry[1];
    if (typeof body === 'function') body = body(j.detail);
    else if (body && typeof body === 'object') body = body[j.reason] || body.generic;
    return [entry[0], body];
  }

  // ───────────── 渲染 ─────────────

  function renderApp(s) {
    var j = s.job || { phase: 'idle' };
    var mac = s.platform === 'darwin';
    show(el.appVersion, '');
    show(el.appLatest, '');
    show(el.appDesc, '');
    show(el.appNote, '');
    setMeter(null);
    setNotice(null);
    setManual(null);
    el.appLink.hidden = s.installed || j.phase !== 'idle';

    if (j.phase === 'checking') {
      setStatus('busy', T.preparing);
      show(el.appDesc, T.preparingDesc);
      setMeter('indeterminate');
      setActions(el.appActions, [button(T.cancel, '', act('cancel'))]);
    } else if (j.phase === 'downloading' || j.phase === 'verifying') {
      setStatus('busy', T.downloading(j.version));
      var line;
      if (j.phase === 'verifying') line = T.verifying;
      else if (j.retrying) line = T.retrying(j.attempt);
      else if (j.total) line = [mb(j.loaded || 0) + ' / ' + mb(j.total), eta(j.loaded || 0, j.total, j.speedBps)].filter(Boolean).join(' · ');
      else line = mb(j.loaded || 0); // 还不知道总大小（下载刚开始）：只显示已下载多少
      setMeter(j.phase === 'verifying' || !j.total ? 'indeterminate' : 'determinate', j.total ? (j.loaded || 0) / j.total : 0, line);
      show(el.appNote, T.downloadNote);
      setActions(el.appActions, [button(T.cancel, '', act('cancel'))]);
    } else if (j.phase === 'installing') {
      setStatus('busy', T.installing(j.version));
      show(el.appDesc, T.installingDesc);
      setMeter('indeterminate');
      setActions(el.appActions, []);
    } else if (j.phase === 'waiting-user') {
      setStatus('busy', T.waiting);
      show(el.appDesc, T.waitingDesc);
      setMeter('indeterminate');
      setActions(el.appActions, [button(T.stop, '', act('cancel'))]);
    } else if (j.phase === 'uninstalling') {
      setStatus('busy', T.uninstalling);
      show(el.appDesc, T.uninstallingDesc);
      setMeter('indeterminate');
      setActions(el.appActions, []);
    } else if (j.phase === 'error' && s.installed && SOFT_ERRORS[j.errorCode]) {
      // 已装好的 ElyOffice 照常能用：更新没查到或没下完只用灰字说明，不显示红色错误。
      var soft = errorText(j);
      setStatus('ok', T.ready);
      show(el.appVersion, s.version ? T.versionLabel(s.version) : '');
      show(el.appLatest, soft[0]);
      show(el.appNote, soft[1]);
      setManual(s);
      setActions(el.appActions, [
        button(T.dismiss, '', act('dismiss')),
        button(j.errorCode === 'DOWNLOAD_FAILED' ? T.resume : T.retry, 'primary', act('install')),
      ]);
    } else if (j.phase === 'error') {
      var text = errorText(j);
      setStatus('error', text[0]);
      setNotice(text[1], j.running);
      if (SOFT_ERRORS[j.errorCode]) setManual(s);
      var retryLabel = j.errorCode === 'DOWNLOAD_FAILED' ? T.resume
        : j.errorCode === 'APPS_RUNNING' ? T.closedContinue
          : j.errorCode === 'UNINSTALL_FAILED' ? T.retryUninstall : T.retry;
      var retryAction = j.errorCode === 'UNINSTALL_FAILED' ? 'uninstall' : 'install';
      setActions(el.appActions, [
        button(T.dismiss, '', act('dismiss')),
        button(retryLabel, 'primary', act(retryAction)),
      ]);
    } else if (!s.installed && s.installSupported === false) {
      setStatus(null, T.unsupported);
      show(el.appDesc, T.unsupportedDesc);
      setActions(el.appActions, []);
    } else if (!s.installed) {
      setStatus(null, T.notInstalled);
      show(el.appDesc, T.installDesc);
      var note = mac ? T.installNoteMac : T.installNoteWin;
      show(el.appNote, s.latest
        ? T.installMeta(s.latest.version, mb(s.latest.bytes)) + (lang === 'zh-CN' ? '。' : '. ') + note
        : note);
      setActions(el.appActions, [button(T.install, 'primary', act('install'))]);
    } else {
      setStatus('ok', T.ready);
      show(el.appVersion, s.version ? T.versionLabel(s.version) : '');
      if (s.updateAvailable && s.latest) {
        show(el.appLatest, T.updateAvailable(s.latest.version));
        setActions(el.appActions, [button(T.update(s.latest.version), 'primary', act('install'))]);
      } else {
        var failedLine = s.latestErrorCode === 'GITHUB_RATE_LIMITED' ? T.updateCheckRateLimited : T.updateCheckFailed;
        show(el.appLatest, checkingUpdate ? T.checkingUpdate : s.latestError ? failedLine : s.latest ? T.upToDate : '');
        setActions(el.appActions, [button(T.checkUpdate, '', checkUpdate)]);
      }
    }
    syncExtra();
  }

  function renderUninstall(s) {
    var j = s.job || { phase: 'idle' };
    var idle = j.phase === 'idle' || j.phase === 'done';
    el.uninstallRow.hidden = !(s.installed && s.platform === 'win32' && idle);
    if (el.uninstallRow.hidden) return;
    if (confirmingUninstall) {
      show(el.uninstallDesc, T.uninstallConfirm);
      setActions(el.uninstallActions, [
        button(T.cancel, '', function () {
          confirmingUninstall = false;
          render();
        }),
        button(T.uninstallYes, 'danger-solid', function () {
          confirmingUninstall = false;
          render();
          return request('uninstall');
        }),
      ]);
    } else {
      show(el.uninstallDesc, T.uninstallDesc);
      setActions(el.uninstallActions, [
        button(T.uninstall, 'danger', function () {
          confirmingUninstall = true;
          render();
        }),
      ]);
    }
  }

  function render() {
    var s = state;
    var mac = Boolean(s && s.platform === 'darwin');
    el.autosaveDesc.textContent = T.autosaveDesc(mac ? 'Cmd+S' : 'Ctrl+S');

    if (unresponsive || !s || !s.ready) {
      setStatus(unresponsive ? 'error' : 'busy', unresponsive ? T.unresponsive : T.checking);
      show(el.appVersion, '');
      show(el.appLatest, '');
      show(el.appDesc, unresponsive ? T.unresponsiveDesc : '');
      show(el.appNote, '');
      setMeter(null);
      setNotice(null);
      syncExtra();
      setActions(el.appActions, unresponsive ? [button(T.retry, '', load)] : []);
      el.autosaveRow.hidden = true;
      el.uninstallRow.hidden = true;
      return;
    }

    renderApp(s);
    el.autosaveRow.hidden = !s.installed;
    el.autosave.checked = Boolean(s.autoSave);
    renderUninstall(s);
  }

  // ───────────── 交互 ─────────────

  async function checkUpdate() {
    checkingUpdate = true;
    render();
    await request('check-update');
    checkingUpdate = false;
    render();
  }

  el.autosave.addEventListener('change', function () {
    var value = el.autosave.checked;
    el.autosave.disabled = true;
    request('set-auto-save', { value: value }).finally(function () {
      el.autosave.disabled = false;
    });
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

  async function loadGithub() {
    var r = await fetch('/secrets');
    if (!r.ok) throw new Error('SECRET_STATUS_FAILED');
    var list = await r.json();
    var secret = list.find(function (x) { return x.key === 'github_token'; });
    if (!secret) throw new Error('SECRET_NOT_DECLARED');
    var parts = [];
    if (secret.hostAvailable && !secret.hostManagedSetup) parts.push(T.githubHost);
    parts.push(secret.saved ? T.githubSaved + (secret.tail ? ' · …' + secret.tail : '') : T.githubMissing);
    $('github-status').textContent = parts.join(' ');
    $('github-clear').disabled = !secret.saved;
  }

  async function changeGithub(remove) {
    var input = $('github-token');
    if (!remove && !input.value.trim()) {
      $('github-feedback').textContent = T.githubEmpty;
      return;
    }
    $('github-save').disabled = true;
    $('github-clear').disabled = true;
    var options = { method: remove ? 'DELETE' : 'PUT' };
    if (!remove) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify({ value: input.value.trim() });
    }
    input.value = '';
    try {
      var response = await fetch('/secrets/github_token', options);
      options.body = undefined;
      if (!response.ok) throw new Error('SECRET_WRITE_FAILED');
      $('github-feedback').textContent = remove ? T.githubCleared : T.githubSavedFeedback;
    } catch (_) {
      $('github-feedback').textContent = T.githubFailed;
    } finally {
      options.body = undefined;
      $('github-save').disabled = false;
      await loadGithub().catch(function () { $('github-status').textContent = T.githubFailed; });
    }
  }
  $('github-form').addEventListener('submit', function (event) { event.preventDefault(); changeGithub(false); });
  $('github-clear').addEventListener('click', function () { changeGithub(true); });

  loadLang().then(function () {
    load();
    loadGithub().catch(function () { $('github-status').textContent = T.githubFailed; });
  });
  // 用户去浏览器下载安装后切回来：重新检查是否装好。只在可能刚装好的状态下检查，并限制频率。
  var lastRecheck = 0;
  function recheckOnReturn() {
    if (document.visibilityState === 'hidden' || !state) return;
    var j = state.job || { phase: 'idle' };
    var mayHaveInstalled = (j.phase === 'error' && SOFT_ERRORS[j.errorCode]) ||
      (!state.installed && (j.phase === 'idle' || j.phase === 'done'));
    if (!mayHaveInstalled || Date.now() - lastRecheck < 5000) return;
    lastRecheck = Date.now();
    request('state');
  }
  window.addEventListener('focus', recheckOnReturn);
  document.addEventListener('visibilitychange', recheckOnReturn);

})();
