// Equipment-specific troubleshooting background for this equipment family's
// common subsystems, written originally by the Tervexa team to give the
// diagnosis AI more specific, useful context to reason from when a report
// clearly involves this equipment. It's background for the model to write
// its OWN diagnosis from, never text meant to be echoed back to a user
// verbatim.
//
// Every note below is deliberately kept at the level of general field-
// service reasoning (what tends to fail, what to check first, how to tell
// one cause from another) rather than citing exact specifications, stats,
// or manufacturer-internal component names/acronyms — useful troubleshooting
// judgment, not a lift of anyone's proprietary documentation.
//
// First pass covered the subsystems technicians report on most often. A
// second pass folded in more specific field-service reasoning for those same
// subsystems found while reviewing a troubleshooting-focused reference for
// this equipment family, and added a few subsystems that reference revealed
// but the first pass didn't cover (printer, firmware/system-software
// anomalies, optional accessory/expansion modules present on some
// configurations but not others) — all rewritten to the same generic level
// (no exact specs, no manufacturer-internal terms). Extend
// SUBSYSTEM_KNOWLEDGE below as more equipment families or subsystems come
// up, keeping to that same level of generality.

const EQUIPMENT_FAMILY_PATTERN = /\b(panther|fusion)\b/i;

const SUBSYSTEM_KNOWLEDGE = [
  {
    key: 'vacuum',
    match: /\b(vacuum|suction|vac[\s_-]?pump|vac[\s_-]?pressure|low vac)\b/i,
    note: 'Vacuum system: on a low-vacuum fault, don\'t assume a clogged or wet filter is the cause just because it\'s the easiest part to swap — that often just masks the real issue temporarily. Work through the full air path systematically: fittings and O-rings (especially quick-release couplings between the waste bottle, manifold, and pump), the vacuum sensor\'s sensing line for buildup or blockage, and general pump wear, comparing actual readings against the documented target range for the system rather than guessing. It\'s also worth distinguishing an intermittent cutout from a genuinely low steady reading — a vacuum that reads fine but shuts off intermittently can trace to a flow-control or duty-cycle setting rather than an actual leak, and is worth checking in software before chasing hardware. Low-vacuum faults are often the sum of more than one small leak rather than a single clean cause, so a full pass across the system — not stopping at the first thing found — is usually what actually fixes it.'
  },
  {
    key: 'pipettor',
    match: /\b(pipettor|pipette|pipetting|gantry|z[\s-]?motor|liquid[\s-]?level)\b/i,
    note: 'Pipettor/liquid-handling: inaccurate aspiration or dispensing, missed liquid-level detection, or pipetting errors often trace to mechanical wear rather than a software fault — a worn calibration reference point, rail wear or misalignment affecting positioning repeatability, disposable-tip residue buildup, or a vertical-axis alignment issue. Confirm whether the fault is repeatable and whether it affects a single pipetting position or all of them: a single-position fault points toward a local mechanical issue, while an all-position fault points more toward calibration, alignment, or a shared drive component. It\'s also worth checking whether failures cluster around a specific batch or lot of disposable tips or consumables rather than a specific position — a bad lot can look exactly like a hardware fault until the consumable itself is swapped out.'
  },
  {
    key: 'barcode',
    match: /\b(barcode|can'?t read (the )?(sample|tube|reagent)|scan(ner)? (error|fail)|label (not )?read)\b/i,
    note: 'Barcode reading (sample or reagent handling): failures to read a tube or reagent barcode usually come down to one of three things — a dirty or misaligned reader needing cleaning or realignment, a physical obstruction along the read path throwing off positioning, or a genuinely damaged or poorly-applied label. Worth checking whether the failure is specific to one position (points to a local obstruction or reader issue) or happens across multiple positions or samples (points more toward the reader itself) — and separately, whether the reader is misreading versus not responding at all, since a non-responsive reader points toward a connection or power issue rather than optics or alignment. If a rotating carousel-mounted reader or its drive motor is making an unusual chirping or grinding noise rather than throwing a read error, that can be a belt or motor tensioning issue rather than a worn bearing — re-tensioning the motor mount sometimes resolves it without a parts replacement.'
  },
  {
    key: 'waste',
    match: /\b(waste (bottle|drawer|line)|coalescing|overflow|leak(ing)?|drain)\b/i,
    note: 'Waste handling: leaks, overflow warnings, or waste-handling faults commonly trace to a full or malfunctioning drain trap, a stuck or failed level sensor (which is what actually signals "full" to the system, not the true fill level), worn quick-release fittings, or a degraded filter. If the complaint is a false "full" reading rather than an actual overflow, the level sensor and its wiring are worth checking before assuming the container genuinely needs emptying. Also worth confirming a recently replaced filter or cover was installed in the correct orientation — an alarming-looking waste or overflow symptom is sometimes nothing more than a part installed backwards, which is a much quicker fix than it first appears.'
  },
  {
    key: 'magwash',
    match: /\b(mag[\s_-]?wash|magnetic wash)\b/i,
    note: 'Magnetic wash module: cycle failures or inconsistent wash results often point to the wash mechanism\'s drive binding or needing lubrication, or to a cycle-configuration mismatch (some setups support more than one wash-cycle type, and a mismatch here can look like a hardware fault when it isn\'t). Confirm the configured cycle settings match what\'s expected for the assay before assuming a mechanical failure. A related pattern worth ruling out is detection-sensor baseline drift: a sensor that has drifted out of its baseline can report a tube or component as "not detected" even though it\'s physically present and seated correctly — that looks like a loading or mechanical fault but is really a sensor calibration issue.'
  },
  {
    key: 'incubator',
    match: /\b(incubator|real[\s-]?time fluoromet(er|ry)|amplification (chamber|incubator))\b/i,
    note: 'Incubation and real-time signal reading: unexpected readings, flagged results, or amplification anomalies are frequently an optical alignment or calibration issue rather than a true reagent or sample problem — the reader works through a fixed optical path, so even small misalignment shows up as inconsistent readings. Temperature drift in the incubation chamber itself is the other common cause worth ruling out, especially if the anomaly is isolated to one position rather than system-wide. When several optical sensor units are wired together in a chain, one failed unit early in the chain can make every unit after it look dead or unresponsive too — worth checking the chain from its start rather than assuming each affected position has its own separate fault. A wavy or inconsistent positioning/alignment curve more often traces to bearing wear, magnet wear, or drive-belt tension than to electronics, and visible debris or dust on an optical lens is worth cleaning and re-testing before replacing the part.'
  },
  {
    key: 'luminometer',
    match: /\b(luminometer|luminescence|\bRLU\b|cal(ibration)? factor)\b/i,
    note: 'Luminometer/signal detection: unexpected light-unit readings or luminescence-based result flags often trace to calibration drift over time rather than a hardware failure outright — the calibration reference is meant to be refreshed periodically. An optical sensor issue is the next most common cause. Before escalating as a hardware fault, it\'s worth checking how recently calibration was last updated, re-running the calibration/normalization step, and whether the anomaly affects one channel/position or reads across the board. Fluidic integrity along the injection path is also worth checking directly — a small leak at a fitting can show up as a delayed or dampened light-off signal that lines up in time with the injection itself, a strong clue it\'s mechanical rather than a chemistry or reagent problem. Ambient or reagent-storage temperature is another factor worth ruling out: a normalization value trending consistently high or low across runs (rather than one-off and random) is worth checking against the temperature where reagents are stored or the lab is kept, since deviations either direction can shift these values with no hardware fault at all. When troubleshooting, capturing a baseline reading before making any change and comparing directly against it after each single change is far more reliable than changing several things at once and hoping the result improves.'
  },
  {
    key: 'universalFluid',
    match: /\b(universal fluid|bleach|wash buffer|solenoid valve|interlock)\b/i,
    note: 'Fluid delivery system: problems like wrong volumes, failed purges, or a system that won\'t proceed past a fluid-related check often trace to a valve sticking, air trapped in a line needing a purge cycle, a fluid-detection sensor giving a false reading, or a safety interlock not registering closed even though it visually looks closed. An interlock fault in particular can look like a much bigger problem than it is, since the system will refuse to run at all until it\'s resolved.'
  },
  {
    key: 'pcNetwork',
    match: /\b(windows|\bBIOS\b|\bLIS\b (connection|communication|interface)|network drive|remote (monitoring|dashboard)|fileshare)\b/i,
    note: 'PC/workstation and connectivity: software-side issues on this platform are often configuration rather than a genuine defect — lab information system (LIS) communication problems commonly trace to a broken network share mapping or communication having been disabled, and BIOS or storage-configuration mismatches tend to surface after a PC has been reimaged or replaced. A sluggish or unresponsive workstation is also sometimes a disk-performance issue rather than a hardware problem. Worth confirming whether the issue started right after any recent PC service, reimage, network change, or software upgrade before assuming a deeper fault — a fresh image or upgrade doesn\'t always carry over every configuration setting the system needs, and re-checking those is often faster than treating it as a new defect. Power-up order can also matter on systems with a separate workstation and main instrument: powering the instrument on before the workstation has fully booted can leave the workstation stuck in an error state that looks like a PC fault but is really a sequencing issue, resolved by powering both down and bringing the workstation up first. When a workstation won\'t boot at all, a useful isolation technique is disconnecting all non-essential peripherals and accessories and booting with only the minimum required connected, then reconnecting one at a time to find what\'s causing the hang. For network/LIS connectivity failures specifically, work through the physical layer before the logical one — cabling and link lights at each device in the chain first, then whether devices can reach each other at all, then address configuration, and only then name-resolution or higher-level settings — rather than jumping straight to advanced configuration changes.'
  },
  {
    key: 'power',
    match: /\b(\bUPS\b|uninterrupt(ible|ed) power|battery (low|disconnect)|bypass mode|power (outage|failure)|overload)\b/i,
    note: 'UPS/power: a UPS typically reports its state through an LED pattern and/or a beep pattern rather than a plain-language "power fault" message, so it\'s worth having whoever\'s on site describe exactly what they\'re seeing and hearing rather than assuming. As a rough guide — steady, slow beeping usually means a utility power failure with the UPS now carrying the load; faster beeping paired with a flashing low-battery indicator means the battery is nearly depleted and equipment needs to shut down soon; a "bypass" indication means utility power is passing through with little or no filtering and battery protection may not be available, worth flagging as higher priority; and a "batteries disconnected" or "overload" indication points to a UPS hardware issue rather than a utility power problem and usually needs escalation rather than a wait-and-see approach. Internal board-to-board communication indicators follow a different pattern worth knowing: a light that flashes only while data is actively passing is normal, while that same light staying solidly lit usually signals that link is saturated or overloaded — often a bad connection somewhere along that segment rather than a fault in the board itself.'
  },
  {
    key: 'cooling',
    match: /\b(cooling module|chiller|coolant|cooling (system|pressure))\b/i,
    note: 'Cooling module: temperature-related faults or shutdowns often trace to low coolant level or pressure in a closed liquid-cooling loop rather than the component actually being cooled. A pressure check of the cooling system is a reasonable first step before assuming the fault lies with whatever downstream module is showing the temperature warning.'
  },
  {
    key: 'queue',
    match: /\b(input queue|output queue|carousel|tube (jam|feed)|injector)\b/i,
    note: 'Input/output queue and sample transport: tube jams, misfeeds, or failed transfers commonly trace to rail alignment drift on the transport carrier, a worn indexing mechanism, or a queue drive needing cleaning and lubrication. Worth noting whether the jam happens at a consistent physical position (points to local mechanical wear) or moves around (points more toward rail alignment or drive speed/timing). After a hardware or firmware upgrade, transport positioning errors that only affect some positions while others work fine often mean stored position-calibration data needs to be re-taught rather than pointing to a new mechanical fault — worth checking calibration history against the upgrade date before pursuing a hardware explanation. A distinct pattern worth recognizing separately is a handoff failure between two modules where the system still believes an item is present after it has actually moved on (or the reverse) — this kind of "phantom" state can cascade into unrelated-looking errors downstream, and is usually resolved by clearing or resetting the affected transport position rather than chasing the downstream symptoms.'
  },
  {
    key: 'printer',
    match: /\b(printer|printing|print job|won'?t print|offline printer)\b/i,
    note: 'Printer: an "offline" or "not available" printer complaint is often not a hardware failure but stale or duplicate driver entries left behind after reinstalling or reconnecting the printer — clearing out every existing driver entry for that printer and letting the system re-detect a single clean instance (rather than adding yet another one alongside the old ones) is usually what actually fixes it. A test page printing successfully from the printer itself while nothing prints from the application confirms the printer and its physical connection are fine and points squarely at the driver/software side.'
  },
  {
    key: 'firmwareSoftware',
    match: /\b(firmware|instrument setup (failed|stalled|stuck)|software (version|upgrade|update|exception|glitch)|system (frozen|unresponsive))\b/i,
    note: 'Firmware and system software: a firmware push or instrument-setup step that fails or won\'t complete is often a configuration selection issue rather than a hardware fault — selecting the wrong system type or wrong hardware variant for a given component during setup can throw errors that look exactly like a missing or non-responding device, and the fix is re-selecting the correct configuration rather than chasing hardware. Setup appearing to stall is also worth checking for a hidden dialog box sitting behind the main setup window before assuming a freeze. A configuration setting that was correct on an older workstation model doesn\'t always carry over to a newer one — a storage or boot-mode setting that works fine on one hardware generation can stop a different, newer model from booting at all, so confirm a setting is appropriate for the specific model in front of you before applying a fix written for a different generation. Software issues are frequently tied to a specific installed version rather than being a novel defect — noting the exact software version before troubleshooting is worthwhile, since some odd behaviors are known, version-specific glitches with a documented fix or a later patch rather than something to chase from scratch. A basic restart is also worth trying on a frozen or unresponsive interface before assuming a deeper software fault. A software upgrade that also migrates the underlying data can fail if leftover data in a newer format is already present where the migration expects to write — clearing that out first, after confirming it isn\'t needed, is a common fix for an otherwise unexplained migration failure. When a procedure calls for copying files onto removable media, confirm the drive is formatted the way the procedure specifies — an incompatible format can cause a transfer to fail in a way that looks like corrupted data.'
  },
  {
    key: 'expansionModules',
    match: /\b(continuous access|continuous waste|expansion module|accessory module|add-on module|auxiliary (bay|drawer))\b/i,
    note: 'Accessory/expansion modules: this equipment family supports optional add-on modules on some configurations (continuous-access waste or fluid handling, an attached carrier-loading module, extra tip-handling hardware) that aren\'t present on every unit — worth confirming which optional modules are actually installed before assuming a report about a drawer, extra loading bay, or continuous-fill behavior concerns the base unit\'s standard transport, waste, or fluid systems. Within these modules, a door or drawer interlock that intermittently fails to lock or unlock is more often a fine mechanical alignment issue — a latch or locking pin not quite centered in its catch — than an electrical fault, especially if it correlates with someone handling the door partway through its cycle; a small positional adjustment often resolves it without any part replacement. A drive that stalls short of its target at roughly the same position each time points to a physical obstruction or interference along its travel path rather than a motor fault, and is worth a visual inspection before deeper troubleshooting. A two-stage fluid or waste transfer that times out without the expected level change is usually a fluidic or mechanical issue on that path — a stuck sensor float, debris buildup, a kinked line, or a valve needing cleaning — rather than a failed pump or sensor outright, and a newly added or reconnected accessory that seems dead after an upgrade is worth checking for a simply loose or unseated connection before anything else.'
  }
];

// equipment: the free-text "equipment" field from the report (e.g.
// "Panther", "Panther Fusion #4"). freeText: anything else worth scanning
// for subsystem keywords — typically the report's description, optionally
// combined with its fault-type category.
//
// Only returns notes when the equipment is recognizably this family —
// there's no value (and some risk of being misleading) in attaching this
// subsystem background to an unrelated piece of equipment just because a
// keyword happened to match.
function getEquipmentKnowledge(equipment, freeText) {
  if (!equipment || !EQUIPMENT_FAMILY_PATTERN.test(equipment)) {
    return [];
  }

  const haystack = String(freeText || '');

  return SUBSYSTEM_KNOWLEDGE
    .filter(function (subsystem) { return subsystem.match.test(haystack); })
    .map(function (subsystem) { return subsystem.note; })
    // Cap at 2 — enough to add real specificity without crowding out the
    // model's own reasoning about the actual report, or bloating the
    // prompt with subsystems that only loosely matched.
    .slice(0, 2);
}

module.exports = { getEquipmentKnowledge };
