'use strict';
'require view';
'require form';
'require rpc';
'require fs';
'require ui';

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: ['name'],
	expect: { '': {} }
});

function getRunning() {
	return L.resolveDefault(callServiceList('evl-tpi-proxy'), {}).then(function(res) {
		try {
			var inst = res['evl-tpi-proxy'].instances;
			for (var k in inst)
				if (inst[k].running)
					return true;
		} catch (e) {}
		return false;
	});
}

function runAction(action) {
	return fs.exec('/etc/init.d/evl-tpi-proxy', [action]).then(function(res) {
		if (res.code === 0)
			ui.addNotification(null, E('p', _('EnvisaLink proxy: %s').format(action)), 'info');
		else
			ui.addNotification(null, E('p', _('Action "%s" failed (code %d)').format(action, res.code)), 'danger');
	}).catch(function(e) {
		ui.addNotification(null, E('p', _('Action failed: %s').format(e)), 'danger');
	});
}

return view.extend({
	load: function() {
		return getRunning();
	},

	render: function(running) {
		var m, s, o;

		m = new form.Map('envisalink', _('EnvisaLink TPI Proxy'),
			_('Shares the EnvisaLink\'s single TPI connection so Home Assistant and the web app can both use it. ' +
			  'Point each client at this router on the listen port below, using the EnvisaLink password.'));

		/* ---- service status + controls ---- */
		s = m.section(form.NamedSection, 'main', 'envisalink', _('Service'));
		s.anonymous = true;

		o = s.option(form.DummyValue, '_status', _('Status'));
		o.cfgvalue = function() {
			return running
				? E('span', { 'style': 'color:#2e8b57;font-weight:bold' }, _('Running'))
				: E('span', { 'style': 'color:#b00;font-weight:bold' }, _('Stopped'));
		};

		o = s.option(form.Button, '_start', _('Start'));
		o.inputtitle = _('Start');
		o.inputstyle = 'apply';
		o.onclick = function() { return runAction('start'); };

		o = s.option(form.Button, '_stop', _('Stop'));
		o.inputtitle = _('Stop');
		o.inputstyle = 'remove';
		o.onclick = function() { return runAction('stop'); };

		o = s.option(form.Button, '_restart', _('Restart'));
		o.inputtitle = _('Restart');
		o.inputstyle = 'reload';
		o.onclick = function() { return runAction('restart'); };

		/* ---- settings ---- */
		s = m.section(form.NamedSection, 'main', 'envisalink', _('Settings'));
		s.anonymous = true;

		o = s.option(form.Flag, 'enabled', _('Enabled'), _('Start the proxy at boot.'));
		o.rmempty = false;

		o = s.option(form.Value, 'evl_host', _('EnvisaLink IP address'));
		o.datatype = 'host';
		o.rmempty = false;

		o = s.option(form.Value, 'evl_port', _('EnvisaLink port'));
		o.datatype = 'port';
		o.placeholder = '4025';

		o = s.option(form.Value, 'evl_pass', _('EnvisaLink password'));
		o.password = true;
		o.rmempty = false;

		o = s.option(form.ListValue, 'panel', _('Panel type'));
		o.value('honeywell', _('Honeywell / Vista'));
		o.value('dsc', _('DSC'));

		o = s.option(form.Value, 'listen_port', _('Listen port'),
			_('Point Home Assistant and the web app at this router on this port.'));
		o.datatype = 'port';
		o.placeholder = '4025';

		o = s.option(form.Value, 'listen_host', _('Listen address'));
		o.datatype = 'ipaddr';
		o.placeholder = '0.0.0.0';
		o.optional = true;

		o = s.option(form.Value, 'client_pass', _('Client password'),
			_('Password clients must send. Leave blank to require the EnvisaLink password.'));
		o.password = true;
		o.optional = true;

		o = s.option(form.Value, 'keepalive', _('Keepalive (seconds)'));
		o.datatype = 'uinteger';
		o.placeholder = '120';
		o.optional = true;

		return m.render();
	}
});
