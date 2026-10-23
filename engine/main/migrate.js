// One-time copy of the old "Dooray Widget" app data (%APPDATA%\dooray-widget) into the
// Desk Widgets layout. Runs before app "ready" so Chromium picks up the copied "Local State"
// (it holds the key safeStorage used for the encrypted API token). The old folder is left as is
// (a backup; the uninstaller's "delete settings" removes it too).
//
// Old layout                     New layout
//   settings.json (everything)     settings.json (engine keys) + widgets/dooray/settings.json (the rest)
//   categories.json, rules.json    widgets/dooray/categories.json, rules.json
//   themes/                        widgets/dooray/themes/
//   Local State                    Local State
const fs = require('fs');
const path = require('path');

// Keys of the old settings.json that belong to the engine now; everything else is Dooray's.
const ENGINE_KEYS = ['desktopMode', 'launchAtStartup', 'idleMinutes', 'notifyDurationSec', 'notifyMaxVisible'];
const DOORAY_FILES = ['categories.json', 'rules.json'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Splits an old settings.json into the engine part and the Dooray widget part. */
function splitLegacySettings(raw) {
  const old = { ...(raw || {}) };
  // Files from before #16 had stayOnDesktop (true/false) instead of desktopMode.
  if (!old.desktopMode && old.stayOnDesktop !== undefined) old.desktopMode = old.stayOnDesktop ? 'anchor' : 'off';
  delete old.stayOnDesktop;
  const engine = {};
  const dooray = {};
  for (const [k, v] of Object.entries(old)) (ENGINE_KEYS.includes(k) ? engine : dooray)[k] = v;
  return { engine, dooray };
}

/**
 * @param {{ legacyDir: string, userData: string, widgetDir?: string }} opts
 * @returns {{ migrated: boolean, reason?: string, copied?: string[] }}
 */
function migrateLegacy({ legacyDir, userData, widgetDir = path.join(userData, 'widgets', 'dooray') }) {
  if (!legacyDir || path.resolve(legacyDir) === path.resolve(userData)) return { migrated: false, reason: 'same-folder' };
  if (!fs.existsSync(legacyDir)) return { migrated: false, reason: 'no-legacy-data' };
  // Only into a fresh folder: never overwrite anything the new app already saved.
  if (fs.existsSync(path.join(userData, 'settings.json')) || fs.existsSync(widgetDir)) return { migrated: false, reason: 'already-set-up' };

  const legacySettings = readJson(path.join(legacyDir, 'settings.json'));
  const hasData = legacySettings || DOORAY_FILES.some((f) => fs.existsSync(path.join(legacyDir, f)));
  if (!hasData) return { migrated: false, reason: 'no-legacy-data' };

  const copied = [];
  fs.mkdirSync(widgetDir, { recursive: true });

  // The encryption key first: without it the copied token cannot be decrypted.
  const localState = path.join(legacyDir, 'Local State');
  if (fs.existsSync(localState)) {
    fs.copyFileSync(localState, path.join(userData, 'Local State'));
    copied.push('Local State');
  }
  for (const f of DOORAY_FILES) {
    const from = path.join(legacyDir, f);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(widgetDir, f));
      copied.push(f);
    }
  }
  const themes = path.join(legacyDir, 'themes');
  if (fs.existsSync(themes)) {
    fs.cpSync(themes, path.join(widgetDir, 'themes'), { recursive: true });
    copied.push('themes');
  }

  const { engine, dooray } = splitLegacySettings(legacySettings);
  if (legacySettings) {
    fs.writeFileSync(path.join(widgetDir, 'settings.json'), JSON.stringify(dooray, null, 2), 'utf8');
    copied.push('settings.json');
  }
  // Written last: its presence marks the migration as done.
  const engineSettings = { ...engine, widgets: { dooray: { enabled: true } }, migratedFrom: legacyDir };
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(engineSettings, null, 2), 'utf8');
  return { migrated: true, copied };
}

module.exports = { migrateLegacy, splitLegacySettings, ENGINE_KEYS };
