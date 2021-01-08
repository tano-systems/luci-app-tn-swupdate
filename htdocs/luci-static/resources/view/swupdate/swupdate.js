/*
 * SPDX-License-Identifier: MIT
 * SPDX-FileCopyrightText: 2021 Tano Systems LLC. All Rights Reserved.
 * 
 * Authors: Anton Kikin <a.kikin@tano-systems.com>
 */

'use strict';
'require rpc';
'require form';
'require ui';
'require fs';

/* Only for debugging */
var logInfoMessages = false;
var logProgressMessages = false;

const UPGRADE_INSTALL_TIMEOUT = 15000;
const UPGRADE_INSTALL_CHECK_INTERVAL = 1000;
const UPLOAD_CURRENT_SPEED_CLEAR_TIMEOUT = 2000;

// EventSource polyfill for IE
if (window && !window.EventSource) {
	console.log('No EventSource, using polyfill');

	var reTrim = /^(\s|\u00A0)+|(\s|\u00A0)+$/g;

	window.EventSource = function(url) {
		var eventsource = this;
		var interval = 500; // polling interval
		var lastEventId = null;
		var cache = '';

		if (!url || typeof url != 'string') {
			throw new SyntaxError('Not enough arguments');
		}

		this.URL = url;
		this.readyState = this.CONNECTING;
		this._pollTimer = null;
		this._xhr = null;

		function pollAgain(interval) {
			eventsource._pollTimer = setTimeout(function() {
				poll.call(eventsource);
			}, interval);
		}

		function poll() {
			try { // force hiding of the error message... insane?
				if (eventsource.readyState == eventsource.CLOSED)
					return;

				// NOTE: IE7 and upwards support
				var xhr = new XMLHttpRequest();
				xhr.open('GET', eventsource.URL, true);
				xhr.setRequestHeader('Accept', 'text/event-stream');
				xhr.setRequestHeader('Cache-Control', 'no-cache');

				// We must make use of this on the server side if we're
				// working with Android - because they don't trigger 
				// readychange until the server connection is closed
				xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');

				if (lastEventId != null)
					xhr.setRequestHeader('Last-Event-ID', lastEventId);

				cache = '';

				xhr.timeout = 50000;
				xhr.onreadystatechange = function () {
					if (this.readyState == 3 ||
					   (this.readyState == 4 && this.status == 200)) {
						// on success
						if (eventsource.readyState == eventsource.CONNECTING) {
							eventsource.readyState = eventsource.OPEN;
							eventsource.dispatchEvent('open', { type: 'open' });
						}

						var responseText = '';
						try {
							responseText = this.responseText || '';
						} catch (e) {}

						// process this.responseText
						var parts = responseText.substr(cache.length).split("\n");
						var eventType = 'message';
						var data = [];
						var i = 0;
						var line = '';

						cache = responseText;

						// TODO handle 'event' (for buffer name), retry
						for (; i < parts.length; i++) {
							line = parts[i].replace(reTrim, '');
							if (line.indexOf('event') == 0) {
								eventType = line.replace(/event:?\s*/, '');
							} else if (line.indexOf('retry') == 0) {
								var retry = parseInt(line.replace(/retry:?\s*/, ''));
								if (!isNaN(retry)) {
									interval = retry;
								}
							} else if (line.indexOf('data') == 0) {
								data.push(line.replace(/data:?\s*/, ''));
							} else if (line.indexOf('id:') == 0) {
								lastEventId = line.replace(/id:?\s*/, '');
							} else if (line.indexOf('id') == 0) { // this resets the id
								lastEventId = null;
							} else if (line == '') {
								if (data.length) {
									var event = new MessageEvent(data.join('\n'), eventsource.url, lastEventId);
									eventsource.dispatchEvent(eventType, event);
									data = [];
									eventType = 'message';
								}
							}
						}

						if (this.readyState == 4)
							pollAgain(interval);
						// don't need to poll again, because we're long-loading
					} else if (eventsource.readyState !== eventsource.CLOSED) {
						if (this.readyState == 4) { // and some other status
							// dispatch error
							eventsource.readyState = eventsource.CONNECTING;
							eventsource.dispatchEvent('error', { type: 'error' });
							pollAgain(interval);
						} else if (this.readyState == 0) { // likely aborted
							pollAgain(interval);
						} else {
						}
					}
				};

				xhr.send();

				setTimeout(function () {
					if (true || xhr.readyState == 3)
						xhr.abort();
				}, xhr.timeout);

				eventsource._xhr = xhr;
			} catch (e) { // in an attempt to silence the errors
				eventsource.dispatchEvent('error', { type: 'error', data: e.message }); // ???
			} 
		};

		poll(); // init now
	};

	window.EventSource.prototype = {
		close: function () {
			// closes the connection - disabling the polling
			this.readyState = this.CLOSED;
			clearInterval(this._pollTimer);
			this._xhr.abort();
		},
		CONNECTING: 0,
		OPEN: 1,
		CLOSED: 2,
		dispatchEvent: function (type, event) {
			var handlers = this['_' + type + 'Handlers'];
			if (handlers) {
				for (var i = 0; i < handlers.length; i++) {
					handlers[i].call(this, event);
				}
			}

			if (this['on' + type]) {
				this['on' + type].call(this, event);
			}
		},
		addEventListener: function (type, handler) {
			if (!this['_' + type + 'Handlers']) {
				this['_' + type + 'Handlers'] = [];
			}

			this['_' + type + 'Handlers'].push(handler);
		},
		removeEventListener: function (type, handler) {
			var handlers = this['_' + type + 'Handlers'];
			if (!handlers) {
				return;
			}
			for (var i = handlers.length - 1; i >= 0; --i) {
				if (handlers[i] === handler) {
					handlers.splice(i, 1);
					break;
				}
			}
		},
		onerror: null,
		onmessage: null,
		onopen: null,
		readyState: 0,
		URL: ''
	};

	var MessageEvent = function (data, origin, lastEventId) {
		this.data = data;
		this.origin = origin;
		this.lastEventId = lastEventId || '';
	};

	window.MessageEvent = MessageEvent;
	window.MessageEvent.prototype = {
		data: null,
		type: 'message',
		lastEventId: '',
		origin: ''
	};
}

// End of EventSource polyfill

var dataMap = {
	controls: {
		cleardata: '0',
		browse: null,
		upgrade: null,
		dryrun: '0',
	},
	warning: {
		box: null,
	},
};

var rpcCallSessionAccess = rpc.declare({
	object: 'session',
	method: 'access',
	params: [ 'scope', 'object', 'function' ],
	expect: { 'access': false }
});

var rpcCallReboot = rpc.declare({
	object: 'system',
	method: 'reboot',
	expect: { result: 0 }
});

var eventSource;

/* Must be synced with include/swupdate_status.h */
const SWU_STATUS_IDLE       = 0;
const SWU_STATUS_START      = 1;
const SWU_STATUS_RUN        = 2;
const SWU_STATUS_SUCCESS    = 3;
const SWU_STATUS_FAILURE    = 4;
const SWU_STATUS_DOWNLOAD   = 5;
const SWU_STATUS_DONE       = 6;
const SWU_STATUS_SUBPROCESS = 7;
const SWU_STATUS_PROGRESS   = 8;

/* Must be synced with include/util.h */
const SWU_LEVEL_ERROR   = 1;
const SWU_LEVEL_WARNING = 2;
const SWU_LEVEL_INFO    = 3;
const SWU_LEVEL_DEBUG   = 4;
const SWU_LEVEL_TRACE   = 5;

const LOG_ERROR      = 0;
const LOG_WARNING    = 1;
const LOG_SUCCESS    = 2;
const LOG_NOTICE     = 3;
const LOG_CMD_OUTPUT = 4;
const LOG_INFO       = 5;
const LOG_DEBUG      = 6;

function swuStatusToLogLevel(msg, status) {
	switch (status) {
		case SWU_STATUS_RUN:
			if (msg.match(/^\[run_system_cmd\] : /))
				return LOG_CMD_OUTPUT;

			return LOG_INFO;

		case SWU_STATUS_IDLE:
		case SWU_STATUS_SUBPROCESS:
		case SWU_STATUS_PROGRESS:
			return LOG_INFO;

		case SWU_STATUS_START:
		case SWU_STATUS_SUCCESS:
		case SWU_STATUS_DONE:
			return LOG_SUCCESS;

		default:
			return LOG_INFO;
	}
}

function swuLevelToLogLevel(level) {
	switch (level) {
		case SWU_LEVEL_ERROR:
			return LOG_ERROR;

		case SWU_LEVEL_WARNING:
			return LOG_WARNING;

		case SWU_LEVEL_INFO:
			return LOG_INFO;

		case SWU_LEVEL_DEBUG:
		case SWU_LEVEL_TRACE:
			return LOG_DEBUG;

		default:
			return LOG_DEBUG;
	}
}

function swuFormatLogMessage(msg) {
	return msg.replace(/\[.*\] : /, '');
}

function logLevelToClass(level) {
	switch (level) {
		case LOG_ERROR:
			return 'swupdate-log-failure';

		case LOG_WARNING:
			return 'swupdate-log-warning';

		case LOG_SUCCESS:
			return 'swupdate-log-success';

		case LOG_NOTICE:
			return 'swupdate-log-notice';

		case LOG_CMD_OUTPUT:
			return 'swupdate-log-cmd-output';

		case LOG_INFO:
			return 'swupdate-log-info';

		case LOG_DEBUG:
			return 'swupdate-log-debug';

		default:
			return 'swupdate-log-debug';
	}
}

function fileSlice(file, start, end) {
	var slice = file.mozSlice ? file.mozSlice :
	            file.webkitSlice ? file.webkitSlice :
	            file.slice ? file.slice : noop;

	return slice.bind(file)(start, end);
}

return L.view.extend({
	swuLogContainer: null,
	swuFileInfoContainer: null,
	swuBrowseButton: null,
	swuUpgradeButton: null,
	swuProgress: null,
	swuFile: null,

	__init__: function() {
		this.super('__init__', arguments);

		var head = document.getElementsByTagName('head')[0];
		var css = E('link', {
			'href': L.resource('swupdate/swupdate.css') + '?v=#PKG_VERSION',
			'rel': 'stylesheet'
		});

		head.appendChild(css);

		this.swuLogContainer = E('div', {}, E('pre', { 'id': 'swupdate-log', }));

		this.swuFileInfoContainer = E('div', { 'class': 'swupdate-file-info' }, [
			E('ul', {}, [
				E('li', {}, [ E('strong', {}, _('File') + ': '), E('span', {}) ]),
				E('li', {}, [ E('strong', {}, _('Size') + ': '), E('span', {}) ]),
			]),
		]);

		this.swuBrowseButton = E('div', { 'style': 'padding-top: 0;' }, [
			E('input', {
				'style': 'display: none',
				'type': 'file',
				'accept': '.swu',
				'change': function(ev) {
					this.onFileSelected(ev.currentTarget.files[0]);
				}.bind(this)
			}),
			E('button', {
				'class': 'cbi-button cbi-button-action',
				'click': function(ev) {
					ev.target.previousElementSibling.click();
				}
			}, [ _('Browse...') ]),
			E('div', { 'class': 'cbi-value-description' }, this.swuFileInfoContainer)
		]);

		this.swuUpgradeButton = E('div', { 'style': 'padding-top: 0;' }, [
			E('button', {
				'class': 'cbi-button cbi-button-remove',
				'disabled': 'disabled',
				'click': ui.createHandlerFn(this, function(ev) {
					return this.onUpgrade();
				})
			}, [ _('Upgrade...', 'Button Title') ]),
		]);

		this.swuProgress = E('div', { 'class': 'swupdate-progress-container' }, [
			E('div', { 'class': 'swupdate-progress' }, [
				E('div', { 'class': 'swupdate-progress-title' }, _('Uploading')),
				E('div', {
					'id': 'swupdate-progress-upload',
					'class': 'cbi-progressbar',
					'title': '0%',
				}, E('div', { 'style': 'width:0' })),
				E('div', { 'class': 'cbi-section' }, [
					E('ul', { 'class': 'swupdate-progress-info' }, [
						E('li', {}, [ E('strong', {}, _('Uploaded') + ': '), E('span', { 'id': 'swupdate-upload-bytes' }, '−')]),
						E('li', {}, [ E('strong', {}, _('Current speed') + ': '), E('span', { 'id': 'swupdate-upload-current' }, '−')]),
						E('li', {}, [ E('strong', {}, _('Average speed') + ': '), E('span', { 'id': 'swupdate-upload-avg' }, '−')]),
					])
				])
			]),
			E('div', { 'class': 'swupdate-progress' }, [
				E('div', { 'class': 'swupdate-progress-title' }, _('Installing / Flashing')),
				E('div', {
					'id': 'swupdate-progress-upgrade',
					'class': 'cbi-progressbar',
					'title': '0%',
				}, E('div', { 'style': 'width:0' })),
				E('div', { 'class': 'cbi-section' }, [
					E('ul', { 'class': 'swupdate-progress-info' }, [
						E('li', {}, [ E('strong', {}, _('Step') + ': '), E('span', { 'id': 'swupdate-upgrade-step' }, '−')]),
					])
				])
			])
		]);
	},

	updateFileInfo: function(container, file) {
		var filename = container.querySelector('ul > li > span');
		var filesize = container.querySelector('ul > li + li > span');

		if (!filename || !filesize)
			return;

		if (file && file.name && file.size) {
			filename.innerHTML = file.name.replace(/^.*[\\\/]/, '');
			filesize.innerHTML = _('%1024.2mB').format(file.size) +
				' (' + _('%d bytes').format(file.size) + ')';
		}
		else {
			filename.innerHTML = _('not selected');
			filesize.innerHTML = _('%1024.2mB').format(0) +
				' (' + _('%d bytes').format(0) + ')';
		}
	},

	onFileSelected: function(file) {
		this.progressReset();
		this.updateFileInfo(this.swuFileInfoContainer, file);

		if (file && file.name && file.size) {
			this.swuUpgradeButton.querySelector('button').disabled = false;
			this.swuFile = file;
		}
		else {
			this.swuUpgradeButton.querySelector('button').disabled = true;
			this.swuFile = null;
		}
	},

	progressUploadReset: function() {
		var pUpload = this.swuProgress.querySelector('#swupdate-progress-upload');

		var info_bytes   = this.swuProgress.querySelector('#swupdate-upload-bytes');
		var info_current = this.swuProgress.querySelector('#swupdate-upload-current');
		var info_avg     = this.swuProgress.querySelector('#swupdate-upload-avg');

		pUpload.setAttribute('title', '%.2f%%'.format(0));
		pUpload.firstElementChild.style.width = '%.2f%%'.format(0);

		info_bytes.innerHTML = '−';
		info_current.innerHTML = '−';
		info_avg.innerHTML = '−';
	},

	progressUpgradeReset: function() {
		var pUpgrade = this.swuProgress.querySelector('#swupdate-progress-upgrade');
		var info_step    = this.swuProgress.querySelector('#swupdate-upgrade-step');

		pUpgrade.setAttribute('title', '%.2f%%'.format(0));
		pUpgrade.firstElementChild.style.width = '%.2f%%'.format(0);

		info_step.innerHTML = '−';
	},

	progressReset: function() {
		this.progressUploadReset();
		this.progressUpgradeReset();
	},

	onPreUpgrade: function(opt) {
		// Disable elements
		if (opt.hasOwnProperty('disableElements')) {
			opt.disableElements.forEach(function(e) {
				e.disabled = true;
			})
		}

		this.swuInstallHeartBeat = 0;
		this.swuInstallSuccess = false;
		this.swuInstallFailure = false;
		this.swuInstallStep = 0;
		this.swuInstallNSteps = 0;
		this.swuItemsToInstall = 0;
		this.swuItemsToInstallReceived = false;

		this.setStatus(opt.statusContainer, [ 'swupdate-status-warning', 'spinning' ],
			_('Upgrade in progress, please wait...'));

		this.logClear();
		this.progressReset();
	},

	onPostUpgrade: function(opt) {
		// Enable elements
		if (opt.hasOwnProperty('enableElements')) {
			opt.enableElements.forEach(function(e) {
				e.disabled = false;
			})
		}
	},

	setStatus: function(container, classes, message) {
		container.classList.remove('swupdate-status-success');
		container.classList.remove('swupdate-status-error');
		container.classList.remove('swupdate-status-warning');
		container.classList.remove('spinning');

		if (Array.isArray(classes)) {
			classes.forEach(function(c) {
				container.classList.add(c);
			});
		}
		else
			container.classList.add(classes);

		container.innerHTML = message;
	},

	onUpgrade: function() {
		if (eventSource.readyState !== 1) {
			console.error("EventSource is not connected");
			return;
		}

		this.map.save(null, true);
		this.logClear();
		this.progressReset();

		var clearData = parseInt(dataMap.controls.cleardata) || 0;
		var dryRun = 0;/*parseInt(dataMap.controls.dryrun) || 0;*/

		return new Promise(function(resolveFn, rejectFn) {
			var swuFormData = {
				swupdate: {
					info: null,
					progress: null,
					log: null,
					control: null,
				},
			};

			var m, s, o
			
			m = new form.JSONMap(swuFormData);

			s = m.section(form.NamedSection, 'swupdate', 'info', _('Information'))
			s.anonymous = true;
			s.addremove = false;

			var statusContainer = E('div', { 'class': 'swupdate-status' });
			this.setStatus(statusContainer, 'swupdate-status-success', _('Ready for upgrade'));

			o = s.option(form.DummyValue, 'information');

			this.versionNode = E('span', {}, '−');

			var infoContainer = E('div', { 'class': 'swupdate-file-info' }, [
				E('ul', {}, [
					E('li', {}, [ E('strong', {}, _('File') + ': '), E('span', {}) ]),
					E('li', {}, [ E('strong', {}, _('Size') + ': '), E('span', {}) ]),
					E('li', {}, [ E('strong', {}, _('Firmware version') + ': '), this.versionNode ]),
					E('li', {}, [ E('strong', {}, _('Erase user data') + ': '),
						E('span', { 'class': 'swupdate-info-' + (clearData ? 'warning' : 'success') },
							clearData ? _('Yes') : _('No'))
					]),
					/*
					E('li', {}, [ E('strong', {}, _('Dry run mode') + ': '),
						E('span', { 'class': 'swupdate-info-' + (dryRun ? 'success' : 'warning') },
							dryRun ? _('Yes') : _('No'))
					]),
					*/
				]),
			]);

			this.updateFileInfo(infoContainer, this.swuFile);

			o.renderWidget = function() {
				return E('div', { 'class': 'swupdate-info' }, [
					infoContainer,
					statusContainer
				]);
			}.bind(this);

			s = m.section(form.NamedSection, 'swupdate', 'progress', _('Firmware Upgrade Progress'))
			s.anonymous = true;
			s.addremove = false;

			o = s.option(form.DummyValue, 'progress');
			o.renderWidget = function() { return this.swuProgress; }.bind(this);

			s = m.section(form.NamedSection, 'swupdate', 'log', _('Firmware Upgrade Log'));
			s.anonymous = true;
			s.addremove = false;

			o = s.option(form.DummyValue, 'log');
			o.renderWidget = function() { return this.swuLogContainer; }.bind(this);

			var btnClose = E('button', {
				'class': 'cbi-button cbi-button-action',
				'click': function(ev) {
					L.ui.hideModal();
					return resolveFn();
				}
			}, [ _('Close') ]);

			var softwareSet = '';
			var runningMode = '';
			var parts = this.swuFile.name.split('.');

			if (Array.isArray(parts) && parts.length === 4) {
				/* image-name.<softwareSet>.<runningMode>.swu */
				softwareSet = parts[1];
				runningMode = parts[2];
			}

			var btnUpgrade = E('button', {
				'class': 'cbi-button cbi-button-remove',
				'click': ui.createHandlerFn(this, function(ev) {
					return this.onUpgradeProcess({
						'disableElements': [ btnClose, btnUpgrade ],
						'enableElements': [ btnClose ],
						'statusContainer': statusContainer,
						'clearData': clearData,
						'dryRun': dryRun,
						'softwareSet': softwareSet,
						'runningMode': runningMode
					});
				})
			}, [ _('Upload and upgrade firmware') ]);

			return m.render().then(function(mapEl) {
				L.ui.showModal(_('Firmware Upgrade'), [
					mapEl,
					E('div', { 'style': 'display: flex;' }, [
						E('div', { 'class': 'left', 'style': 'flex: 1;' }, [
							btnUpgrade
						]),
						E('div', { 'class': 'right', 'style': 'flex: 1;' }, [
							btnClose
						])
					])
				]);
			}.bind(this));
		}.bind(this));
	},

	onUpgradeProcess: function(opt) {
		if (eventSource.readyState !== 1) {
			console.error("EventSource is not connected");
			return;
		}

		this.onPreUpgrade(opt);
		return this.checkSessionACL(opt)
			.then(this.onUpgradeUpload.bind(this, opt))
			.then(this.onUpgradeFlash.bind(this, opt))
			.then(this.onUpgradeReboot.bind(this, opt))
			.catch(function(e) {
				this.setStatus(opt.statusContainer, 'swupdate-status-error', e);
				return Promise.reject();
			}.bind(this))
			.finally(function() {
				this.onPostUpgrade(opt);
			}.bind(this))
			.catch(function(e) {});
	},

	checkSessionACL: function(opt) {
		this.logUiMessage(LOG_INFO, 'Checking permissions...');

		return L.resolveDefault(rpcCallSessionAccess('cgi-swupdate', 'update', 'write'), false).then(function(access) {
			if (!access) {
				L.notifySessionExpiry();
				this.logUiMessage(LOG_ERROR, 'Not enough permissions');
				return Promise.reject(_('Not enough permissions'));
			}
		}.bind(this));
	},

	onUpgradeUpload: function(opt) {
		var pUpload = this.swuProgress.querySelector('#swupdate-progress-upload');

		this.logUiMessage(LOG_INFO, 'Uploading firmware file into device...');

		var formData = new FormData();
		formData.append('sessionid', rpc.getSessionID());
		formData.append('filename', this.swuFile.name.replace(/^.*[\\\/]/, ''));
		formData.append('postupdate', 1);
		formData.append('cleardata', opt.clearData);
		formData.append('dryrun', opt.dryRun);
		formData.append('swu_software_set', opt.softwareSet);
		formData.append('swu_running_mode', opt.runningMode);
		formData.append('swupdatedata', this.swuFile);
		// TODO: fileSlice(this.swuFile, 0, this.swuFile.size));

		var infoUploadBytes        = this.swuProgress.querySelector('#swupdate-upload-bytes');
		var infoUploadSpeedCurrent = this.swuProgress.querySelector('#swupdate-upload-current');
		var infoUploadSpeedAvg     = this.swuProgress.querySelector('#swupdate-upload-avg');

		var speedTStart = null;
		var speedT0 = null;
		var speedT1 = null;
		var speedMeasuresCount = 0;
		var speedLastUploaded = 0;

		var curSpeedClearTimerId = null;

		return L.Request.post(L.env.cgi_base + '/cgi-swupdate', formData, {
			timeout: 0,
			progress: function(pev) {
				var uploadedSize = pev.loaded;
				var percent = (uploadedSize * 100) / pev.total;
			
				if (speedMeasuresCount == 0) {
					speedT0 = speedTStart = performance.now();
					speedT0 = null;
					speedT1 = null;
					speedMeasuresCount++;
					speedLastUploaded = 0;
				} else {
					speedT1 = performance.now();

					var speedCurrent = (uploadedSize - speedLastUploaded) /
						(speedT1 - speedT0) * 1000.0;
					var speedAvg = ((uploadedSize) / (speedT1 - speedTStart)) * 1000.0;

					speedLastUploaded = uploadedSize;
					speedMeasuresCount++;
					speedT0 = speedT1;

					var fileUploaded = uploadedSize - (pev.total - this.swuFile.size);
					if (fileUploaded < 0)
						fileUploaded = 0;

					infoUploadBytes.innerHTML =
						_('%1024.2mB of %1024.2mB').format(fileUploaded, this.swuFile.size);

					infoUploadSpeedCurrent.innerHTML =
						_('%1024.2mB/s').format(speedCurrent);

					infoUploadSpeedAvg.innerHTML =
						_('%1024.2mB/s').format(speedAvg);

					if (curSpeedClearTimerId)
						clearTimeout(curSpeedClearTimerId);

					curSpeedClearTimerId = setTimeout(function() {
						infoUploadSpeedCurrent.innerHTML = '−';
					}, UPLOAD_CURRENT_SPEED_CLEAR_TIMEOUT);
				}

				pUpload.setAttribute('title', '%.2f%%'.format(percent));
				pUpload.firstElementChild.style.width = '%.2f%%'.format(percent);
			
			}.bind(this)
		}).catch(function(e) {
			return new Promise(function(resolveFn, rejectFn) {
				setTimeout(function() {
					this.logUiMessage(LOG_ERROR, 'Could not upload firmware file');
					rejectFn(_('Uploading failure'));
				}.bind(this), 2500);
			}.bind(this));
		}.bind(this)).then(function() {
			return Promise.resolve();
		}.bind(this));
	},

	onUpgradeFlash: function(opt) {
		this.setStatus(opt.statusContainer, [ 'swupdate-status-warning', 'spinning' ],
			_('Installation in progress, please wait...'));

		return new Promise(function(resolveFn, rejectFn) {
			var upgradeTimeoutHeartBeat = this.swuInstallHeartBeat;
			var upgradeTimeoutTimerId = setInterval(function upgradeTimeoutFunc() {
				if (upgradeTimeoutHeartBeat == this.swuInstallHeartBeat) {
					this.logUiMessage(LOG_ERROR, 'Installation timed out');
					clearInterval(upgradeTimeoutTimerId);
					rejectFn(_('Installation timed out'));
				}

				upgradeTimeoutHeartBeat = this.swuInstallHeartBeat;
			}.bind(this), UPGRADE_INSTALL_TIMEOUT);

			var upgradeCheckTimerId = setInterval(function() {
				if (!this.swuItemsToInstallReceived)
					return;

				if (this.swuInstallFailure ||
				    this.swuInstallSuccess ||
				   (this.swuItemsToInstall == 0)) {
					clearInterval(upgradeCheckTimerId);
					clearInterval(upgradeTimeoutTimerId);
				}

				if (!this.swuItemsToInstall) {
					resolveFn();
				}

				if (this.swuInstallFailure) {
					this.logUiMessage(LOG_ERROR, 'Installation failure');
					rejectFn(_('Installation failure'));
				}

				if (this.swuInstallSuccess)
					resolveFn();
			}.bind(this), UPGRADE_INSTALL_CHECK_INTERVAL);
		}.bind(this));
	},

	getRebootState: function() {
		return L.resolveDefault(fs.read('/tmp/swu_reboot_state'), '0').then(function(data) {
			if (parseInt(data) > 0) {
				return true;
			}
			else {
				return false;
			}
		})
	},

	onUpgradeReboot: function(opt) {
		return this.getRebootState().then(function(doReboot) {
			if (opt.dryRun || !doReboot || (this.swuItemsToInstall == 0)) {
				return new Promise(function(resolveFn, rejectFn) {
					setTimeout(function() {
						if (this.swuItemsToInstall == 0) {
							this.logUiMessage(LOG_SUCCESS,
								'The current device firmware is fully matches the ' +
								'uploaded firmware. Firmware upgrade has not been ' +
								'done since it is not required');
						}
						else {
							if (opt.dryRun) {
								this.logUiMessage(LOG_SUCCESS,
									'Dry run is successfully completed');
							}
							else {
								this.logUiMessage(LOG_SUCCESS,
									'Successfully completed');
							}
						}

						this.setStatus(opt.statusContainer, [ 'swupdate-status-success' ],
							_('Successfully completed'));

						resolveFn();
					}.bind(this), 1500);
				}.bind(this));
			}

			this.logUiMessage(LOG_INFO, 'Rebooting device...');
			this.setStatus(opt.statusContainer, [ 'swupdate-status-success', 'spinning' ],
				_('Rebooting, please wait...'));

			this.closeEventSource();

			return new Promise(function(resolveFn, rejectFn) {
				this.logUiMessage(LOG_NOTICE, 'Waiting for the new system to be started after firmware upgrade...');
				ui.awaitReconnect(window.location.host);
			}.bind(this));
		}.bind(this));
	},

	logClear: function() {
		var logElement = this.swuLogContainer.querySelector('#swupdate-log');

		while (logElement.lastChild) {
			logElement.removeChild(logElement.lastChild);
		}
	},

	logMessage: function(tag, level, msg, scroll) {
		if (typeof scroll === 'undefined')
			scroll = true;

		var logElement = this.swuLogContainer.querySelector('#swupdate-log');

		logElement.appendChild(
			E('span', { 'class': 'swupdate-log-line' }, [
				E('span', { 'class': 'swupdate-log-msg ' + logLevelToClass(level) }, msg),
				E('span', { 'class': 'swupdate-log-tag' }, tag),
			])
		);

		if (scroll) {
			logElement.scrollTop = logElement.scrollHeight -
			                       logElement.clientHeight;
		}
	},

	logSwuInfoMessage: function(data, scroll) {
		if (typeof scroll === 'undefined')
			scroll = true;

		var level;

		if (data.error)
			level = LOG_ERROR;
		else {
			var level_status = swuStatusToLogLevel(data.msg, data.status);
			var level_msg    = swuLevelToLogLevel(data.level);

			if (level_status == LOG_INFO)
				level = level_msg;
			else
				level = level_status;
		}

		return this.logMessage('swu', level, swuFormatLogMessage(data.msg), scroll);
	},

	logUiMessage: function(level, msg, scroll) {
		if (typeof scroll === 'undefined')
			scroll = true;

		return this.logMessage('ui', level, msg, scroll);
	},

	closeEventSource: function() {
		eventSource.close();
	},

	initEventSource: function() {
		eventSource = new EventSource('/ubus/subscribe/swupdate' + '?' + rpc.getSessionID());
		eventSource.onopen = function(event) {
			this.logUiMessage(LOG_NOTICE, 'EventSource connected', true);
		}.bind(this);

		eventSource.onerror = function(event) {
			if (eventSource.readyState == 2) {
				this.logUiMessage(LOG_WARNING, 'EventSource disconnected', true);
				return;
			}
		}.bind(this);

		var pUpgrade = this.swuProgress.querySelector('#swupdate-progress-upgrade');
		var info_step = this.swuProgress.querySelector('#swupdate-upgrade-step');

		var handleInfoEvent = function(data) {
			if (logInfoMessages)
				console.debug(data);

			this.logSwuInfoMessage(data, true);
		}.bind(this);

		var handleProgressEvent = function(data) {
			if (logProgressMessages)
				console.debug(data);

			var status = data.status;

			this.swuInstallHeartBeat = this.swuInstallHeartBeat + 1;

			switch (status) {
				case SWU_STATUS_FAILURE:
					this.swuInstallFailure = true;
					break;

				case SWU_STATUS_SUCCESS:
					this.swuInstallSuccess = true;
					pUpgrade.setAttribute('title', '%.2f%%'.format(100));
					pUpgrade.firstElementChild.style.width = '%.2f%%'.format(100);
					break;

				case SWU_STATUS_RUN:
					if (!data.info)
						return;

					try {
						var json = JSON.parse(data.info);

						if (json.hasOwnProperty('0')) {
							if (json['0'].hasOwnProperty('VERSION')) {
								var version = json['0']['VERSION'];
								if (this.versionNode)
									this.versionNode.innerHTML = version;
							}
							if (json['0'].hasOwnProperty('ITEMS_TO_INSTALL')) {
								this.swuItemsToInstall = json['0']['ITEMS_TO_INSTALL'];
								this.swuItemsToInstallReceived = true;

								if (this.swuItemsToInstall) {
									this.logUiMessage(LOG_NOTICE,
										'Installing %d item(s)...'.format(this.swuItemsToInstall));
								}
								else {
									this.logUiMessage(LOG_NOTICE,
										'No items to install');
								}
							}
						}
					}
					catch (e) {}
					break;

				case SWU_STATUS_PROGRESS:
					var percent = data.cur_percent;
					var step    = data.cur_step;
					var nsteps  = data.nsteps;

					if (nsteps > this.swuInstallNSteps)
						this.swuInstallNSteps = nsteps;

					if (step > this.swuInstallStep)
						this.swuInstallStep = step;

					if ((step > 0) && (step >= this.swuInstallStep)) {
						var totalPercent = ((step - 1) * 100 + percent) / nsteps;

						pUpgrade.setAttribute('title', '%.2f%%'.format(totalPercent));
						pUpgrade.firstElementChild.style.width = '%.2f%%'.format(totalPercent);

						info_step.innerHTML = _('%d of %d').format(step, nsteps);
					}

					break;
				default:
					break;
			}
		}.bind(this);

		eventSource.addEventListener('info', function(event) {
			try {
				var json = JSON.parse(event.data);
				handleInfoEvent(json);
			} catch (e) {
				this.logUiMessage(LOG_WARNING,
					"Failed to parse received 'info' event data");
			}
		}.bind(this));

		eventSource.addEventListener('progress', function(event) {
			try {
				var json = JSON.parse(event.data);
				handleProgressEvent(json);
			} catch (e) {
				this.logUiMessage(LOG_WARNING,
					"Failed to parse received 'progress' event data");
			}
		}.bind(this));
	},

	render: function(data) {
		var s, o;

		this.map = new form.JSONMap(dataMap, _('Firmware Upgrade'),
			_('Here you can perform firmware upgrade on this device.'));

		// ------------------------------------------------------------------

		s = this.map.section(form.NamedSection, 'controls', null,
			_('Upgrade Configuration and Actions'));
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.Flag, 'cleardata', _('Erase user data'),
			_('Checking this option will completely erase the user data ' +
			  '(including the device configuration) during firmware upgrade'));
		o.default = '0';
		o.rmempty = false;

		/*
		o = s.option(form.Flag, 'dryrun', _('Dry run mode'),
			_('If this option is enabled, the actual flashing will not be ' +
			  'performed on the device. If this option is checked, user data ' +
			  'is also not erased when the option "Erase user data" is checked.'));
		o.default = '0';
		o.rmempty = false;
		*/

		o = s.option(form.DummyValue, 'browse', _('Firmware file'));
		o.renderWidget = function() { return this.swuBrowseButton; }.bind(this);

		o = s.option(form.DummyValue, 'upgrade', _('Upgrade firmware'));
		o.renderWidget = function() {
			return this.swuUpgradeButton;
		}.bind(this);

		// ------------------------------------------------------------------

		s = this.map.section(form.NamedSection, 'warning');
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.DummyValue, 'box');
		o.renderWidget = function() {
			return E('div', { 'class': 'alert-message info' }, [
				E('h4', _('Attention')),
				E('p', [
					_('Once the firmware upgrade procedure has been started, ' +
					  'please do NOT POWER OFF the device until the firmware ' +
					  'upgrade is fully completed.'),
					' ',
					_('Note that firmware upgrading can take a long time, ' +
					  'up to 5–15 minutes (depending on the connection speed). ' +
					  'So please be patient during this operation.'),
				])
			]);
		}.bind(this);

		// ------------------------------------------------------------------

		return this.map.render().then(function(mapEl) {
			this.initEventSource();
			this.updateFileInfo(this.swuFileInfoContainer, null);
			return mapEl;
		}.bind(this));
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
