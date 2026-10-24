"use strict";

// Data fields, zone types and the alpha vocabulary for the ADEMCO VISTA-15P /
// VISTA-20P (and their SIA variants), from the Programming Guide K5305-1PRV5
// (10/04 Rev. A). Page numbers below refer to that guide.
//
// Field entry kinds (program.js turns each into keypresses):
//   sel    one entry from a list; values 10-15 are keyed as # + value
//   bits   checkboxes whose values add up to one sel-style entry
//   dd     two digits, 00-99
//   digits exactly `len` digits
//   phone  up to `max` positions: 0-9, * (#11), # (#12), P = 2 s pause (#13);
//          ends with * when shorter than max (or exactly `len`, no *)
//   acct   3, 4 or 10 characters 0-9 / B-F (B-F keyed as #11-#15); 3 ends with *
// Entry flags: p2 = VISTA-20P only (partition 2 / common), sia = SIA variants only.
// Field flags: only20 = VISTA-20P only, sia / nosia = only on / not on SIA variants.

var PGM = (function () {
  function range(a, b, fmt) {
    var out = [];
    for (var i = a; i <= b; i++) out.push([i, fmt ? fmt(i) : String(i)]);
    return out;
  }
  var NOYES = [[0, "No"], [1, "Yes"]];
  var OFFON = [[0, "Disabled"], [1, "Enabled"]];
  var TIMES = ["15 seconds", "30 seconds", "45 seconds", "60 seconds", "90 seconds", "2 minutes",
               "2½ minutes", "3 minutes", "4 minutes", "5 minutes", "6 minutes", "7 minutes",
               "8 minutes", "10 minutes", "12 minutes", "15 minutes"];
  var TIME_OPTS = TIMES.map(function (t, i) { return [i, t]; });
  var MONTHS = ["Disabled", "January", "February", "March", "April", "May", "June", "July",
                "August", "September", "October", "November", "December"];
  var RC1 = [[0, "Disabled"], [1, "Enabled (Contact ID)"]];
  var RC2 = [["00", "Disabled"], ["10", "Enabled (Contact ID)"]];
  var PAGER_OPTS = [[0, "No reports"], [1, "Opens/closes, all users"], [4, "All alarms and troubles"],
                    [5, "Alarms/troubles + opens/closes"], [12, "Alarms/troubles for zones in the pager's zone list"],
                    [13, "Pager zone list alarms/troubles + opens/closes"]];
  var KEYPAD_PART20 = [[0, "Keypad disabled"], [1, "Partition 1"], [2, "Partition 2"], [3, "Common"]];
  var KEYPAD_SOUND = [[0, "No suppression"], [1, "Suppress arm/disarm and entry/exit beeps"],
                      [2, "Suppress chime beeps only"], [3, "Suppress arm/disarm, entry/exit and chime beeps"]];

  // One entry per partition: P1, plus P2 and Common on the VISTA-20P.
  function perPart(base, withCommon) {
    var out = [Object.assign({ label: "Partition 1" }, base),
               Object.assign({ label: "Partition 2", p2: true }, base)];
    if (withCommon) out.push(Object.assign({ label: "Common", p2: true }, base));
    return out;
  }
  function rc(num, name, boxes, dflt, extra) {
    return Object.assign({ num: num, name: name, dflt: dflt,
                           entries: [{ t: "sel", opts: boxes === 2 ? RC2 : RC1, raw: boxes === 2 }] }, extra || {});
  }

  var sections = [
    { title: "Security & arming", fields: [
      { num: 20, name: "Installer Code", dflt: "4112",
        help: "The 4-digit code used to enter programming mode (installer code + 8 0 0).",
        warn: "Write the new code down. Without it you can only get back in by powering the panel down and pressing ✱ and # together within 50 seconds of power-up.",
        entries: [{ t: "digits", len: 4, label: "New installer code" }] },
      { num: 21, name: "Quick Arm Enable", dflt: "0,0",
        help: "Allow arming with # + 2 (away) / # + 3 (stay) instead of a code.",
        entries: perPart({ t: "sel", opts: NOYES }) },
      { num: 22, name: "RF Jam Option", dflt: "0", nosia: true,
        help: "Report RF jamming. UL: must be 1 if wireless devices are used.",
        entries: [{ t: "sel", opts: [[0, "No RF jam detection"], [1, "Send RF jam report"]] }] },
      { num: 23, name: "Quick (Forced) Bypass", dflt: "0,0",
        help: "Allow code + BYPASS + # to bypass every open zone at once.",
        entries: perPart({ t: "sel", opts: [[0, "No quick bypass"], [1, "Allow quick bypass (code + 6 + #)"]] }) },
      { num: 24, name: "RF House ID Code", dflt: "00,00,00",
        help: "House ID for 5827 / 5827BD / 5804BD wireless keypads. 00 disables wireless keypads.",
        entries: perPart({ t: "dd", min: 0, max: 31, hint: "00 = disabled, 01-31 = house ID" }, true) },
      { num: 26, name: "Chime By Zone", dflt: "0",
        help: "Only chime for the zones on zone list 3 (set it up with the Zone lists tab).",
        entries: [{ t: "sel", opts: [[0, "No - all entry/perimeter zones chime"], [1, "Yes - only zones on zone list 3"]] }] },
      { num: 34, name: "Exit Delay", dflt: "60,60",
        help: "Seconds to leave after arming. 97 = 120 seconds. SIA panels: at least 45.",
        entries: perPart({ t: "dd", min: 0, max: 97, hint: "00-96 seconds, 97 = 120 s" }) },
      { num: 35, name: "Entry Delay #1", dflt: "30,30",
        help: "Seconds to disarm after opening an entry/exit #1 zone. 97 = 120 s, 98 = 180 s, 99 = 240 s.",
        entries: perPart({ t: "dd", min: 0, max: 99, hint: "00-96 seconds, 97 = 2 min, 98 = 3 min, 99 = 4 min" }) },
      { num: 36, name: "Entry Delay #2", dflt: "30,30",
        help: "Same as *35, for entry/exit #2 zones.",
        entries: perPart({ t: "dd", min: 0, max: 99, hint: "00-96 seconds, 97 = 2 min, 98 = 3 min, 99 = 4 min" }) },
      { num: 37, name: "Audible Exit Warning", dflt: "1,1",
        help: "Keypad beeps during the exit delay.",
        entries: perPart({ t: "sel", opts: NOYES }) },
      { num: 38, name: "Confirmation Of Arming Ding", dflt: "0,0",
        help: "A short bell 'ding' when the system arms.",
        entries: perPart({ t: "sel", opts: [[0, "No"], [1, "Yes (wired keypads and RF)"], [2, "Yes, RF only"]] }) },
      { num: 39, name: "Power Up In Previous State", dflt: "1",
        help: "After a total power loss, come back armed if it was armed.",
        entries: [{ t: "sel", opts: [[0, "No - always power up disarmed"], [1, "Yes - power up in previous state"]] }] },
      { num: 84, name: "Auto Stay Arm", dflt: "3",
        help: "If you arm AWAY and nobody leaves through an entry/exit door, the panel arms STAY instead.",
        entries: [{ t: "sel", opts: [[0, "No"], [1, "Partition 1 only"], [2, "Partition 2 only"], [3, "Both partitions"]],
                    opts15: [[0, "No"], [1, "Yes"]] }] },
      { num: 85, name: "Cross Zone Timer", dflt: "0",
        help: "Two zones on zone list 4 must both fault within this time to cause an alarm. Not for UL installations.",
        entries: [{ t: "sel", opts: TIME_OPTS }] },
      { num: 86, name: "Cancel Verify Keypad Display", dflt: "1",
        help: "Show 'ALARM CANCELED' after disarming during an alarm (code + OFF again clears it).",
        entries: [{ t: "sel", opts: [[0, "No display"], [1, "Display 'Alarm Canceled'"]] }] },
      { num: 87, name: "Misc. Fault Delay Time", dflt: "0",
        help: "Delay used by configurable zone types that select 'fault delay'.",
        entries: [{ t: "sel", opts: TIME_OPTS }] },
      { num: 88, name: "Program Mode Lockout Options", dflt: "0",
        help: "What exiting with ✱98 locks out.",
        warn: "Options 1 and 3 can lock you out of keypad programming. Leave at 0 unless you know you need it.",
        entries: [{ t: "sel", opts: [[0, "Standard ✱98 lockout (re-enter with ✱ + # after power-up)"],
                                     [1, "Lock out ✱ + # re-entry (installer code or downloader only)"],
                                     [3, "Lock out local programming (downloader only)"]] }] },
    ]},
    { title: "Sounders & power", fields: [
      { num: 31, name: "Single Alarm Sounding Per Zone", dflt: "0",
        entries: [{ t: "sel", opts: [[0, "Unlimited sounding"], [1, "One alarm sounding per zone"]] }] },
      { num: 32, name: "Fire Alarm Sounder Timeout", dflt: "0",
        entries: [{ t: "sel", opts: [[0, "Sound stops at bell timeout"], [1, "No timeout"]] }] },
      { num: 33, name: "Alarm Sounder (Bell) Timeout", dflt: "1",
        entries: [{ t: "sel", opts: [[0, "None"], [1, "4 minutes"], [2, "8 minutes"], [3, "12 minutes"], [4, "16 minutes"]] }] },
      { num: 177, name: "Device Duration 1, 2", dflt: "0,0",
        help: "Run times for output actions 'duration 1' and 'duration 2' (✱80).",
        entries: [{ t: "sel", opts: TIME_OPTS, label: "Duration 1" }, { t: "sel", opts: TIME_OPTS, label: "Duration 2" }] },
      { num: 181, name: "50/60 Hertz AC Operation", dflt: "0",
        entries: [{ t: "sel", opts: [[0, "60 Hz"], [1, "50 Hz"]] }] },
    ]},
    { title: "Keypads", fields: [
      { num: 189, name: "AUI Device 1 and 2 Enable", dflt: "1,1",
        help: "Touch-screen keypads (6270, Symphony). Set the touch screen's own address to 1 or 2.",
        entries: [{ t: "sel", label: "AUI 1", opts: [[0, "Disabled"], [1, "Partition 1"], [2, "Partition 2"], [3, "Common"]], opts15: OFFON },
                  { t: "sel", label: "AUI 2", opts: [[0, "Disabled"], [1, "Partition 1"], [2, "Partition 2"], [3, "Common"]], opts15: OFFON }] },
    ].concat([2, 3, 4, 5, 6, 7, 8].map(function (k) {
      return { num: 188 + k, name: "Keypad " + k + " (device address " + (15 + k) + ")", dflt: "0,0",
               help: "Enable the keypad set to address " + (15 + k) + ". Keypad 1 (address 16) is always on. The EnvisaLink itself uses one keypad address - leave that one enabled.",
               entries: [{ t: "sel", label: "Partition / enable", opts: KEYPAD_PART20, opts15: OFFON },
                         { t: "sel", label: "Sound", opts: KEYPAD_SOUND }] };
    })).concat([
      { num: 197, name: "Exit Time Display Interval", dflt: "0",
        help: "Count down the exit delay on the keypad, refreshing every N seconds.",
        entries: [{ t: "sel", opts: [[0, "No display"]].concat(range(1, 5, function (i) { return i + " s between refreshes"; })) }] },
      { num: 198, name: "Display Partition Number", dflt: "0", only20: true,
        entries: [{ t: "sel", opts: NOYES }] },
      { num: 199, name: "ECP Fail Display", dflt: "0",
        entries: [{ t: "sel", opts: [[0, "3-digit display ('1' + device address)"], [1, "2-digit fixed display as '91'"]] }] },
    ])},
    { title: "Phone & central station", fields: [
      { num: 40, name: "PABX Access Code or Call Waiting Disable", dflt: "(blank)", clearable: true,
        help: "Digits dialled before the phone number. For call waiting use ✱70 then a pause: type *70P.",
        entries: [{ t: "phone", max: 6, label: "Digits" }] },
      { num: 41, name: "Primary Phone No.", dflt: "(blank)", clearable: true,
        entries: [{ t: "phone", max: 20, label: "Phone number" }] },
      { num: 42, name: "Second Phone No.", dflt: "(blank)", clearable: true,
        entries: [{ t: "phone", max: 20, label: "Phone number" }] },
      { num: 43, name: "Partition 1 Primary Acct. No.", dflt: "FFFFFFFFFF", clearable: true,
        entries: [{ t: "acct", label: "Account number" }] },
      { num: 44, name: "Partition 1 Secondary Acct. No.", dflt: "FFFFFFFFFF", clearable: true,
        entries: [{ t: "acct", label: "Account number" }] },
      { num: 45, name: "Partition 2 Primary Acct. No.", dflt: "FFFFFFFFFF", clearable: true, only20: true,
        entries: [{ t: "acct", label: "Account number" }] },
      { num: 46, name: "Partition 2 Secondary Acct. No.", dflt: "FFFFFFFFFF", clearable: true, only20: true,
        entries: [{ t: "acct", label: "Account number" }] },
      { num: 47, name: "Phone System Select", dflt: "1",
        entries: [{ t: "sel", opts: [[0, "Pulse dial"], [1, "Tone dial"], [2, "Pulse dial (central station on WATS line)"], [3, "Tone dial (central station on WATS line)"]] }] },
      { num: 48, name: "Report Format", dflt: "7,7",
        entries: ["Primary", "Secondary"].map(function (l) {
          return { t: "sel", label: l, opts: [[0, "3+1, 4+1 Ademco L/S standard"], [1, "3+1, 4+1 Radionics standard"],
            [2, "4+2 Ademco L/S standard"], [3, "4+2 Radionics standard"], [5, "10-digit Ademco Contact ID"],
            [6, "4+2 Ademco Express"], [7, "4-digit Ademco Contact ID"], [8, "3+1, 4+1 Ademco L/S expanded"],
            [9, "3+1, 4+1 Radionics expanded"]] };
        }) },
      { num: 49, name: "Split/Dual Reporting", dflt: "0",
        entries: [{ t: "sel", opts: [[0, "Standard/backup only (all to primary)"],
          [1, "Primary: alarms, restore, cancel / 2nd: others"], [2, "Primary: all but open/close, test / 2nd: open/close, test"],
          [3, "Primary: alarms, restore, cancel / 2nd: all"], [4, "Primary: all but open/close, test / 2nd: all"], [5, "All to both"]] }] },
      { num: 50, name: "Burglary Dialer Delay", dflt: "2,0",
        help: "Wait before dialling a burglary alarm, so a quick disarm cancels it.",
        entries: [{ t: "sel", label: "Delay", opts: [[0, "No delay"], [1, "15 seconds"], [2, "30 seconds"], [3, "45 seconds"]] },
                  { t: "sel", label: "Delay disable", sia: true, opts: [[0, "Use the delay above"], [1, "No dial delay for zones on zone list 6"]] }] },
      { num: 53, name: "SESCOA/Radionics Select", dflt: "0",
        entries: [{ t: "sel", opts: [[0, "Radionics (0-9, B-F) - use for all non-SESCOA formats"], [1, "SESCOA (0-9 only)"]] }] },
      { num: 54, name: "Dynamic Signaling Delay", dflt: "0",
        entries: [{ t: "sel", opts: range(0, 15, function (i) { return i ? (i * 15) + " seconds" : "No delay (both signals sent)"; }) }] },
      { num: 55, name: "Dynamic Signaling Priority", dflt: "0",
        entries: [{ t: "sel", opts: [[0, "Primary dialer first"], [1, "Long range radio first"]] }] },
      { num: 91, name: "Option Selection", dflt: "8,0",
        entries: [{ t: "sel", label: "Options", opts: [[0, "None"], [4, "AAV"], [8, "Exit delay restart/reset"], [12, "AAV and exit delay restart/reset"]] },
                  { t: "sel", label: "Call waiting disable", sia: true, opts: [[0, "Call waiting not used"], [1, "Dial ✱40 digits on alternate attempts"]] }] },
      { num: 92, name: "Phone Line Monitor Enable", dflt: "0,0",
        entries: [{ t: "sel", label: "Delay", opts: range(0, 15, function (i) { return i ? i + " min" : "Disabled"; }) },
                  { t: "sel", label: "When faulted", opts: [[0, "Keypad display"], [1, "Keypad display + trouble sound"], [2, "Display + trouble sound + start output device (and sounder if armed)"]] }] },
      { num: 93, name: "Reports In Armed Period Per Zone", dflt: "1,0",
        entries: [{ t: "sel", label: "Report pairs", opts: [[0, "Unlimited"], [1, "1 report pair"], [2, "2 report pairs"]] },
                  { t: "sel", label: "Unlimited reports", sia: true, opts: [[0, "Restrict to the setting above"], [1, "Unlimited for zones on zone list 7"]] }] },
      { num: 94, name: "Download Phone No.", dflt: "(blank)", clearable: true,
        entries: [{ t: "phone", max: 20, label: "Phone number" }] },
      { num: 95, name: "Ring Count For Downloading", dflt: "15",
        entries: [{ t: "sel", opts: [[0, "Disable station-initiated download"]].concat(range(1, 14, function (i) { return i + " ring" + (i > 1 ? "s" : ""); })).concat([[15, "Answering machine defeat"]]) }] },
      { num: 28, name: "Access Code For Phone Module", dflt: "00",
        help: "Two keys for the 4285/4286 phone module: a digit 1-9 then * or #, e.g. 1*. 00 = disabled.",
        entries: [{ t: "phone", len: 2, label: "Access code" }] },
      { num: 29, name: "Long Range Radio Output", dflt: "0",
        entries: [{ t: "sel", opts: OFFON }] },
    ]},
    { title: "Report codes", note: "Contact ID: any non-zero first digit enables the report, 0 disables it.", fields: [
      rc(59, "Exit Error Alarm Report Code", 1, "0"),
      rc(60, "Trouble Report Code", 2, "00"),
      rc(61, "Bypass Report Code", 2, "00"),
      rc(62, "AC Loss Report Code", 2, "00"),
      rc(63, "Low Bat Report Code", 2, "00"),
      rc(64, "Test Report Code", 2, "00"),
      { num: 65, name: "Open Report Code", dflt: "0,0,0", entries: perPart({ t: "sel", opts: RC1 }, true) },
      { num: 66, name: "Arm Away/Stay Report Code", dflt: "0,0,0,0,0,0",
        entries: [{ label: "Part. 1 away" }, { label: "Part. 1 stay" }, { label: "Part. 2 away", p2: true },
                  { label: "Part. 2 stay", p2: true }, { label: "Common away", p2: true }, { label: "Common stay", p2: true }]
                  .map(function (e) { return Object.assign({ t: "sel", opts: RC1 }, e); }) },
      rc(67, "RF Transmitter Low Bat Report Code", 2, "00"),
      rc(68, "Cancel Report Code", 2, "00"),
      rc(69, "Recent Closing Report Code", 2, "11", { sia: true }),
      rc(70, "Alarm Restore Report Code", 1, "0"),
      rc(71, "Trouble Restore Report Code", 2, "00"),
      rc(72, "Bypass Restore Report Code", 2, "00"),
      rc(73, "AC Restore Report Code", 2, "00"),
      rc(74, "Low Bat Restore Report Code", 2, "00"),
      rc(75, "RF Transmitter Low Bat Restore Report Code", 2, "00"),
      rc(76, "Test Restore Report Code", 2, "00"),
      rc(89, "Event Log Full Report Code", 2, "00"),
    ]},
    { title: "Clock & event log", fields: [
      { num: 77, name: "Daylight Saving Time Start/End Month", dflt: "4,10",
        help: "US rules since 2007: March and November.",
        entries: [{ t: "sel", label: "Start month", opts: MONTHS.map(function (m, i) { return [i, m]; }) },
                  { t: "sel", label: "End month", opts: MONTHS.map(function (m, i) { return [i, m]; }) }] },
      { num: 78, name: "Daylight Saving Time Start/End Weekend", dflt: "1,5",
        help: "US rules since 2007: second weekend (start) and first weekend (end).",
        entries: ["Start weekend", "End weekend"].map(function (l) {
          return { t: "sel", label: l, opts: [[0, "Disabled"], [1, "First"], [2, "Second"], [3, "Third"], [4, "Fourth"],
                                               [5, "Last"], [6, "Next to last"], [7, "Third to last"]] };
        }) },
      { num: 90, name: "Event Log Enables", dflt: "3",
        help: "Which events the panel's own event log keeps.",
        entries: [{ t: "bits", opts: [[1, "Alarm / alarm restore"], [2, "Trouble / trouble restore"],
                                      [4, "Bypass / bypass restore"], [8, "Open / close"]] }] },
    ]},
    { title: "Pagers", fields: [].concat.apply([], [1, 2, 3, 4].map(function (p) {
      var base = 160 + (p - 1) * 3, o20 = p > 2;
      return [
        { num: base, name: "Pager " + p + " Phone No.", dflt: "(blank)", clearable: true, only20: o20,
          entries: [{ t: "phone", max: 20, label: "Phone number" }] },
        { num: base + 1, name: "Pager " + p + " Characters", dflt: "(blank)", clearable: true, only20: o20,
          help: "Optional prefix characters sent before the pager message.",
          entries: [{ t: "phone", max: 16, label: "Characters" }] },
        { num: base + 2, name: "Pager " + p + " Report Options", dflt: "0,0,0", only20: o20,
          help: "Options 12/13 use zone list " + (8 + p) + ".",
          entries: perPart({ t: "sel", opts: PAGER_OPTS }, true) },
      ];
    })).concat([
      { num: 172, name: "Pager Delay Option For Alarms", dflt: "3",
        entries: [{ t: "sel", opts: [[0, "None"], [1, "1 minute"], [2, "2 minutes"], [3, "3 minutes"]] }] },
    ])},
    { title: "Other devices", fields: [
      { num: 27, name: "Powerline Carrier Device (X-10) House Code", dflt: "0",
        entries: [{ t: "sel", opts: "ABCDEFGHIJKLMNOP".split("").map(function (c, i) { return [i, c]; }) }] },
      { num: 174, name: "Clean Me Reporting Options", dflt: "0",
        help: "For ESL smoke detectors. If enabled, set zone 1's response time to 3 in ✱56.",
        entries: [{ t: "sel", opts: [[0, "Disabled"], [1, "Clean Me signal reports"]] }] },
    ]},
  ];

  var ZONE_TYPES = [
    [0, "Not used"], [1, "Entry/exit #1"], [2, "Entry/exit #2"], [3, "Perimeter"], [4, "Interior follower"],
    [5, "Trouble day / alarm night"], [6, "24-hr silent"], [7, "24-hr audible"], [8, "24-hr auxiliary"],
    [9, "Fire"], [10, "Interior with delay"], [12, "Monitor zone"], [14, "Carbon monoxide"],
    [16, "Fire with verification"], [20, "Arm STAY (5800 buttons)"], [21, "Arm AWAY (5800 buttons)"],
    [22, "Disarm (5800 buttons)"], [23, "No alarm response"], [24, "Silent burglary"], [77, "Keyswitch"],
    [81, "AAV monitor zone"], [90, "Configurable 90"], [91, "Configurable 91"]
  ];
  var HARDWIRE = [[0, "EOL (end-of-line resistor)"], [1, "NC (normally closed)"], [2, "NO (normally open)"],
                  [3, "Zone doubling (VISTA-20P)"], [4, "Double-balanced (VISTA-20P)"]];
  var RESPONSE = [[0, "10 ms"], [1, "350 ms (default)"], [2, "700 ms"], [3, "1.2 s"]];
  var INPUT_TYPES = [[2, "AW - wired on a 4219/4229 expander"], [3, "RF - supervised wireless"],
                     [4, "UR - unsupervised wireless"], [5, "BR - unsupervised button (keyfob)"]];

  var ZONE_LISTS = [
    [1, "General purpose"], [2, "General purpose"], [3, "Chime-by-zone (✱26) or general purpose"],
    [4, "Cross zones (✱85) or general purpose"], [5, "Night-stay zones or general purpose"],
    [6, "Dial delay disable (✱50, SIA) or general purpose"], [7, "Unlimited reports (✱93, SIA) or general purpose"],
    [8, "General purpose"], [9, "Zones activating pager 1"], [10, "Zones activating pager 2"],
    [11, "Zones activating pager 3 (VISTA-20P)"], [12, "Zones activating pager 4 (VISTA-20P)"]
  ];

  // Alpha vocabulary (page 11). 000 is a blank word.
  var VOCAB = {
    "AIR": 1, "ALARM": 2, "ALLEY": 4, "AMBUSH": 5, "AREA": 6, "APARTMENT": 7, "ATTIC": 9, "AUDIO": 10,
    "BABY": 12, "BACK": 13, "BAR": 14, "BASEMENT": 16, "BATHROOM": 17, "BED": 18, "BEDROOM": 19, "BELL": 20,
    "BLOWER": 21, "BOILER": 22, "BOTTOM": 23, "BREAK": 25, "BUILDING": 26,
    "CABINET": 28, "CALL": 29, "CAMERA": 30, "CAR": 31, "CASH": 33, "CCTV": 34, "CEILING": 35, "CELLAR": 36,
    "CENTRAL": 37, "CIRCUIT": 38, "CLOSED": 40, "COMPUTER": 46, "CONTACT": 47,
    "DAUGHTERS": 48, "DELAYED": 49, "DEN": 50, "DESK": 51, "DETECTOR": 52, "DINING": 53, "DISCRIMINATOR": 54,
    "DISPLAY": 55, "DOOR": 57, "DOWN": 59, "DOWNSTAIRS": 60, "DRAWER": 61, "DRIVEWAY": 62, "DUCT": 64,
    "EAST": 65, "ELECTRIC": 66, "EMERGENCY": 67, "ENTRY": 68, "EQUIPMENT": 69, "EXIT": 71, "EXTERIOR": 72,
    "FACTORY": 73, "FAMILY": 75, "FATHERS": 76, "FENCE": 77, "FIRE": 79, "FLOOR": 80, "FLOW": 81, "FOIL": 82,
    "FOYER": 83, "FREEZER": 84, "FRONT": 85,
    "GARAGE": 89, "GAS": 90, "GATE": 91, "GLASS": 92, "GUEST": 93, "GUN": 94,
    "HALL": 95, "HEAT": 96, "HOLDUP": 98, "HOUSE": 99,
    "INFRARED": 100, "INSIDE": 101, "INTERIOR": 102, "INTRUSION": 103, "JEWELRY": 104, "KITCHEN": 105,
    "LAUNDRY": 106, "LEFT": 107, "LEVEL": 108, "LIBRARY": 109, "LIGHT": 110, "LINE": 111, "LIVING": 113,
    "LOADING": 114, "LOCK": 115, "LOOP": 116, "LOW": 117, "LOWER": 118,
    "MACHINE": 119, "MAIDS": 121, "MAIN": 122, "MASTER": 123, "MEDICAL": 125, "MEDICINE": 126, "MONEY": 128,
    "MONITOR": 129, "MOTHERS": 130, "MOTION": 131, "MOTOR": 132,
    "NORTH": 134, "NURSERY": 135, "OFFICE": 136, "OPEN": 138, "OPENING": 139, "OUTSIDE": 140, "OVERHEAD": 142,
    "PAINTING": 143, "PANIC": 144, "PASSIVE": 145, "PATIO": 146, "PERIMETER": 147, "PHONE": 148, "POINT": 150,
    "POLICE": 151, "POOL": 152, "POWER": 153,
    "RADIO": 155, "REAR": 156, "RECREATION": 157, "REFRIGERATION": 159, "RF": 160, "RIGHT": 161, "ROOM": 162, "ROOF": 163,
    "SAFE": 164, "SCREEN": 165, "SENSOR": 166, "SERVICE": 167, "SHED": 168, "SHOCK": 169, "SHOP": 170, "SHORT": 171,
    "SIDE": 173, "SKYLIGHT": 174, "SLIDING": 175, "SMOKE": 176, "SONS": 178, "SOUTH": 179, "SPRINKLER": 180,
    "STATION": 182, "STORE": 184, "STORAGE": 185, "STORY": 186, "SUPERVISED": 190, "SUPERVISION": 191,
    "SWIMMING": 192, "SWITCH": 193,
    "TAMPER": 194, "TELCO": 196, "TELEPHONE": 197, "TEMPERATURE": 199, "THERMOSTAT": 200, "TOOL": 201, "TRANSMITTER": 202,
    "UP": 205, "UPPER": 206, "UPSTAIRS": 207, "UTILITY": 208,
    "VALVE": 209, "VAULT": 210, "VOLTAGE": 212,
    "WALL": 213, "WAREHOUSE": 214, "WEST": 216, "WINDOW": 217, "WING": 219, "WIRELESS": 220,
    "XMITTER": 222, "YARD": 223, "ZONE": 225,
    "0": 226, "1": 227, "1ST": 228, "2": 229, "2ND": 230, "3": 231, "3RD": 232, "4": 233, "4TH": 234,
    "5": 235, "5TH": 236, "6": 237, "6TH": 238, "7": 239, "7TH": 240, "8": 241, "8TH": 242, "9": 243, "9TH": 244
  };
  // Common words that aren't in the vocabulary, mapped to ones that are.
  var VOCAB_ALIASES = {
    "WINDOWS": "WINDOW", "DOORS": "DOOR", "BEDROOMS": "BEDROOM", "ROOMS": "ROOM", "LIV": "LIVING",
    "GLASSBREAK": "GLASS", "BATH": "BATHROOM", "KIT": "KITCHEN",
    "FIRST": "1ST", "SECOND": "2ND", "THIRD": "3RD", "PIR": "MOTION", "SLIDER": "SLIDING",
    "DETECTORS": "DETECTOR", "SENSORS": "SENSOR"
  };

  return { sections: sections, ZONE_TYPES: ZONE_TYPES, HARDWIRE: HARDWIRE, RESPONSE: RESPONSE,
           INPUT_TYPES: INPUT_TYPES, ZONE_LISTS: ZONE_LISTS, VOCAB: VOCAB, VOCAB_ALIASES: VOCAB_ALIASES };
})();
