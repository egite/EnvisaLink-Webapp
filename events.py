"""
Event model + detection.

Event-type numbers and the default message templates match the original
AlarmDecoder webapp exactly, so notification settings and message templates
import/export cleanly. `detect()` turns a before/after pair of state snapshots
(the dicts returned by EVLPanel.get_state) into a list of (event_type, kwargs)
the notifier can act on.
"""

from collections import OrderedDict

# Event types (values match AlarmDecoder's notifications/constants.py).
ARM = 0
DISARM = 1
POWER_CHANGED = 2
ALARM = 3
FIRE = 4
BYPASS = 5
BOOT = 6
CONFIG_RECEIVED = 7
ZONE_FAULT = 8
ZONE_RESTORE = 9
LOW_BATTERY = 10
PANIC = 11
ALARM_RESTORED = 13
LRR = 14
READY = 15
CHIME = 16
RFX = 17
EXP = 18
AUI = 19

# Our own additions; numbered well clear of AlarmDecoder's range.
PANEL_OFFLINE = 100
PANEL_ONLINE = 101
WEB_ACTION = 102

EVMSG_VERSION = -1

# Life-safety events are never held back by the e-mail throttle.
CRITICAL_EVENTS = [ALARM, PANIC, FIRE, PANEL_OFFLINE]

EVENT_TYPES = {
    ARM: 'arm', DISARM: 'disarm', POWER_CHANGED: 'power changed', ALARM: 'alarm',
    FIRE: 'fire changed', BYPASS: 'bypass', BOOT: 'boot',
    CONFIG_RECEIVED: 'config received', ZONE_FAULT: 'zone fault',
    ZONE_RESTORE: 'zone restore', LOW_BATTERY: 'low battery', PANIC: 'panic',
    LRR: 'lrr', READY: 'ready changed', CHIME: 'chime changed',
    ALARM_RESTORED: 'alarm restored', RFX: 'rfx', EXP: 'exp', AUI: 'aui',
    PANEL_OFFLINE: 'panel offline', PANEL_ONLINE: 'panel online', WEB_ACTION: 'web action',
}

# Which events a user can subscribe to, in display order (subset relevant to EVL).
SUBSCRIPTIONS = OrderedDict([
    (ALARM, 'Alarm system is triggered'),
    (ALARM_RESTORED, 'Alarm system stops signaling'),
    (PANIC, 'A panic has been detected'),
    (FIRE, 'The fire state has changed'),
    (ARM, 'Alarm system is armed'),
    (DISARM, 'Alarm system is disarmed'),
    (ZONE_FAULT, 'A zone has faulted'),
    (ZONE_RESTORE, 'A zone has been restored'),
    (BYPASS, 'A zone has been bypassed'),
    (POWER_CHANGED, 'Power status has changed'),
    (LOW_BATTERY, 'A low battery has been detected'),
    (BOOT, 'The system has (re)connected'),
    (PANEL_OFFLINE, 'Lost contact with the panel'),
    (PANEL_ONLINE, 'Contact with the panel restored'),
    (READY, 'A READY event was detected'),
    (CHIME, 'A CHIME event was detected'),
])

DEFAULT_EVENT_MESSAGES = {
    EVMSG_VERSION: '1.2',
    ARM: 'The alarm system has been armed {arm_type}.',
    DISARM: 'The alarm system has been disarmed.',
    POWER_CHANGED: 'Power status has changed to {status}.',
    ALARM: 'The alarm system has been triggered on zone {zone_name} ({zone})!',
    ALARM_RESTORED: 'The alarm system has stopped signaling the alarm for zone {zone_name} ({zone}).',
    FIRE: 'Fire status has changed to {status}',
    BYPASS: 'A zone has been bypassed.',
    BOOT: 'The system has finished booting.',
    ZONE_FAULT: 'Zone {zone_name} ({zone}) has been faulted.',
    ZONE_RESTORE: 'Zone {zone_name} ({zone}) has been restored.',
    LOW_BATTERY: 'Low battery detected.',
    PANIC: 'Panic!',
    READY: 'Ready status has changed to {status}',
    CHIME: 'Chime status has changed to {status}',
    PANEL_OFFLINE: 'Lost contact with the alarm panel for {minutes} minutes ({reason}).',
    PANEL_ONLINE: 'Contact with the alarm panel restored after {duration}.',
    WEB_ACTION: '{action} from the web app ({who}).',
}


def _armed(pstatus):
    return bool(pstatus.get('armed_away') or pstatus.get('armed_stay')
                or pstatus.get('armed_zero_entry_delay'))


def _arm_type(pstatus):
    if pstatus.get('armed_stay'):
        return 'in stay mode'
    if pstatus.get('armed_zero_entry_delay'):
        return 'in night mode'
    return 'in away mode'


def _zone_in_alarm(cur_zones):
    for n, z in cur_zones.items():
        if z.get('alarm'):
            return n, z.get('name', 'Zone %s' % n)
    return '', ''


def detect(prev, cur):
    """Diff two get_state() snapshots; return a list of (event_type, kwargs)."""
    events = []
    if not prev:
        return events

    pparts = prev.get('partitions', {})
    cparts = cur.get('partitions', {})
    for p, cs in cparts.items():
        ps = pparts.get(p, {})
        if not ps:
            continue

        if not _armed(ps) and _armed(cs):
            events.append((ARM, {'partition': p, 'arm_type': _arm_type(cs)}))
        elif _armed(ps) and not _armed(cs):
            events.append((DISARM, {'partition': p}))

        if not ps.get('alarm') and cs.get('alarm'):
            zn, zname = _zone_in_alarm(cur.get('zones', {}))
            events.append((ALARM, {'partition': p, 'zone': zn, 'zone_name': zname}))
        elif ps.get('alarm') and not cs.get('alarm'):
            events.append((ALARM_RESTORED, {'partition': p, 'zone': '', 'zone_name': ''}))

        if ps.get('fire') != cs.get('fire'):
            events.append((FIRE, {'partition': p, 'status': 'on' if cs.get('fire') else 'off'}))

        if ps.get('ac_present', True) and not cs.get('ac_present', True):
            events.append((POWER_CHANGED, {'partition': p, 'status': 'AC power lost'}))
        elif not ps.get('ac_present', True) and cs.get('ac_present', True):
            events.append((POWER_CHANGED, {'partition': p, 'status': 'AC power restored'}))

        if not ps.get('bat_trouble') and cs.get('bat_trouble'):
            events.append((LOW_BATTERY, {'partition': p}))

        if ps.get('ready') != cs.get('ready'):
            events.append((READY, {'partition': p, 'status': 'on' if cs.get('ready') else 'off'}))

        if ps.get('chime') != cs.get('chime'):
            events.append((CHIME, {'partition': p, 'status': 'on' if cs.get('chime') else 'off'}))

    pzones = prev.get('zones', {})
    czones = cur.get('zones', {})
    for n, cz in czones.items():
        pz = pzones.get(n, {})
        if not pz:
            continue
        name = cz.get('name', 'Zone %s' % n)

        prev_faulted = bool(pz.get('open') or pz.get('fault'))
        cur_faulted = bool(cz.get('open') or cz.get('fault'))
        if not prev_faulted and cur_faulted:
            events.append((ZONE_FAULT, {'zone': n, 'zone_name': name}))
        elif prev_faulted and not cur_faulted:
            events.append((ZONE_RESTORE, {'zone': n, 'zone_name': name}))

        if not pz.get('bypassed') and cz.get('bypassed'):
            events.append((BYPASS, {'zone': n, 'zone_name': name}))

    return events
