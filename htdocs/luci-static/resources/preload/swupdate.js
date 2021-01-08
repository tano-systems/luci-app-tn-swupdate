/*
 * SPDX-License-Identifier: WTFPL
 * SPDX-FileCopyrightText: 2021 Tano Systems LLC. All Rights Reserved.
 *
 * Authors: Anton Kikin <a.kikin@tano-systems.com>
 */

'use strict';
'require uci';
'require ui';
'require baseclass';

return baseclass.extend({
	__init__: function() {
		return uci.load('swupdate').then(this.checkUpdateState.bind(this));
	},

	userConfirm: function(callback) {
		uci.set('swupdate', 'state', 'user_confirmed', '1');
		uci.save();

		return uci.apply().finally(callback);
	},

	checkUpdateState: function() {
		var state = uci.get('swupdate', 'state', 'state');
		var user_confirmed = uci.get('swupdate', 'state', 'user_confirmed');

		if ((state === 'ok') || (user_confirmed !== '0'))
			return;

		var msgFailed = E('div', { 'style': 'display: flex; align-items: center;' }, [
			E('img', {
				'style': 'width: 64px; margin-right: 8px;',
				'src': L.resource('swupdate/icon-failed.svg')
			}),
			E('p', { 'style': 'margin: 0;' },
				_('Booting the system with the new firmware failed. ' +
				  'The system has been rolled back to the previous firmware ' +
				  'and is now booted with the previous firmware.')
			)
		]);

		return new Promise(function(resolveFn, rejectFn) {
			ui.showModal(_('Firmware Upgrade'), [
				E('div', {}, msgFailed),
				E('div', { 'class': 'cbi-section right' }, [
					E('div', {
						'class': 'btn error',
						'click': ui.createHandlerFn(this, 'userConfirm', function() {
							ui.hideModal();
							resolveFn();
						})
					}, _('Close'))
				])
			]);
		}.bind(this));
	},
});
